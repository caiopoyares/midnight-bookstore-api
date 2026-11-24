import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export const prod = process.env.NODE_ENV === 'production';
export const mode = process.env.PAYMENT_MODE ?? 'demo';
export const origin = process.env.STOREFRONT_URL ?? 'http://localhost:3000';
export const country = (process.env.SHIPPING_COUNTRY ?? 'US').toUpperCase();
export const shipping = Number(process.env.SHIPPING_CENTS ?? '495');
export const currency = 'usd';
export const staffKeys: Record<string, string> = JSON.parse(
  process.env.STAFF_KEYS ?? '{}',
);
export function validateConfig() {
  if (
    !['demo', 'stripe'].includes(mode) ||
    !Number.isSafeInteger(shipping) ||
    shipping < 0 ||
    shipping > 100000 ||
    !/^[A-Z]{2}$/.test(country)
  )
    throw Error('Invalid shop configuration');
  if (
    mode === 'stripe' &&
    (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET)
  )
    throw Error('Configure both Stripe secrets');
  if (
    prod &&
    (mode !== 'stripe' ||
      !origin.startsWith('https://') ||
      !process.env.DATABASE_URL ||
      !process.env.SHIPPING_COUNTRY ||
      !process.env.SHIPPING_CENTS ||
      !process.env.RESEND_API_KEY ||
      !process.env.MAIL_FROM ||
      !Object.keys(staffKeys).length)
  )
    throw Error('Production settings incomplete. See README.');
  for (const key of Object.values(staffKeys))
    if (typeof key !== 'string' || key.length < 32)
      throw Error('Use staff keys of at least 32 characters');
}
function digest(value: string) {
  return createHash('sha256').update(value).digest();
}
export function staffIdentity(header?: string) {
  const token = digest(header ?? '');
  for (const [name, key] of Object.entries(staffKeys))
    if (timingSafeEqual(token, digest('Bearer ' + key))) return name;
  throw new UnauthorizedException('A valid staff key is required.');
}
