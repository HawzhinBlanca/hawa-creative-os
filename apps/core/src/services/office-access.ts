/** ADR-146: explicit private-office trust, never a credential or a public default. */
export interface OfficeAccessPolicy { mode: 'required' | 'trusted_office'; origin?: string }

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
  return { mode, origin: url.origin };
}

export function permitsOfficeRequest(policy: OfficeAccessPolicy, request: {
  url: string; method: string; header(name: string): string | undefined;
}): boolean {
  if (policy.mode !== 'trusted_office' || !policy.origin) return false;
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
