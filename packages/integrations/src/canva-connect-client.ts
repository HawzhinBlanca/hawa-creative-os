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
  /**
   * Waits between attempts of a create call (POST /exports, /imports, /designs) that Canva refused
   * for the moment. Which failures are repeated depends on the call: see `createWithRetry`.
   */
  createRetryDelaysMs?: number[];
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

export interface CanvaCapabilitiesResponse { capabilities: string[] }
export interface CanvaDesignDatasetResponse {
  dataset: Record<string, {type:'text'|'image'|'chart'|'sheet'}>;
}

export interface CanvaTextAutofillCopyParams {
  designId: string;
  title: string;
  text: Record<string, string>;
  /** The caller must read this from the same source immediately before admission. */
  dataset: CanvaDesignDatasetResponse['dataset'];
}

export interface CanvaTextAutofillCopyResponse {
  job:
    | { id: string; status: 'in_progress' }
    | { id: string; status: 'failed'; error?: { code: string } }
    | { id: string; status: 'success'; result: { type: 'create_design'; design: CanvaDesignResponse['design'] } };
}

const CANVA_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function providerRecord(value:unknown):value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value);
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
 * Canva answered with an HTTP error. Definite refusal can permit retry; a 5xx may follow an
 * accepted effect and is still uncertain. Callers must classify the status, not only this class.
 * A transport failure (no answer at all) is a plain Error and may have been acted on. Callers tell
 * the two apart by this class (2026-09-24): a 429 on POST /exports used to be recorded as an
 * uncertain export that blocked the format for good. `oauthError` is the token endpoint's `error`.
 * `retryAfterMs` is the wait Canva asked for on a 429 the client gave up on, when it named one: the
 * caller waits that long (durably) before sending the same request again.
 */
export class CanvaHttpError extends Error {
  constructor(message: string, readonly status: number, readonly oauthError?: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'CanvaHttpError';
  }
}

/** Network errors raised before a connection to Canva existed: the request never left. */
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** Whether a failed fetch certainly never reached Canva (so Canva cannot have acted on it). */
export function canvaRequestNeverSent(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && PRE_SEND_CODES.has(code);
}
/** The longest Retry-After the client waits for. Asked to wait longer, it reports the 429 instead. */
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * Retry-After in milliseconds (delta-seconds or an HTTP date), or null when absent or unreadable.
 * Test doubles may hand back a bare object with no headers, so a missing `headers` is allowed.
 */
function retryAfterMs(res: Response): number | null {
  const value = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
/**
 * How long to wait before the next attempt: Canva's Retry-After when it sent one, otherwise the
 * backoff step. Null means do not try again (Canva asked for a longer wait than the bound).
 */
function nextWaitMs(res: Response | null, backoffMs: number): number | null {
  const asked = res ? retryAfterMs(res) : null;
  if (asked === null) return backoffMs;
  return asked > MAX_RETRY_AFTER_MS ? null : asked;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A create call Canva refused, as an error; a 429 carries the wait Canva asked for. */
function createRefused(what: string, res: Response): CanvaHttpError {
  const asked = res.status === 429 ? retryAfterMs(res) : null;
  return new CanvaHttpError(`Canva ${what} failed (HTTP ${res.status})`, res.status, undefined, asked ?? undefined);
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
  private readonly createRetryDelaysMs: number[];
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
    // Five attempts over about 15 s: the chaos suite's R1.K9 (three 503s and a 429) is answered on
    // the fifth. Canva's export limit is 20 requests a minute per user, so this stays under it.
    this.createRetryDelaysMs = options.createRetryDelaysMs ?? [1000, 2000, 4000, 8000];
  }

  /**
   * A status read is safe to repeat, so a transient failure is asked again rather than failing the
   * design: one HTTP 500 from GET /imports/{id} failed task e8da3cec (2026-09-18) although Canva had
   * finished the import. Retries 429, 5xx and network errors; anything else returns at once.
   */
  private async readWithRetry(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.readRetryDelaysMs.length;
      let wait = this.readRetryDelaysMs[attempt];
      try {
        const res = await this.fetcher(url, { method: 'GET', headers: { Authorization: await this.getAuthHeader() } });
        if (res.ok || !(res.status === 429 || res.status >= 500) || last) return res;
        const asked = nextWaitMs(res, wait);
        if (asked === null) return res;
        wait = asked;
      } catch (err) {
        if (last) throw err;
      }
      await sleep(wait);
    }
  }

  /**
   * A create call Canva refused for the moment is asked again, within a bound, before the design
   * is failed: one 503 on POST /exports ended a draft as CANVA_PREVIEW_FAILED (chaos R1.K9,
   * 2026-09-24). Canva documents no idempotency key for any create call, so a repeat is a second
   * request, and what may be repeated depends on what a duplicate would cost:
   *  - Every call: a 429 (Canva's rate limit refuses before acting, and says how long to wait in
   *    Retry-After) and a network error raised before the request left.
   *  - `repeatServerErrors` (POST /exports only): a 5xx too. A 5xx carries no job id and may come
   *    from a gateway after Canva made the job, but an export job only reads the design; a duplicate
   *    is a file nobody fetches, and Canva's error guide says to retry internal_error after a delay.
   *    An import or a new design is a design in the owner's Canva account, so a 5xx there is not
   *    repeated: the caller records it and reconciles.
   * A connection lost after the request was sent is never repeated here; the caller records it as
   * uncertain.
   */
  private async createWithRetry(url: string, init: () => Promise<RequestInit>, repeatServerErrors: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.createRetryDelaysMs.length;
      let wait = this.createRetryDelaysMs[attempt];
      try {
        const res = await this.fetcher(url, await init());
        const transient = res.status === 429 || (repeatServerErrors && res.status >= 500);
        if (res.ok || !transient || last) return res;
        const asked = nextWaitMs(res, wait);
        if (asked === null) return res;
        wait = asked;
      } catch (err) {
        if (last || !canvaRequestNeverSent(err)) throw err;
      }
      await sleep(wait);
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
          // The OAuth error says whether the refresh token itself was refused (invalid_grant).
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          const oauthError = typeof body?.error === 'string' ? body.error : undefined;
          throw new CanvaHttpError(`Canva token refresh failed (HTTP ${res.status})`, res.status, oauthError);
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
    this.assertConfigured();
    const payload: Record<string, any> = {
      title: params.title,
    };

    if (params.assetId) {
      payload.asset_id = params.assetId;
    }
    if (params.designType) {
      payload.design_type = params.designType;
    }

    const res = await this.createWithRetry(`${this.baseUrl}/designs`, async () => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await this.getAuthHeader(),
      },
      body: JSON.stringify(payload),
    }), false);

    if (!res.ok) {
      throw createRefused('createDesign', res);
    }

    return validateCanvaDesignResponse(await res.json());
  }

  public async getDesign(designId: string): Promise<CanvaDesignResponse> {
    const res = await this.readWithRetry(`${this.baseUrl}/designs/${encodeURIComponent(designId)}`);

    if (!res.ok) {
      throw new CanvaHttpError(`Canva getDesign failed (HTTP ${res.status})`, res.status);
    }

    return validateCanvaDesignResponse(await res.json());
  }

  /** Account observation is distinct from operation qualification or a subscription inference. */
  public async getCapabilities():Promise<CanvaCapabilitiesResponse> {
    const res=await this.readWithRetry(`${this.baseUrl}/users/me/capabilities`);
    if(!res.ok)throw new CanvaHttpError(`Canva capabilities failed (HTTP ${res.status})`,res.status);
    const body:unknown=await res.json();
    if(!providerRecord(body) || (body.capabilities!==undefined && (!Array.isArray(body.capabilities) ||
      body.capabilities.length>100 || body.capabilities.some(v=>typeof v!=='string' || !/^[a-z][a-z0-9_]{0,99}$/.test(v)))))
      throw new Error('Invalid Canva capabilities response');
    return {capabilities:[...new Set((body.capabilities??[]) as string[])]};
  }

  /** Exact names/types must be read before constructing any autofill request; unknown names are skipped remotely. */
  public async getDesignDataset(designId:string):Promise<CanvaDesignDatasetResponse> {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(designId))throw new Error('Invalid Canva design ID');
    const res=await this.readWithRetry(`${this.baseUrl}/designs/${encodeURIComponent(designId)}/dataset`);
    if(!res.ok)throw new CanvaHttpError(`Canva dataset failed (HTTP ${res.status})`,res.status);
    const body:unknown=await res.json();
    if(!providerRecord(body) || (body.dataset!==undefined && !providerRecord(body.dataset)))throw new Error('Invalid Canva dataset response');
    const entries=Object.entries(body.dataset??{});
    if(entries.length>512)throw new Error('Invalid Canva dataset size');
    const dataset:CanvaDesignDatasetResponse['dataset']=Object.fromEntries(entries.map(([name,value])=>{
      if(!name || name.length>1024 || !providerRecord(value) || typeof value.type!=='string' || !['text','image','chart','sheet'].includes(value.type))
        throw new Error('Invalid Canva dataset field');
      return [name,{type:value.type as 'text'|'image'|'chart'|'sheet'}];
    }));
    return {dataset};
  }

  /**
   * Copy only. A durable caller claim is required before dispatch; a lost/malformed reply or
   * 5xx cannot authorize a new POST. A successful job still needs native postcondition checks.
   */
  public async createTextAutofillCopy(input: CanvaTextAutofillCopyParams): Promise<CanvaTextAutofillCopyResponse> {
    const { body, sourceId } = prepareCanvaTextAutofillCopy(input);
    this.assertConfigured();
    const response = await this.createWithRetry(`${this.baseUrl}/autofills`, async () => ({
      method: 'POST', headers: { Authorization: await this.getAuthHeader(), 'Content-Type': 'application/json' }, body,
    }), false);
    if (!response.ok) throw new CanvaHttpError(`Canva autofill copy failed (HTTP ${response.status})`, response.status);
    return validateTextAutofillCopy(await response.json(), sourceId);
  }

  public async getTextAutofillCopyJob(jobId: string, sourceDesignId: string): Promise<CanvaTextAutofillCopyResponse> {
    if (typeof jobId !== 'string' || !CANVA_IDENTIFIER.test(jobId) ||
        typeof sourceDesignId !== 'string' || !CANVA_IDENTIFIER.test(sourceDesignId)) {
      throw new Error('Invalid Canva autofill identifier');
    }
    const response = await this.readWithRetry(`${this.baseUrl}/autofills/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new CanvaHttpError(`Canva autofill status failed (HTTP ${response.status})`, response.status);
    return validateTextAutofillCopy(await response.json(), sourceDesignId, jobId);
  }

  public async createImportJob(bytes: Uint8Array, title: string) {
    if (bytes.byteLength < 32 || bytes.byteLength > 25 * 1024 * 1024) throw new Error('Import must be between 32 bytes and 25 MiB');
    this.assertConfigured();
    const response = await this.createWithRetry(`${this.baseUrl}/imports`, async () => ({ method: 'POST', headers: {
      Authorization: await this.getAuthHeader(), 'Content-Type': 'application/octet-stream',
      'Import-Metadata': JSON.stringify({ title_base64: Buffer.from(title.slice(0, 50)).toString('base64'),
        mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
    }, body: new Uint8Array(bytes) }), false);
    if (!response.ok) throw createRefused('import', response);
    return this.validateImport(await response.json());
  }

  public async getImportJob(id: string) {
    const response = await this.readWithRetry(`${this.baseUrl}/imports/${encodeURIComponent(id)}`);
    if (!response.ok) throw new CanvaHttpError(`Canva import status failed (HTTP ${response.status})`, response.status);
    return this.validateImport(await response.json());
  }

  private validateImport(value: any): { job: { id: string; status: 'in_progress' | 'success' | 'failed'; result?: { designs: Array<{ id: string; urls: { edit_url: string; view_url: string } }> }; error?: { code: string } } } {
    if (!value?.job?.id || !['in_progress','success','failed'].includes(value.job.status)) throw new Error('Invalid Canva import response');
    if (value.job.status === 'success' && (!Array.isArray(value.job.result?.designs) || !value.job.result.designs.length ||
      value.job.result.designs.some((d: any) => !/^DA[A-Za-z0-9_-]+$/.test(d.id)))) throw new Error('Invalid imported design identifiers');
    return value;
  }

  public async createExportJob(designId: string, format: 'png' | 'pdf' | 'pptx' = 'png'): Promise<CanvaExportJobResponse> {
    this.assertConfigured();
    const formatSpec = format === 'png' ? { type: 'png', lossless: true } : {type:format}; 

    const res = await this.createWithRetry(`${this.baseUrl}/exports`, async () => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await this.getAuthHeader(),
      },
      body: JSON.stringify({
        design_id: designId,
        format: formatSpec,
      }),
    }), true);

    if (!res.ok) {
      throw createRefused('createExportJob', res);
    }

    return validateCanvaExportJob(await res.json());
  }

  public async getExportJob(exportId: string): Promise<CanvaExportJobResponse> {
    const res = await this.readWithRetry(`${this.baseUrl}/exports/${encodeURIComponent(exportId)}`);

    if (!res.ok) {
      throw new CanvaHttpError(`Canva getExportJob failed (HTTP ${res.status})`, res.status);
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

/** Pure preparation also lets durable callers reject invalid requests before claiming a send. */
export function prepareCanvaTextAutofillCopy(input: CanvaTextAutofillCopyParams): { body: string; sourceId: string } {
  if (!input || typeof input.designId !== 'string' || !CANVA_IDENTIFIER.test(input.designId) ||
      typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 255 ||
      !providerRecord(input.text) || !providerRecord(input.dataset)) {
    throw new Error('Invalid Canva autofill input');
  }
  const entries = Object.entries(input.text);
  if (entries.length < 1 || entries.length > 32) throw new Error('Invalid Canva autofill field count');
  const data = Object.fromEntries(entries.map(([name, text]) => {
    if (!name || name.length > 1024 || typeof text !== 'string' || text.length > 16384) {
      throw new Error('Invalid Canva autofill text field');
    }
    if (!Object.hasOwn(input.dataset, name) || input.dataset[name]?.type !== 'text') {
      throw new Error('Canva autofill field is not an observed text field');
    }
    return [name, { type: 'text', text }];
  }));
  const sourceId = input.designId;
  const body = JSON.stringify({ type: 'create_from_design', design_id: sourceId, title: input.title, data });
  if (Buffer.byteLength(body, 'utf8') > 128 * 1024) throw new Error('Invalid Canva autofill payload size');
  return { body, sourceId };
}

/** Whitelist native job evidence; provider prose and unrecognized properties are not retained. */
function validateTextAutofillCopy(value: unknown, sourceId: string, expectedJobId?: string): CanvaTextAutofillCopyResponse {
  const job = providerRecord(value) ? value.job : undefined;
  if (!providerRecord(job) || typeof job.id !== 'string' || !CANVA_IDENTIFIER.test(job.id) ||
      (expectedJobId !== undefined && job.id !== expectedJobId)) throw new Error('Invalid Canva autofill job');
  const id = job.id;
  if (job.status !== 'success' && Object.hasOwn(job, 'result')) throw new Error('Invalid Canva autofill contradictory result');
  if (job.status === 'in_progress') return { job: { id, status: 'in_progress' } };
  if (job.status === 'failed') {
    if (job.error === undefined) return { job: { id, status: 'failed' } };
    if (!providerRecord(job.error) || typeof job.error.code !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(job.error.code)) {
      throw new Error('Invalid Canva autofill error code');
    }
    return { job: { id, status: 'failed', error: { code: job.error.code } } };
  }
  if (job.status !== 'success' || !providerRecord(job.result) || job.result.type !== 'create_design') {
    throw new Error('Invalid Canva autofill result');
  }
  try {
    const d = validateCanvaDesignResponse({ design: job.result.design }).design;
    if (!CANVA_IDENTIFIER.test(d.id) || d.id === sourceId || d.created_at < 0 || d.updated_at < 0 ||
        (d.title !== undefined && (typeof d.title !== 'string' || d.title.length > 255)) ||
        (d.page_count !== undefined && (!Number.isSafeInteger(d.page_count) || d.page_count < 1))) throw new Error('Invalid copy');
    const design: CanvaDesignResponse['design'] = {
      id: d.id, created_at: d.created_at, updated_at: d.updated_at,
      urls: { edit_url: d.urls.edit_url, view_url: d.urls.view_url },
      ...(d.title === undefined ? {} : { title: d.title }),
      ...(d.page_count === undefined ? {} : { page_count: d.page_count }),
    };
    return { job: { id, status: 'success', result: { type: 'create_design', design } } };
  } catch {
    throw new Error('Invalid Canva autofill copy metadata');
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
