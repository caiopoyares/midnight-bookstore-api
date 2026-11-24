import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Database } from './db';
import { origin, prod } from './config';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const cookieName = 'midnight_session';
function cookie(req: Request) {
  const raw = req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + '='));
  return raw?.slice(cookieName.length + 1) ?? '';
}
@Injectable()
export class Auth {
  constructor(private db: Database) {}
  async request(email: unknown, ip: string) {
    if (
      typeof email !== 'string' ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    )
      throw new BadRequestException('Informe um e-mail válido.');
    email = email.trim().toLowerCase();
    const token = randomBytes(32).toString('hex'),
      key = hash(token);
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        ip,
      ]);
      await c.query(
        "DELETE FROM login_requests WHERE created_at<now()-interval '1 day'",
      );
      const recent = await c.query(
        "SELECT count(*)::int AS n FROM login_requests WHERE (email=$1 OR ip=$2) AND created_at>now()-interval '15 minutes'",
        [email, ip],
      );
      if (recent.rows[0].n >= 10)
        throw new HttpException(
          'Aguarde alguns minutos antes de pedir outro link.',
          429,
        );
      await c.query('INSERT INTO login_requests(email,ip) VALUES ($1,$2)', [
        email,
        ip,
      ]);
      await c.query('DELETE FROM login_links WHERE expires_at<now()');
      await c.query(
        "INSERT INTO login_links VALUES ($1,$2,now()+interval '15 minutes')",
        [key, email],
      );
    });
    const text =
      'Acesse sua conta na Midnight Books. Este link vale por 15 minutos e pode ser usado uma vez.\n\n' +
      origin +
      '/login#token=' +
      token;
    try {
      let response: globalThis.Response;
      if (process.env.MAILPIT_URL && !prod) {
        response = await fetch(process.env.MAILPIT_URL + '/api/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            From: { Email: 'acesso@midnight.test', Name: 'Midnight Books' },
            To: [{ Email: email }],
            Subject: 'Seu link de acesso à Midnight Books',
            Text: text,
          }),
        });
      } else {
        response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
            'Idempotency-Key': 'login/' + key,
          },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            from: process.env.MAIL_FROM,
            to: [email],
            subject: 'Seu link de acesso à Midnight Books',
            text,
          }),
        });
      }
      if (!response.ok) throw Error();
    } catch {
      await this.db.pool.query('DELETE FROM login_links WHERE hash=$1', [key]);
      throw new HttpException(
        'Não foi possível enviar o e-mail. Tente novamente.',
        503,
      );
    }
    return { message: 'Enviamos um link de acesso para o seu e-mail.' };
  }
  async verify(token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new BadRequestException('Link de acesso inválido.');
    const session = randomBytes(32).toString('hex');
    const user = await this.db.tx(async (c) => {
      const link = (
        await c.query(
          'DELETE FROM login_links WHERE hash=$1 AND expires_at>now() RETURNING email',
          [hash(token)],
        )
      ).rows[0];
      if (!link)
        throw new UnauthorizedException(
          'O link expirou ou já foi usado. Peça um novo.',
        );
      const customer = (
        await c.query(
          'INSERT INTO customers(id,email) VALUES ($1,$2) ON CONFLICT(email) DO UPDATE SET email=excluded.email RETURNING id,email',
          [randomUUID(), link.email],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO customer_sessions VALUES ($1,$2,now()+interval '7 days')",
        [hash(session), customer.id],
      );
      return customer;
    });
    return { session, user };
  }
  async require(req: Request) {
    const token = cookie(req);
    const { rows } = await this.db.pool.query(
      'SELECT c.id,c.email FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE s.hash=$1 AND s.expires_at>now()',
      [hash(token)],
    );
    if (!rows.length)
      throw new UnauthorizedException('Entre na sua conta para continuar.');
    return rows[0] as { id: string; email: string };
  }
  async own(req: Request, id: string) {
    const user = await this.require(req);
    if (
      !(
        await this.db.pool.query(
          'SELECT 1 FROM orders WHERE id=$1 AND customer_id=$2',
          [id, user.id],
        )
      ).rowCount
    )
      throw new UnauthorizedException(
        'Este pedido não está disponível para esta conta.',
      );
    return user;
  }
  async logout(req: Request) {
    await this.db.pool.query('DELETE FROM customer_sessions WHERE hash=$1', [
      hash(cookie(req)),
    ]);
  }
}
@Controller('v1/auth')
class AuthController {
  constructor(private auth: Auth) {}
  @Post('link') @HttpCode(200) link(
    @Body() body: { email: unknown },
    @Req() req: Request,
  ) {
    return this.auth.request(body?.email, req.ip ?? 'unknown');
  }
  @Post('verify') @HttpCode(200) async verify(
    @Body() body: { token: unknown },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verify(body?.token);
    res.cookie(cookieName, result.session, {
      httpOnly: true,
      secure: prod,
      sameSite: 'lax',
      maxAge: 7 * 86400000,
      path: '/',
    });
    return result.user;
  }
  @Get('me') me(@Req() req: Request) {
    return this.auth.require(req);
  }
  @Post('logout') @HttpCode(200) async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: prod,
      sameSite: 'lax',
      path: '/',
    });
    return { message: 'Você saiu da sua conta.' };
  }
}
@Global()
@Module({ providers: [Auth], controllers: [AuthController], exports: [Auth] })
export class AuthModule {}
