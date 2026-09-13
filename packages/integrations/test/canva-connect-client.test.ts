import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvaConnectClient, CanvaNotConfiguredError } from '../src/canva-connect-client.js';

describe('CanvaConnectClient (CV-22, R01, Phase 3)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CANVA_API_KEY;
    delete process.env.CANVA_ACCESS_TOKEN;
    delete process.env.CANVA_CLIENT_ID;
    delete process.env.CANVA_CLIENT_SECRET;
  });

  it('fails closed with CANVA_NOT_CONFIGURED when credentials are absent', async () => {
    const client = new CanvaConnectClient();
    expect(client.isConfigured()).toBe(false);

    await expect(client.createDesign({ title: 'Test' })).rejects.toThrow(CanvaNotConfiguredError);
    await expect(client.getDesign('design_123')).rejects.toThrow(CanvaNotConfiguredError);
    await expect(client.createExportJob('design_123')).rejects.toThrow(CanvaNotConfiguredError);
  });

  it('authenticates with the explicitly supplied OAuth bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        design: {
          id: 'DAF_test_1',
          title: 'KAAE Announcement',
          urls: {
            edit_url: 'https://www.canva.com/design/DAF_test_1/edit',
            view_url: 'https://www.canva.com/design/DAF_test_1/view',
          },
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      }),
    });

    const client = new CanvaConnectClient({
      apiKey: 'canva_live_key_entropy_12345',
      customFetch: mockFetch as any,
    });

    expect(client.isConfigured()).toBe(true);
    const design = await client.createDesign({ title: 'KAAE Announcement' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, req] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.canva.com/rest/v1/designs');
    expect(req.headers['Authorization']).toBe('Bearer canva_live_key_entropy_12345');
    expect(design.design.id).toBe('DAF_test_1');
  });

  it('exchanges explicit PKCE authorization then creates an export job', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.endsWith('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'oauth_token_abc_999',
            expires_in: 3600,
          }),
        };
      }
      if (url.endsWith('/exports')) {
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'exp_job_456',
              status: 'in_progress',
            },
          }),
        };
      }
      if (url.includes('/exports/exp_job_456')) {
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'exp_job_456',
              status: 'success',
              urls: ['https://export.canva.com/artifacts/design_master.png'],
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new CanvaConnectClient({
      clientId: 'canva_client_id_001',
      clientSecret: 'canva_client_sec_002',
      customFetch: mockFetch as any,
    });

    expect(client.isConfigured()).toBe(true);

    await client.exchangeAuthorizationCode({ code: 'authorized-code', codeVerifier: 'test-verifier', redirectUri: 'https://hawa.test/oauth/callback' });
    const exportJob = await client.createExportJob('DAF_test_1', 'png');
    expect(exportJob.job.id).toBe('exp_job_456');

    const urls = await client.pollExportUntilComplete('exp_job_456', { intervalMs: 10, maxAttempts: 5 });
    expect(urls).toEqual(['https://export.canva.com/artifacts/design_master.png']);
    expect(callCount).toBe(3); // token + export create + export poll
  });

  it('rejects with error if Canva export job fails', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'tok_1', expires_in: 3600 }),
        };
      }
      if (url.includes('/exports/exp_job_fail')) {
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'exp_job_fail',
              status: 'failed',
              error: { code: 'EXPORT_FAILED', message: 'Rasterizer out of memory' },
            },
          }),
        };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const client = new CanvaConnectClient({
      apiKey: 'direct_key',
      customFetch: mockFetch as any,
    });

    await expect(
      client.pollExportUntilComplete('exp_job_fail', { intervalMs: 10, maxAttempts: 3 })
    ).rejects.toThrow('Canva export job failed');
  });

  it('generates compliant PKCE authorization URL with S256 challenge', () => {
    const client = new CanvaConnectClient({
      clientId: 'test_client_id_pkce',
      clientSecret: 'test_client_sec_pkce',
    });

    const pkce = client.generatePkceAuthorization({
      redirectUri: 'https://hawa.design/oauth/callback',
      scopes: ['design:content:read', 'design:content:write'],
      state: 'session_state_123',
    });

    expect(pkce.codeVerifier).toBeDefined();
    expect(pkce.codeChallenge).toBeDefined();
    expect(pkce.authorizationUrl).toContain('https://www.canva.com/api/oauth/authorize');
    expect(pkce.authorizationUrl).toContain('response_type=code');
    expect(pkce.authorizationUrl).toContain('code_challenge_method=S256');
    expect(pkce.authorizationUrl).toContain(`code_challenge=${pkce.codeChallenge}`);
  });

  it('exchanges PKCE authorization code and serializes token refresh', async () => {
    const tokenCalls: any[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      if (url.endsWith('/oauth/token')) {
        const body = new URLSearchParams(init.body);
        tokenCalls.push(Object.fromEntries(body.entries()));
        if (body.get('grant_type') === 'authorization_code') {
          return {
            ok: true,
            json: async () => ({
              access_token: 'acc_token_v1',
              refresh_token: 'ref_token_v1',
              expires_in: 3600,
            }),
          };
        }
        if (body.get('grant_type') === 'refresh_token') {
          return {
            ok: true,
            json: async () => ({
              access_token: 'acc_token_v2_refreshed',
              refresh_token: 'ref_token_v2',
              expires_in: 3600,
            }),
          };
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new CanvaConnectClient({
      clientId: 'canva_id_test',
      clientSecret: 'canva_sec_test',
      customFetch: mockFetch as any,
    });

    const tokens = await client.exchangeAuthorizationCode({
      code: 'auth_code_123',
      codeVerifier: 'verifier_abc_456',
      redirectUri: 'https://hawa.design/oauth/callback',
    });

    expect(tokens.access_token).toBe('acc_token_v1');
    expect(tokens.refresh_token).toBe('ref_token_v1');

    // Concurrent refresh calls are serialized
    const [r1, r2] = await Promise.all([
      client.refreshAccessToken(),
      client.refreshAccessToken(),
    ]);

    expect(r1.access_token).toBe('acc_token_v2_refreshed');
    expect(r2.access_token).toBe('acc_token_v2_refreshed');
    // Token refresh endpoint called exactly once due to serialized promise
    const refreshCalls = tokenCalls.filter((c) => c.grant_type === 'refresh_token');
    expect(refreshCalls.length).toBe(1);
  });
});

describe('Canva OAuth admission', () => {
  it('never attempts the unsupported client_credentials grant', async () => {
    const transport = vi.fn();
    const client = new CanvaConnectClient({ clientId: 'id', clientSecret: 'secret', customFetch: transport });
    await expect(client.getDesign('DAexample')).rejects.toThrow('PKCE');
    expect(transport).not.toHaveBeenCalled();
  });
});
