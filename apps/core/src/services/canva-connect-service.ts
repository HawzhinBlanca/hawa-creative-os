import { assertTaskGenerationAllowed } from './task-generation-guard.js';
import { assertNativeRevisionAdmission, nativeRevisionHandoff } from './native-revision-handoff.js';
import { latestNativeCopy, nativeInitialHandoff } from './initial-native-handoff.js';
import { canRetryCanvaCreation } from '@hawa/domain';
import { CanvaFlowError } from './canva-flow-error.js';
import { inspectCanvaAmendment } from './canva-amendment-observation.js';
import { CanvaNativeCopyService, type NativeTextCopyRequest } from './canva-native-copy.js';
import { lockNativeRecovery, type NativeActorScope } from './lifecycle-native-scope.js';
import { resolveManualExportPolicy, type ExportCheckPolicy } from './canva-export-policy.js';
import { checkCanvaPdf, checkCanvaPptx } from '@hawa/qa';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, withRlsContext, withSessionAdvisoryLock, CanvaBindingRepository, type BlobStore, type Database, type Kysely } from '@hawa/db';
import { blobStoreFor, putToStore } from './blob-store-context.js';
import { CanvaConnectClient, CanvaCapturePipeline, CanvaHttpError, canvaRequestNeverSent } from '@hawa/integrations';

type Scope = NativeActorScope;
export type CanvaPublicationVersionCheck =
  | { ok: true; capturedVersion: string; observedVersion: string }
  | { ok: false; code: 'CANVA_CAPTURE_UNVERIFIED' | 'CANVA_DESIGN_CHANGED' | 'CANVA_DESIGN_CHECK_UNAVAILABLE'; message: string; retryable: boolean };
export { CanvaFlowError } from './canva-flow-error.js';
const fail = (status: number, code: string, message: string): never => { throw new CanvaFlowError(status, code, message); };
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
/**
 * The roles that act on another actor's Canva work for the same task: the studio's resume and abandon
 * allow the same two. The import override checked for 'admin', a role no principal has (2026-09-24).
 */
const OVERRIDE_ROLES = ['administrator', 'art_director'];
const overrides = (s: Scope) => OVERRIDE_ROLES.includes(s.role || '');
/**
 * A failed create call that certainly created nothing: Canva refused it with a 4xx, or the request
 * never left. A 429 on POST /exports was recorded as uncertain and then blocked every later export
 * of the format with CANVA_EXPORT_PENDING (2026-09-24).
 * A 5xx is different: it may come from a gateway after Canva made the job, the same reasoning the
 * client uses when it declines to repeat one. On an export that does not matter (a duplicate job only
 * reads the design), so `serverErrorCreatedNothing` says so there; on an import it would be a second
 * design in the owner's account, so a 5xx leaves the import uncertain for reconciliation.
 * Imports told the operator "nothing was created, and it may be sent again" on a 5xx until 2026-09-24.
 */
const createdNothing = (err: unknown, serverErrorCreatedNothing: boolean) =>
  canvaRequestNeverSent(err) || (err instanceof CanvaHttpError && (err.status < 500 || serverErrorCreatedNothing));
/**
 * Canva still refusing a create call with 429 after the client's short retry, or asking for a longer
 * wait than the client keeps (30 s). Canva's rate limit refuses before acting, so nothing was created
 * and the same request may be sent again. Such a refusal was recorded as failed and ended the draft
 * (DESIGN_FAILED, CANVA_PREVIEW_FAILED) until 2026-09-28, although every automatic draft goes through
 * the office's one connection and Canva allows 20 imports and 20 exports a minute per user (ADR-132).
 * The operation is now marked failed with `rateLimited`, which lets the same key send it again, and
 * Core answers 429 CANVA_RATE_LIMITED with Canva's wait, bounded to what the worker keeps (1 to 30 s),
 * or 30 s when Canva named none.
 */
const CANVA_RATE_LIMIT_MIN_WAIT_MS = 1000;
const CANVA_RATE_LIMIT_MAX_WAIT_MS = 30_000;
export const canvaRateLimitWaitMs = (askedMs: number | undefined): number =>
  Math.min(CANVA_RATE_LIMIT_MAX_WAIT_MS, Math.max(CANVA_RATE_LIMIT_MIN_WAIT_MS, askedMs ?? CANVA_RATE_LIMIT_MAX_WAIT_MS));
const canvaRateLimited = (err: unknown): err is CanvaHttpError => err instanceof CanvaHttpError && err.status === 429;
/** An operation Canva refused with 429: the only failed operation its own key may send again. */
const heldByRateLimit = (row: { status?: string; metadata?: { rateLimited?: unknown } | null } | undefined) =>
  row?.status === 'failed' && row.metadata?.rateLimited === true;
/** A Canva connection row as the token refresh reads it. */
type ConnectionRow = { status: string; generation: string; encrypted_tokens: string; expires_at: Date; claimedRefresh?: boolean; refresh_abandoned?: boolean };
export class CanvaTokenCipher {
  private key: Buffer;
  constructor(hex: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('CANVA_TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    this.key = Buffer.from(hex, 'hex');
  }
  seal(value: unknown, scope: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(value: string, scope: string): any {
    const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0,12));
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(b.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString());
  }
}
export interface CanvaServiceOptions {
  clientId?: string; clientSecret?: string; redirectUri?: string; encryptionKey?: string;
  fetcher?: typeof fetch;
  /** Where editable sources are stored (ADR-035); HAWA_BLOB_DIR's when absent. */
  blobStore?: BlobStore | null;
  /**
   * The client's waits between attempts (packages/integrations canva-connect-client.ts): status reads,
   * and create calls Canva refused for the moment. Tests shorten them; production keeps the defaults.
   */
  retryDelaysMs?: { read?: number[]; create?: number[] };
}
/**
 * The immutable sent faces of a Studio or planner import, ordered by exact-copy identity.
 * Reference packs do not replace a complete per-block plan. Historical sources without a plan
 * retain their explicit reference-font policy; a declared ambiguous plan is refused by admission.
 */
export function studioSentBlocks(manifest: any): Array<{ fontFamily: string; role?: string }> | null {
  if (!manifest || !Array.isArray(manifest.copy) || !manifest.copy.length ||
      !manifest.copy.every((part: unknown) => typeof part === 'string') || !Array.isArray(manifest.plan?.text)) return null;
  const blocks = [...manifest.plan.text];
  if (blocks.length !== manifest.copy.length || blocks.some((t: any) => !t || typeof t !== 'object' ||
      Array.isArray(t) || !Number.isSafeInteger(t.copyIndex) || typeof t.fontFamily !== 'string' ||
      !t.fontFamily.trim() || (t.role !== undefined && typeof t.role !== 'string'))) return null;
  blocks.sort((a: any, b: any) => a.copyIndex - b.copyIndex);
  return blocks.every((t: any, index: number) => t.copyIndex === index) ? blocks : null;
}

/** Only explicit booleans on each uniquely indexed source block establish a direction. */
export function importedSourceDirections(manifest: { copy?: unknown; plan?: { text?: unknown } } | null): Array<'ltr' | 'rtl' | null> | undefined {
  if (!Array.isArray(manifest?.copy) || !Array.isArray(manifest.plan?.text)) return undefined;
  const blocks = manifest.plan.text as Array<{ copyIndex?: unknown; rtl?: unknown }>;
  if (blocks.length !== manifest.copy.length || blocks.some(block => !block || typeof block !== 'object')) return undefined;
  const ordered = [...blocks].sort((a, b) => Number(a.copyIndex) - Number(b.copyIndex));
  if (ordered.some((block, index) => block.copyIndex !== index)) return undefined;
  return ordered.map(block => block.rtl === true ? 'rtl' : block.rtl === false ? 'ltr' : null);
}

export class CanvaConnectService {
  private options: CanvaServiceOptions;
  constructor(private db: Kysely<Database>, options: CanvaServiceOptions = {}) {
    this.options = { clientId: process.env.CANVA_CLIENT_ID, clientSecret: process.env.CANVA_CLIENT_SECRET,
      redirectUri: process.env.CANVA_REDIRECT_URI, encryptionKey: process.env.CANVA_TOKEN_ENCRYPTION_KEY, ...options };
  }
  configuration() {
    const missing = Object.entries({ CANVA_CLIENT_ID: this.options.clientId, CANVA_CLIENT_SECRET: this.options.clientSecret,
      CANVA_REDIRECT_URI: this.options.redirectUri, CANVA_TOKEN_ENCRYPTION_KEY: this.options.encryptionKey }).filter(([,v]) => !v).map(([k]) => k);
    let valid = !missing.length;
    if (valid) { try { this.cipher(); this.redirect(); } catch { valid = false; } }
    return { configured: valid, missing, redirectUri: this.options.redirectUri || null };
  }
  private cipher() { return new CanvaTokenCipher(this.options.encryptionKey || ''); }
  private aad(s: Scope) { return `${s.tenantId}:${s.actorId}`; }
  redirect() {
    const u = new URL(this.options.redirectUri || '');
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) ||
        u.username || u.password || u.search || u.hash || u.pathname !== '/v1/integrations/canva/callback') throw new Error('Invalid configured Canva redirect URI');
    return u.href;
  }
  private client(token?: string, refreshToken?: string) {
    return new CanvaConnectClient({ clientId: this.options.clientId, clientSecret: this.options.clientSecret,
      accessToken: token, refreshToken, customFetch: this.options.fetcher,
      readRetryDelaysMs: this.options.retryDelaysMs?.read, createRetryDelaysMs: this.options.retryDelaysMs?.create });
  }
  private tx<T>(s: Scope, f: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return withRlsContext(this.db, { tenantId: s.tenantId, userId: s.actorId, role: s.role || 'operator' }, f);
  }
  async status(s: Scope) {
    const config = this.configuration();
    if (!config.configured) return { ...config, status: 'setup_required', authorized: false };
    const row = await this.tx(s, async db => (await sql<any>`SELECT status, expires_at FROM hawa.canva_connections WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db)).rows[0]);
    return { ...config, status: row?.status || 'authorization_required', authorized: row?.status === 'active',
      expiresAt: row?.expires_at || null, nativeComposition: false, semanticCapture: false, printQualified: false };
  }
  async startAuthorization(s: Scope) {
    if (!this.configuration().configured) fail(503, 'CANVA_SETUP_REQUIRED', 'Configure the Canva integration and encryption key first');
    const state = `${s.tenantId}.${randomBytes(32).toString('base64url')}`;
    const auth = this.client().generatePkceAuthorization({ redirectUri: this.redirect(), state });
    await this.tx(s, async db => {
      await sql`DELETE FROM hawa.canva_oauth_states WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db);
      await sql`INSERT INTO hawa.canva_oauth_states(state_hash,tenant_id,actor_id,encrypted_verifier,expires_at)
        VALUES (${hash(state)},${s.tenantId}::uuid,${s.actorId},${this.cipher().seal(auth.codeVerifier,this.aad(s))},now()+interval '10 minutes')`.execute(db);
    });
    return { authorizationUrl: auth.authorizationUrl, state };
  }
  async finishAuthorization(state: string, cookie: string, code: string) {
    if (!state || state !== cookie || !code || code.length > 4096 || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(state)) fail(400,'CANVA_OAUTH_STATE_INVALID','Authorization state is invalid or belongs to another browser');
    const tenantId = state.split('.')[0];
    const row = await this.tx({ tenantId, actorId: 'oauth_callback' }, async db => (await sql<any>`DELETE FROM hawa.canva_oauth_states
      WHERE tenant_id=${tenantId}::uuid AND state_hash=${hash(state)} AND expires_at > now() RETURNING *`.execute(db)).rows[0]);
    if (!row) fail(400,'CANVA_OAUTH_STATE_EXPIRED','Authorization expired or was already used; connect again');
    const scope = { tenantId, actorId: row.actor_id };
    const verifier = this.cipher().open(row.encrypted_verifier, this.aad(scope));
    const tokens = await this.client().exchangeAuthorizationCode({ code, codeVerifier: verifier, redirectUri: this.redirect() });
    if (!tokens.refresh_token) fail(502,'CANVA_REFRESH_TOKEN_MISSING','Canva did not return a refresh token; reconnect');
    await this.tx(scope, async db => {
      await sql`INSERT INTO hawa.canva_connections(tenant_id,actor_id,encrypted_tokens,expires_at,status,generation)
        VALUES (${tenantId}::uuid,${scope.actorId},${this.cipher().seal(tokens,this.aad(scope))},${new Date(Date.now()+tokens.expires_in*1000)},'active',${randomUUID()}::uuid)
        ON CONFLICT (tenant_id,actor_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,status='active',generation=excluded.generation,updated_at=now()`.execute(db);
    });
  }
  async disconnect(s: Scope) {
    const old=await this.tx(s,async db=>{
      const row=(await sql<any>`SELECT encrypted_tokens FROM hawa.canva_connections WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId} FOR UPDATE`.execute(db)).rows[0];
      if (!row) return null;
      await sql`UPDATE hawa.canva_connections SET encrypted_tokens=${this.cipher().seal({},this.aad(s))},status='reconnect_required',generation=${randomUUID()}::uuid,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db);
      await sql`DELETE FROM hawa.canva_oauth_states WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db);
      return row;
    });
    if(!old)return {disconnected:true,providerRevoked:false};
    try {
      const token=this.cipher().open(old.encrypted_tokens,this.aad(s));
      if(!token.refresh_token&&!token.access_token)return {disconnected:true,providerRevoked:false};
      await this.client().revokeToken(token.refresh_token||token.access_token);
      return {disconnected:true,providerRevoked:true};
    } catch {return {disconnected:true,providerRevoked:false,message:'Hawa disconnected locally. Provider revocation was not confirmed; remove the integration in Canva account settings.'};}
  }
  async authorizedClient(s: Scope): Promise<CanvaConnectClient> {
    if (!this.configuration().configured) fail(503,'CANVA_SETUP_REQUIRED','Configure and authorize Canva in Settings');
    let row = await this.tx(s, async db => {
      const r = (await sql<any>`SELECT * FROM hawa.canva_connections WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId} FOR UPDATE`.execute(db)).rows[0];
      if (!r || r.status !== 'active') return r;
      if (new Date(r.expires_at).getTime() <= Date.now()+60000) {
        // Commit the refresh claim BEFORE the remote rotating-token operation.
        await sql`UPDATE hawa.canva_connections SET status='refreshing',updated_at=now() WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db);
        r.claimedRefresh = true;
      }
      return r;
    });
    // Another call is rotating the token: this one waits for it and uses the new token. It was
    // refused with 409 CANVA_RECONNECT_REQUIRED, which the worker treats as final, whenever two
    // designs reached Canva during the same refresh (2026-09-24).
    if (row?.status === 'refreshing') {
      row = await this.awaitRefresh(s);
      // A refresh that ended without a new token (Canva was unavailable) leaves this caller nothing to use yet.
      if (row?.status === 'active' && new Date(row.expires_at).getTime() <= Date.now()+60000) fail(503,'CANVA_TEMPORARILY_UNAVAILABLE','Canva could not refresh the connection just now; retry shortly');
    }
    if (!row || row.status !== 'active') fail(409,'CANVA_RECONNECT_REQUIRED','Connect Canva; a missing or uncertain token rotation cannot be replayed');
    const tokens = this.cipher().open(row.encrypted_tokens,this.aad(s));
    if (!row.claimedRefresh) return this.client(tokens.access_token);
    const release = (status: 'active' | 'reconnect_required') => this.tx(s, db => sql`UPDATE hawa.canva_connections SET status=${status},updated_at=now()
      WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId} AND generation=${row.generation}::uuid AND status='refreshing'`.execute(db));
    let fresh: Awaited<ReturnType<CanvaConnectClient['refreshAccessToken']>>;
    try {
      fresh = await this.client(undefined,tokens.refresh_token).refreshAccessToken();
    } catch (err) {
      // Canva refused without taking the refresh token (a rate limit, an outage), or the request never
      // left: the connection is as good as before, so it stays active and the caller may retry. Only a
      // refused grant, or a loss after the request was sent (Canva may have rotated the token and the
      // answer is gone), needs a person to reconnect. Every failure did until 2026-09-24, a Canva 503
      // on the token endpoint included.
      const status = err instanceof CanvaHttpError ? err.status : undefined;
      const grantRefused = err instanceof CanvaHttpError && err.oauthError === 'invalid_grant';
      if (!grantRefused && (status !== undefined || canvaRequestNeverSent(err))) {
        await release('active');
        if (status === undefined || status === 429 || status >= 500) fail(503,'CANVA_TEMPORARILY_UNAVAILABLE','Canva could not refresh the connection just now; retry shortly');
        fail(502,'CANVA_TOKEN_REFRESH_REFUSED',`Canva refused the token refresh (HTTP ${status}); check the Canva integration settings`);
      }
      await release('reconnect_required');
      return fail(409,'CANVA_RECONNECT_REQUIRED','Token rotation could not be confirmed; reconnect Canva');
    }
    try {
      // Canva answered, so the old refresh token is spent: without the rotated one, or without saving
      // it, the connection cannot be used again.
      if (!fresh.refresh_token) throw new Error('Missing rotated refresh token');
      const count = await this.tx(s, async db => (await sql`UPDATE hawa.canva_connections SET encrypted_tokens=${this.cipher().seal(fresh,this.aad(s))},expires_at=${new Date(Date.now()+fresh.expires_in*1000)},status='active',updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId} AND generation=${row.generation}::uuid AND status='refreshing'`.execute(db)).numAffectedRows);
      if (count !== 1n) fail(409,'CANVA_CONNECTION_CHANGED','Canva connection changed during refresh; retry with the current connection');
      return this.client(fresh.access_token);
    } catch {
      await release('reconnect_required');
      return fail(409,'CANVA_RECONNECT_REQUIRED','Token rotation could not be confirmed; reconnect Canva');
    }
  }
  /**
   * The connection once another call's token refresh has finished. The refresh request is limited to
   * 15 s, so a claim still open after 20 s is slow; one untouched for two minutes belongs to a process
   * that died during the refresh, and whether Canva rotated the token is unknown: it needs a reconnect.
   */
  private async awaitRefresh(s: Scope): Promise<ConnectionRow | undefined> {
    const read = () => this.tx(s, async db => (await sql<ConnectionRow>`SELECT *, (status='refreshing' AND updated_at < now() - interval '2 minutes') AS refresh_abandoned
      FROM hawa.canva_connections WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId}`.execute(db)).rows[0]);
    const deadline = Date.now() + 20000;
    let row = await read();
    while (row?.status === 'refreshing' && !row.refresh_abandoned && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await read();
    }
    if (row?.status !== 'refreshing') return row;
    if (row.refresh_abandoned) {
      await this.tx(s, db => sql`UPDATE hawa.canva_connections SET status='reconnect_required',updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND actor_id=${s.actorId} AND generation=${row.generation}::uuid AND status='refreshing'`.execute(db));
      return { ...row, status: 'reconnect_required' };
    }
    return fail(503,'CANVA_TOKEN_REFRESHING','The Canva connection is being refreshed; retry shortly');
  }
  async binding(s: Scope, taskId: string) {
    return this.tx(s, async db => {
      const task = (await sql<any>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid`.execute(db)).rows[0];
      const binding = await new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId);
      if (!task?.client_id || !binding || task.client_id !== binding.client_id || binding.status !== 'bound') return fail(409,'CANVA_BINDING_REQUIRED','Link a separate Canva design to this task first');
      return binding;
    });
  }
  async editor(s: Scope, taskId: string) {
    const binding = await this.binding(s,taskId), client = await this.authorizedClient(s);
    const { design } = await client.getDesign(binding.canva_design_id);
    if (design.id !== binding.canva_design_id) return fail(502,'CANVA_DESIGN_MISMATCH','Canva returned a different design');
    return { url: design.urls.edit_url, designId: design.id, bindingVersion: binding.version,
      verification: 'provider_metadata_verified', updatedAt: design.updated_at, pageCount: design.page_count ?? null };
  }
  async amendmentObservation(s:Scope,taskId:string) {
    return inspectCanvaAmendment(this.db,s,taskId,()=>this.authorizedClient(s));
  }
  /** Internal preparation surface. No HTTP creation route is admitted until native qualification. */
  async createNativeTextCopyCandidate(s:Scope,taskId:string,key:string,input:NativeTextCopyRequest) {
    return new CanvaNativeCopyService(this.db,scope=>this.authorizedClient(scope)).create(s,taskId,key,input);
  }
  async reconcileNativeTextCopy(s:Scope,taskId:string,id:string) {
    return new CanvaNativeCopyService(this.db,scope=>this.authorizedClient(scope)).reconcile(s,taskId,id);
  }
  async createDesign(s: Scope,taskId: string,key: string,width: number,height: number) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || ![width,height].every(n => Number.isInteger(n) && n >= 40 && n <= 8000) || width*height > 25000000) fail(422,'CANVA_DESIGN_REQUEST_INVALID','Specify a stable request key and dimensions between 40 and 8000 pixels');
    const task = await this.tx(s,async db => (await sql<any>`SELECT client_id,title FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid`.execute(db)).rows[0]);
    if (!task?.client_id) fail(404,'CANVA_TASK_NOT_FOUND','Select a client before creating a design');
    const requestHash = hash(JSON.stringify({ width,height,title:task.title }));
    const prior = await this.tx(s,async db => (await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND request_key=${key}`.execute(db)).rows[0]);
    if (prior) {
      if (prior.kind !== 'create' || prior.request_hash !== requestHash || prior.actor_id !== s.actorId || prior.client_id !== task.client_id) fail(409,'CANVA_IDEMPOTENCY_CONFLICT','Request key already belongs to another request');
      return { operationId:prior.id,status:prior.status,designId:prior.design_id,contentStatus:'blank_native_canvas' };
    }
    const existing = await this.tx(s,db => new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId));
    if (existing) fail(409,'CANVA_ALREADY_BOUND','This task already has a Canva design; edit its existing binding');
    const client = await this.authorizedClient(s), id=randomUUID();
    const claim = await this.tx(s, async db => {
      // Lock the task to serialize different create keys, not only identical retries.
      const locked=(await sql<any>`SELECT client_id,state FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if(locked?.client_id!==task.client_id)fail(409,'CANVA_CLIENT_CHANGED','Client changed during the operation');
      const previous = (await sql<any>`SELECT id FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND kind='create' LIMIT 1`.execute(db)).rows[0];
      const bound = await new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId);
      if (previous || bound) return false;
      assertTaskGenerationAllowed(locked.state);
      await assertNativeRevisionAdmission(db,s.tenantId,taskId);
      await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,metadata)
        VALUES (${id}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${task.client_id}::uuid,${s.actorId},${key},${requestHash},'create','creating',${JSON.stringify({width,height})}::jsonb)`.execute(db);
      return true;
    });
    if (!claim) fail(409,'CANVA_CREATE_PENDING','A design creation already exists for this task; inspect its result rather than creating a duplicate');
    try {
      const { design } = await client.createDesign({ title:task.title.slice(0,255),designType:{type:'custom',width,height} });
      // Save the real returned ID before binding, so an interrupted binding is recoverable.
      await this.tx(s,db => sql`UPDATE hawa.canva_remote_operations SET design_id=${design.id},status='submitted',
        metadata=(metadata-'reconciliationReason')||'{"reconciliationRequired":false}'::jsonb,updated_at=now()
        WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
      await this.tx(s,async db => {
        await new CanvaBindingRepository(db).createBinding({ tenantId:s.tenantId,taskId,clientId:task.client_id,
          canvaDesignId:design.id,editUrl:'https://www.canva.com/design/'+design.id+'/edit',canvaUserId:design.owner?.user_id,canvaTeamId:design.owner?.team_id });
        await sql`UPDATE hawa.canva_remote_operations SET status='retrieved',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db);
      });
      return { operationId:id,status:'retrieved',designId:design.id,contentStatus:'blank_native_canvas' };
    } catch {
      await this.tx(s,db => sql`UPDATE hawa.canva_remote_operations SET status='uncertain',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
      return { operationId:id,status:'uncertain',message:'Creation or binding could not be confirmed. Inspect the operation and bind the returned design ID; do not create another copy.' };
    }
  }
  async taskState(s: Scope,taskId: string) {
    return this.tx(s,async db => {
      const task=(await sql<any>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid`.execute(db)).rows[0];
      if (!task) fail(404,'CANVA_TASK_NOT_FOUND','Task not found');
      const binding = await new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId);
      // The task's operations and exports whoever made them. Both were filtered to the caller's own
      // actor, and the studio exports as the worker's identity while approval needs a reviewer's,
      // so the approver saw no export at all and Approve stayed disabled on every studio design.
      // Exports are limited to the design currently bound, as exportsById limits them.
      const operations=(await sql<any>`SELECT id,kind,status,design_id,remote_job_id,metadata,metadata->>'method' AS method,created_at FROM hawa.canva_remote_operations
        WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid ORDER BY created_at DESC LIMIT 20`.execute(db)).rows.map(({metadata,...op}) => {
          const legacyUnknown=op.kind==='create'&&op.status==='failed'&&!canRetryCanvaCreation({...op,metadata});
          return {...op,status:legacyUnknown?'uncertain':op.status,
            reconciliation_required:legacyUnknown||metadata?.reconciliationRequired===true,
            reconciliation_reason:legacyUnknown?'legacy_failed_without_evidence':metadata?.reconciliationReason??null};
        });
      const artifacts=binding ? (await sql<any>`SELECT b.id,b.operation_id,b.format,b.sha256,b.content_check,octet_length(b.content) AS byte_size,
          o.metadata->>'designUpdatedAt' AS capture_version,
          o.metadata->'checkingPolicy'->>'confirmationEventId' AS confirmation_event_id FROM hawa.canva_export_bytes b
        JOIN hawa.canva_remote_operations o ON o.id=b.operation_id AND o.tenant_id=b.tenant_id
        WHERE b.tenant_id=${s.tenantId}::uuid AND b.task_id=${taskId}::uuid AND o.status='retrieved'
          AND o.design_id=${binding.canva_design_id} AND o.binding_version=${binding.version}
        ORDER BY b.created_at DESC LIMIT 20`.execute(db)).rows : [];
      return { artifacts, binding:binding ? { designId:binding.canva_design_id,version:binding.version,status:binding.status } : null,operations,semanticCapture:'unverified',approvalReady:false,
        revisionHandoff:await nativeRevisionHandoff(db,s.tenantId,taskId) ?? await nativeInitialHandoff(db,s.tenantId,taskId) };
    });
  }
  async importEditableDesign(s:Scope,taskId:string,key:string,source:{bytes:Buffer;sha256:string;manifest:Record<string,unknown>}) {
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(key)||source.bytes.length<32||source.bytes.length>26214400||hash(source.bytes)!==source.sha256)fail(422,'CANVA_SOURCE_INVALID','A bounded, checksummed editable source is required');
    const task=await this.tx(s,async db=>(await sql<any>`SELECT client_id,title FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid`.execute(db)).rows[0]);
    if(!task?.client_id)fail(404,'CANVA_TASK_NOT_FOUND','Select a client before creating a design');
    const requestHash=hash(JSON.stringify(source.manifest));
    const client=await this.authorizedClient(s);
    // The source to the file store first (ADR-035). A studio or planner source is already there under
    // the same hash, so this finds the file and writes nothing; its bytes stay in the row until the strip.
    await putToStore(blobStoreFor(this.db,this.options.blobStore),source.bytes,'application/vnd.openxmlformats-officedocument.presentationml.presentation','an editable source');
    const claimed=await this.tx(s,async db=>{
      const locked=(await sql<any>`SELECT client_id,state FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if(locked?.client_id!==task.client_id)fail(409,'CANVA_CLIENT_CHANGED','Client changed during the operation');
      // This key's own operation, whatever became of it: a failed one is reported, never sent again
      // under the same key (the key is unique, and a second INSERT failed with a database error).
      const own=(await sql<{ id: string; kind: string; status: string; request_hash: string; actor_id: string; metadata: { method?: string; rateLimited?: unknown } | null }>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND request_key=${key}`.execute(db)).rows[0];
      if(own){
        if(own.kind!=='create'||own.request_hash!==requestHash||own.actor_id!==s.actorId||own.metadata?.method!=='pptx_import')fail(409,'CANVA_IDEMPOTENCY_CONFLICT','Request key already belongs to another request');
        // Except one Canva refused with 429 (it created nothing): that one is sent again below, once
        // the checks a new import passes still hold. Any other outcome (uncertain above all) is followed.
        if(!heldByRateLimit(own))return {id:own.id,created:false};
      }
      const prior=(await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND kind='create' ORDER BY created_at`.execute(db)).rows.find(op=>!canRetryCanvaCreation(op));
      if(prior){
        // The same document from the same actor under another key (a studio transfer retried after a
        // restart, or re-driven) is the same import: while Canva has a job for it, it is followed, never
        // sent a second time. Refused with 409 CANVA_CREATE_CONFLICT until 2026-09-24, which stranded
        // the task while the first import was still settling. One with no job to follow (creating,
        // uncertain), held for reconciliation, or historically failed without evidence cannot
        // authorize another creation. Explicit resume may still reconcile the original job.
        if(!prior.remote_job_id||prior.status==='failed'||prior.metadata?.reconciliationRequired===true||prior.request_hash!==requestHash||prior.actor_id!==s.actorId||prior.metadata?.method!=='pptx_import')fail(409,'CANVA_CREATE_CONFLICT','A creation requires reconciliation. Inspect the original operation instead of making another document');
        return {id:prior.id,created:false};
      }
      assertTaskGenerationAllowed(locked.state);
      await assertNativeRevisionAdmission(db,s.tenantId,taskId);
      if(await new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId))fail(409,'CANVA_ALREADY_BOUND','Edit the existing Canva design');
      if(own){
        // The task row is locked, so a second retry of the same key waits here and then follows this one.
        const reclaimed=(await sql<{ id: string }>`UPDATE hawa.canva_remote_operations SET status='creating',metadata=metadata-'rateLimited'-'failureEvidence',updated_at=now()
          WHERE tenant_id=${s.tenantId}::uuid AND id=${own.id}::uuid AND status='failed' AND metadata->'rateLimited'='true'::jsonb RETURNING id`.execute(db)).rows[0];
        return {id:own.id,created:Boolean(reclaimed)};
      }
      const id=randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,metadata)
        VALUES(${id}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${task.client_id}::uuid,${s.actorId},${key},${requestHash},'create','creating','{"method":"pptx_import"}'::jsonb)`.execute(db);
      await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
        VALUES(${randomUUID()}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${task.client_id}::uuid,${s.actorId},${id}::uuid,${source.sha256},${source.bytes},${JSON.stringify(source.manifest)}::jsonb)`.execute(db);
      return {id,created:true};
    });
    if(!claimed.created)return this.resumeImport(s,taskId,claimed.id);
    try {
      const result=await client.createImportJob(source.bytes,task.title);
      await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET remote_job_id=${result.job.id},status='submitted',
        metadata=(metadata-'reconciliationReason')||'{"reconciliationRequired":false}'::jsonb,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND id=${claimed.id}::uuid`.execute(db));
    } catch (err) {
      if(canvaRateLimited(err))return this.holdForRateLimit(s,claimed.id,'import',err);
      if(createdNothing(err,false)){
        await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET status='failed',
          metadata=metadata||'{"failureEvidence":{"kind":"not_accepted"}}'::jsonb,updated_at=now()
          WHERE tenant_id=${s.tenantId}::uuid AND id=${claimed.id}::uuid`.execute(db));
        return {operationId:claimed.id,status:'failed',message:`Canva did not accept the import (${(err as Error)?.message || 'not sent'}); nothing was created, and it may be sent again.`};
      }
      await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET status='uncertain',updated_at=now() WHERE tenant_id=${s.tenantId}::uuid AND id=${claimed.id}::uuid`.execute(db));
      return {operationId:claimed.id,status:'uncertain',message:'Import result is unconfirmed. Source is retained; do not create another copy.'};
    }
    return this.resumeImport(s,taskId,claimed.id);
  }
  async resumeImport(s:Scope,taskId:string,id:string) {
    const op=await this.tx(s,async db=>(await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND id=${id}::uuid`.execute(db)).rows[0]);
    if(!op||(op.actor_id!==s.actorId&&!overrides(s))||op.kind!=='create'||op.metadata?.method!=='pptx_import')fail(404,'CANVA_IMPORT_NOT_FOUND','Import operation not found');
    if(op.status==='retrieved'||canRetryCanvaCreation(op))return {operationId:id,status:op.status,designId:op.design_id};
    if(!op.remote_job_id){
      if(op.status==='failed')return this.holdCanvaOperation(s,op,'legacy_failed_without_evidence');
      return {operationId:id,status:op.status,designId:op.design_id};
    }
    let result: any;
    try {
      // Read with the connection that made the import: a Canva job is visible to that account only.
      result=await (await this.authorizedClient({...s,actorId:op.actor_id})).getImportJob(op.remote_job_id);
    } catch (err: any) {
      // A missing job can be expired or inaccessible after creation. No read error proves that
      // the original effect did not happen (ADR-108).
      if(err instanceof CanvaHttpError&&err.status===404){
        return this.holdCanvaOperation(s,op,'import_job_unavailable');
      }
      return {operationId:id,status:op.status==='submitted'?'submitted':'uncertain',message:`Canva import status could not be read just now (${err?.message || String(err)}); the original operation is retained.`};
    }
    if(result.job.id!==op.remote_job_id)return this.holdCanvaOperation(s,op,'import_job_identity_mismatch');
    if(result.job.status==='in_progress')return {operationId:id,status:op.status==='submitted'?'submitted':'uncertain'};
    if(result.job.status==='failed'){
      if(result.job.result?.designs?.length)return this.holdCanvaOperation(s,op,'import_result_requires_inspection');
      const evidence=JSON.stringify({failureEvidence:{kind:'provider_failed',remoteJobId:op.remote_job_id},reconciliationRequired:false});
      const updated=await this.tx(s,db=>sql<{status:string}>`UPDATE hawa.canva_remote_operations
        SET status='failed',metadata=(metadata-'reconciliationReason')||${evidence}::jsonb,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid AND status=${op.status}
          AND design_id IS NULL AND remote_job_id=${op.remote_job_id} RETURNING status`.execute(db));
      if(!updated.rows.length)return this.operationOutcome(s,id);
      return {operationId:id,status:'failed',message:'Canva reported that this import job failed. Original source is retained.'};
    }
    if(result.job.result?.designs.length!==1)return this.holdCanvaOperation(s,op,'import_result_requires_inspection');
    const design=result.job.result!.designs[0];
    await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET design_id=${design.id},updated_at=now() WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid`.execute(db));
    await this.tx(s,async db=>{
      const locked=(await sql<any>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if(locked?.client_id!==op.client_id)fail(409,'CANVA_CLIENT_CHANGED','Client changed during the operation');
      const existing=await new CanvaBindingRepository(db).findByTaskId(s.tenantId,taskId);
      if(existing&&existing.canva_design_id!==design.id)fail(409,'CANVA_BINDING_CONFLICT','Task now refers to another document');
      if(!existing)await new CanvaBindingRepository(db).createBinding({tenantId:s.tenantId,taskId,clientId:op.client_id,canvaDesignId:design.id,editUrl:`https://www.canva.com/design/${design.id}/edit`});
      await sql`UPDATE hawa.canva_remote_operations SET status='retrieved',metadata=(metadata-'reconciliationReason'-'failureEvidence')||'{"reconciliationRequired":false}'::jsonb,updated_at=now() WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid`.execute(db);
    });
    return {operationId:id,status:'retrieved',designId:design.id,contentStatus:'imported_editable_draft',qaStatus:'not_run'};
  }
  private async operationOutcome(s:Scope,id:string) {
    const row=await this.tx(s,async db=>(await sql<{status:string;design_id:string|null}>`SELECT status,design_id
      FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid`.execute(db)).rows[0]);
    if(!row)fail(404,'CANVA_OPERATION_NOT_FOUND','Operation not found');
    return {operationId:id,status:row.status,designId:row.design_id};
  }
  private async holdCanvaOperation(s:Scope,op:{id:string;status:string;remote_job_id:string|null},reason:string) {
    // A late sweep cannot demote an operation that acquired its job or completed meanwhile.
    const metadata=JSON.stringify({reconciliationRequired:true,reconciliationReason:reason});
    await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations
      SET status='uncertain',metadata=metadata||${metadata}::jsonb,updated_at=now()
      WHERE tenant_id=${s.tenantId}::uuid AND id=${op.id}::uuid AND status=${op.status}
        AND remote_job_id IS NOT DISTINCT FROM ${op.remote_job_id}`.execute(db));
    const outcome=await this.operationOutcome(s,op.id);
    return outcome.status==='uncertain'
      ? {...outcome,message:'The original Canva outcome needs reconciliation. Check the original job or link its returned design; do not create another copy.'}
      : outcome;
  }
  /**
   * Settles Canva operations nobody is following any more, so none blocks the task for good (Core
   * runs this on an interval since 2026-09-24; nothing called it before, and a slow import left the
   * task refusing every later design with 409 CANVA_CREATE_CONFLICT).
   *  - a submitted import or export is asked about again, with the connection that made it;
   *  - an import still unresolved after `giveUpMinutes` needs explicit reconciliation;
   *  - an operation left 'creating' (Core stopped mid-call) or 'uncertain' (the answer was lost) has
   *    no Canva job to ask about. Unknown creations remain held; exports have separate read-only
   *    retry semantics. Age never proves creation failure (ADR-108).
   */
  async sweepStrandedOperations(s: Scope, options: { maxAgeMinutes?: number; giveUpMinutes?: number; limit?: number } = {}) {
    const maxAgeMinutes = options.maxAgeMinutes ?? 10;
    const giveUpMinutes = options.giveUpMinutes ?? 24 * 60;
    const limit = options.limit ?? 20;
    const stranded = await this.tx(s, async db =>
      (await sql<any>`SELECT id, task_id, remote_job_id, actor_id, kind, status, metadata->>'format' AS format,metadata->>'method' AS method,
          created_at < now() - (interval '1 minute' * ${giveUpMinutes}) AS expired
        FROM hawa.canva_remote_operations
        WHERE tenant_id = ${s.tenantId}::uuid
          AND metadata->>'reconciliationRequired' IS DISTINCT FROM 'true'
          AND ((status = 'submitted' AND created_at < now() - (interval '1 minute' * ${maxAgeMinutes})
                AND ((kind = 'create' AND metadata->>'method' IN ('pptx_import','native_text_copy')) OR kind = 'export'))
            OR (status IN ('creating', 'uncertain') AND (kind = 'export' OR design_id IS NULL) AND updated_at < now() - (interval '1 minute' * ${maxAgeMinutes})))
        ORDER BY created_at ASC
        LIMIT ${limit}`.execute(db)).rows
    );

    const settled: Array<{ id: string; taskId: string; kind: string; format?: string; status: string; designId?: string; error?: string }> = [];
    const markFailed = (id: string, from: string) =>
      this.tx(s, db => sql`UPDATE hawa.canva_remote_operations SET status='failed', updated_at=now() WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid AND status=${from}`.execute(db));
    for (const op of stranded) {
      const base = { id: op.id, taskId: op.task_id, kind: op.kind, ...(op.format ? { format: op.format } : {}) };
      if (op.status !== 'submitted') {
        if(op.kind==='create'){
          const held=await this.holdCanvaOperation(s,op,'creation_reply_unavailable');
          settled.push({...base,status:held.status});
          continue;
        }
        await markFailed(op.id, op.status);
        settled.push({ ...base, status: 'failed', error: `Left ${op.status} with no Canva job to ask about` });
        continue;
      }
      const owner = { ...s, actorId: op.actor_id };
      try {
        const res: { status: string; designId?: string } = op.kind === 'export'
          ? await this.exportStatus(owner, op.task_id, op.id)
          : op.method === 'native_text_copy'
            ? await this.reconcileNativeTextCopy(owner,op.task_id,op.id).then(result=>({...result,designId:result.designId??undefined}))
            : await this.resumeImport(owner, op.task_id, op.id);
        if (res.status === 'submitted' && op.expired) {
          if(op.kind==='create'){
            const held=await this.holdCanvaOperation(s,op,'import_polling_deadline');
            settled.push({...base,status:held.status});
            continue;
          }
          await markFailed(op.id, 'submitted');
          settled.push({ ...base, status: 'failed', error: `Canva had not settled it after ${giveUpMinutes} minutes` });
        } else {
          settled.push({ ...base, status: res.status, designId: res.designId });
        }
      } catch (err: any) {
        if(op.kind==='create'){
          if(op.expired){
            const held=await this.holdCanvaOperation(s,op,'import_reconciliation_unavailable');
            settled.push({...base,status:held.status});
          }else settled.push({...base,status:'submitted',error:err?.message||String(err)});
          continue;
        }
        // A refusal that cannot change (the binding moved on, the import is not this task's, Canva
        // has no such job) settles the operation; a failed read is asked again on the next pass.
        const final = (err instanceof CanvaFlowError && err.status >= 400 && err.status < 500 && err.status !== 429)
          || (err instanceof CanvaHttpError && err.status === 404);
        if (final || op.expired) await markFailed(op.id, 'submitted');
        settled.push({ ...base, status: final || op.expired ? 'failed' : 'submitted', error: err?.message || String(err) });
      }
    }
    return { sweptCount: stranded.length, settled };
  }
  async startExport(s: Scope, taskId: string, key: string, format: 'png'|'pdf'|'pptx', expectedVersion: number) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !['png','pdf','pptx'].includes(format) || !Number.isInteger(expectedVersion)) fail(422,'CANVA_EXPORT_REQUEST_INVALID','Use a stable request key, format and expected binding version');
    const binding = await this.binding(s,taskId);
    if (binding.version !== expectedVersion) fail(409,'CANVA_BINDING_STALE','Refresh the task binding before exporting');
    const requestHash = hash(JSON.stringify({ designId:binding.canva_design_id,format,expectedVersion }));
    const existing = await this.tx(s, async db => (await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND request_key=${key}`.execute(db)).rows[0]);
    // An export Canva refused with 429 created nothing: its own key sends it again, as a new one would be.
    const retrying = heldByRateLimit(existing);
    if (existing) { this.checkReplay(existing,s,requestHash); if (!retrying) return this.exportStatus(s,taskId,existing.id); }
    const client = await this.authorizedClient(s);
    const { design } = await client.getDesign(binding.canva_design_id);
    if (design.id !== binding.canva_design_id) fail(502,'CANVA_DESIGN_MISMATCH','Canva returned a different design');
    if (format === 'png' && design.page_count !== 1) fail(422,'CANVA_MULTIPAGE_PNG_UNSUPPORTED','Use PDF for multi-page designs; PNG capture currently requires exactly one page');
    const id: string = retrying ? existing.id : randomUUID(), metadata: { format: string; designUpdatedAt: unknown; checkingPolicy?: ExportCheckPolicy } = { format, designUpdatedAt:design.updated_at };
    const inserted = await this.tx(s, async db => {
      if (s.nativeRecovery) await lockNativeRecovery(db,s,taskId);
      const task = (await sql<{client_id:string}>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      const locked = (await sql<{version:number;canva_design_id:string}>`SELECT version,canva_design_id FROM hawa.canva_bindings
        WHERE tenant_id=${s.tenantId}::uuid AND id=${binding.id}::uuid AND status='bound' FOR SHARE`.execute(db)).rows[0];
      if (!task || task.client_id !== binding.client_id || !locked || locked.version !== expectedVersion || locked.canva_design_id !== design.id)
        fail(409,'CANVA_BINDING_STALE','The task or binding changed before export admission');
      // A concurrent retry keeps the first receipt, without reading today's mutable font policy. So
      // does a retry of an export Canva refused with 429: it was admitted, and keeps its own policy.
      const own = (await sql<{ status: string; metadata: { rateLimited?: unknown } | null }>`SELECT status, metadata FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid
        AND task_id=${taskId}::uuid AND request_key=${key}`.execute(db)).rows[0];
      if (own && !(retrying && heldByRateLimit(own))) return undefined;
      if (!retrying) {
        const revisionCopy = await latestNativeCopy(db,s.tenantId,taskId);
        if (!revisionCopy) await assertNativeRevisionAdmission(db,s.tenantId,taskId);
        // ADR-126: an owned manual request captures only under its current human copy confirmation.
        if (!revisionCopy && s.nativeRecovery) fail(409,'NATIVE_COPY_CONFIRMATION_REQUIRED','Confirm the exact final copy against the linked design before capture');
        // Both preview and editable capture must belong to the same human confirmation.
        if (format === 'pptx' || revisionCopy) {
          const source = format === 'pptx' ? await this.editableSource(s,taskId,binding.client_id,design.id,db) : undefined;
          if (revisionCopy) {
            metadata.checkingPolicy=await resolveManualExportPolicy(db,s.tenantId,taskId,binding.client_id,s);
          } else if (source) {
            const manifest=source.manifest, blocks=studioSentBlocks(manifest);
            const directionsByIndex=importedSourceDirections(manifest);
            if (manifest?.plan !== undefined && !blocks)
              fail(422,'SOURCE_REQUIRED','The imported source has an incomplete or ambiguous per-block font plan');
            if (!Array.isArray(manifest?.copy) || !manifest.copy.length || !manifest.copy.every((part:unknown)=>typeof part==='string') ||
                (!blocks && !manifest.reference?.rules?.fontFamily))
              fail(422,'SOURCE_REQUIRED','The imported source has no complete saved copy and font policy');
            metadata.checkingPolicy={version:1,kind:'imported_source',sourceId:source.id,copy:manifest.copy,
              ...(blocks ? {options:{fontsByIndex:blocks.map(t=>t.fontFamily),roles:blocks.map(t=>t.role||'body'),directionsByIndex}} :
                {requiredFont:manifest.reference.rules.fontFamily,options:{scriptFonts:manifest.reference.rules.scriptFonts,directionsByIndex}})};
          } else {
            const inaccessible = (await sql`SELECT e.id FROM hawa.canva_editable_sources e JOIN hawa.canva_remote_operations o
              ON o.id=e.operation_id AND o.tenant_id=e.tenant_id WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid
              AND e.client_id=${binding.client_id}::uuid AND o.design_id=${design.id} LIMIT 1`.execute(db)).rows.length;
            if (inaccessible) fail(403,'SOURCE_FORBIDDEN','The imported source belongs to another actor; an art director or administrator must check this design');
            metadata.checkingPolicy=await resolveManualExportPolicy(db,s.tenantId,taskId,binding.client_id);
          }
        }
      }
      const pending=(await sql<any>`SELECT id FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid
        AND kind='export' AND design_id=${design.id} AND metadata->>'format'=${format} AND status IN ('creating','submitted','uncertain') AND request_key<>${key} LIMIT 1`.execute(db)).rows[0];
      if(pending) fail(409,'CANVA_EXPORT_PENDING','An export of this format is already pending or uncertain; resume the existing operation');
      if (retrying) return (await sql<any>`UPDATE hawa.canva_remote_operations SET status='creating',metadata=(metadata-'rateLimited'-'failureEvidence')||${JSON.stringify({ designUpdatedAt:design.updated_at })}::jsonb,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid AND status='failed' AND metadata->'rateLimited'='true'::jsonb RETURNING id`.execute(db)).rows[0];
      return (await sql<any>`INSERT INTO hawa.canva_remote_operations
      (id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version,metadata)
      VALUES (${id}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${binding.client_id}::uuid,${s.actorId},${key},${requestHash},'export','creating',${design.id},${expectedVersion},${JSON.stringify(metadata)}::jsonb)
      ON CONFLICT (tenant_id,task_id,request_key) DO NOTHING RETURNING id`.execute(db)).rows[0];
    });
    if (!inserted) {
      const raced = await this.tx(s, async db => (await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND request_key=${key}`.execute(db)).rows[0]);
      this.checkReplay(raced,s,requestHash); return this.exportStatus(s,taskId,raced.id);
    }
    try {
      const job = await client.createExportJob(design.id,format);
      await this.tx(s, db => sql`UPDATE hawa.canva_remote_operations SET status='submitted',remote_job_id=${job.job.id},updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
    } catch (err) {
      if (canvaRateLimited(err)) return this.holdForRateLimit(s, id, 'export', err);
      if (createdNothing(err, true)) {
        await this.tx(s, db => sql`UPDATE hawa.canva_remote_operations SET status='failed',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
        return { operationId:id,status:'failed',message:`Canva did not accept the export (${(err as Error)?.message || 'not sent'}); request it again.`,qaStatus:'not_run' };
      }
      await this.tx(s, db => sql`UPDATE hawa.canva_remote_operations SET status='uncertain',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
      return { operationId:id,status:'uncertain',message:'Export submission could not be confirmed. Do not create another request until reconciled.',qaStatus:'not_run' };
    }
    return { operationId:id,status:'submitted',qaStatus:'not_run' };
  }
  /**
   * The Hawa-made source a PPTX export of this task is checked against: the caller's own, or for an
   * art director or administrator the task's, whoever made it. The studio imports as the worker's
   * identity, so the Desk's "Check copy & fonts" failed SOURCE_REQUIRED on every studio design until
   * 2026-09-24. Only the source imported into this exact design is eligible.
   */
  private editableSource(s: Scope, taskId: string, clientId: string, designId: string, transaction?: Kysely<Database>) {
    const read = async (db: Kysely<Database>) => (await sql<any>`SELECT e.id, e.manifest FROM hawa.canva_editable_sources e
      JOIN hawa.canva_remote_operations o ON o.id = e.operation_id AND o.tenant_id = e.tenant_id
      WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid AND e.client_id=${clientId}::uuid
        AND o.design_id=${designId} AND o.status='retrieved' AND (e.actor_id=${s.actorId} OR ${overrides(s)})
      ORDER BY e.created_at DESC LIMIT 1`.execute(db)).rows[0];
    return transaction ? read(transaction) : this.tx(s,read);
  }
  /**
   * Records a create call Canva refused with 429 (nothing was created: `failureEvidence` not_accepted,
   * so it blocks no other creation for the task) so that its own key may send it again, and answers 429 CANVA_RATE_LIMITED with the wait: the worker keeps it and asks again.
   */
  private async holdForRateLimit(s: Scope, id: string, what: 'import'|'export', err: CanvaHttpError): Promise<never> {
    await this.tx(s, db => sql`UPDATE hawa.canva_remote_operations
      SET status='failed',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('rateLimited',true,'rateLimitCount',coalesce((metadata->>'rateLimitCount')::int,0)+1,
        'failureEvidence',jsonb_build_object('kind','not_accepted')),updated_at=now()
      WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
    const waitMs = canvaRateLimitWaitMs(err.retryAfterMs);
    throw new CanvaFlowError(429,'CANVA_RATE_LIMITED',`Canva is refusing new ${what}s for the moment (its rate limit); nothing was created. Send the same request again in about ${Math.ceil(waitMs/1000)} s.`,waitMs);
  }
  private checkReplay(row: any,s: Scope,requestHash: string) {
    if (!row || row.actor_id !== s.actorId || row.request_hash !== requestHash || row.kind !== 'export') fail(409,'CANVA_IDEMPOTENCY_CONFLICT','Request key already belongs to a different request or actor');
  }
  async exportStatus(s: Scope,taskId: string,id: string) {
    const row = await this.tx(s, async db => (await sql<any>`SELECT * FROM hawa.canva_remote_operations WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND actor_id=${s.actorId} AND id=${id}::uuid`.execute(db)).rows[0]);
    if (!row) return fail(404,'CANVA_EXPORT_NOT_FOUND','Export not found in the current task and actor scope');
    const binding = await this.binding(s,taskId);
    if (binding.canva_design_id !== row.design_id || binding.version !== row.binding_version || binding.client_id !== row.client_id) fail(409,'CANVA_BINDING_STALE','Binding changed; this export cannot become current evidence');
    if (row.status === 'submitted') {
      const client = await this.authorizedClient(s), { job } = await client.getExportJob(row.remote_job_id);
      if (job.id !== row.remote_job_id) fail(502,'CANVA_EXPORT_MISMATCH','Canva returned a different job');
      if (job.status === 'failed') {
        await this.tx(s, db => sql`UPDATE hawa.canva_remote_operations SET status='failed',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db)); row.status='failed';
      } else if (job.status === 'success') {
        if (job.urls?.length !== 1) fail(422,'CANVA_EXPORT_SHAPE_UNSUPPORTED','Expected one complete export file');
        const bytes = await downloadCanvaExport(job.urls![0],this.options.fetcher);
        const validator = new CanvaCapturePipeline();
        let contentCheck:any=null;
        if(row.metadata.format==='pptx'){
          const policy = row.metadata.checkingPolicy as ExportCheckPolicy | undefined;
          if (policy) {
            contentCheck={...checkCanvaPptx(bytes,policy.copy,policy.requiredFont || policy.options,policy.options),
              expectedCopy:policy.copy,checkingPolicy:policy};
          } else {
            const source=await this.editableSource(s,taskId,row.client_id,row.design_id);
            // Legacy operations have no frozen policy. A complete imported plan supplies each block's
            // face, including planner sources with a reference pack (ADR220); only plan-free historical
            // sources use the explicit reference/script policy below.
            const manifest=source?.manifest;
            const sentBlocks=studioSentBlocks(manifest);
            const directionsByIndex=importedSourceDirections(manifest);
            if (manifest?.plan !== undefined && !sentBlocks)
              fail(422,'SOURCE_REQUIRED','The imported source has an incomplete or ambiguous per-block font plan');
            if(sentBlocks){
              contentCheck={...checkCanvaPptx(bytes,manifest.copy,{fontsByIndex:sentBlocks.map(t=>t.fontFamily),roles:sentBlocks.map(t=>t.role||'body'),directionsByIndex}),expectedCopy:manifest.copy};
            }else{
              if(!manifest?.copy||!manifest.reference?.rules?.fontFamily)fail(422,'SOURCE_REQUIRED','No saved copy and brand font are available for this task');
              contentCheck={...checkCanvaPptx(bytes,manifest.copy,manifest.reference.rules.fontFamily,{scriptFonts:manifest.reference.rules.scriptFonts,directionsByIndex}),expectedCopy:manifest.copy};
            }
          }
        }else{
          const validated=validator.validateArtifactBytes(bytes,row.metadata.format==='png'?'png':'pdf_standard');
          if(!validated.ok)fail(422,validated.error.code,'Canva export failed byte validation; no capture was accepted');
          if(row.metadata.format==='pdf'){
            // ADR-258: a PDF is read back for what its file alone can show (one page, embedded fonts, live
            // text, the imported source's Latin-script copy found exactly). Arabic-script copy is checked
            // visually on the PNG of the same version; a PDF that cannot be read records why.
            try {
              const source=await this.editableSource(s,taskId,row.client_id,row.design_id);
              const copy=Array.isArray(source?.manifest?.copy)?source!.manifest.copy.filter((l: unknown): l is string=>typeof l==='string'):[];
              contentCheck={...checkCanvaPdf(bytes,copy),expectedCopy:copy};
            } catch (err) {
              contentCheck={source:'canva_exported_pdf',pass:false,copyPass:null,errors:[`Not read: ${(err as Error)?.message || err}`]};
            }
          }
        }
        const { design } = await client.getDesign(row.design_id);
        if (design.id !== row.design_id || design.updated_at !== row.metadata.designUpdatedAt) {
          await this.tx(s,db => sql`UPDATE hawa.canva_remote_operations SET status='stale',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db));
          return { operationId:id,status:'stale',qaStatus:'not_run' };
        }
        // A publisher rechecks approval after taking this same session lock and keeps it through
        // provider effects. Capture must commit both bytes and operation status while it owns the
        // lock; otherwise a newer export can appear after that recheck and still be delivered.
        const held = await withSessionAdvisoryLock(this.db, `publish:${taskId}`, () => this.tx(s, async db => {
          const task = (await sql<any>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
          if (!task || task.client_id !== row.client_id) fail(409,'CANVA_CLIENT_CHANGED','Client changed during export');
          const locked = (await sql<any>`SELECT * FROM hawa.canva_bindings WHERE id=${binding.id}::uuid AND tenant_id=${s.tenantId}::uuid FOR UPDATE`.execute(db)).rows[0];
          if (!locked || locked.version !== row.binding_version || locked.status !== 'bound' || locked.client_id !== row.client_id) fail(409,'CANVA_BINDING_STALE','Binding changed during export');
          await sql`INSERT INTO hawa.canva_export_bytes(id,tenant_id,task_id,client_id,operation_id,format,sha256,content,content_check,created_at)
            VALUES (${randomUUID()}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${row.client_id}::uuid,${id}::uuid,${row.metadata.format === 'png' ? 'png' : row.metadata.format==='pptx'?'pptx':'pdf_standard'},${hash(bytes)},${bytes},${contentCheck?JSON.stringify(contentCheck):null}::jsonb,clock_timestamp()) ON CONFLICT (operation_id) DO NOTHING`.execute(db);
          await sql`UPDATE hawa.canva_remote_operations SET status='retrieved',updated_at=now() WHERE id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db);
        }));
        // Leave the remote operation submitted so a later resume can commit the downloaded bytes.
        // A 503 is retryable by the stranded-operation sweeper; a 409 would incorrectly fail it.
        if (!held.acquired) fail(503,'PUBLICATION_IN_PROGRESS','Delivery is publishing this task; resume the Canva capture shortly');
        row.status='retrieved';
      }
    }
    const artifact = row.status === 'retrieved' ? await this.tx(s,async db => (await sql<any>`SELECT id,format,sha256,content_check,octet_length(content) AS byte_size FROM hawa.canva_export_bytes WHERE operation_id=${id}::uuid AND tenant_id=${s.tenantId}::uuid`.execute(db)).rows[0]) : null;
    return { operationId:id,status:row.status,artifact,qaStatus:'not_run',semanticCoverage:'unverified',printQualified:false,
      message: row.status === 'retrieved' ? 'Native export retrieved and hashed. Exact-copy, logo, layout and human approval checks are still required.' : undefined };
  }
  async artifact(s: Scope,taskId: string,id: string): Promise<any> {
    const binding = await this.binding(s,taskId);
    const result = await this.tx(s,async db => (await sql<any>`SELECT a.content,a.format,a.sha256 FROM hawa.canva_export_bytes a JOIN hawa.canva_remote_operations o ON o.id=a.operation_id
      WHERE a.tenant_id=${s.tenantId}::uuid AND a.task_id=${taskId}::uuid AND a.id=${id}::uuid
        AND o.status='retrieved' AND o.design_id=${binding.canva_design_id} AND o.binding_version=${binding.version}`.execute(db)).rows[0]);
    if (!result) fail(404,'CANVA_ARTIFACT_NOT_FOUND','Export evidence not found for the current task and design');
    return result;
  }
  /** Retrieved exports of this task with these ids, for pinning to an approval. Unknown ids are left out. */
  async exportsById(s: Scope,taskId: string,ids: string[]): Promise<Array<{ id:string; format:'png'|'pdf'|'pptx'; sha256:string; byte_size:number }>> {
    if (!ids.length) return [];
    let binding: any = null;
    try {
      binding = await this.binding(s, taskId);
    } catch {
      binding = null;
    }
    if (!binding?.canva_design_id) return [];
    const rows = await this.tx(s,async db => {
      const query = sql<any>`SELECT b.id,b.format,b.sha256,octet_length(b.content) AS byte_size FROM hawa.canva_export_bytes b
        JOIN hawa.canva_remote_operations o ON o.id=b.operation_id AND o.tenant_id=b.tenant_id
        WHERE b.tenant_id=${s.tenantId}::uuid AND b.task_id=${taskId}::uuid AND o.status='retrieved'
          AND (b.content_check IS NULL OR ((b.content_check->>'copyPass') IS DISTINCT FROM 'false' AND (b.content_check->>'fontPass') IS DISTINCT FROM 'false' AND (b.content_check->>'status') IS DISTINCT FROM 'failed'))
          AND o.design_id=${binding.canva_design_id} AND o.binding_version=${binding.version}
          AND b.id = ANY(${ids}::uuid[])`;
      return (await query.execute(db)).rows;
    });
    return rows.map((r:any) => ({ id:String(r.id),format:r.format,sha256:String(r.sha256),byte_size:Number(r.byte_size) }));
  }
  /** All retrieved exports of this task passing checks, for pinning or delivery when export IDs were not pre-specified. */
  async allExports(s: Scope,taskId: string): Promise<Array<{ id:string; format:'png'|'pdf'|'pptx'; sha256:string; byte_size:number }>> {
    let binding: any = null;
    try {
      binding = await this.binding(s, taskId);
    } catch {
      binding = null;
    }
    if (!binding?.canva_design_id) return [];
    const rows = await this.tx(s,async db => {
      const query = sql<any>`SELECT b.id,b.format,b.sha256,octet_length(b.content) AS byte_size FROM hawa.canva_export_bytes b
        JOIN hawa.canva_remote_operations o ON o.id=b.operation_id AND o.tenant_id=b.tenant_id
        WHERE b.tenant_id=${s.tenantId}::uuid AND b.task_id=${taskId}::uuid AND o.status='retrieved'
          AND (b.content_check IS NULL OR ((b.content_check->>'copyPass') IS DISTINCT FROM 'false' AND (b.content_check->>'fontPass') IS DISTINCT FROM 'false' AND (b.content_check->>'status') IS DISTINCT FROM 'failed'))
          AND o.design_id=${binding.canva_design_id} AND o.binding_version=${binding.version}
        ORDER BY b.created_at DESC`;
      return (await query.execute(db)).rows;
    });
    return rows.map((r:any) => ({ id:String(r.id),format:r.format,sha256:String(r.sha256),byte_size:Number(r.byte_size) }));
  }
  /** The stored bytes of one export of this task, for delivery. The caller checks them against the pinned hash. */
  async exportBytes(s: Scope,taskId: string,id: string): Promise<Buffer|null> {
    const row = await this.tx(s,async db => (await sql<any>`SELECT content FROM hawa.canva_export_bytes
      WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND id=${id}::uuid`.execute(db)).rows[0]);
    return row?.content ? Buffer.from(row.content) : null;
  }
  /**
   * A publication-time, read-only check of the working Canva design against the exact QC-linked
   * capture. It catches edits not yet exported into Hawa. Canva's REST updated_at has one-second
   * precision, so an equal value is supporting evidence, not proof of byte-identical design state.
   */
  async verifyApprovedDesignVersion(input: {
    tenantId: string; taskId: string; approvalId: string; artifactIds: string[];
  }): Promise<CanvaPublicationVersionCheck> {
    const unverified: CanvaPublicationVersionCheck = { ok: false, code: 'CANVA_CAPTURE_UNVERIFIED',
      message: 'The approval has no complete QC-linked Canva capture version; capture and approve the design again', retryable: false };
    if (!input.artifactIds.length || new Set(input.artifactIds).size !== input.artifactIds.length) return unverified;
    let proof: { designId: string; actorId: string; version: string } | null;
    try {
      proof = await this.tx({ tenantId: input.tenantId, actorId: SYSTEM_AUTOMATION_USER_ID }, async db => {
        const approval = (await sql<{ checked_id: string | null; version: string | null; binding_id: string | null; binding_version: number | null }>`
          SELECT q.report->>'exportArtifactId' AS checked_id, q.report->>'captureVersion' AS version,
            a.decision_payload->>'canvaBindingId' AS binding_id,
            (a.decision_payload->>'canvaBindingVersion')::integer AS binding_version
          FROM hawa.approvals a LEFT JOIN hawa.qc_runs q ON q.id = a.qc_run_id AND q.tenant_id = a.tenant_id
          WHERE a.tenant_id = ${input.tenantId}::uuid AND a.task_id = ${input.taskId}::uuid
            AND a.id = ${input.approvalId}::uuid AND a.decision = 'approved'`.execute(db)).rows[0];
        if (!approval?.checked_id || !approval.version || !approval.binding_id || !Number.isInteger(approval.binding_version)
          || !input.artifactIds.includes(approval.checked_id)) return null;
        const binding = (await sql<{ design_id: string; version: number }>`SELECT canva_design_id AS design_id, version
          FROM hawa.canva_bindings WHERE tenant_id = ${input.tenantId}::uuid AND task_id = ${input.taskId}::uuid
            AND id = ${approval.binding_id}::uuid AND status = 'bound'`.execute(db)).rows[0];
        if (!binding || Number(binding.version) !== Number(approval.binding_version)) return null;
        const rows = (await sql<{ id: string; actor_id: string; design_id: string; binding_version: number; capture_version: string | null }>`
          SELECT b.id, o.actor_id, o.design_id, o.binding_version,
            o.metadata->>'designUpdatedAt' AS capture_version
          FROM hawa.canva_export_bytes b JOIN hawa.canva_remote_operations o
            ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
          WHERE b.tenant_id = ${input.tenantId}::uuid AND b.task_id = ${input.taskId}::uuid
            AND b.id = ANY(${input.artifactIds}::uuid[])`.execute(db)).rows;
        if (rows.length !== input.artifactIds.length || rows.some(row =>
          row.design_id !== binding.design_id || Number(row.binding_version) !== Number(binding.version)
          || row.capture_version !== approval.version)) return null;
        const checked = rows.find(row => row.id === approval.checked_id);
        if (checked) {
          const current=(await sql<{current:boolean}>`SELECT bool_and(hawa.canva_export_policy_current(o.tenant_id,o.client_id,COALESCE(o.metadata,'{}'::jsonb) || jsonb_build_object('taskId',o.task_id))) AS current
            FROM hawa.canva_remote_operations o JOIN hawa.canva_export_bytes b ON b.operation_id=o.id AND b.tenant_id=o.tenant_id
            WHERE b.id=ANY(${rows.map(row=>row.id)}::uuid[]) AND b.tenant_id=${input.tenantId}::uuid`.execute(db)).rows[0];
          if (!current?.current) return null;
        }
        return checked ? { designId: binding.design_id, actorId: checked.actor_id, version: approval.version } : null;
      });
    } catch {
      return { ok: false, code: 'CANVA_DESIGN_CHECK_UNAVAILABLE',
        message: 'The approved Canva capture could not be checked in storage; retry before publication', retryable: true };
    }
    if (!proof) return unverified;
    try {
      const client = await this.authorizedClient({ tenantId: input.tenantId, actorId: proof.actorId });
      const { design } = await client.getDesign(proof.designId);
      if (design.id !== proof.designId || String(design.updated_at) !== proof.version) {
        return { ok: false, code: 'CANVA_DESIGN_CHANGED',
          message: 'Canva reports that the design changed after its approved capture; capture, check and approve it again', retryable: false };
      }
      return { ok: true, capturedVersion: proof.version, observedVersion: String(design.updated_at) };
    } catch {
      return { ok: false, code: 'CANVA_DESIGN_CHECK_UNAVAILABLE',
        message: 'Canva could not confirm the approved design version; retry or reconnect before publication', retryable: true };
    }
  }
}
export async function downloadCanvaExport(value: string, customFetch: typeof fetch = fetch): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    // `throw` (not the `fail` helper) so TypeScript's definite-assignment analysis sees the exit.
    throw new CanvaFlowError(422, 'CANVA_EXPORT_HOST_DENIED', 'Export URL is not an admitted Canva download host');
  }
  if (u.protocol !== 'https:' || !['export-download.canva.com','document-export.canva.com'].includes(u.hostname) || u.port || u.username || u.password) fail(422,'CANVA_EXPORT_HOST_DENIED','Export URL is not an admitted Canva download host');
  const response = await customFetch(u.href,{ redirect:'error',signal:AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail(502,'CANVA_EXPORT_DOWNLOAD_FAILED','Canva export download failed');
  const limit = 25*1024*1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body!.cancel(); fail(413,'CANVA_EXPORT_TOO_LARGE','Export exceeds 25 MB'); }
  const reader = response.body!.getReader(), chunks: Uint8Array[]=[]; let size=0;
  try { while (true) { const {done,value:chunk}=await reader.read(); if(done)break; size+=chunk.length;
    if(size>limit) { await reader.cancel(); fail(413,'CANVA_EXPORT_TOO_LARGE','Export exceeds 25 MB'); } chunks.push(chunk); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
