import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Database } from './db';
import { Payments } from './payments';
import type { Order } from './orders';

@Injectable()
export class Jobs implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private active = false;
  private log = new Logger('Jobs');
  constructor(
    private db: Database,
    private payments: Payments,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.tick().catch(() =>
          this.log.error(
            'Background work failed. Check database connectivity.',
          ),
        ),
      15000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async tick() {
    if (this.active) return;
    this.active = true;
    try {
      const pending = await this.db.pool.query<Order>(
        "SELECT * FROM orders WHERE state='pending' AND expires_at<=now() ORDER BY last_checked NULLS FIRST,expires_at LIMIT 25",
      );
      for (const order of pending.rows) {
        await this.db.pool.query(
          'UPDATE orders SET last_checked=now() WHERE id=$1',
          [order.id],
        );
        try {
          await this.payments.reconcile(order);
        } catch {
          this.log.warn('Payment reconciliation pending for order ' + order.id);
        }
      }
      for (let i = 0; i < 20; i++) if (!(await this.deliverOne())) break;
    } finally {
      this.active = false;
    }
  }
  async deliverOne() {
    return this.db.tx(async (client) => {
      const { rows } =
        await client.query(`SELECT j.*,o.email,o.origin,o.mode,o.total,o.currency FROM mail_jobs j JOIN orders o ON o.id=j.order_id
        WHERE j.state='queued' AND j.next_at<=now() ORDER BY j.next_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      const job = rows[0];
      if (!job) return false;
      try {
        if (job.mode === 'demo') {
          await client.query(
            "UPDATE mail_jobs SET state='demo-preview' WHERE order_id=$1",
            [job.order_id],
          );
          return true;
        }
        if (Date.now() - job.created_at.getTime() > 23 * 3600000)
          throw Error('Delivery window exceeded. Review delivery history.');
        const message =
          'Your Nightjar Books order ' +
          job.order_id.slice(0, 8) +
          ' is confirmed. Total: ' +
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: job.currency,
          }).format(job.total / 100) +
          '. View your receipt: ' +
          job.origin +
          '/orders/' +
          job.order_id;
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'order/' + job.order_id,
          },
          body: JSON.stringify({
            from: process.env.MAIL_FROM,
            to: [job.email],
            subject: 'Your Nightjar Books order',
            text: message,
          }),
        });
        if (!response.ok)
          throw Error('Email provider returned ' + response.status);
        await client.query(
          "UPDATE mail_jobs SET state='sent',last_error=NULL WHERE order_id=$1",
          [job.order_id],
        );
      } catch (error) {
        const attempts = job.attempts + 1;
        await client.query(
          `UPDATE mail_jobs SET attempts=$2,state=$3,last_error=$4,next_at=now()+$5*interval '1 minute' WHERE order_id=$1`,
          [
            job.order_id,
            attempts,
            attempts >= 8 ||
            Date.now() - job.created_at.getTime() > 23 * 3600000
              ? 'failed'
              : 'queued',
            error instanceof Error ? error.message : 'Mail delivery failed',
            Math.min(2 ** attempts, 60),
          ],
        );
      }
      return true;
    });
  }
}
