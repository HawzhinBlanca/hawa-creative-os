import { createHmac, timingSafeEqual } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

/** Domain-separated signature over the complete office event; the secret is never sent to Restate. */
export function signLifecycleOfficeEvent(secret: string, event: object): string {
  if (!secret.trim()) throw new Error('Lifecycle office gateway credential is not configured');
  return createHmac('sha256', secret).update('hawa:lifecycle-office:v1\n').update(canonical(event)).digest('hex');
}

export function verifyLifecycleOfficeEvent(secret: string, event: object, signature: unknown): boolean {
  if (!secret.trim() || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature, 'hex');
  const expected = Buffer.from(signLifecycleOfficeEvent(secret, event), 'hex');
  return timingSafeEqual(actual, expected);
}

/** A distinct signature keeps public Delivery ingress from inventing a lifecycle-owned run. */
export function signLifecycleDeliveryClaim(secret: string, claim: object): string {
  if (!secret.trim()) throw new Error('Lifecycle delivery credential is not configured');
  return createHmac('sha256', secret).update('hawa:lifecycle-delivery:v1\n').update(canonical(claim)).digest('hex');
}

export function verifyLifecycleDeliveryClaim(secret: string, claim: object, signature: unknown): boolean {
  if (!secret.trim() || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(signLifecycleDeliveryClaim(secret, claim), 'hex'));
}
