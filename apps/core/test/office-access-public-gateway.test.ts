import { describe, expect, it } from 'vitest';
import { PUBLIC_GATEWAY_HEADER, officeAccessPolicy, permitsOfficeRequest } from '../src/services/office-access.js';

/**
 * ADR-294: nginx's public listeners (design-api.hawzhin.app, desk.hawzhin.app, through the Cloudflare
 * tunnel) set X-Hawa-Public-Gateway on every request they proxy. Trusted-office access must never apply
 * to such a request, even one that carries the office proof and the office Host, which only a
 * misconfigured listener could produce. The office listener (127.0.0.1:8080) never sets the header, so
 * trusted-office access there is unchanged.
 */
const proof = 'c'.repeat(64);
const policy = officeAccessPolicy({
  HAWA_DESK_AUTH_MODE: 'trusted_office', HAWA_TRUSTED_OFFICE_ORIGIN: 'http://127.0.0.1:8080', HAWA_OFFICE_PROXY_PROOF: proof,
});
const request = (headers: Record<string, string>, method = 'GET') => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url: 'http://127.0.0.1:8080/v1/tasks', method, header: (name: string) => lower[name.toLowerCase()] };
};
const office = { Host: '127.0.0.1:8080', 'X-Hawa-Office-Proof': proof };

describe('trusted-office access and the public gateway header', () => {
  it('admits an office-listener request (proof, office Host, no public-gateway header)', () => {
    expect(permitsOfficeRequest(policy, request(office))).toBe(true);
    expect(permitsOfficeRequest(policy, request({ ...office, 'X-Hawa-Office-Request': '1' }, 'POST'))).toBe(true);
  });

  it('refuses the same request when it came through a public listener, whatever the header value', () => {
    for (const value of ['desk', 'customer', '', 'anything']) {
      expect(permitsOfficeRequest(policy, request({ ...office, [PUBLIC_GATEWAY_HEADER]: value })), value).toBe(false);
      expect(permitsOfficeRequest(policy, request({ ...office, 'X-Hawa-Office-Request': '1', [PUBLIC_GATEWAY_HEADER]: value }, 'POST')), value).toBe(false);
    }
  });

  it('names the header nginx sets on both public listeners', () => {
    expect(PUBLIC_GATEWAY_HEADER).toBe('X-Hawa-Public-Gateway');
  });

  it('never admits anything in required mode', () => {
    expect(permitsOfficeRequest(officeAccessPolicy({ HAWA_DESK_AUTH_MODE: 'required' }), request(office))).toBe(false);
  });
});
