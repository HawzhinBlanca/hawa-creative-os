/** ADR256: authentication only. A member still needs a Hawa customer/client grant. */
export const HAWZHIN_AUTH_ORIGIN = 'https://bpqpexwekalrfrodjidn.supabase.co';

export type WorkspaceMember = Readonly<{
  kind: 'workspace_member';
  issuer: typeof HAWZHIN_AUTH_ORIGIN;
  subject: string;
}>;

export class WorkspaceAccessError extends Error {
  constructor(public readonly status: 401 | 403 | 503, public readonly code:
    'WORKSPACE_SIGN_IN_REQUIRED' | 'WORKSPACE_ACCESS_DENIED' | 'WORKSPACE_ACCESS_UNAVAILABLE') {
    super(code);
    this.name = 'WorkspaceAccessError';
  }
}

function unavailable(): WorkspaceAccessError {
  return new WorkspaceAccessError(503, 'WORKSPACE_ACCESS_UNAVAILABLE');
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32_768) throw unavailable();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw unavailable();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function permittedPublishableKey(key: string): boolean {
  if (/^sb_publishable_[a-zA-Z0-9_-]{12,}$/.test(key)) return true;
  // Legacy anon keys are supported; inspecting this configuration is NOT user JWT verification.
  const parts = key.split('.');
  if (parts.length !== 3 || key.length > 16_384) return false;
  try { return (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: string }).role === 'anon'; }
  catch { return false; }
}

/** No caller-supplied URL, service key, role, client, identity, or office fallback. */
export function createWorkspaceMemberVerifier(options: {
  publishableKey: string;
  fetcher?: typeof fetch;
}): (authorization: string | undefined) => Promise<WorkspaceMember> {
  if (!permittedPublishableKey(options.publishableKey)) {
    throw new Error('Workspace authentication requires its publishable or legacy anon key');
  }
  const transport = options.fetcher ?? fetch;
  return async authorization => {
    if (!authorization || authorization.length > 16_384 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) {
      throw new WorkspaceAccessError(401, 'WORKSPACE_SIGN_IN_REQUIRED');
    }
    // One deadline covers both reads. A dependency outage is not a revoked membership.
    const signal = AbortSignal.timeout(8_000);
    const headers = { Authorization: authorization, apikey: options.publishableKey };
    async function request(path: string, init: RequestInit): Promise<Response> {
      try {
        const response = await transport(HAWZHIN_AUTH_ORIGIN + path, {
          ...init, signal, redirect: 'error', headers: { ...headers, ...init.headers },
        });
        if (response.status === 401) {
          await response.body?.cancel();
          throw new WorkspaceAccessError(401, 'WORKSPACE_SIGN_IN_REQUIRED');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw unavailable();
        }
        return response;
      } catch (error) {
        if (error instanceof WorkspaceAccessError) throw error;
        throw unavailable();
      }
    }
    // Server verification, not getSession(), JWT decoding or browser-supplied profile metadata.
    const user = await boundedJson(await request('/auth/v1/user', { method: 'GET' }));
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw unavailable();
    const record = user as Record<string, unknown>;
    if (typeof record.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id) ||
      record.role !== 'authenticated' || record.aud !== 'authenticated' || record.is_anonymous === true) {
      throw new WorkspaceAccessError(401, 'WORKSPACE_SIGN_IN_REQUIRED');
    }
    const allowed = await boundedJson(await request('/rest/v1/rpc/has_app_access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _user_id: record.id }),
    }));
    if (allowed === false) throw new WorkspaceAccessError(403, 'WORKSPACE_ACCESS_DENIED');
    if (allowed !== true) throw unavailable();
    return Object.freeze({ kind: 'workspace_member', issuer: HAWZHIN_AUTH_ORIGIN, subject: record.id });
  };
}
