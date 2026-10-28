import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(raw: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
}
