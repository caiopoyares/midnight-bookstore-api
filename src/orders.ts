import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Auth } from './auth';
import type { Request } from 'express';
import { Req } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from './db';
import { Inventory, InventoryModule } from './inventory';
import {
  country,
  currency,
  mode,
  origin,
  shipping,
  staffIdentity,
} from './config';

export type Address = {
  name: string;
  street: string;
  city: string;
  region: string;
  postal: string;
  country: string;
};
export type Basket = {
  email: string;
  address: Address;
  lines: { sku: string; quantity: number }[];
};
export interface Order {
  id: string;
  email: string;
  state: 'pending' | 'paid' | 'expired' | 'shipped';
  mode: 'stripe' | 'demo';
  subtotal: number;
  shipping: number;
  total: number;
  currency: string;
  origin: string;
  session_id: string | null;
  payment_url: string | null;
  expires_at: Date;
  created_at: Date;
}
function field(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BadRequestException('Confira ' + label + '.');
  return value.trim();
}
function normalize(body: Basket): Basket {
  const email = field(body?.email, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new BadRequestException('Informe um e-mail válido.');
  const address: Address = {
    name: field(body.address?.name, 'nome do destinatário', 100),
    street: field(body.address?.street, 'endereço', 180),
    city: field(body.address?.city, 'cidade', 100),
    region: field(body.address?.region, 'estado', 100),
    postal: field(body.address?.postal, 'CEP', 24),
    country: field(body.address?.country, 'country', 2).toUpperCase(),
  };
  if (address.country !== country)
    throw new BadRequestException('Entregamos apenas para ' + country + '.');
  if (
    !Array.isArray(body.lines) ||
    !body.lines.length ||
    body.lines.length > 50
  )
    throw new BadRequestException('Escolha entre 1 e 50 edições.');
  const counts = new Map<string, number>();
  for (const item of body.lines) {
    const sku = field(item?.sku, 'edição', 64),
      quantity = item.quantity;
    const combined = (counts.get(sku) ?? 0) + quantity;
    if (!Number.isInteger(quantity) || quantity <= 0 || combined > 99)
      throw new BadRequestException('Escolha de 1 a 99 exemplares por edição.');
    counts.set(sku, combined);
  }
  const lines = [...counts.keys()]
    .sort()
    .map((sku) => ({ sku, quantity: counts.get(sku)! }));
  return { email, address, lines };
}
@Injectable()
export class Orders {
  constructor(
    readonly db: Database,
    private inventory: Inventory,
  ) {}
  async reserve(
    key: string,
    input: Basket,
    customerId?: string,
  ): Promise<Order> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key ?? '',
      )
    )
      throw new BadRequestException(
        'A tentativa de compra deve ter um identificador válido.',
      );
    const body = normalize(input);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    return this.db.tx(async (client) => {
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO orders(id,attempt,fingerprint,email,address,mode,currency,shipping,origin,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 minutes') ON CONFLICT(attempt) DO NOTHING`,
        [
          id,
          key,
          fingerprint,
          body.email,
          body.address,
          mode,
          currency,
          shipping,
          origin,
        ],
      );
      if (!inserted.rowCount) {
        const prior = (
          await client.query('SELECT * FROM orders WHERE attempt=$1', [key])
        ).rows[0];
        if (
          prior.fingerprint !== fingerprint ||
          prior.customer_id !== (customerId ?? null)
        )
          throw new ConflictException(
            'Inicie uma nova compra para a sacola alterada.',
          );
        return prior;
      }
      let subtotal = 0;
      for (const { sku, quantity } of body.lines) {
        const { title, format, price } = await this.inventory.hold(
          client,
          sku,
          quantity,
        );
        await client.query(
          'INSERT INTO order_lines(order_id,sku,title,format,quantity,price) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, sku, title, format, quantity, price],
        );
        subtotal += quantity * price;
      }
      return (
        await client.query(
          'UPDATE orders SET subtotal=$2,total=$2+shipping,customer_id=$3 WHERE id=$1 RETURNING *',
          [id, subtotal, customerId ?? null],
        )
      ).rows[0];
    });
  }
  async get(id: string): Promise<Order> {
    const { rows } = await this.db.pool.query(
      'SELECT * FROM orders WHERE id=$1',
      [id],
    );
    if (!rows.length) throw new NotFoundException('Pedido não encontrado.');
    return rows[0];
  }
  async summary(id: string) {
    const { state, mode, total, currency, shipping, subtotal, expires_at } =
      await this.get(id);
    const { rows: lines } = await this.db.pool.query(
      'SELECT sku,title,format,quantity,price FROM order_lines WHERE order_id=$1 ORDER BY sku',
      [id],
    );
    return {
      id,
      state,
      mode,
      total,
      currency,
      shipping,
      subtotal,
      expires_at,
      lines,
    };
  }
  async settle(
    id: string,
    state: 'paid' | 'expired',
    eventId: string,
    expected: {
      mode: string;
      total?: number;
      currency?: string;
      session?: string;
    },
  ) {
    return this.db.tx(async (client) => {
      const order = (
        await client.query<Order>(
          'SELECT * FROM orders WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!order) throw new NotFoundException('Pedido não encontrado.');
      if (
        order.mode !== expected.mode ||
        (expected.session &&
          order.session_id &&
          order.session_id !== expected.session) ||
        (state === 'paid' &&
          (order.total !== expected.total ||
            order.currency !== expected.currency))
      )
        throw new ConflictException(
          'Os dados do pagamento não correspondem ao pedido.',
        );
      if (order.state !== 'pending') return order.state;
      let next = state;
      if (order.mode === 'demo' && order.expires_at.getTime() <= Date.now())
        next = 'expired';
      const saved = await client.query(
        'INSERT INTO payment_events VALUES ($1,$2,now()) ON CONFLICT DO NOTHING',
        [eventId, id],
      );
      if (!saved.rowCount) return order.state;
      await this.inventory.finish(client, id, next === 'paid');
      await client.query(
        'UPDATE orders SET state=$2,session_id=coalesce(session_id,$3) WHERE id=$1',
        [id, next, expected.session ?? null],
      );
      if (next === 'paid')
        await client.query(
          'INSERT INTO mail_jobs(order_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [id],
        );
      return next;
    });
  }
}
@Controller('v1')
class OrdersController {
  constructor(
    private orders: Orders,
    private auth: Auth,
  ) {}
  @Get('orders') async history(
    @Req() req: Request,
    @Query('page') value?: string,
  ) {
    const user = await this.auth.require(req);
    const page = Number(value ?? 1);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger((page - 1) * 20)
    ) {
      throw new BadRequestException('Informe uma página válida.');
    }
    const { rows } = await this.orders.db.pool.query(
      `WITH customer_page AS (
        SELECT o.id,o.state,o.total,o.currency,o.created_at,o.shipped_at,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'sku',l.sku,'title',l.title,'format',l.format,'quantity',l.quantity,'price',l.price
          ) ORDER BY l.sku) FROM order_lines l WHERE l.order_id=o.id),'[]'::jsonb) AS lines
        FROM orders o WHERE o.customer_id=$1
        ORDER BY o.created_at DESC,o.id DESC LIMIT 20 OFFSET $2
      )
      SELECT (SELECT count(*)::int FROM orders WHERE customer_id=$1) AS total,
        COALESCE(jsonb_agg(p ORDER BY p.created_at DESC,p.id DESC),'[]'::jsonb) AS orders
      FROM customer_page p`,
      [user.id, (page - 1) * 20],
    );
    return { ...rows[0], page, pageSize: 20 };
  }
  @Get('orders/:id') async summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.auth.own(req, id);
    return this.orders.summary(id);
  }
  @Get('staff') async staff(@Headers('authorization') token: string) {
    const actor = staffIdentity(token),
      db = this.orders.db.pool;
    const [stock, orders, log, jobs] = await Promise.all([
      db.query(
        'SELECT e.sku,b.title,e.format,e.on_hand,e.reserved FROM editions e JOIN books b ON b.slug=e.book_slug ORDER BY b.position,e.price',
      ),
      db.query(`SELECT o.id,o.state,o.total,o.currency,o.email,o.address,o.expires_at,o.created_at,
        (SELECT jsonb_agg(jsonb_build_object('sku',l.sku,'quantity',l.quantity,'title',l.title,'format',l.format) ORDER BY l.sku)
         FROM order_lines l WHERE l.order_id=o.id) AS lines FROM orders o
        ORDER BY (o.state IN ('pending','paid')) DESC,o.created_at DESC LIMIT 200`),
      db.query(
        'SELECT sku,delta,reason,actor,created_at FROM stock_log ORDER BY id DESC LIMIT 30',
      ),
      db.query(
        "SELECT order_id,state,attempts,last_error FROM mail_jobs WHERE state IN ('failed','queued') ORDER BY next_at LIMIT 50",
      ),
    ]);
    return {
      actor,
      stock: stock.rows,
      orders: orders.rows,
      log: log.rows,
      jobs: jobs.rows,
    };
  }
  @Post('staff/orders/:id/ship') async ship(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('authorization') token: string,
  ) {
    const actor = staffIdentity(token);
    const result = await this.orders.db.pool.query(
      `UPDATE orders SET state='shipped',shipped_at=coalesce(shipped_at,now()),shipped_by=coalesce(shipped_by,$2)
      WHERE id=$1 AND state IN ('paid','shipped') RETURNING state`,
      [id, actor],
    );
    if (!result.rowCount)
      throw new ConflictException('Apenas pedidos pagos podem ser enviados.');
    return result.rows[0];
  }
}
@Module({
  imports: [InventoryModule],
  providers: [Orders],
  exports: [Orders],
  controllers: [OrdersController],
})
export class OrdersModule {}
