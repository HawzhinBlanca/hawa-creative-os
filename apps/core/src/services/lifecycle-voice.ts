/** One durable paid attempt per tenant/client/audio hash. No attempt is dispatched on replay. */
import { sql, type Kysely, type Database } from '@hawa/db';
import type { VoiceAudioInspection } from '@hawa/domain';
import type { KurdishVoiceTranscriber, VoiceTranscriptionResult } from '@hawa/integrations';
import { chaosPoint } from '@hawa/observability';
import { appendSourceRecord as append, readSourceRecord as read, sourceHash, SourceConflict,
  type SourceUpload } from './lifecycle-source-store.js';

type Tx = <T>(action: (trx: Kysely<Database>) => Promise<T>) => Promise<T>;
type Decision = { mode: 'manual'; reason: string } | { mode: 'transcribe'; key: string };
interface Attempt {
  key: string; clientId: string; sourceSha256: string; sourceUpdateId: number; day: string;
  deploymentId: string; deploymentVersion: string; model: 'whisper-1';
  dnaId: string; dnaHash: string; policyHash: string; estimatedMicrousd: number;
  languageHint: 'ckb' | 'ar' | 'en';
  adapterVersion: 'voice-raw-v1';
}
interface Outcome {
  key: string; sourceSha256: string; result: VoiceTranscriptionResult;
  transcriptSha256: string; actualUsd: null;
}
export interface SourceVoiceReview {
  state: 'manual' | 'received' | 'rejected' | 'uncertain'; message: string;
  transcript: string | null; estimatedUsd: number | null; actualUsd: null; attemptKey?: string;
  providerRequestId?: string | null;
}
const keyFor = (source: SourceUpload) => sourceHash(`voice-v1:${source.clientId}:${source.blob.sha256}`);
const lock = (trx: Kysely<Database>, tenantId: string, key: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:voice:${key}`},0))`.execute(trx);
const manual = (reason: string): SourceVoiceReview => ({ state: 'manual', message: reason,
  transcript: null, estimatedUsd: null, actualUsd: null });

export async function readVoiceReview(trx: Kysely<Database>, tenantId: string, source: SourceUpload): Promise<SourceVoiceReview> {
  const decision = await read<Decision>(trx, tenantId, 'lifecycle_voice_decision', source.updateId);
  if (!decision) return manual('Audio is retained. Transcription has not been admitted; listen to the original and review exact copy.');
  if (decision.mode === 'manual') return manual(decision.reason);
  const attempt = await read<Attempt>(trx, tenantId, 'lifecycle_voice_attempt', decision.key);
  const outcome = await read<Outcome>(trx, tenantId, 'lifecycle_voice_outcome', decision.key);
  if (!attempt || attempt.key !== keyFor(source) || attempt.clientId !== source.clientId || attempt.sourceSha256 !== source.blob.sha256)
    throw new SourceConflict('Voice attempt identity differs from the retained source');
  const estimate = attempt.estimatedMicrousd / 1_000_000;
  if (!outcome) return { state: 'uncertain', message: 'Transcription was admitted but its outcome is not recorded. It will not be retried. Listen to the original for manual copy review; the office must reconcile the paid call.',
    transcript: null, estimatedUsd: estimate, actualUsd: null, attemptKey: attempt.key };
  if (outcome.key !== attempt.key || outcome.sourceSha256 !== source.blob.sha256 || outcome.transcriptSha256 !== sourceHash(outcome.result.transcript))
    throw new SourceConflict('Voice outcome differs from its source or transcript hash');
  const received = outcome.result.audioStatus === 'transcribed' && outcome.result.providerOutcome === 'received';
  const state = received ? 'received' : outcome.result.providerOutcome === 'uncertain' ? 'uncertain' : 'rejected';
  return { state, transcript: received ? outcome.result.transcript : null, estimatedUsd: estimate, actualUsd: null,
    attemptKey: attempt.key, providerRequestId: outcome.result.providerRequestId, message: received ? 'Unreviewed transcription; listen to the original and correct every factual word before confirming copy.'
      : state === 'uncertain' ? 'The transcription outcome is uncertain. It will not be retried; use the original for manual copy review and ask the office to reconcile the call.'
        : 'Transcription did not produce usable text. It will not be retried automatically; listen to the original and supply reviewed copy.' };
}

/** Confirmation can close the source to future egress before a delayed upload retry reaches admission. */
export async function holdVoiceForManualReview(trx: Kysely<Database>, tenantId: string, source: SourceUpload) {
  await lock(trx, tenantId, keyFor(source));
  const prior = await read<Decision>(trx, tenantId, 'lifecycle_voice_decision', source.updateId);
  if (!prior) await append<Decision>(trx, tenantId, 'lifecycle_voice_decision', source.updateId,
    { mode: 'manual', reason: 'Copy was reviewed from the original before transcription admission; no cloud call will start on replay.' });
}

interface Dna { id: string; content_hash: string; dna: { privacy?: { modelEgressMode?: unknown; allowedProviders?: unknown } } }
interface Deployment { id: string; deployment_version: string; admission: string;
  policy_profile: { usdPerMinute?: unknown; maxUsdPerCall?: unknown; dailyUsdBudget?: unknown; maxCallsPerDay?: unknown } }
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

async function admit(trx: Kysely<Database>, tenantId: string, source: SourceUpload, audio: VoiceAudioInspection,
  providerConfigured: boolean): Promise<Attempt | null> {
  const key = keyFor(source);
  await lock(trx, tenantId, key);
  if (await read<Decision>(trx, tenantId, 'lifecycle_voice_decision', source.updateId)) return null;
  const decide = (decision: Decision) => append(trx, tenantId, 'lifecycle_voice_decision', source.updateId, decision);
  const hold = async (reason: string) => { await decide({ mode: 'manual', reason }); return null; };
  const cached = await read<Attempt>(trx, tenantId, 'lifecycle_voice_attempt', key);
  if (cached) { await decide({ mode: 'transcribe', key }); return null; }
  const client = await trx.selectFrom('clients').select(['id','model_egress_policy','default_language'])
    .where('id', '=', source.clientId).where('tenant_id', '=', tenantId).where('status', '=', 'active').forShare().executeTakeFirst();
  const dna = (await sql<Dna>`SELECT id,content_hash,dna FROM hawa.client_dna_versions WHERE tenant_id=${tenantId}::uuid
    AND client_id=${source.clientId}::uuid AND status='active' AND approved_by IS NOT NULL
    AND (effective_from IS NULL OR effective_from <= now()) AND (effective_until IS NULL OR effective_until > now()) FOR SHARE`.execute(trx)).rows[0];
  const policy = client?.model_egress_policy, privacy = dna?.dna.privacy;
  if (!client || !dna || !['approved_providers','evaluated_external_allowed'].includes(String(policy?.mode)) ||
      (policy?.allowedProviders !== undefined && (!Array.isArray(policy.allowedProviders) || !policy.allowedProviders.includes('openai'))) ||
      !['approved_providers','evaluated_external_allowed'].includes(String(privacy?.modelEgressMode)) ||
      !Array.isArray(privacy?.allowedProviders) || !privacy.allowedProviders.includes('openai'))
    return hold('Client privacy does not authorize cloud transcription. The original is retained for manual copy review; no audio was sent to a model.');
  const deployments = (await sql<Deployment>`SELECT * FROM hawa.lock_voice_deployments()`.execute(trx)).rows;
  const model = deployments[0], cost = model?.policy_profile;
  if (!model || !cost || (deployments.length > 1 && model.admission !== 'primary') || !model.deployment_version ||
      !positive(cost.usdPerMinute) || cost.usdPerMinute < 0.006 || cost.usdPerMinute > 1 ||
      !positive(cost.maxUsdPerCall) || !positive(cost.dailyUsdBudget) ||
      !positive(cost.maxCallsPerDay) || !Number.isSafeInteger(cost.maxCallsPerDay))
    return hold('No eligible transcription model with an explicit cost policy is admitted. The original is available for manual copy review.');
  if (!providerConfigured) return hold('Transcription is not configured. The original is available for manual copy review; no provider call was admitted.');
  const estimatedMicrousd = Math.ceil(audio.encodedSamples / 48_000 / 60) * Math.ceil(cost.usdPerMinute * 1_000_000);
  if (estimatedMicrousd > Math.min(cost.maxUsdPerCall, 0.10) * 1_000_000)
    return hold('This recording exceeds the admitted transcription cost per call. Use the original for manual copy review.');
  const day = (await sql<{ day: string }>`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`.execute(trx)).rows[0].day;
  await lock(trx, tenantId, `day:${day}`);
  const usage = (await sql<{ calls: string; reserved: string }>`SELECT count(*) AS calls,
    coalesce(sum((payload->>'estimatedMicrousd')::bigint),0)::text AS reserved FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id='lifecycle_voice_attempt' AND event_kind='lifecycle_voice_attempt'
      AND payload->>'day'=${day}`.execute(trx)).rows[0];
  if (Number(usage.calls) >= Math.min(cost.maxCallsPerDay, 1000) ||
      Number(usage.reserved) + estimatedMicrousd > Math.min(cost.dailyUsdBudget, 1) * 1_000_000)
    return hold('The daily transcription reservation limit is reached. No new paid call started; use manual copy review.');
  const attempt: Attempt = { key, clientId: source.clientId, sourceSha256: source.blob.sha256, sourceUpdateId: source.updateId,
    day, deploymentId: model.id, deploymentVersion: model.deployment_version, model: 'whisper-1',
    dnaId: dna.id, dnaHash: dna.content_hash, policyHash: sourceHash(JSON.stringify([policy, privacy, cost])),
    estimatedMicrousd, adapterVersion: 'voice-raw-v1', languageHint: client.default_language === 'en' || client.default_language === 'ar' ? client.default_language : 'ckb' };
  await append(trx, tenantId, 'lifecycle_voice_attempt', key, attempt);
  await decide({ mode: 'transcribe', key });
  return attempt;
}

export async function transcribeRetainedVoice(tx: Tx, tenantId: string, source: SourceUpload,
  audio: VoiceAudioInspection, bytes: Uint8Array, transcriber: KurdishVoiceTranscriber): Promise<SourceVoiceReview> {
  const key = process.env.OPENAI_API_KEY;
  const attempt = await tx(trx => admit(trx, tenantId, source, audio, Boolean(key && !key.startsWith('mock-'))));
  if (attempt) {
    await chaosPoint('core.voice.after-attempt', { updateId: source.updateId, attemptKey: attempt.key });
    const result = await transcriber.transcribe({ audioBuffer: bytes, audioMimeType: 'audio/ogg',
      durationSeconds: audio.durationSeconds, languageHint: attempt.languageHint,
      egressDecision: { clientId: source.clientId, dataClass: 'client_voice', mode: 'approved_providers', allowedProviders: ['openai'] } });
    await chaosPoint('core.voice.after-response', { updateId: source.updateId, attemptKey: attempt.key });
    await tx(trx => append<Outcome>(trx, tenantId, 'lifecycle_voice_outcome', attempt.key,
      { key: attempt.key, sourceSha256: source.blob.sha256, result, transcriptSha256: sourceHash(result.transcript), actualUsd: null }));
    await chaosPoint('core.voice.after-outcome', { updateId: source.updateId, attemptKey: attempt.key });
  }
  return tx(trx => readVoiceReview(trx, tenantId, source));
}
