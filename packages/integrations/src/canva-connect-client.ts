export interface CanvaConnectClientOptions {
  /** Existing OAuth bearer token; this is not a Canva API-key grant. */
  accessToken?: string;
  refreshToken?: string;
  /** @deprecated Use accessToken. */
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  customFetch?: typeof fetch;
  /** Waits between attempts of a status read (GET) that failed with 429, 5xx or a network error. */
  readRetryDelaysMs?: number[];
}

export interface CanvaDesignResponse {
  design: {
    id: string;
    title?: string;
    page_count?: number;
    owner?: { user_id: string; team_id: string };
    urls: {
      edit_url: string;
      view_url: string;
    };
    created_at: number;
    updated_at: number;
  };
}

export interface CanvaExportJobResponse {
  job: {
    id: string;
    status: 'in_progress' | 'success' | 'failed';
    urls?: string[];
    error?: {
      code: string;
      message: string;
    };
  };
}

export interface CreateDesignParams {
  title: string;
  assetId?: string;
  designType?: { type: 'custom'; width: number; height: number } | {
    type: 'preset';
    name: 'social_media' | 'presentation' | 'doc' | 'whiteboard';
  };
}

export class CanvaNotConfiguredError extends Error {
  readonly code = 'CANVA_NOT_CONFIGURED';

  constructor(message = 'Canva Connect API credentials are not configured in environment (CANVA_API_KEY, CANVA_CLIENT_ID, CANVA_CLIENT_SECRET).') {
    super(message);
    this.name = 'CanvaNotConfiguredError';
  }
}

/**
 * Authentic Canva Connect REST API client (CV-22, R01, Phase 3).
 * Connects to official Canva Connect Cloud API (https://api.canva.com/rest/v1).
 * Fails closed with typed CANVA_NOT_CONFIGURED if environment credentials are absent.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface CanvaTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

export class CanvaConnectClient {
  private readonly apiKey?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly readRetryDelaysMs: number[];
  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiresAt = 0;
  private refreshPromise: Promise<CanvaTokenResponse> | null = null;

  constructor(options: CanvaConnectClientOptions = {}) {
    this.refreshToken = options.refreshToken;
    if (options.accessToken) {
      this.accessToken = options.accessToken;
      this.tokenExpiresAt = Date.now() + 3600 * 1000;
    }
    this.apiKey = options.apiKey || (!options.accessToken ? process.env.CANVA_ACCESS_TOKEN : undefined);
    this.clientId = options.clientId || process.env.CANVA_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.CANVA_CLIENT_SECRET;
    this.baseUrl = options.baseUrl || process.env.CANVA_BASE_URL || 'https://api.canva.com/rest/v1';
    const transport = options.customFetch || globalThis.fetch;
    this.fetcher = (input, init) => transport(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) });
    this.readRetryDelaysMs = options.readRetryDelaysMs ?? [1000, 3000];
  }

  /**
   * A status read is safe to repeat, so a transient failure is asked again rather than failing the
   * design: one HTTP 500 from GET /imports/{id} failed task e8da3cec (2026-09-18) although Canva had
   * finished the import. Retries 429, 5xx and network errors; anything else returns at once.
   */
  private async readWithRetry(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.readRetryDelaysMs.length;
      try {
        const res = await this.fetcher(url, { method: 'GET', headers: { Authorization: await this.getAuthHeader() } });
        if (res.ok || !(res.status === 429 || res.status >= 500) || last) return res;
      } catch (err) {
        if (last) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, this.readRetryDelaysMs[attempt]));
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.accessToken || this.apiKey || (this.clientId && this.clientSecret));
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new CanvaNotConfiguredError();
    }
  }

  /**
   * Generates a standard PKCE authorization URL and code verifier for Canva Connect OAuth2
   */
  public generatePkceAuthorization(options: {
    redirectUri: string;
    scopes?: string[];
    state?: string;
  }): { authorizationUrl: string; codeVerifier: string; codeChallenge: string; state: string } {
    if (!this.clientId || !this.clientSecret) throw new CanvaNotConfiguredError('Configure the Canva OAuth integration before authorization');
    const verifierBytes = randomBytes(32);
    const codeVerifier = verifierBytes.toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = options.state || randomBytes(16).toString('hex');
    const scopeStr = (options.scopes || ['design:meta:read', 'design:content:read', 'design:content:write']).join(' ');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId || '',
      redirect_uri: options.redirectUri,
      scope: scopeStr,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return {
      authorizationUrl: `https://www.canva.com/api/oauth/authorize?${params.toString()}`,
      codeVerifier,
      codeChallenge,
      state,
    };
  }

  /**
   * Exchanges an authorization code + PKCE codeVerifier for access and refresh tokens
   */
  public async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<CanvaTokenResponse> {
    this.assertConfigured();
    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
      code: params.code,
      redirect_uri: params.redirectUri,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (this.clientId && this.clientSecret) {
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    }

    const res = await this.fetcher(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers,
      body: bodyParams.toString(),
    });

    if (!res.ok) {
      throw new Error(`Canva PKCE authorization code exchange failed (HTTP ${res.status})`);
    }

    const data = this.validateTokens(await res.json());
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return data;
  }

  /**
   * Serialized refresh rotation: ensures only one token refresh runs at a time
   */
  public async refreshAccessToken(): Promise<CanvaTokenResponse> {
    this.assertConfigured();
    if (!this.refreshToken) {
      throw new Error('Cannot refresh Canva token: no refresh_token available');
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const bodyParams = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken!,
        });

        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        if (this.clientId && this.clientSecret) {
          const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
          headers['Authorization'] = `Basic ${basicAuth}`;
        }

        const res = await this.fetcher(`${this.baseUrl}/oauth/token`, {
          method: 'POST',
          headers,
          body: bodyParams.toString(),
        });

        if (!res.ok) {
              throw new Error(`Canva token refresh failed (HTTP ${res.status})`);
        }

        const data = this.validateTokens(await res.json());
        this.accessToken = data.access_token;
        if (data.refresh_token) {
          this.refreshToken = data.refresh_token;
        }
        this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        return data;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Revokes an existing access or refresh token
   */
  public async revokeToken(tokenToRevoke?: string): Promise<void> {
    const targetToken = tokenToRevoke || this.accessToken || this.refreshToken;
    if (!targetToken) return;

    const bodyParams = new URLSearchParams({
      token: targetToken,
    });

    if (!this.clientId || !this.clientSecret) throw new CanvaNotConfiguredError('Canva OAuth client is required for revocation');
    const res = await this.fetcher(`${this.baseUrl}/oauth/revoke`, {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      }, body: bodyParams.toString(),
    });
    if (!res.ok) throw new Error(`Canva token revocation failed (HTTP ${res.status})`);

    if (targetToken === this.accessToken) {
      this.accessToken = undefined;
      this.tokenExpiresAt = 0;
    }
    if (targetToken === this.refreshToken) {
      this.refreshToken = undefined;
    }
  }

  private validateTokens(value: any): CanvaTokenResponse {
    if (typeof value?.access_token !== 'string' || !value.access_token ||
        !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
        (value.refresh_token !== undefined && typeof value.refresh_token !== 'string')) {
      throw new Error('Invalid Canva token response');
    }
    return value;
  }

  private async getAuthHeader(): Promise<string> {
    this.assertConfigured();

    // 1. Use active OAuth access token if unexpired
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return `Bearer ${this.accessToken}`;
    }

    // 2. If refresh token exists, rotate via serialized refresh
    if (this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      return `Bearer ${refreshed.access_token}`;
    }

    // 3. Use active access token even if close to expiry if no refresh token exists
    if (this.accessToken) {
      return `Bearer ${this.accessToken}`;
    }

    // 4. Fall back to static API key if configured
    if (this.apiKey) {
      return `Bearer ${this.apiKey}`;
    }

    throw new CanvaNotConfiguredError('Canva user authorization is required: complete Authorization Code with PKCE before making API calls');
  }

  public async createDesign(params: CreateDesignParams): Promise<CanvaDesignResponse> {
    const authHeader = await this.getAuthHeader();
    const payload: Record<string, any> = {
      title: params.title,
    };

    if (params.assetId) {
      payload.asset_id = params.assetId;
    }
    if (params.designType) {
      payload.design_type = params.designType;
    }

    const res = await this.fetcher(`${this.baseUrl}/designs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Canva createDesign failed (HTTP ${res.status})`);
    }

    return validateCanvaDesignResponse(await res.json());
  }

  public async getDesign(designId: string): Promise<CanvaDesignResponse> {
    const res = await this.readWithRetry(`${this.baseUrl}/designs/${encodeURIComponent(designId)}`);

    if (!res.ok) {
      throw new Error(`Canva getDesign failed (HTTP ${res.status})`);
    }

    return validateCanvaDesignResponse(await res.json());
  }

  public async createImportJob(bytes: Uint8Array, title: string) {
    if (bytes.byteLength < 32 || bytes.byteLength > 25 * 1024 * 1024) throw new Error('Import must be between 32 bytes and 25 MiB');
    const response = await this.fetcher(`${this.baseUrl}/imports`, { method: 'POST', headers: {
      Authorization: await this.getAuthHeader(), 'Content-Type': 'application/octet-stream',
      'Import-Metadata': JSON.stringify({ title_base64: Buffer.from(title.slice(0, 50)).toString('base64'),
        mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
    }, body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error(`Canva import failed (HTTP ${response.status})`);
    return this.validateImport(await response.json());
  }

  public async getImportJob(id: string) {
    const response = await this.readWithRetry(`${this.baseUrl}/imports/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Canva import status failed (HTTP ${response.status})`);
    return this.validateImport(await response.json());
  }

  private validateImport(value: any): { job: { id: string; status: 'in_progress' | 'success' | 'failed'; result?: { designs: Array<{ id: string; urls: { edit_url: string; view_url: string } }> }; error?: { code: string } } } {
    if (!value?.job?.id || !['in_progress','success','failed'].includes(value.job.status)) throw new Error('Invalid Canva import response');
    if (value.job.status === 'success' && (!Array.isArray(value.job.result?.designs) || !value.job.result.designs.length ||
      value.job.result.designs.some((d: any) => !/^DA[A-Za-z0-9_-]+$/.test(d.id)))) throw new Error('Invalid imported design identifiers');
    return value;
  }

  public async createExportJob(designId: string, format: 'png' | 'pdf' | 'pptx' = 'png'): Promise<CanvaExportJobResponse> {
    const authHeader = await this.getAuthHeader();
    const formatSpec = format === 'png' ? { type: 'png', lossless: true } : {type:format}; 

    const res = await this.fetcher(`${this.baseUrl}/exports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({
        design_id: designId,
        format: formatSpec,
      }),
    });

    if (!res.ok) {
      throw new Error(`Canva createExportJob failed (HTTP ${res.status})`);
    }

    return validateCanvaExportJob(await res.json());
  }

  public async getExportJob(exportId: string): Promise<CanvaExportJobResponse> {
    const res = await this.readWithRetry(`${this.baseUrl}/exports/${encodeURIComponent(exportId)}`);

    if (!res.ok) {
      throw new Error(`Canva getExportJob failed (HTTP ${res.status})`);
    }

    return validateCanvaExportJob(await res.json());
  }

  public async pollExportUntilComplete(
    exportId: string,
    options: { maxAttempts?: number; intervalMs?: number } = {}
  ): Promise<string[]> {
    const maxAttempts = options.maxAttempts ?? 20;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('Invalid export polling limit');
    const intervalMs = options.intervalMs ?? 500;
    if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 30000) throw new Error('Invalid export polling interval');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const status = await this.getExportJob(exportId);
      if (status.job.status === 'success' && status.job.urls && status.job.urls.length > 0) {
        return status.job.urls;
      }
      if (status.job.status === 'failed') {
        const detail = status.job.error?.code ? ` [${status.job.error.code}]: ${status.job.error.message || ''}` : '';
        throw new Error(`Canva export job failed${detail}`);
      }
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Canva export job ${exportId} timed out after ${maxAttempts} attempts`);
  }
}

/** Provider links may be opaque. Never use this parser to infer a user-supplied design ID. */
export function validateCanvaProviderLink(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Invalid provider editor URL: expected a valid URL string');
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error('Invalid provider editor URL: malformed URL');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.canva.com' || u.port || u.username || u.password ||
      !/^\/(?:api\/design|design|d)\//.test(u.pathname)) throw new Error('Invalid provider editor URL');
  return u.href;
}
export function validateCanvaDesignResponse(value: any): CanvaDesignResponse {
  const d = value?.design;
  if (!d || !/^[A-Za-z0-9_-]+$/.test(d.id) || typeof d.id !== 'string' ||
      !Number.isSafeInteger(d.updated_at) || !Number.isSafeInteger(d.created_at)) throw new Error('Invalid Canva design response');
  validateCanvaProviderLink(d.urls?.edit_url);
  validateCanvaProviderLink(d.urls?.view_url);
  return value;
}
export function validateCanvaExportJob(value: any): CanvaExportJobResponse {
  const j = value?.job;
  if (!j || typeof j.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(j.id) ||
      !['in_progress','success','failed'].includes(j.status) ||
      (j.status === 'success' && (!Array.isArray(j.urls) || !j.urls.length || j.urls.some((u: unknown) => typeof u !== 'string')))) {
    throw new Error('Invalid Canva export job response');
  }
  return value;
}
