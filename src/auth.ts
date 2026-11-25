import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
export function hashPassword(p: string) { const s = randomBytes(16); return s.toString('hex') + ':' + scryptSync(p, s, 64).toString('hex'); }
export function verifyPassword(p: string, h: string) {
  const [s, k] = h.split(':'); if (!s || !k) return false;
  const a = scryptSync(p, Buffer.from(s, 'hex'), 64), b = Buffer.from(k, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signToken(sub: string, secret: string, ttlSec = 30 * 86400) {
  const body = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return body + '.' + b64(createHmac('sha256', secret).update(body).digest());
}
export function verifyToken(t: string, secret: string): string | null {
  const [body, sig] = t.split('.'); if (!body || !sig) return null;
  const exp = b64(createHmac('sha256', secret).update(body).digest());
  if (exp.length !== sig.length || !timingSafeEqual(Buffer.from(exp), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p.sub : null;
}
