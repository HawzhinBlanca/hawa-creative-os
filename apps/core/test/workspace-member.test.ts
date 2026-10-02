import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceMemberVerifier, HAWZHIN_AUTH_ORIGIN } from '../src/customer/supabase-member.js';

const key = 'sb_publishable_testfixture12';
const token = 'Bearer untrusted.claims.signature';
const subject = 'b1000000-0000-4000-a000-000000000001';
const member = { id: subject, role: 'authenticated', aud: 'authenticated' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function verifier(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return { verify: createWorkspaceMemberVerifier({ publishableKey: key, fetcher }), fetcher };
}

describe('ADR256 existing workspace membership boundary', () => {
  it('verifies identity and current access at the pinned issuer; grants no office/client authority', async () => {
    const { verify, fetcher } = verifier(json({ ...member, user_metadata: { role: 'administrator', clientId: 'other-client' } }), json(true));
    const actual = await verify(token);
    expect(actual).toEqual({ kind: 'workspace_member', issuer: HAWZHIN_AUTH_ORIGIN, subject });
    expect(Object.isFrozen(actual)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = fetcher.mock.calls;
    expect(calls[0][0]).toBe(HAWZHIN_AUTH_ORIGIN + '/auth/v1/user');
    expect(calls[1][0]).toBe(HAWZHIN_AUTH_ORIGIN + '/rest/v1/rpc/has_app_access');
    expect(calls[1][1]?.body).toBe(JSON.stringify({ _user_id: subject }));
    for (const [, init] of calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: token, apikey: key });
      expect(init?.signal).toBe(calls[0][1]?.signal);
    }
  });

  it.each([undefined, '', 'Bearer office-secret', 'Bearer hawa_sess_office', 'Basic a.b.c', 'Bearer a.b.c\nX-Role: administrator', 'Bearer ' + 'a'.repeat(16_384)])(
    'refuses non-user credential %s before transport', async authorization => {
      const { verify, fetcher } = verifier();
      await expect(verify(authorization)).rejects.toMatchObject({ status: 401, code: 'WORKSPACE_SIGN_IN_REQUIRED' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('rejects a token refused by Auth without checking membership', async () => {
    const { verify, fetcher } = verifier(json({ message: 'invalid signature' }, 401));
    await expect(verify(token)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...member, role: 'service_role' }, { ...member, aud: 'another-app' },
    { ...member, id: 'claimed-customer' }, { ...member, is_anonymous: true },
  ])('rejects an inappropriate Auth principal', async principal => {
    const { verify, fetcher } = verifier(json(principal));
    await expect(verify(token)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks revocation again for the next request', async () => {
    const { verify, fetcher } = verifier(json(member), json(true), json(member), json(false));
    await verify(token);
    await expect(verify(token)).rejects.toMatchObject({ status: 403, code: 'WORKSPACE_ACCESS_DENIED' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not trust a truthy or malformed membership answer', async () => {
    for (const answer of ['true', { allowed: true }, null, 1]) {
      const { verify } = verifier(json(member), json(answer));
      await expect(verify(token)).rejects.toMatchObject({ status: 503 });
    }
  });

  it.each([403, 429, 500, 503])('reports a dependency HTTP %s as unavailable', async status => {
    const { verify } = verifier(json(member), json({ details: token }, status));
    await expect(verify(token)).rejects.toMatchObject({ status: 503, message: 'WORKSPACE_ACCESS_UNAVAILABLE' });
  });

  it('does not expose a transport error or token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(token));
    const verify = createWorkspaceMemberVerifier({ publishableKey: key, fetcher });
    await expect(verify(token)).rejects.toMatchObject({ status: 503, message: 'WORKSPACE_ACCESS_UNAVAILABLE' });
  });

  it('bounds the whole verification deadline and does not retry a failed dependency', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const verify = createWorkspaceMemberVerifier({ publishableKey: key, fetcher });
      // Node's native AbortSignal.timeout uses its own clock, so replace only this clock dependency.
      const controller = new AbortController();
      const clock = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
      try {
        const outcome = expect(verify(token)).rejects.toMatchObject({ status: 503 });
        await vi.advanceTimersByTimeAsync(8_000);
        await outcome;
        expect(clock).toHaveBeenCalledWith(8_000);
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally { clock.mockRestore(); }
    } finally { vi.useRealTimers(); }
  });

  it.each([new Response('not json'), json([]), json(null), json({ ...member, padding: 'x'.repeat(32_768) })])(
    'refuses malformed or oversized Auth responses', async response => {
      const { verify, fetcher } = verifier(response);
      await expect(verify(token)).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects service/secret keys in configuration and accepts legacy anon configuration', () => {
    const legacy = (role: string) => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
    for (const invalid of ['sb_secret_do_not_send', legacy('service_role'), '', 'office-key']) {
      expect(() => createWorkspaceMemberVerifier({ publishableKey: invalid })).toThrow('publishable or legacy anon key');
    }
    expect(() => createWorkspaceMemberVerifier({ publishableKey: legacy('anon') })).not.toThrow();
  });
});
