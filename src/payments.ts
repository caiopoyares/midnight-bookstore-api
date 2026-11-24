import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { Basket, Order, Orders, OrdersModule } from './orders';
import { Auth } from './auth';
import { mode } from './config';

@Injectable()
export class Payments {
  private stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, {
        timeout: 10000,
        maxNetworkRetries: 1,
      })
    : undefined;
  constructor(private orders: Orders) {}
  private gateway() {
    if (!this.stripe)
      throw new ServiceUnavailableException(
        'O serviço de pagamentos está indisponível.',
      );
    return this.stripe;
  }
  private async session(order: Order) {
    if (order.session_id)
      return this.gateway().checkout.sessions.retrieve(order.session_id);
    // Stripe may prune a creation key after 24 hours. Older ambiguous sessions need staff review.
    if (Date.now() - order.created_at.getTime() > 22 * 3600000)
      throw new ServiceUnavailableException(
        'O pagamento pendente precisa de revisão.',
      );
    const session = await this.gateway().checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: order.id,
        metadata: { order_id: order.id },
        customer_email: order.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: order.currency,
              unit_amount: order.total,
              product_data: {
                name: 'Midnight Books order ' + order.id.slice(0, 8),
              },
            },
          },
        ],
        success_url: order.origin + '/orders/' + order.id,
        cancel_url: order.origin + '/orders/' + order.id,
      },
      { idempotencyKey: 'nightjar-' + order.id },
    );
    await this.orders.db.pool.query(
      'UPDATE orders SET session_id=$2,payment_url=$3 WHERE id=$1',
      [order.id, session.id, session.url],
    );
    return session;
  }
  private async apply(session: Stripe.Checkout.Session, eventId: string) {
    const id = session.metadata?.order_id;
    if (!id || session.client_reference_id !== id) return;
    const expected = {
      mode: 'stripe',
      session: session.id,
      total: session.amount_total ?? undefined,
      currency: session.currency ?? undefined,
    };
    if (session.status === 'complete' && session.payment_status === 'paid')
      await this.orders.settle(id, 'paid', eventId, expected);
    if (session.status === 'expired')
      await this.orders.settle(id, 'expired', eventId, expected);
  }
  async checkout(key: string, body: Basket, customerId?: string) {
    const order = await this.orders.reserve(key, body, customerId),
      receipt = '/orders/' + order.id;
    if (order.mode === 'demo' || order.state !== 'pending')
      return { id: order.id, url: receipt };
    if (order.expires_at.getTime() <= Date.now()) {
      await this.reconcile(order);
      return { id: order.id, url: receipt };
    }
    if (order.payment_url) return { id: order.id, url: order.payment_url };
    const session = await this.session(order);
    return { id: order.id, url: session.url ?? receipt };
  }
  async reconcile(order: Order) {
    if (order.mode === 'demo') {
      if (order.expires_at.getTime() <= Date.now())
        await this.orders.settle(order.id, 'expired', 'expiry-' + order.id, {
          mode: 'demo',
        });
      return;
    }
    // After the creation key's safe retry window, search the provider ledger.
    // A network error leaves the reservation intact for the next worker pass.
    const age = Date.now() - order.created_at.getTime();
    if (!order.session_id && age > 22 * 3600000) {
      const created = Math.floor(order.created_at.getTime() / 1000);
      const history = this.gateway().checkout.sessions.list({
        created: { gte: created - 60, lte: created + 23 * 3600 },
        limit: 100,
      });
      for await (const candidate of history) {
        if (
          candidate.client_reference_id === order.id &&
          candidate.metadata?.order_id === order.id
        ) {
          order = { ...order, session_id: candidate.id };
          await this.orders.db.pool.query(
            'UPDATE orders SET session_id=$2 WHERE id=$1',
            [order.id, candidate.id],
          );
          break;
        }
      }
      if (!order.session_id) {
        if (age > 48 * 3600000)
          await this.orders.settle(order.id, 'expired', 'orphan-' + order.id, {
            mode: 'stripe',
          });
        return;
      }
    }
    let session = await this.session(order);
    if (session.status === 'open' && order.expires_at.getTime() <= Date.now()) {
      try {
        session = await this.gateway().checkout.sessions.expire(session.id);
      } catch {
        session = await this.gateway().checkout.sessions.retrieve(session.id);
      }
    }
    await this.apply(session, 'reconcile-' + session.id + '-' + session.status);
  }
  async demo(id: string) {
    const order = await this.orders.get(id);
    if (mode !== 'demo' || order.mode !== 'demo') throw new NotFoundException();
    await this.orders.settle(id, 'paid', 'demo-' + id, {
      mode: 'demo',
      total: order.total,
      currency: order.currency,
    });
    return this.orders.summary(id);
  }
  async webhook(raw: Buffer | undefined, sig: string) {
    if (mode !== 'stripe') throw new NotFoundException();
    let event: Stripe.Event;
    try {
      event = this.gateway().webhooks.constructEvent(
        raw!,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch {
      throw new BadRequestException('Assinatura de pagamento inválida.');
    }
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.expired'
    )
      await this.apply(event.data.object, event.id);
    return { received: true };
  }
  async resume(id: string) {
    const order = await this.orders.get(id);
    if (
      order.mode !== 'stripe' ||
      order.state !== 'pending' ||
      order.expires_at.getTime() <= Date.now()
    )
      throw new BadRequestException('Esta sessão de pagamento foi encerrada.');
    return {
      id,
      url: (await this.session(order)).url ?? order.origin + '/orders/' + id,
    };
  }
}
@Controller('v1')
class PaymentsController {
  constructor(
    private payments: Payments,
    private auth: Auth,
  ) {}
  @Post('checkout') @HttpCode(200) async checkout(
    @Headers('idempotency-key') key: string,
    @Body() body: Basket,
    @Req() req: Request,
  ) {
    const user = await this.auth.require(req);
    return this.payments.checkout(key, { ...body, email: user.email }, user.id);
  }
  @Post('orders/:id/demo-pay') @HttpCode(200) async demo(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.auth.own(req, id);
    return this.payments.demo(id);
  }
  @Post('orders/:id/resume') @HttpCode(200) async resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.auth.own(req, id);
    return this.payments.resume(id);
  }
  @Post('payments/webhook') @HttpCode(200) webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') sig: string,
  ) {
    return this.payments.webhook(req.rawBody, sig);
  }
}
@Module({
  imports: [OrdersModule],
  providers: [Payments],
  controllers: [PaymentsController],
  exports: [Payments],
})
export class PaymentsModule {}
