import { timingSafeEqual } from 'node:crypto';

/** ADR-146/163: private origin plus proof from the office reverse proxy. */

/**
 * ADR-294: the header nginx sets on every request it proxies from a public listener (the customer API
 * and the Desk at desk.hawzhin.app, reached through the Cloudflare tunnel). Its presence, with any
 * value, means the request came from the internet, so trusted-office access never applies to it, even
 * if that listener were ever misconfigured to send the office proof. The office listener never sets it.
 */
export const PUBLIC_GATEWAY_HEADER = 'X-Hawa-Public-Gateway';
export interface OfficeAccessPolicy { mode: 'required' | 'trusted_office'; origin?: string; proxyProof?: string }

export function officeAccessPolicy(env: NodeJS.ProcessEnv): OfficeAccessPolicy {
  const mode = env.HAWA_DESK_AUTH_MODE || 'required';
  if (mode === 'required') return { mode };
  if (mode !== 'trusted_office') throw new Error('Unknown HAWA_DESK_AUTH_MODE');
  let url: URL;
  try { url = new URL(env.HAWA_TRUSTED_OFFICE_ORIGIN || ''); }
  catch { throw new Error('Trusted office access requires HAWA_TRUSTED_OFFICE_ORIGIN'); }
  const host = url.hostname;
  const parts = host.split('.').map(Number);
  const ipv4 = parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255);
  const privateHost = host === 'localhost' || host === '[::1]' || ipv4 &&
    (parts[0] === 127 || parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  if (!privateHost || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Trusted office origin must be a private office HTTP origin');
  const proxyProof = env.HAWA_OFFICE_PROXY_PROOF;
  if (!proxyProof || !/^[a-f0-9]{64}$/.test(proxyProof)) throw new Error('Trusted office access requires a server-only HAWA_OFFICE_PROXY_PROOF');
  if (['HAWA_DESIGN_WORKER_TOKEN','HAWA_WORKER_TOKEN','HAWA_WORKER_TOKEN_PREVIOUS','HAWA_API_KEY','HAWA_BEARER_TOKEN',
      'HAWA_ADMIN_KEY','HAWA_ART_DIRECTOR_KEY','HAWA_REVIEWER_KEY','HAWA_DESK_SECRET'].some(key => env[key] === proxyProof))
    throw new Error('Office proxy proof must be distinct from service and office credentials');
  return { mode, origin: url.origin, proxyProof };
}

export function permitsOfficeRequest(policy: OfficeAccessPolicy, request: {
  url: string; method: string; header(name: string): string | undefined;
}): boolean {
  if (policy.mode !== 'trusted_office' || !policy.origin || !policy.proxyProof) return false;
  if (request.header(PUBLIC_GATEWAY_HEADER) !== undefined) return false;
  const proof = request.header('X-Hawa-Office-Proof') || '';
  if (Buffer.byteLength(proof) !== Buffer.byteLength(policy.proxyProof) ||
      !timingSafeEqual(Buffer.from(proof), Buffer.from(policy.proxyProof))) return false;
  const expected = new URL(policy.origin);
  const actualHost = request.header('Host') || new URL(request.url).host;
  if (actualHost.toLowerCase() !== expected.host.toLowerCase()) return false;
  const origin = request.header('Origin');
  if (origin && origin !== expected.origin) return false;
  if (request.header('Sec-Fetch-Site') === 'cross-site') return false;
  return ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.header('X-Hawa-Office-Request') === '1';
}

export function validateOfficeBind(policy: OfficeAccessPolicy, bindIp: string): void {
  if (policy.mode !== 'trusted_office') return;
  const host = new URL(policy.origin!).hostname;
  const expected = host === 'localhost' ? '127.0.0.1' : host === '[::1]' ? '::1' : host;
  if (bindIp !== expected) throw new Error('Trusted office deployment must bind only to its configured private office address');
}
