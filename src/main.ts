import 'reflect-metadata';
import { AuthModule } from './auth';
import {
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CatalogModule } from './catalog';
import { Database, DataModule } from './db';
import { OrdersModule } from './orders';
import { PaymentsModule } from './payments';
import { Jobs } from './jobs';
import { validateConfig, origin } from './config';

@Controller('v1')
class Health {
  constructor(private db: Database) {}
  @Get('health') async health() {
    const { rows } = await this.db.pool.query(`SELECT
      (SELECT count(*)::int FROM orders WHERE state='pending' AND expires_at<now()-interval '10 minutes') AS overdue,
      (SELECT count(*)::int FROM mail_jobs WHERE state='failed' OR (state='queued' AND created_at<now()-interval '30 minutes')) AS mail`);
    if (rows[0].overdue || rows[0].mail)
      throw new ServiceUnavailableException({ status: 'degraded', ...rows[0] });
    return { status: 'ok' };
  }
}
@Module({
  imports: [
    DataModule,
    AuthModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
  ],
  providers: [Jobs],
  controllers: [Health],
})
export class AppModule {}
export async function bootstrap() {
  validateConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Authorization'],
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  app.use((req: any, res: any, next: any) => {
    if (
      req.method === 'POST' &&
      req.headers.origin &&
      req.headers.origin !== origin
    )
      return res
        .status(403)
        .json({ message: 'Origem da solicitação inválida.' });
    next();
  });
  const db = app.get(Database);
  await db.migrate(process.env.SEED_CATALOG === 'yes');
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT ?? 4100),
    process.env.HOST ?? '127.0.0.1',
  );
  return app;
}
if (require.main === module)
  bootstrap().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
