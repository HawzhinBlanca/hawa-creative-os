/**
 * ADR-234: a client's consent to model readings of its messages, recorded by a human administrator.
 *
 * The intake router, the office reader, the copy reader (requester-intent-model.ts `egressAllowed`)
 * and voice transcription (lifecycle-voice.ts) send a client's words to a provider only when the
 * client's active DNA version is approved and its `privacy` admits that provider. Saving DNA through
 * POST /v1/clients/:id/dna leaves the new version unapproved, and no route approved one, so consent
 * could not be recorded without SQL.
 *
 * This action makes the next DNA version: the active DNA unchanged except `privacy.modelEgressMode`
 * and `privacy.allowedProviders` (other privacy fields are kept), its `version` and its commit
 * metadata. The acting administrator creates and approves it. The previous version is superseded. An
 * append-only hawa.audit_events row names who, why and the privacy before and after.
 *
 * Withdrawal is the same action with no providers (or mode `none` / `local_only`): it records
 * `local_only` with no providers, which every reader refuses.
 *
 * Replays: the request names the version it changes (`expectedVersion`). Sent again after it was
 * applied, the same request finds the version it made (the same DNA, made by the same administrator
 * from that version) and answers with it; any other request against a stale version is a conflict.
 */
import { sql, withRlsContext, type ClientRepository, type Database, type Kysely } from '@hawa/db';
import { isServiceUserId } from '@hawa/contracts';
import { canonicalJson, computeDnaHash, isValidUuid } from '../core-helpers.js';
import { egressAllowed } from './requester-intent-model.js';

export const MODEL_CONSENT_PROVIDERS = ['openai', 'google', 'anthropic'] as const;
type Provider = (typeof MODEL_CONSENT_PROVIDERS)[number];
type GrantMode = 'approved_providers' | 'evaluated_external_allowed';
type StoredMode = GrantMode | 'local_only';

export interface ModelConsentRequest { expectedVersion: number; mode: StoredMode; providers: Provider[]; reason: string }
export interface ModelConsentActor {
  authenticated: boolean; tenantId?: string; userId?: string; actorId?: string; role?: string; authMethod?: string;
}
export interface ModelConsentResult {
  clientId: string; version: number; previousVersion: number; changed: boolean; replayed: boolean;
  privacy: Record<string, unknown>; approvedBy: string; contentHash: string; modelReading: { openai: boolean };
}

export class ModelConsentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new ModelConsentError(status, code, message); };

/** Actors that are not a person: Core's own services, the workers and test principals. */
const SYNTHETIC_ACTORS = new Set(['anonymous', 'test_harness', 'hawa_worker', 'hawa_design_worker']);

/** The request, strictly: nothing but these four fields, so nothing else in the DNA can be named. */
export function parseModelConsentRequest(body: unknown): ModelConsentRequest {
  const invalid = (detail: string) => fail(400, 'MODEL_CONSENT_INVALID', detail);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Send expectedVersion, mode, providers and reason.');
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['expectedVersion', 'mode', 'providers', 'reason'].includes(k));
  if (extra.length) return invalid(`Only expectedVersion, mode, providers and reason may be sent (not ${extra.join(', ')}).`);
  if (!Number.isSafeInteger(b.expectedVersion) || (b.expectedVersion as number) < 1) return invalid('expectedVersion must be the active DNA version.');
  if (!['approved_providers', 'evaluated_external_allowed', 'local_only', 'none'].includes(String(b.mode)))
    return invalid('mode must be approved_providers, evaluated_external_allowed, local_only or none.');
  if (!Array.isArray(b.providers) || b.providers.length > MODEL_CONSENT_PROVIDERS.length ||
      !b.providers.every((p) => (MODEL_CONSENT_PROVIDERS as readonly unknown[]).includes(p)))
    return invalid(`providers must list only ${MODEL_CONSENT_PROVIDERS.join(', ')}.`);
  const providers = [...new Set(b.providers as Provider[])];
  if (providers.length !== b.providers.length) return invalid('providers must not repeat a provider.');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) return invalid('reason must say why, in 3 to 500 characters.');
  const withdraw = b.mode === 'none' || b.mode === 'local_only' || providers.length === 0;
  if (withdraw && providers.length) return invalid(`mode ${String(b.mode)} admits no provider; send providers [] to withdraw.`);
  return { expectedVersion: b.expectedVersion as number, mode: withdraw ? 'local_only' : b.mode as GrantMode,
    providers: withdraw ? [] : providers, reason };
}

/** Only a person holding the administrator role; never a service, worker or test principal. */
function humanAdministrator(actor: ModelConsentActor): { tenantId: string; userId: string; label: string } {
  if (!actor.authenticated || !actor.tenantId) return fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in as an office administrator.');
  if (actor.role !== 'administrator') return fail(403, 'MODEL_CONSENT_ADMINISTRATOR_REQUIRED', 'Only an office administrator can record a client\'s model consent.');
  const userId = actor.userId ?? '';
  if (!isValidUuid(userId) || isServiceUserId(userId) || SYNTHETIC_ACTORS.has(actor.actorId ?? 'anonymous') ||
      /^test_/.test(actor.actorId ?? '') || actor.authMethod === 'design_worker')
    return fail(403, 'HUMAN_ADMINISTRATOR_REQUIRED', 'Model consent is recorded by a person, not a service or test identity.');
  return { tenantId: actor.tenantId, userId, label: actor.actorId || userId };
}

/** The same identity rules, answered rather than thrown: null when the actor is not a human administrator. */
function humanAdministratorOrNull(actor: ModelConsentActor) {
  try { return humanAdministrator(actor); } catch (error) { if (error instanceof ModelConsentError) return null; throw error; }
}

/** Whether this person holds an active administrator membership of the tenant in Postgres (inside the caller's RLS context). */
async function activeAdministrator(trx: Kysely<Database>, tenantId: string): Promise<boolean> {
  return Boolean((await sql<{ ok: boolean }>`SELECT hawa.has_tenant_role(${tenantId}::uuid,
    ARRAY['administrator']::hawa.membership_role[]) AS ok`.execute(trx)).rows[0]?.ok);
}

interface DnaRow { id: string; version: number; dna: Record<string, unknown>; content_hash: string; created_by: string | null; approved_by: string | null }
const parsed = (dna: unknown) => (typeof dna === 'string' ? JSON.parse(dna) : dna) as Record<string, unknown>;
const privacyOf = (dna: Record<string, unknown>) =>
  dna.privacy && typeof dna.privacy === 'object' && !Array.isArray(dna.privacy) ? dna.privacy as Record<string, unknown> : null;
const hashable = (dna: Record<string, unknown>) => { const h = { ...dna }; delete h.__commitMessage; delete h.__createdBy; return h; };

/** The version this request makes from `from`: only privacy's two fields, the version and commit metadata differ. */
function nextDna(from: DnaRow, input: ModelConsentRequest, label: string): Record<string, unknown> {
  const dna = parsed(from.dna);
  const privacy = { ...(privacyOf(dna) ?? {}), modelEgressMode: input.mode, allowedProviders: input.providers };
  const what = input.providers.length ? `${input.mode} for ${input.providers.join(', ')}` : 'withdrawn (local_only)';
  return { ...dna, privacy, version: from.version + 1,
    __commitMessage: `Model reading consent ${what}, from version ${from.version} (ADR-234). Reason: ${input.reason}`,
    __createdBy: label };
}

async function activeRow(trx: Kysely<Database>, tenantId: string, clientId: string): Promise<DnaRow | undefined> {
  return (await sql<DnaRow>`SELECT id, version, dna, content_hash, created_by, approved_by FROM hawa.client_dna_versions
    WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND status = 'active' FOR UPDATE`.execute(trx)).rows[0];
}

export async function recordClientModelConsent(db: Kysely<Database>, clientRepo: ClientRepository, actor: ModelConsentActor,
  clientRef: string, body: unknown): Promise<ModelConsentResult & { code: string | null; dna: Record<string, unknown> }> {
  const admin = humanAdministrator(actor);
  const input = parseModelConsentRequest(body);
  const scope = { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' };
  const client = isValidUuid(clientRef) ? clientRef
    : await withRlsContext(db, scope, async (trx) => (await clientRepo.findByCode(admin.tenantId, clientRef, trx))?.id);
  if (!client) return fail(404, 'CLIENT_NOT_FOUND', `Client '${clientRef}' is not in this office.`);

  const outcome = await withRlsContext(db, { ...scope, clientId: client }, async (trx) => {
    // The role the credential claims must also be an active membership of this person in Postgres.
    if (!await activeAdministrator(trx, admin.tenantId)) return fail(403, 'HUMAN_ADMINISTRATOR_REQUIRED', 'This person is not an active administrator of the office.');
    const row = await trx.selectFrom('clients').select(['id', 'code', 'status']).where('tenant_id', '=', admin.tenantId)
      .where('id', '=', client).executeTakeFirst();
    if (!row || row.status !== 'active') return fail(404, 'CLIENT_NOT_FOUND', `Client '${clientRef}' is not an active client of this office.`);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`client-dna:${admin.tenantId}:${client}`}, 0))`.execute(trx);
    const active = await activeRow(trx, admin.tenantId, client);
    if (!active) return fail(409, 'CLIENT_DNA_REQUIRED', 'The client has no active DNA version to record consent on.');

    if (active.version !== input.expectedVersion) {
      // A replay: the version this same request made from expectedVersion, by this administrator.
      const from = await clientRepo.findDnaByVersion(admin.tenantId, client, input.expectedVersion, trx) as DnaRow | undefined;
      if (from && active.version === input.expectedVersion + 1 && active.created_by === admin.userId && active.approved_by === admin.userId &&
          canonicalJson(parsed(active.dna)) === canonicalJson(nextDna({ ...from, dna: parsed(from.dna) }, input, admin.label))) {
        return { row: active, previous: input.expectedVersion, changed: true, replayed: true, code: row.code };
      }
      return fail(409, 'DNA_VERSION_CONFLICT', `The active DNA version is ${active.version}, not ${input.expectedVersion}. Read it again before recording consent.`);
    }

    const current = parsed(active.dna);
    const before = privacyOf(current);
    if (active.approved_by && before?.modelEgressMode === input.mode &&
        canonicalJson(before?.allowedProviders ?? null) === canonicalJson(input.providers)) {
      return { row: active, previous: active.version, changed: false, replayed: false, code: row.code };
    }
    const dna = nextDna({ ...active, dna: current }, input, admin.label);
    const contentHash = computeDnaHash(hashable(dna));
    const saved = await clientRepo.saveDnaVersion({ tenantId: admin.tenantId, clientId: client, version: active.version + 1, dna,
      contentHash, createdBy: admin.userId, approvedBy: admin.userId, expectedVersion: active.version }, trx);
    await sql`INSERT INTO hawa.audit_events (tenant_id, actor_type, actor_id, action, resource_type, resource_id, client_id,
        reason, before_hash, after_hash, data)
      VALUES (${admin.tenantId}::uuid, 'user', ${admin.userId},
        ${input.providers.length ? 'client.model_consent.granted' : 'client.model_consent.withdrawn'},
        'client_dna_version', ${saved.id}, ${client}::uuid, ${input.reason}, ${active.content_hash}, ${contentHash},
        ${JSON.stringify({ adr: 'ADR-234', fromVersion: active.version, toVersion: active.version + 1,
          before, after: dna.privacy, previousApprovedBy: active.approved_by,
          actor: { userId: admin.userId, actorId: actor.actorId ?? null, authMethod: actor.authMethod ?? null, role: actor.role } })}::jsonb)`.execute(trx);
    return { row: { ...saved, dna } as unknown as DnaRow, previous: active.version, changed: true, replayed: false, code: row.code };
  });

  const dna = parsed(outcome.row.dna);
  const openai = await withRlsContext(db, { ...scope, clientId: client }, (trx) => egressAllowed(trx, admin.tenantId, client));
  return { clientId: client, version: outcome.row.version, previousVersion: outcome.previous, changed: outcome.changed,
    replayed: outcome.replayed, privacy: privacyOf(dna) ?? {}, approvedBy: outcome.row.approved_by ?? admin.userId,
    contentHash: outcome.row.content_hash, modelReading: { openai }, code: outcome.code, dna };
}

/** What the readers see now: the active version, whether it is approved, its privacy and the client's policy. */
export async function readClientModelConsent(db: Kysely<Database>, clientRepo: ClientRepository, actor: ModelConsentActor, clientRef: string) {
  if (!actor.authenticated || !actor.tenantId || !actor.userId) return fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in to the office.');
  if (!['administrator', 'operator', 'auditor'].includes(actor.role ?? '')) return fail(403, 'MODEL_CONSENT_FORBIDDEN', 'Office staff only.');
  const scope = { tenantId: actor.tenantId, userId: actor.userId, role: actor.role! };
  const client = isValidUuid(clientRef) ? clientRef
    : await withRlsContext(db, scope, async (trx) => (await clientRepo.findByCode(actor.tenantId!, clientRef, trx))?.id);
  if (!client) return fail(404, 'CLIENT_NOT_FOUND', `Client '${clientRef}' is not in this office.`);
  return withRlsContext(db, { ...scope, clientId: client }, async (trx) => {
    const policy = await trx.selectFrom('clients').select(['model_egress_policy']).where('tenant_id', '=', actor.tenantId!)
      .where('id', '=', client).executeTakeFirst();
    if (!policy) return fail(404, 'CLIENT_NOT_FOUND', `Client '${clientRef}' is not in this office.`);
    const active = (await sql<DnaRow & { created_at: string }>`SELECT id, version, dna, content_hash, created_by, approved_by, created_at
      FROM hawa.client_dna_versions WHERE tenant_id = ${actor.tenantId}::uuid AND client_id = ${client}::uuid AND status = 'active'`.execute(trx)).rows[0];
    const dna = active ? parsed(active.dna) : null;
    return { clientId: client, version: active?.version ?? null, approved: Boolean(active?.approved_by), approvedBy: active?.approved_by ?? null,
      privacy: dna ? privacyOf(dna) : null, commitMessage: typeof dna?.__commitMessage === 'string' ? dna.__commitMessage : null,
      clientPolicy: policy.model_egress_policy ?? null, modelReading: { openai: await egressAllowed(trx, actor.tenantId!, client) } };
  });
}

/**
 * ADR-239: a DNA save keeps the client's model consent only when it is safe to. POST /dna, /snapshots
 * and /dna/rollback used to save every new version with approved_by NULL, so egressAllowed() and voice
 * admission closed for the client with no word to anyone. Now, when the version it supersedes was
 * approved with a privacy block, the save is by a human administrator (the model-consent action's
 * identity rules and an active membership in Postgres) and its privacy block is canonically identical,
 * the new version is approved by that administrator, with an audit row. Any other save stays unapproved,
 * and the caller tells the Desk so (`modelReadingAfterSave`).
 */
export type DnaSaveVia = 'dna' | 'snapshot' | 'rollback';
export interface DnaSaveConsent { kept: boolean; reason: string | null }
export interface DnaSaveParams {
  tenantId: string; clientId: string; version: number; dna: Record<string, unknown>; contentHash: string;
  createdBy: string | null; expectedVersion?: number; via: DnaSaveVia;
}

const NO_CONSENT = 'This client has no administrator-approved consent to model reading. An administrator records it with the model-consent action (ADR-234).';
const NOT_ADMIN = 'Only an office administrator, signed in as a person, keeps the client\'s model consent when saving DNA. An administrator must record the consent again (ADR-234).';
const PRIVACY_CHANGED = 'The privacy block changed in this save, so the client\'s model consent was not carried over. An administrator must record it again (ADR-234).';
const VERSION_MOVED = 'The active DNA version changed during this save, so the client\'s model consent was not carried over.';

export async function saveDnaVersionKeepingConsent(trx: Kysely<Database>, clientRepo: ClientRepository, actor: ModelConsentActor,
  params: DnaSaveParams): Promise<{ saved: { id: string }; consent: DnaSaveConsent }> {
  // The consent action's lock: a save and a consent change for one client never interleave.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`client-dna:${params.tenantId}:${params.clientId}`}, 0))`.execute(trx);
  const active = await activeRow(trx, params.tenantId, params.clientId);
  const before = active?.approved_by && !isServiceUserId(active.approved_by) ? privacyOf(parsed(active.dna)) : null;
  const admin = humanAdministratorOrNull(actor);
  let reason: string | null = null;
  if (!active || !before) reason = NO_CONSENT;
  else if (active.version !== params.version - 1) reason = VERSION_MOVED;
  else if (canonicalJson(privacyOf(params.dna)) !== canonicalJson(before)) reason = PRIVACY_CHANGED;
  else if (!admin || admin.tenantId !== params.tenantId || !await activeAdministrator(trx, params.tenantId)) reason = NOT_ADMIN;
  const kept = reason === null && Boolean(admin);
  const saved = await clientRepo.saveDnaVersion({ tenantId: params.tenantId, clientId: params.clientId, version: params.version,
    dna: params.dna, contentHash: params.contentHash, createdBy: params.createdBy, approvedBy: kept ? admin!.userId : null,
    expectedVersion: params.expectedVersion }, trx) as { id: string };
  if (kept) {
    await sql`INSERT INTO hawa.audit_events (tenant_id, actor_type, actor_id, action, resource_type, resource_id, client_id,
        reason, before_hash, after_hash, data)
      VALUES (${params.tenantId}::uuid, 'user', ${admin!.userId}, 'client.model_consent.kept', 'client_dna_version', ${saved.id},
        ${params.clientId}::uuid, ${`An administrator saved client DNA through ${params.via} with the privacy block unchanged`},
        ${active!.content_hash}, ${params.contentHash},
        ${JSON.stringify({ adr: 'ADR-239', via: params.via, fromVersion: active!.version, toVersion: params.version, privacy: before,
          previousApprovedBy: active!.approved_by,
          actor: { userId: admin!.userId, actorId: actor.actorId ?? null, authMethod: actor.authMethod ?? null, role: actor.role } })}::jsonb)`.execute(trx);
  }
  return { saved, consent: { kept, reason } };
}

/**
 * What the readers see after a DNA save, through the real egressAllowed(): `{ openai: true }`, or
 * `{ openai: false, reason }` for the Desk to show, so model reading never switches off unseen.
 */
export async function modelReadingAfterSave(db: Kysely<Database>, scope: { tenantId: string; userId: string; role: string },
  clientId: string, consent: DnaSaveConsent): Promise<{ openai: boolean; reason?: string }> {
  const openai = await withRlsContext(db, { ...scope, clientId }, (trx) => egressAllowed(trx, scope.tenantId, clientId));
  if (openai) return { openai };
  return { openai, reason: consent.reason ?? 'The client\'s recorded consent or its model policy does not admit OpenAI.' };
}
