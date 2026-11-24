import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Injectable,
  Module,
  Post,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { Database } from './db';
import { staffIdentity } from './config';

@Injectable()
export class Inventory {
  constructor(private db: Database) {}
  async hold(client: PoolClient, sku: string, quantity: number) {
    const { rows } = await client.query(
      `UPDATE editions e SET reserved=reserved+$2 FROM books b
      WHERE e.sku=$1 AND b.slug=e.book_slug AND e.on_hand-e.reserved >= $2
      RETURNING e.price,e.format,b.title`,
      [sku, quantity],
    );
    if (!rows.length)
      throw new ConflictException(
        'Estoque insuficiente para ' +
          sku +
          '. Ajuste este item na sua sacola.',
      );
    return rows[0];
  }
  async finish(client: PoolClient, id: string, sold: boolean) {
    const { rows } = await client.query(
      'SELECT sku,quantity FROM order_lines WHERE order_id=$1 ORDER BY sku',
      [id],
    );
    for (const { sku, quantity } of rows)
      await client.query(
        'UPDATE editions SET reserved=reserved-$2,on_hand=on_hand-$3 WHERE sku=$1',
        [sku, quantity, sold ? quantity : 0],
      );
  }
  async adjust(
    body: { sku?: string; delta?: number; reason?: string; requestId?: string },
    actor: string,
  ) {
    const { sku, delta, reason, requestId } = body ?? {};
    if (
      typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    )
      throw new BadRequestException('Informe o identificador do ajuste.');
    if (
      typeof sku !== 'string' ||
      !Number.isInteger(delta) ||
      !delta ||
      Math.abs(delta) > 100000 ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 200
    )
      throw new BadRequestException(
        'Informe o SKU, uma alteração diferente de zero e um motivo.',
      );
    return this.db.tx(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [requestId],
      );
      const previous = (
        await client.query('SELECT * FROM stock_log WHERE request_id=$1', [
          requestId,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.sku !== sku ||
          previous.delta !== delta ||
          previous.reason !== reason.trim() ||
          previous.actor !== actor
        )
          throw new ConflictException(
            'O identificador do ajuste já foi utilizado.',
          );
        return (
          await client.query(
            'SELECT sku,on_hand,reserved FROM editions WHERE sku=$1',
            [sku],
          )
        ).rows[0];
      }
      const { rows } = await client.query(
        'UPDATE editions SET on_hand=on_hand+$2 WHERE sku=$1 AND on_hand+$2>=reserved RETURNING sku,on_hand,reserved',
        [sku, delta],
      );
      if (!rows.length)
        throw new ConflictException('Confira o SKU e o estoque disponível.');
      await client.query(
        'INSERT INTO stock_log(sku,delta,reason,actor,request_id) VALUES ($1,$2,$3,$4,$5)',
        [sku, delta, reason.trim(), actor, requestId],
      );
      return rows[0];
    });
  }
}
@Controller('v1/staff')
class InventoryController {
  constructor(private inventory: Inventory) {}
  @Post('stock') update(
    @Headers('authorization') token: string,
    @Body() body: Parameters<Inventory['adjust']>[0],
  ) {
    return this.inventory.adjust(body, staffIdentity(token));
  }
}
@Module({
  providers: [Inventory],
  exports: [Inventory],
  controllers: [InventoryController],
})
export class InventoryModule {}
