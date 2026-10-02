import { StudioVisualInputsRepository, StudioVisualInputsError } from '@hawa/db';
import { authorityPolicySha256, captureVisualInputs, restoreVisualInputs } from './visual-inputs.js';
import { captureRenderFontInputs, reserveStudioText, reserveStudioImage, type OpenAiStructuredResponse } from '@hawa/creative';
import { freshRoundIntent, StudioSubstepReplay, studioBindingText, studioSubstepKey, studioUsdMicros, type RecordedStudioAttempt, type StudioCallReservation } from '@hawa/domain';
import { currentStudioSubstep, inStudioSubstep, substepBindsAuthority, substepBindsRenderer } from './substeps.js';
import { assertWithinStudioSpendCap, chargeStudioSpendCap, inStudioSpendCap } from './spend-cap.js';
import { TaskGenerationBlockedError } from '@hawa/db';
import { assertTaskGenerationAllowed, assertStudioCallsResolved } from '../task-generation-guard.js';
import { assertNativeRevisionAdmission } from '../native-revision-handoff.js';
import { orderedAlbumImages } from '../lifecycle-album.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sql,
  withRlsContext,
  type BlobStore,
  type Database,
  type Kysely,
  DesignStudioRepository,
  ClientRulesRepository,
  formatClientRulesForPrompt,
  type DesignStudioStatus,
  type DesignStudioTier,
  type DesignStudioJudgeStatus,
  type DesignStudioCandidateStatus,
  type RecordCallStartParams,
} from '@hawa/db';
import {
  OpenAiStudioClient,
  OpenAiImageProvider,
  requestStudioArtImage,
  StudioArtAccountingError,
  NoEligibleCandidateError,
  eligibleCandidatesV3,
  type StudioLayoutV2,
  ExemplarRetrievalIndex, EXEMPLAR_RETRIEVAL_VERSION,
  studioReferenceFromRaw,
  creativeAssetPath,
  fontCoversText,
  fontFamilyScript,
  probeFontScripts,
} from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { resolveModel, resolveImageSettings, newStudioBudget, parseStudioBudget, StudioBudgetEvidenceError, OfficeDayExhaustedError, parseStudioImagery, parseStudioTier, type StudioImagery, type StudioTier } from '@hawa/domain';
import { resolveOrnamentSettings, imagePixelSize, settlePhotos, uprightPhotoDataUrl, negativeSpacePolicyIdentity, thumbnailPlaybookPrompt, type OrnamentSettings } from '@hawa/creative';
import { fitPhotoBoxesToImages, photoSelectionFromInstructions, photoRecipeOf, eligibleRecipes, artDirectionRulesFromRaw, pageGrammarFromRaw } from '@hawa/creative';

/**
 * ADR-238: a packaged reference's admitted display faces by script (`rules.typography.display.admitted`
 * when its policy is the guideline's), so hard QA holds the client to them. A free policy admits the
 * studio's whole set, as before.
 */
export function packagedAdmittedDisplayFonts(reference: Record<string, any>): { latin: string[]; arabic: string[] } | undefined {
  const display = reference?.rules?.typography?.display;
  if (display?.policy !== 'guideline' || !Array.isArray(display.admitted)) return undefined;
  const names = display.admitted.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0);
  const latin = names.filter((f: string) => fontFamilyScript(f) === 'latin');
  const arabic = names.filter((f: string) => fontFamilyScript(f) === 'arabic');
  return latin.length && arabic.length ? { latin, arabic } : undefined;
}
import { briefPhotoFacts } from './art-direction.js';
import { recordedPhotoSelection, studioCopyBlocks } from './design-quality.js';
import { requestedBackgroundFor } from './stages/brief.stage.js';
import { buildRunBriefContract, StudioBriefContractError, StudioRunStatusChangedError } from './brief-contract.js';
import { blockingBriefConflicts, briefContractIdentitySha256, verifyBriefContractIntegrity, type BriefProposalInput, type ExecutableBriefContract } from '@hawa/domain';
import { runDirectedEditStage, isModelTransportError, DirectedEditRefusal } from './stages/edit.stage.js';
import { PhotoCutouts, CUTOUT_WORDS, arrangeCutouts, alignFramedHeads, type PhotoFaces } from './photo-cutouts.js';
import { log } from '../../logging.js';
import { blobStoreFor, putToStore, readPreferringStore } from '../blob-store-context.js';
import { assertCurrentClientDesignReference, resolveClientDesignReference } from '../client-design-reference.js';
import { ClientExemplarsUnavailableError, clientPackOf, packagedReferenceExemplarManifest } from '../client-packs.js';

/** The owner's ornament settings; an invalid one is reported and the defaults stand. */
const ornamentSettings = (): OrnamentSettings => {
  try {
    return resolveOrnamentSettings();
  } catch (err) {
    log.error('[studio] ornament settings invalid, using the defaults:', err instanceof Error ? err.message : err);
    return resolveOrnamentSettings({});
  }
};

/**
 * A stored brief, with the marker the service writes when the client's reference photo reached the
 * run after the brief had already been written. It keeps the extra brief call to one per run and
 * records a photo that came too late to change anything.
 */
type LateReferenceBrief = CreativeBrief & { referenceRebrief?: 'applied' | 'too_late' };

/** The request asks for its photographs to appear in the design. */
export function asksForPictures(instructions: string | undefined): boolean {
  return /\b(picture|photo|photograph|image|portrait|headshot|pic)s?\b|وێنە|عکس|صورة|صور/i.test(instructions || '');
}

export function contentPhotoFromDataUrl(dataUrl: string): ContentPhoto {
  const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!m) throw new Error('Not an image data URL');
  const mimeType = (m[1] === 'image/jpg' ? 'image/jpeg' : m[1]) as ContentPhoto['mimeType'];
  const bytes = Buffer.from(m[2], 'base64');
  const size = imagePixelSize(bytes);
  return { dataUrl, bytes, mimeType, ...(size ? { width: size.width, height: size.height } : {}) };
}

/** A run's stage record, whether the driver returned JSON or text. */
const runStages = (run: { stages?: unknown }): Record<string, any> => {
  let stages = run.stages;
  if (typeof stages === 'string') {
    try { stages = JSON.parse(stages); } catch { return {}; }
  }
  // Migration 013 used [] for a new run. Named stage properties on that array vanish
  // in JSON.stringify, including a recovered paid brief. Preserve empty legacy runs as objects.
  if (Array.isArray(stages) && stages.length === 0) return {};
  return (stages as Record<string, any>) || {};
};
import { CanvaConnectService, CanvaFlowError } from '../canva-connect-service.js';
import { CanvaDesignPlanner, savedDesignCopy, classifyCopyScript } from '../canva-design-planner.js';
import { savedDesignCopyLocales } from '../saved-design-copy.js';
import { runsPipelineV3, PICTURE_ONLY_DIRECTIVE } from '../chat-intake.js';
import { StudioBudgetExhaustedError, isModelCallHoldError, type StageContext, type CandidateState, type CreativeBrief, type Concept, type ReferencePack, type CopyBlock, type ParityResult, type ContentPhoto } from './types.js';
import {
  runBriefStage,
  runConceptsStage,
  runLayoutsStage,
  runArtStage,
  runRenderStage,
  runCritiqueStage,
  runReviseStage,
  runTournamentStage,
  runCanaryStage,
  runQAStage,
  runTransferStage,
  runParityStage,
  runCritiqueStageV3,
  runReviseStageV3,
  runVisualReviewStageV3,
  runVisualRefinementStageV3,
  type VisualReviewStageRecord,
  runJudgeStageV3,
  judgeBriefForStageV3,
  rankStudioCandidatesV3,
  copyForStageV3,
  V3_CANDIDATE_SLOTS,
  pendingV3Concept,
} from './stages/index.js';
import { resolveStudioJudgeProtocol, resolveVisualReviewSettings, type StudioJudgeProtocol } from '@hawa/creative';

export type Scope = { tenantId: string; actorId: string; role?: string; clientId?: string };

class RequestOwnedImageUnavailable extends Error {}

/** ADR-142: the run's failure code when one request's reservation is larger than the run has left. */
export const STUDIO_RUN_LIMIT_TOO_SMALL = 'STUDIO_RUN_LIMIT_TOO_SMALL';
export const OFFICE_DAY_EXHAUSTED = 'OFFICE_DAY_EXHAUSTED';

const optionalImages = (error: unknown): string[] => {
  if (error instanceof RequestOwnedImageUnavailable) throw error;
  return [];
};

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The retained art and its provenance, which final QA checks the final layout against (ADR-123). */
const candidateArt = (row: { art_png?: Buffer | Uint8Array | null; art_provenance?: unknown }): Pick<CandidateState, 'artPng' | 'artProvenance'> => ({
  ...(row.art_png ? { artPng: Buffer.from(row.art_png) } : {}),
  ...(row.art_provenance ? { artProvenance: (typeof row.art_provenance === 'string' ? JSON.parse(row.art_provenance) : row.art_provenance) as Record<string, unknown> } : {}),
});

type StudioReplayCall = Pick<Awaited<ReturnType<DesignStudioRepository['getCallsForRun']>>[number],
  'id' | 'stage' | 'provider' | 'model' | 'status' | 'reservation' | 'call_ordinal' | 'has_retained_result'> &
  Partial<Pick<Awaited<ReturnType<DesignStudioRepository['getCallsForRun']>>[number],
    'substep_key' | 'substep_attempt' | 'binding_sha256' | 'cost_basis' | 'usd_estimate' | 'error_code'>>;
class RetainedStudioReply {
  constructor(readonly value: unknown) {}
}

const recordedStudioAttempt = (call: StudioReplayCall): RecordedStudioAttempt => ({
  callId: call.id, substep: call.substep_key ?? null, attempt: call.substep_attempt ?? null, ordinal: call.call_ordinal,
  stage: call.stage, provider: call.provider, model: call.model, status: call.status, retained: call.has_retained_result,
  costBasis: call.cost_basis ?? null, usd: Number(call.usd_estimate ?? 0), errorCode: call.error_code ?? null,
  requestSha256: call.reservation?.requestSha256 ?? null, bindingSha256: call.binding_sha256 ?? null,
});

/** Stable object-key order for the digest only; provider requests keep their original shape. */
const canonicalCallJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, (_key, child) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]))
      : child);
  if (!serialized) throw new TypeError('Studio model call input cannot be serialized.');
  return serialized;
};

type StudioFontProfile = { latin: string[]; arabic: string[] };

/** Reject a versioned brand font that the renderer would substitute or cannot draw for this copy. */
function qualifiedStudioFonts(reference: Record<string, any>, copyBlocks: CopyBlock[]): StudioFontProfile | undefined {
  if (reference.status !== 'active_client_dna') return undefined;
  const body = reference.rules.typography.formalBody as { latin: string; arabic: string };
  const display = reference.rules.typography.display.admitted as string[];
  const textFor = (script: CopyBlock['script']) => copyBlocks.filter((block) => block.script === script).map((block) => block.text).join('\n');
  const qualify = (family: string, text: string) => {
    const script = fontFamilyScript(family);
    let exact = false;
    try { exact = probeFontScripts(family)[script].verdict === 'exact' && fontCoversText(family, text).covers; }
    catch { /* A missing renderer or unreadable font cannot qualify a client brand. */ }
    if (!exact) {
      throw new CanvaFlowError(422, 'CLIENT_FONT_UNAVAILABLE',
        `The client font "${family}" cannot render the required text faithfully in Studio. Install and qualify that font before generating this design.`);
    }
  };
  if (textFor('latin')) qualify(body.latin, textFor('latin'));
  if (textFor('arabic')) qualify(body.arabic, textFor('arabic'));
  const profile: StudioFontProfile = { latin: [], arabic: [] };
  for (const family of display) {
    const script = fontFamilyScript(family);
    qualify(family, textFor(script));
    profile[script].push(family);
  }
  return profile;
}

/**
 * The official KAAE logo's path. Resolved inside @hawa/creative, from that package's own location,
 * because paths built here from cwd or from this file's depth under apps/core all missed in the
 * image: every studio design reached Canva with its logo box empty (both pilots of 2026-09-18).
 */
export function officialLogoPath(): string {
  return creativeAssetPath('logos/kaae-official-logo.png');
}

/**
 * Whether a run executes the v3 pipeline. The run's own record decides — it was fixed when the run
 * was created, from the chat the task came from. The global flag is honoured too, which covers runs
 * created before the decision was recorded.
 */
export function isPipelineV3Run(run: { request?: unknown }): boolean {
  const request: any = typeof run?.request === 'string' ? JSON.parse(run.request) : run?.request;
  return request?.pipelineV3 === true || process.env.DESIGN_PIPELINE_V3 === 'on';
}

export interface CreateStudioRunInput {
  width: number;
  height: number;
  tier?: StudioTier;
  imagery?: StudioImagery;
  previews?: number;
  holdForSelection?: boolean;
}

export interface DesignStudioServiceOptions {
  apiKey?: string;
  geminiApiKey?: string;
  fetcher?: typeof fetch;
  maxUsd?: number;
  maxCalls?: number;
  defaultTier?: 'standard' | 'premium';
  defaultImagery?: 'auto' | 'none' | 'generated';
  planner?: CanvaDesignPlanner;
  maxRetries?: number;
  /** Minutes without a write after which an unfinished run no longer holds a studio slot. */
  staleRunMinutes?: number;
  /** The file store candidate pictures are written to (ADR-035); HAWA_BLOB_DIR's when absent. */
  blobStore?: BlobStore | null;
}

export interface StudioResumeResult {
  runId: string;
  status: DesignStudioStatus;
  stage?: string;
  spentUsd?: number;
  planId?: string;
  designId?: string;
  message?: string;
  diagnostic?: string;
  winnerCandidateId?: string;
  judgeStatus?: DesignStudioJudgeStatus;
  /** A failure's code, when it has a more precise one than the worker would read from the text. */
  code?: string;
}

export class DesignStudioService {
  private repo: DesignStudioRepository;
  private visualInputRepo: StudioVisualInputsRepository;
  private inFlightResumes = new Map<string, Promise<StudioResumeResult>>();
  /** People cut out of client photos (ADR-032); unconfigured without CUTOUT_URL, and then photos stay framed. */
  private cutouts: PhotoCutouts;

  constructor(
    private db: Kysely<Database>,
    private canva?: CanvaConnectService,
    private options: DesignStudioServiceOptions = {}
  ) {
    this.blobs = blobStoreFor(db, options.blobStore);
    this.repo = new DesignStudioRepository(db, this.blobs);
    this.visualInputRepo = new StudioVisualInputsRepository(db, this.blobs);
    this.cutouts = new PhotoCutouts({ blobStore: this.blobs });
  }

  /** Where candidate pictures and cut-outs are stored (ADR-035); null keeps them in rows only. */
  private readonly blobs: BlobStore | null;

  private tx<T>(s: Scope, fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return withRlsContext(this.db, { tenantId: s.tenantId, userId: s.actorId, role: 'operator' }, fn);
  }

  /**
   * Builds the request context from task data, brand reference pack, and logo.
   */
  /**
   * Every image the request carries, in the order they arrived: photos sent on their own from the
   * same chat around it (each belongs to the nearest request in time), the one saved with the task
   * at intake, and photos that joined it afterwards (Telegram delivers text and photo as two
   * messages). A request re-sent as text alone, the same words as one sent with images within the
   * hour before, carries that one's images: on 2026-09-22 a client re-sent the brief at 14:49 without
   * re-attaching the portraits sent with it at 14:36, and the design got none.
   */
  private async requestImages(s: Scope, taskId: string, depth = 0): Promise<string[]> {
    const valid = (url: unknown): url is string => typeof url === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(url);
    const source = await this.tx(s, async (db) =>
      (
        await sql<{ data: any; created_at: string; request_id: string | null }>`SELECT e.data, t.created_at, t.request_id FROM hawa.task_events e
        JOIN hawa.tasks t ON t.id = e.task_id AND t.tenant_id = e.tenant_id
        WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid AND e.event_type='task.created'
        ORDER BY e.aggregate_version LIMIT 1`.execute(db)
      ).rows[0]
    );
    const payload = source?.data?.payload || source?.data || {};
    const myTime = source?.created_at ? new Date(source.created_at).getTime() : NaN;
    const found: Array<{ at: number; url: string }> = [];

    const own = payload.studioOptions?.referenceImageBase64 || payload.referenceImageBase64;
    if (valid(own)) found.push({ at: myTime, url: own });

    // RequestLifecycle fixes scope when it creates the task. Nearby unbound photos have no
    // verified request identity, so only images attached to this task may enter its design.
    if (source?.request_id) {
      const refs = await this.tx(s, async (db) =>
        (await sql<{ sha256: string; media_type: string; size: string }>`SELECT f.sha256, b.media_type, b.size
          FROM hawa.task_files f JOIN hawa.blobs b ON b.sha256 = f.sha256
          WHERE f.tenant_id = ${s.tenantId}::uuid AND f.task_id = ${taskId}::uuid
            AND f.role = 'reference_image'
          ORDER BY f.created_at, f.sha256`.execute(db)).rows);
      if (refs.length && !this.blobs) throw new RequestOwnedImageUnavailable('A request-owned image needs its durable blob store');
      if (payload.lifecycleAlbum) found.length = 0;
      // The request's own photos are the design's content ("using only the provided photos"). An album
      // whose stored files no longer match its manifest, or a photo of a type the Studio cannot read,
      // used to be turned into no images at all by the caller (optionalImages), and the design went on
      // without them. It stops the run instead, with the reason (2026-09-29).
      let ordered: typeof refs;
      try { ordered = orderedAlbumImages(payload.lifecycleAlbum, refs); }
      catch (error) {
        throw new RequestOwnedImageUnavailable(`The request's photos cannot be used: ${error instanceof Error ? error.message : String(error)}.`);
      }
      for (const ref of ordered) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(ref.media_type)) {
          throw new RequestOwnedImageUnavailable('A request-owned image has an unsupported stored media type');
        }
        let bytes: Buffer;
        try { bytes = await this.blobs!.read(ref.sha256, { verify: true }); }
        catch { throw new RequestOwnedImageUnavailable('A request-owned image is missing or corrupt'); }
        found.push({ at: myTime, url: `data:${ref.media_type};base64,${bytes.toString('base64')}` });
      }
      return [...new Set(found.map((item) => item.url))];
    }

    const channel = payload.sourceChannelId;
    // An hour back, not a day: a day's window let pictures from the day's earlier attempts, failed
    // or finished, merge into a new design.
    const minutes = Math.max(0, Number(process.env.HAWA_REFERENCE_MERGE_MINUTES_BEFORE || 60));
    // Text first, photos after, is as common as the reverse (2026-09-22, 14:36: the brief, then two
    // images 10 and 12 seconds later, saved as "awaiting request").
    const afterMinutes = Math.max(0, Number(process.env.HAWA_REFERENCE_MERGE_MINUTES_AFTER || 15));
    type ChatRow = { task_id: string; occurred_at: string; client_id: string | null; image: string | null; raw: string | null };
    let rows: ChatRow[] = [];
    if (typeof channel === 'string' && channel && (minutes > 0 || afterMinutes > 0)) {
      // Nearest the request first. Oldest first, a busy chat filled the limit with the window's
      // earliest rows and cut off the ones beside the request.
      rows = await this.tx(s, async (db) =>
        (
          await sql<ChatRow>`WITH me AS (SELECT created_at FROM hawa.tasks WHERE id=${taskId}::uuid AND tenant_id=${s.tenantId}::uuid)
          SELECT e.task_id, e.occurred_at, t.client_id,
                 e.data->'payload'->'studioOptions'->>'referenceImageBase64' AS image,
                 e.data->'payload'->>'rawRequestText' AS raw
          FROM hawa.task_events e
          JOIN hawa.tasks t ON t.id = e.task_id AND t.tenant_id = e.tenant_id, me
          WHERE e.tenant_id=${s.tenantId}::uuid AND e.event_type='task.created' AND e.task_id <> ${taskId}::uuid
            AND e.data->'payload'->>'sourceChannelId' = ${channel}
            AND e.occurred_at > me.created_at - make_interval(mins => ${minutes})
            AND e.occurred_at <= me.created_at + make_interval(mins => ${afterMinutes})
            AND (
              t.client_id IS NOT NULL
              OR (COALESCE(e.data->'payload'->>'autoGenerate', 'false') <> 'true'
                  AND e.data->'payload'->'studioOptions'->>'referenceImageBase64' IS NOT NULL
                  AND e.data->'payload'->'studioOptions'->>'referenceFor' IS NULL)
            )
          ORDER BY abs(extract(epoch FROM e.occurred_at - me.created_at)) ASC, e.occurred_at ASC LIMIT 40`.execute(db)
        ).rows
      );
      // Each orphan photo belongs to the request nearest to it in time, this one or another from
      // the same chat, so a photo between two requests goes to one of them, not both.
      const requests = rows.filter((r) => r.client_id).map((r) => new Date(r.occurred_at).getTime());
      for (const r of rows) {
        if (r.client_id || !valid(r.image)) continue;
        const at = new Date(r.occurred_at).getTime();
        const mineDistance = Math.abs(at - myTime);
        if (!requests.some((other) => Math.abs(at - other) < mineDistance)) found.push({ at, url: r.image });
      }
    }

    // A photo sent without a caption just after the request is saved as its own instruction-only
    // task pointing here (task 936c5c6f became a second full design run on 2026-09-19).
    const late = await this.tx(s, async (db) =>
      (
        await sql<{ data: any; occurred_at: string }>`SELECT e.data, e.occurred_at FROM hawa.task_events e
        WHERE e.tenant_id=${s.tenantId}::uuid AND e.event_type='task.created'
          AND e.data->'studioOptions'->>'referenceFor' = ${taskId}
        ORDER BY e.occurred_at ASC LIMIT 6`.execute(db)
      ).rows
    );
    for (const row of late) {
      const url = row.data?.studioOptions?.referenceImageBase64 || row.data?.payload?.studioOptions?.referenceImageBase64;
      if (valid(url)) found.push({ at: new Date(row.occurred_at).getTime(), url });
    }

    const ordered = found.sort((a, b) => a.at - b.at).map((f) => f.url).filter((u, i, all) => all.indexOf(u) === i);
    if (ordered.length || depth > 0) return ordered;

    // No image of its own: the same request sent earlier today from this chat, if it had some.
    const words = (t: unknown) => String(t || '').replace(/\s+/g, ' ').trim();
    const mine = words(payload.rawRequestText);
    if (!mine) return ordered;
    const earlier = rows
      .filter((r) => r.client_id && words(r.raw) === mine && new Date(r.occurred_at).getTime() < myTime)
      .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
    for (const r of earlier) {
      const inherited = await this.requestImages(s, r.task_id, depth + 1);
      if (inherited.length) return inherited;
    }
    return ordered;
  }

  /**
   * A change's words with the captions of its album's later photos. An album sent in reply to a draft
   * can carry its caption on a later photo; the first photo, with none, started the change as a
   * picture-only one. The captions are read here, after the album has settled (briefing), and replace
   * the picture-only sentence, or follow the change's own words.
   */
  private async directiveWithAlbumCaptions(s: Scope, taskId: string, directive: string): Promise<string> {
    const captions = await this.tx(s, async (db) =>
      (
        await sql<{ caption: string }>`SELECT e.data->'studioOptions'->>'albumCaption' AS caption FROM hawa.task_events e
          WHERE e.tenant_id = ${s.tenantId}::uuid AND e.event_type = 'task.created'
            AND e.data->'studioOptions'->>'referenceFor' = ${taskId}
            AND COALESCE(e.data->'studioOptions'->>'albumCaption', '') <> ''
          ORDER BY e.occurred_at ASC LIMIT 6`.execute(db)
      ).rows.map((r) => r.caption.trim()).filter(Boolean)
    ).catch(() => [] as string[]);
    if (!captions.length) return directive;
    const own = directive.trim() === PICTURE_ONLY_DIRECTIVE ? '' : directive.trim();
    return [own, ...captions].filter(Boolean).join('\n\n').slice(0, 2000);
  }

  /**
   * A request that came as an album: Telegram delivers each photo as its own message, a second or
   * so apart, and the brief could be written before the last ones were saved. The brief waits until
   * the album has been quiet for a few seconds (at most HAWA_ALBUM_SETTLE_MAX_MS after the request).
   */
  private async settleAlbum(s: Scope, taskId: string): Promise<void> {
    const quietMs = Number(process.env.HAWA_ALBUM_QUIET_MS || 4000);
    const maxMs = Number(process.env.HAWA_ALBUM_SETTLE_MAX_MS || 20000);
    const read = () =>
      this.tx(s, async (db) =>
        (
          await sql<{ album: string | null; created_at: Date; photos: number; newest: Date | null }>`
            SELECT o.payload->'studioOptions'->>'mediaGroupId' AS album, o.created_at,
              (SELECT count(*)::int FROM hawa.outbox_commands p WHERE p.tenant_id = o.tenant_id AND p.command_type = 'task.created'
                 AND p.payload->'studioOptions'->>'mediaGroupId' = o.payload->'studioOptions'->>'mediaGroupId') AS photos,
              (SELECT max(p.created_at) FROM hawa.outbox_commands p WHERE p.tenant_id = o.tenant_id AND p.command_type = 'task.created'
                 AND p.payload->'studioOptions'->>'mediaGroupId' = o.payload->'studioOptions'->>'mediaGroupId') AS newest
            FROM hawa.outbox_commands o
            WHERE o.tenant_id = ${s.tenantId}::uuid AND o.aggregate_id = ${taskId}::uuid AND o.command_type = 'task.created'
            ORDER BY o.created_at LIMIT 1`.execute(db)
        ).rows[0]
      ).catch(() => undefined);
    let row = await read();
    if (!row?.album) return;
    const deadline = new Date(row.created_at).getTime() + maxMs;
    while (Date.now() < deadline) {
      const newest = new Date(row.newest || row.created_at).getTime();
      if (Date.now() - newest >= quietMs) return;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(100, deadline - Date.now()))));
      row = (await read()) || row;
    }
  }

  /** The image the brief reads as a reference: the latest one the request carries, or undefined. */
  private async attachedImage(s: Scope, taskId: string): Promise<string | undefined> {
    const images = await this.requestImages(s, taskId);
    return images.length ? images[images.length - 1] : undefined;
  }

  private async getTaskContext(s: Scope, taskId: string, width: number, height: number) {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 640 && n <= 2400)) {
      throw new CanvaFlowError(422, 'DIMENSIONS_REQUIRED', 'Choose dimensions between 640 and 2400 pixels.');
    }

    const task = await this.tx(s, async (db) =>
      (
        await sql<any>`SELECT t.client_id, t.description,
        (SELECT e.data FROM hawa.task_events e WHERE e.task_id=t.id AND e.tenant_id=t.tenant_id AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
        FROM hawa.tasks t WHERE t.tenant_id=${s.tenantId}::uuid AND t.id=${taskId}::uuid`.execute(db)
      ).rows[0]
    );

    if (!task?.client_id) {
      throw new CanvaFlowError(422, 'CLIENT_REQUIRED', 'Select the client before retrieving brand references.');
    }

    const { reference, logo } = await resolveClientDesignReference(this.db, s, task.client_id);

    const content = savedDesignCopy(task.source, task.description || '');
    if (!content.copy.length || content.copy.join('').length > 16000) {
      throw new CanvaFlowError(422, 'COPY_UNSUPPORTED', 'This transfer supports bounded copy only. Review the source before generating.');
    }

    const copyScripts = content.copy.map(classifyCopyScript);
    if (copyScripts.includes('unsupported')) {
      throw new CanvaFlowError(
        422,
        'COPY_UNSUPPORTED',
        'This transfer sets English and Sorani Kurdish copy only; the request contains other scripts or symbols.'
      );
    }

    const copyLocales = savedDesignCopyLocales(task.source, content.copy);
    const copyBlocks: CopyBlock[] = studioCopyBlocks(content.copy, copyScripts, copyLocales);
    qualifiedStudioFonts(reference, copyBlocks);

    return {
      task,
      reference,
      content,
      copyBlocks,
      copyScripts,
      logo,
      logoAspect: logo.readUInt32BE(16) / (logo.readUInt32BE(20) || 1),
    };
  }

  /**
   * Claims or retrieves a design studio run with advisory locking, RLS isolation, and idempotency.
   */
  public async createOrGetRun(
    s: Scope,
    taskId: string,
    key: string,
    params: CreateStudioRunInput
  ): Promise<{ run: any; created: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new CanvaFlowError(422, 'REQUEST_KEY_REQUIRED', 'Use a stable studio generation request key (8-128 chars).');
    }

    const tier: DesignStudioTier =
      params.tier ||
      this.options.defaultTier ||
      (process.env.DESIGN_STUDIO_TIER_DEFAULT === 'standard' ? 'standard' : 'premium');

    const imagery =
      params.imagery ||
      this.options.defaultImagery ||
      parseStudioImagery(process.env.DESIGN_STUDIO_IMAGERY_DEFAULT) ||
      'auto';

    await this.tx(s, db => assertNativeRevisionAdmission(db, s.tenantId, taskId));
    const taskCtx = await this.getTaskContext(s, taskId, params.width, params.height);

    // Which pipeline a run uses is decided once, here, from the chat the task came from, and
    // recorded on the run so every later stage and every resume agrees. The key is omitted rather
    // than written false so a non-v3 run's request hash is unchanged from before it existed.
    const pipelineV3 = runsPipelineV3(taskCtx.task.source?.sourceChannelId);
    if (pipelineV3 && taskCtx.reference.status !== 'reference_for_draft_not_release_approval') {
      throw new CanvaFlowError(422, 'CLIENT_V3_PROFILE_REQUIRED',
        'This client has no admitted Studio v3 font and exemplar profile. Use the standard Studio path until its profile is qualified.');
    }
    const fresh = freshRoundIntent(taskCtx.task.source);
    // A change the client asked for on a design they received: the run edits that design.
    const sourceOptions = (taskCtx.task.source?.payload || taskCtx.task.source || {})?.studioOptions || {};
    const directed =
      pipelineV3 && typeof sourceOptions.parentTaskId === 'string' && typeof sourceOptions.revisionDirective === 'string' && sourceOptions.revisionDirective.trim()
        ? {
            parentTaskId: sourceOptions.parentTaskId as string,
            revisionDirective: (sourceOptions.revisionDirective as string).trim().slice(0, 2000),
            // The requester has answered a question about this change: it is not asked again.
            ...(sourceOptions.clarified === true ? { clarified: true } : {}),
            // The task whose question this change answers: its photos (an album sent with the change) join.
            ...(typeof sourceOptions.answers === 'string' && /^[0-9a-f-]{36}$/i.test(sourceOptions.answers) ? { answers: sourceOptions.answers } : {}),
            // The same design in another size (the task's variant), not a change.
            ...(typeof sourceOptions.reformat === 'string' && sourceOptions.reformat.trim() ? { reformat: sourceOptions.reformat.trim().slice(0, 40) } : {}),
          }
        : undefined;

    const requestPayload = {
      width: params.width,
      height: params.height,
      tier,
      imagery,
      previews: params.previews || 1,
      holdForSelection: Boolean(params.holdForSelection),
      copyBlocks: taskCtx.copyBlocks,
      instructions: taskCtx.content.instructions,
      clientId: taskCtx.task.client_id,
      referenceHash: hash(JSON.stringify(taskCtx.reference)),
      ...(taskCtx.reference.dnaVersion ? { dnaVersion: taskCtx.reference.dnaVersion } : {}),
      logoSha256: hash(taskCtx.logo),
      logoAspect: taskCtx.logoAspect,
      ...(pipelineV3 ? { pipelineV3: true } : {}),
      ...(directed ? { directed } : {}),
      // ADR-233: a new design of the same request (a redo, or changes sent while the first draft was made).
      // Recorded on the run, as `directed` is, so every stage and resume reads the same parent for photos.
      ...(fresh ? { fresh: { parentTaskId: fresh.parentTaskId, kind: fresh.kind } } : {}),
    };

    const requestHash = hash(JSON.stringify(requestPayload));

    return this.tx(s, async (db) => {
      // 1. Transaction-level advisory lock per tenant
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'design-studio:' + s.tenantId}, 0))`.execute(db);

      // 2. Lock task row FOR UPDATE to verify client scope immutability
      const lockedTask = (
        await sql<any>`SELECT client_id,state FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];

      if (!lockedTask || lockedTask.client_id !== taskCtx.task.client_id) {
        throw new CanvaFlowError(409, 'CLIENT_CHANGED', 'Client changed while references were retrieved.');
      }
      await assertCurrentClientDesignReference(db, s, taskCtx.reference);

      // 3. Check for existing run by request_key OR in-flight active run for this task.
      // A task keeps at most one unfinished run (unique index design_studio_one_active_run): it is
      // resumed or abandoned, never silently replaced. `stale`: the run has not moved for as long as
      // the Desk and /redo count a run as live (LIVE_RUN in services/live-run.ts).
      const staleMinutes = this.options.staleRunMinutes ?? 30;
      const prior = (
        await sql<any>`SELECT *, updated_at <= now() - make_interval(mins => ${staleMinutes}) AS stale FROM hawa.design_studio_runs
        WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid
          AND (request_key=${key} OR status NOT IN ('transferred', 'degraded', 'failed', 'abandoned'))
        ORDER BY created_at DESC LIMIT 1`.execute(db)
      ).rows[0];

      if (prior) {
        if (prior.request_key === key) {
          if (prior.request_hash !== requestHash || prior.actor_id !== s.actorId) {
            throw new CanvaFlowError(409, 'GENERATION_CONFLICT', 'A different generation already exists with this key.');
          }
          return { run: prior, created: false };
        }

        assertTaskGenerationAllowed(lockedTask.state);
        await assertStudioCallsResolved(db, s.tenantId, taskId);

        // Different key, but an active run is in flight
        if (!prior.stale) {
          throw new CanvaFlowError(
            409,
            'STUDIO_RUN_IN_PROGRESS',
            'A studio run is already in progress for this task. Resume or abandon it before starting another.'
          );
        }
        // A run nothing has advanced for that long was given up on (the worker stopped following it,
        // or a restart cut it off mid-stage). It is abandoned, as abandon() does, and the new run
        // starts. It refused every new run for ever until 2026-09-24, so /redo promised a design that
        // never came.
        await this.repo.updateRunStatus(prior.id, s.tenantId, 'abandoned', {
          diagnostic: `Abandoned by ${s.actorId}: no progress at '${prior.status}' for ${staleMinutes} minutes; a new run was requested`,
        }, db);
      }

      assertTaskGenerationAllowed(lockedTask.state);
      await assertStudioCallsResolved(db, s.tenantId, taskId);

      // 4. Verify task is not already bound to Canva
      const bound = (
        await sql`SELECT id FROM hawa.canva_bindings WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid`.execute(db)
      ).rows;
      if (bound.length > 0) {
        throw new CanvaFlowError(409, 'CANVA_ALREADY_BOUND', 'Edit the existing Canva design; studio generation never overwrites it.');
      }

      // 5. Concurrency check: max 2 active studio runs per tenant.
      // A whole run takes minutes and writes on every stage. One left unadvanced (a Desk run nobody
      // resumed, a run cut off by a crash) stops holding a tenant slot, so it cannot block other tasks.
      const activeRuns = (
        await sql<any>`SELECT count(*) AS n FROM hawa.design_studio_runs 
        WHERE tenant_id=${s.tenantId}::uuid AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')
          AND updated_at > now() - make_interval(mins => ${staleMinutes})`.execute(db)
      ).rows[0];

      if (Number(activeRuns.n) >= 2) {
        throw new CanvaFlowError(
          429,
          'STUDIO_BUSY',
          'Two studio designs are already in progress. Resume existing work before starting another.'
        );
      }

      // 6. Ensure model API key or fetcher is configured
      const apiKey = this.options.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey && !this.options.fetcher) {
        throw new CanvaFlowError(503, 'MODEL_NOT_CONFIGURED', 'Configure the requested design model first.');
      }

      // 7. Create run record
      const runId = randomUUID();
      // A finished design costs $0.33-0.78 in at most 10 calls (2026-09-23), so a cap of $6 and 40
      // calls let a run that was going wrong spend eight designs' worth before it stopped.
      let budget;
      try {
        budget = newStudioBudget(this.options.maxUsd ?? process.env.DESIGN_STUDIO_MAX_USD,
          this.options.maxCalls ?? process.env.DESIGN_STUDIO_MAX_CALLS);
      } catch (error) {
        if (error instanceof StudioBudgetEvidenceError) throw new CanvaFlowError(503, error.code, error.message);
        throw error;
      }

      const [run] = await db
        .insertInto('design_studio_runs')
        .values({
          id: runId,
          tenant_id: s.tenantId,
          task_id: taskId,
          client_id: taskCtx.task.client_id,
          actor_id: s.actorId,
          request_key: key,
          request_hash: requestHash,
          request: JSON.stringify(requestPayload),
          tier,
          status: 'briefing',
          budget: JSON.stringify(budget),
          stages: JSON.stringify({}),
        })
        .returningAll()
        .execute();

      return { run, created: true };
    });
  }

  /**
   * The pictures a run works with. A change to a design starts from that design's pictures, in
   * their order, with any new picture sent with the change after them: a revision's own lookup
   * found only its own new picture, or nothing once the look-back window had passed, and the edit
   * was refused for photos the design still showed.
   */
  private async imagesForRun(s: Scope, run: { task_id: string; request: unknown }): Promise<string[]> {
    const request = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request) as
      | { pipelineV3?: boolean; directed?: { parentTaskId?: string; answers?: string }; fresh?: { parentTaskId?: string } }
      | undefined;
    const own = await this.requestImages(s, run.task_id);
    // ADR-233: a fresh round (a redo, or changes sent while the first draft was made) is a new design of
    // the same request: it places the request's photos, from the design it follows back to the first.
    const parentTaskId = request?.pipelineV3 && request?.directed?.parentTaskId
      ? request.directed.parentTaskId : request?.fresh?.parentTaskId;
    if (!parentTaskId) return own;
    const parent = await this.revisionChainImages(s, parentTaskId).catch(optionalImages);
    // A change that answers a question carries the photos the question's task was sent with (an
    // album sent with the change was filed under that task, which is not in the chain).
    const answered = request?.directed?.answers ? await this.requestImages(s, request.directed.answers).catch(optionalImages) : [];
    const before = [...parent, ...answered.filter((url) => !parent.includes(url))];
    return [...before, ...own.filter((url) => !before.includes(url))];
  }

  /**
   * The pictures of a design and of every design it was a change to, back to the request that
   * brought them, in that order. A change to a change looked one design back, to a revision with no
   * pictures of its own and a look-back window long past, found none, and the edit removed both
   * portraits (2026-09-23, "0 of your 2 photos placed").
   */
  private async revisionChainImages(s: Scope, taskId: string, depth = 0): Promise<string[]> {
    const own = await this.requestImages(s, taskId);
    const parentTaskId = depth < 10 ? await this.parentTaskOf(s, taskId).catch(() => undefined) : undefined;
    // A version that answered a question carries the photos filed under the question's task (an album
    // sent with the change), as imagesForRun gives them to its own run. Left out here, a later change
    // or size of that version lost them and its layout pointed at a photo that was not there (review
    // of 2026-09-24).
    const answersTask = depth < 10 ? await this.answersOf(s, taskId).catch(() => undefined) : undefined;
    const answered = answersTask ? await this.requestImages(s, answersTask).catch(optionalImages) : [];
    const parent = parentTaskId && parentTaskId !== taskId ? await this.revisionChainImages(s, parentTaskId, depth + 1).catch(optionalImages) : [];
    const before = [...parent, ...answered.filter((url) => !parent.includes(url))];
    return [...before, ...own.filter((url) => !before.includes(url))];
  }

  /**
   * The task a revision task changes (undefined for a first design), and the task whose question it
   * answers, if any, from the request that created it.
   */
  /** The task a revision task changes, from the request that created it; undefined for a first design. */
  private async parentTaskOf(s: Scope, taskId: string): Promise<string | undefined> {
    return (await this.chainLinksOf(s, taskId)).parent;
  }

  /** The task whose question a revision task answers, if it answers one. */
  private async answersOf(s: Scope, taskId: string): Promise<string | undefined> {
    return (await this.chainLinksOf(s, taskId)).answers;
  }

  private async chainLinksOf(s: Scope, taskId: string): Promise<{ parent?: string; answers?: string }> {
    const row = await this.tx(s, async (db) =>
      (
        await sql<{ parent: string | null; answers: string | null; source: unknown }>`SELECT
            COALESCE(e.data->'payload'->'studioOptions'->>'parentTaskId', e.data->'studioOptions'->>'parentTaskId') AS parent,
            COALESCE(e.data->'payload'->'studioOptions'->>'answers', e.data->'studioOptions'->>'answers') AS answers,
            e.data AS source
          FROM hawa.task_events e
          WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid AND e.event_type='task.created'
          ORDER BY e.aggregate_version LIMIT 1`.execute(db)
      ).rows[0]
    );
    const uuid = (v: string | null | undefined) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);
    // A fresh round's parent (ADR-233) carries the request's photos as a revision's parent does.
    const fresh = freshRoundIntent(row?.source)?.parentTaskId;
    return { parent: uuid(row?.parent) ?? fresh, answers: uuid(row?.answers) };
  }

  /**
   * Whether this run shows the people in the client's photos cut out of their backgrounds: the
   * request or the change asks for it, the brief read the reference as cut-out portraits, or the
   * design being changed already shows them cut out.
   */
  private async cutoutsWanted(s: Scope, run: { request: unknown }, ctx: StageContext, stages: { brief?: unknown }): Promise<boolean> {
    const request = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request) as { directed?: { parentTaskId?: string; revisionDirective?: string } } | undefined;
    const brief = (stages.brief || {}) as { referenceNotes?: string; must?: string[]; imageRoles?: Array<{ role?: string; notes?: string }> };
    const words = [
      ctx.instructions,
      request?.directed?.revisionDirective,
      brief.referenceNotes,
      ...(brief.must || []),
      ...(brief.imageRoles || []).filter((r) => r.role === 'style_reference').map((r) => r.notes),
    ];
    if (words.some((w) => typeof w === 'string' && CUTOUT_WORDS.test(w))) return true;
    const parentTaskId = request?.directed?.parentTaskId;
    if (!parentTaskId) return false;
    const parent = await this.parentWinner(s, parentTaskId).catch(() => undefined);
    return Boolean(parent?.layout.photos?.some((p) => p.treatment === 'cutout'));
  }

  /**
   * What the earlier rounds of changes to a design asked for and made, oldest first: the asks each
   * run recorded as done, along the chain of revisions back to the first design.
   */
  private async earlierAsks(s: Scope, parentTaskId: string | undefined): Promise<string[]> {
    const chain: string[] = [];
    for (let id = parentTaskId; id && chain.length < 12 && !chain.includes(id); id = await this.parentTaskOf(s, id).catch(() => undefined)) chain.push(id);
    if (!chain.length) return [];
    const rows = await this.tx(s, async (db) =>
      (
        await sql<{ task_id: string; asks: unknown }>`SELECT r.task_id::text AS task_id, r.stages->'directed'->'asks' AS asks
          FROM hawa.design_studio_runs r
          WHERE r.tenant_id = ${s.tenantId}::uuid AND r.task_id = ANY(${chain}::uuid[]) AND r.status IN ('transferred', 'degraded')
          ORDER BY r.created_at`.execute(db)
      ).rows
    );
    const done: string[] = [];
    for (const id of [...chain].reverse()) {
      for (const row of rows.filter((r) => r.task_id === id)) {
        for (const a of Array.isArray(row.asks) ? (row.asks as Array<{ ask?: unknown; status?: unknown }>) : []) {
          if (a?.status === 'done' && typeof a.ask === 'string' && a.ask.trim() && !done.includes(a.ask.trim())) done.push(a.ask.trim());
        }
      }
    }
    return done;
  }

  /** The brief of the design a directed revision changes, or undefined when it is not one. */
  private async parentBrief(s: Scope, run: { request: unknown }): Promise<CreativeBrief | undefined> {
    const request = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request) as
      | { pipelineV3?: boolean; directed?: { parentTaskId?: string } }
      | undefined;
    if (!request?.pipelineV3 || !request?.directed?.parentTaskId) return undefined;
    const parent = await this.parentWinner(s, request.directed.parentTaskId).catch(() => undefined);
    if (!parent) return undefined;
    const parentRun = await this.repo.getRunById(parent.runId, s.tenantId).catch(() => undefined);
    const parentStages = parentRun ? (typeof parentRun.stages === 'string' ? JSON.parse(parentRun.stages) : parentRun.stages) : undefined;
    return parentStages?.brief || undefined;
  }

  /**
   * The design a revision changes: the winner of the latest finished run of the task the client
   * replied to (or, on resume, the candidate already chosen).
   */
  private async parentWinner(
    s: Scope,
    parentTaskId?: string,
    candidateId?: string
  ): Promise<{ runId: string; candidateId: string; layout: StudioLayoutV2; previewPng?: Buffer; artPng?: Buffer; concept: unknown } | undefined> {
    const row = await this.tx(s, async (db) =>
      (
        await sql<{ run_id: string; candidate_id: string; layouts: unknown; preview_png: Buffer | null; preview_sha256: string | null; art_png: Buffer | null; art_sha256: string | null; concept: unknown }>`SELECT r.id AS run_id, c.id AS candidate_id, c.layouts, c.preview_png, c.preview_sha256, c.art_png, c.art_sha256, c.concept
          FROM hawa.design_studio_runs r JOIN hawa.design_studio_candidates c ON c.id = r.winner_candidate_id AND c.tenant_id = r.tenant_id
          WHERE r.tenant_id = ${s.tenantId}::uuid
            AND ${candidateId ? sql`c.id = ${candidateId}::uuid` : sql`r.task_id = ${parentTaskId}::uuid AND r.status IN ('transferred', 'degraded')`}
          ORDER BY r.created_at DESC LIMIT 1`.execute(db)
      ).rows[0]
    );
    if (!row) return undefined;
    const layouts: StudioLayoutV2[] = (Array.isArray(row.layouts) ? row.layouts : []).map((l: unknown) => (typeof l === 'string' ? JSON.parse(l) : l));
    const layout = layouts[layouts.length - 1];
    if (!layout) return undefined;
    return {
      runId: String(row.run_id),
      candidateId: String(row.candidate_id),
      layout,
      previewPng: await this.repo.readCandidateImage(row, 'preview'),
      artPng: await this.repo.readCandidateImage(row, 'art'),
      concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
    };
  }

  /**
   * Refuses, for now, a revision of a design that is still being made. With no finished design to
   * edit, the revision was designed afresh at full cost while the design it changes was still on its
   * way. It stays at its stage and a later resume makes the edit. A parent run left unadvanced past
   * the stale window no longer holds it up, and a parent with no run in progress (all failed, or
   * none) is designed afresh as before.
   */
  private async refuseWhileParentRuns(s: Scope, parentTaskId: string): Promise<void> {
    if ((await this.activeRunsOfTask(s, parentTaskId)) > 0) {
      throw new CanvaFlowError(
        409,
        'PARENT_STILL_RUNNING',
        'The design this change is for is still being made. Resume this revision once that design is finished.'
      );
    }
  }

  /** A task's unfinished studio runs, less any left unadvanced past the stale window. */
  private async activeRunsOfTask(s: Scope, taskId: string): Promise<number> {
    const staleMinutes = this.options.staleRunMinutes ?? 30;
    const row = await this.tx(s, async (db) =>
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.design_studio_runs
          WHERE tenant_id = ${s.tenantId}::uuid AND task_id = ${taskId}::uuid
            AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')
            AND updated_at > now() - make_interval(mins => ${staleMinutes})`.execute(db)
      ).rows[0]
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Adds the office's standing rules for this client, said in chat or read from its guidelines.
   * Every stage reads promotedRules in its system prompt, so they reach the brief, the layouts, the
   * critique and the judge alike. A read failure stops the run: designing without rules the office
   * set is the silent failure this replaced.
   */
  private async withClientRules(s: Scope, ctx: StageContext, runStartedAt?: Date | string): Promise<StageContext> {
    // No database (a unit harness) means no rules to read; with one, a failed read stops the run.
    if (!ctx.clientId || typeof (this.db as { transaction?: unknown })?.transaction !== 'function') return ctx;
    // The rules as they stood when the run started: every stage re-read the current ones, so a rule
    // sent mid-run changed the critique and the judge but not the brief (audit 2026-09-27 #16).
    const startedAt = runStartedAt ? new Date(runStartedAt) : undefined;
    const rules = await this.tx(s, (db) => {
      const repo = new ClientRulesRepository(db);
      return startedAt && !Number.isNaN(startedAt.getTime())
        ? repo.listInForceAt(s.tenantId, ctx.clientId, startedAt)
        : repo.listActive(s.tenantId, ctx.clientId);
    });
    const text = formatClientRulesForPrompt(rules);
    if (!text) return ctx;
    ctx.clientRules = text;
    ctx.promotedRules = `${ctx.promotedRules}\n\n${text}`;
    return ctx;
  }

  /**
   * Builds the StageContext with wrapped clients that enforce ledger-insert-before-dispatch and budget caps.
   */
  private async createStageContext(
    s: Scope,
    run: any,
    currentStageName: string,
    currentBudget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    onSpendUpdate: (cost: number) => Promise<void>,
    replayCalls: StudioReplayCall[] = [],
    skipExemplarRetrieval = false,
    runHistory: StudioReplayCall[] = replayCalls,
  ): Promise<StageContext> {
    const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
    const fetchFn = this.options.fetcher || fetch;
    const apiKey = this.options.apiKey || process.env.OPENAI_API_KEY || 'mock-key';

    const baseClient = new OpenAiStudioClient({
      apiKey,
      fetcher: fetchFn,
      timeoutMs: 240000,
      retainedInputCount: requestSha256 => {
        for (const call of runHistory) {
          const reservation = (typeof call.reservation === 'string' ? JSON.parse(call.reservation) : call.reservation) as StudioCallReservation;
          if (reservation?.requestSha256 !== requestSha256 || reservation.policy !== 'studio-sol61-2026-09-30-v2-counted-images') continue;
          const count = reservation.nativeInputCount;
          if (!count || count.model !== 'gpt-6.1-sol' || count.object !== 'response.input_tokens') {
            throw new StudioVisualInputsError('The retained Sol image count cannot be verified. No transport is permitted.');
          }
          return { ...count, model: 'gpt-6.1-sol', object: 'response.input_tokens' };
        }
        return undefined;
      },
    });

    const baseArtProvider = new OpenAiImageProvider(apiKey, fetchFn);

    // A failed local receipt/snapshot write cannot authorize provider retry or a clean fallback.
    const account = async <T>(write: () => Promise<T>): Promise<T> => {
      try { return await write(); }
      catch (error) {
        if (isModelCallHoldError(error) || error instanceof StudioBudgetExhaustedError) throw error;
        throw new StudioArtAccountingError(error);
      }
    };
    const finalizeCall = (params: Parameters<DesignStudioRepository['finalizeCall']>[0]) =>
      account(() => this.repo.finalizeCall({ ...params, actorId: s.actorId }));
    const recordSpend = (cost: number) => account(() => onSpendUpdate(cost));
    // ADR-122: retained results are consumed by semantic substep and attempt. A persisted branch
    // or an interleaved failure no longer shifts every later result; a changed binding still holds.
    const replayLedger = new StudioSubstepReplay(replayCalls.map(recordedStudioAttempt), runHistory.map(recordedStudioAttempt));
    let boundContext: StageContext | undefined;
    let rendererIdentity: string | undefined;
    const renderer = () => {
      if (rendererIdentity) return rendererIdentity;
      try { rendererIdentity = captureRenderFontInputs().sha256; }
      catch { throw new StudioVisualInputsError('The current font and renderer basis cannot be verified. Restore it before continuing.'); }
      return rendererIdentity;
    };
    const replay = async (kind: 'structured' | 'image', stage: string, provider: string, model: string,
      reservation: StudioCallReservation, schema?: string): Promise<NonNullable<RecordCallStartParams['substep']>> => {
      const requestSha256 = reservation.requestSha256;
      // Parity is content-keyed (ADR-049): each distinct export check is its own substep.
      const substep = currentStageName === 'parity' && stage === 'parity'
        ? studioSubstepKey('parity', `request-${requestSha256.slice(0, 16)}`) : currentStudioSubstep(stage);
      const identities: Record<string, string> = { stage, provider, model, kind, capability: reservation.policy };
      if (schema) identities.schema = schema;
      if (substepBindsAuthority(substep, stage)) {
        if (!boundContext) throw new TypeError('A Studio model call ran before its stage context was built.');
        identities.authority = authorityPolicySha256(boundContext);
      }
      if (substepBindsRenderer(substep, stage)) identities.renderer = renderer();
      const bindingText = studioBindingText({ version: 1, substep, inputs: { request: requestSha256 }, identities, assets: [] });
      const bindingSha256 = hash(bindingText);
      const decision = replayLedger.next({ substep, stage, provider, model, kind, requestSha256, bindingSha256 });
      // Every ledger hold keeps the pipeline's hold code; resume reports unknown calls before this.
      if (decision.action === 'hold') {
        throw new CanvaFlowError(409, 'MODEL_STAGE_REPLAY_UNSAFE', `${decision.detail} Reconcile its saved results before continuing.`);
      }
      // A definite image refusal is reproduced as the same outcome, without transport or charge.
      if (decision.action === 'replay_refusal') throw new RetainedStudioReply(null);
      if (decision.action === 'reuse') {
        const retained = await account(() => this.repo.getRetainedCallResult(decision.callId, s.tenantId, s.actorId));
        if (!retained || retained.kind !== kind) throw new CanvaFlowError(409, 'MODEL_STAGE_REPLAY_UNSAFE', 'The interrupted stage has no matching retained result.');
        throw new RetainedStudioReply(kind === 'image' ? { ...(retained.payload as object), imageBuffer: retained.image } : retained.payload);
      }
      return { key: substep, attempt: decision.attempt, bindingText, bindingSha256 };
    };

    // PostgreSQL admits one logical call identity before transport. The ordinal fences two Core
    // processes that read the same run budget; parity is content-keyed because a transferred run's
    // budget is immutable and a changed Canva export must remain independently checkable.
    const admitCall = async (call: {
      id: string; stage: string; provider: string; model: string; input: unknown; reservation: StudioCallReservation;
      substep: NonNullable<RecordCallStartParams['substep']>;
    }) => {
      const callOrdinal = currentStageName === 'parity' ? null : currentBudget.calls + 1;
      const logicalCallSha256 = hash(canonicalCallJson({
        version: 1, runId: run.id, stage: call.stage, provider: call.provider,
        model: call.model, callOrdinal, input: call.input,
      }));
      try {
        await this.repo.recordCallStart({
          id: call.id,
          runId: run.id,
          tenantId: s.tenantId,
          actorId: s.actorId,
          stage: call.stage,
          provider: call.provider,
          model: call.model,
          requestedModel: call.model,
          callOrdinal,
          logicalCallSha256,
          reservation: call.reservation,
          substep: call.substep,
        });
      } catch (error) {
        if (error instanceof TaskGenerationBlockedError || error instanceof StudioBudgetEvidenceError) {
          throw new CanvaFlowError(409, error.code, error.message);
        }
        if (isModelCallHoldError(error) || error instanceof StudioBudgetExhaustedError) throw error;
        throw new StudioArtAccountingError(error);
      }
      currentBudget.calls++;
    };

    const checkReservation = (cost: number, reservation: StudioCallReservation) => {
      if (studioUsdMicros(cost) > studioUsdMicros(reservation.usd)) {
        throw new StudioBudgetEvidenceError('STUDIO_BUDGET_RESERVATION_EXCEEDED',
          'The provider cost exceeded its reservation. The receipt is saved; review pricing before continuing.');
      }
    };
    const complete = async <T>(invoke: (beforeDispatch: NonNullable<Parameters<OpenAiStudioClient['createStructuredCompletion']>[0]['beforeDispatch']>) => Promise<OpenAiStructuredResponse<T>>) => {
      const callId = randomUUID();
      let reservation: StudioCallReservation | undefined;
      let result: OpenAiStructuredResponse<T>;
      try {
        result = await invoke(async (body, nativeCount) => {
          const quoted = reserveStudioText(body, nativeCount);
          const parsed = JSON.parse(body) as { model: string; response_format?: { json_schema?: { name?: unknown } } };
          const schema = typeof parsed.response_format?.json_schema?.name === 'string' ? parsed.response_format.json_schema.name : undefined;
          const substep = await replay('structured', currentStageName, 'openai', parsed.model, quoted, schema);
          // ADR-237: work declared under a spending cap (the visual review) is refused here, unsent.
          assertWithinStudioSpendCap(quoted.usd);
          if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) throw new StudioBudgetExhaustedError();
          await admitCall({ id: callId, stage: currentStageName, provider: 'openai', model: parsed.model,
            input: { requestSha256: quoted.requestSha256 }, reservation: quoted, substep });
          reservation = quoted;
        });
      } catch (err: any) {
        if (err instanceof RetainedStudioReply) {
          // A retained answer was paid for once; it still counts against a declared spending cap.
          chargeStudioSpendCap(Number((err.value as OpenAiStructuredResponse<T> | null)?.receipt?.costUsd) || 0);
          return err.value as OpenAiStructuredResponse<T>;
        }
        // A refused quote/admission has no ledger row and must never be finalized as a paid call.
        if (!reservation) throw err;
        const billedUsd = Number(err?.costUsd) > 0 ? Number(err.costUsd) : 0;
        const uncertain = err?.isUncertain === true;
        const notAccepted = typeof err?.status === 'number' && err.status >= 400 && err.status < 500;
        await finalizeCall({ id: callId, tenantId: s.tenantId, responseId: err?.responseId,
          inputTokens: 0, outputTokens: 0, usdEstimate: billedUsd,
          costBasis: notAccepted ? 'not_accepted' : uncertain ? 'unavailable' : err?.costBasis ?? 'estimate',
          status: uncertain ? 'uncertain' : 'error',
          errorCode: uncertain ? (err.code || 'ACCEPTANCE_UNKNOWN') : (err.code || 'CALL_FAILED') });
        if (billedUsd > 0) await recordSpend(billedUsd);
        chargeStudioSpendCap(billedUsd);
        checkReservation(billedUsd, reservation);
        throw err;
      }
      const cost = result.receipt.costUsd;
      await finalizeCall({ id: callId, tenantId: s.tenantId, responseId: result.receipt.responseId,
        servedModel: result.receipt.servedModel, providerRequestId: result.receipt.xRequestId,
        responseSha256: result.receipt.sha256, latencyMs: result.receipt.latencyMs,
        attempts: result.receipt.attempts, inputTokens: result.receipt.inputTokens,
        cachedInputTokens: result.receipt.cacheReadTokens || 0, outputTokens: result.receipt.outputTokens,
        usdEstimate: cost, costBasis: result.receipt.costBasis ?? 'estimate', status: 'ok',
        retainedResult: { kind: 'structured', payload: result } });
      await recordSpend(cost);
      chargeStudioSpendCap(cost);
      checkReservation(cost, reservation!);
      return result;
    };
    const ledgerClient = {
      calculateCost: baseClient.calculateCost.bind(baseClient), circuitBreaker: baseClient.circuitBreaker,
      primaryModel: baseClient.primaryModel, fallbackModel: baseClient.fallbackModel,
      completeJson: <T>(params: Parameters<OpenAiStudioClient['completeJson']>[0]) =>
        complete<T>(beforeDispatch => baseClient.completeJson<T>({ ...params, beforeDispatch })),
      createStructuredCompletion: <T>(params: Parameters<OpenAiStudioClient['createStructuredCompletion']>[0]) =>
        complete<T>(beforeDispatch => baseClient.createStructuredCompletion<T>({ ...params, beforeDispatch })),
    };

    const ledgerArtProvider: Pick<OpenAiImageProvider, 'generateArt'> = {
      generateArt: async params => {
        // One image per admission. The verifier uses the same ledger-backed text client;
        // the bounded art controller cannot hide its second attempt inside the first receipt.
        // The art stage describes its reserved region in the frame these settings request (ADR-123).
        const settings = params.settings ?? resolveImageSettings();
        return baseArtProvider.generateArt({ ...params, settings, visionClient: ledgerClient,
          requestImage: async (selected, prompt) => {
            const callId = randomUUID();
            let reservation: StudioCallReservation | undefined;
            const started = Date.now();
            let result: Awaited<ReturnType<typeof requestStudioArtImage>>;
            try {
              result = await requestStudioArtImage(selected, prompt,
                selected.provider === 'google' ? params.geminiApiKey || process.env.GEMINI_API_KEY || '' : apiKey,
                fetchFn, async body => {
                  const quoted = reserveStudioImage(selected.provider, body);
                  const substep = await replay('image', 'art', selected.provider, selected.model, quoted);
                  if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
                  await admitCall({ id: callId, stage: 'art', provider: selected.provider, model: selected.model,
                    input: { requestSha256: quoted.requestSha256 }, reservation: quoted, substep });
                  reservation = quoted;
                });
            } catch (error) {
              if (error instanceof RetainedStudioReply) return error.value as Awaited<ReturnType<typeof requestStudioArtImage>>;
              if (!reservation) throw error;
              const uncertain = !!error && typeof error === 'object' && 'isUncertain' in error && error.isUncertain === true;
              await finalizeCall({ id: callId, tenantId: s.tenantId, inputTokens: 0, outputTokens: 0,
                usdEstimate: 0, status: uncertain ? 'uncertain' : 'error',
                errorCode: uncertain ? 'ACCEPTANCE_UNKNOWN' : 'ART_FAILED', latencyMs: Date.now() - started, attempts: 1 });
              throw error;
            }
            const cost = result?.costUsd ?? 0;
            await finalizeCall({ id: callId, tenantId: s.tenantId,
              responseId: result?.responseId, servedModel: result?.servedModel,
              providerRequestId: result?.xRequestId,
              responseSha256: result ? hash(result.imageBuffer) : null,
              inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0,
              images: result ? 1 : 0, usdEstimate: cost, status: result ? 'ok' : 'error',
              costBasis: !result ? 'not_accepted' : result.costSource === 'usage' || result.costSource === 'price_list' ? result.costSource : 'estimate',
              errorCode: result ? null : 'IMAGE_REQUEST_REJECTED', latencyMs: Date.now() - started, attempts: 1,
              ...(result ? { retainedResult: { kind: 'image' as const,
                payload: { ...result, imageBuffer: undefined }, image: result.imageBuffer } } : {}) });
            await recordSpend(cost);
            checkReservation(cost, reservation!);
            return result;
          },
        });
      },
    };

    const { reference, logo: logoBytes } = await resolveClientDesignReference(this.db, s, run.client_id, request.dnaVersion);
    if (request.clientId !== run.client_id || reference.clientId !== run.client_id ||
        hash(JSON.stringify(reference)) !== request.referenceHash ||
        hash(logoBytes) !== request.logoSha256) {
      throw new CanvaFlowError(409, 'CLIENT_REFERENCE_CHANGED',
        'The client reference changed after this Studio run was created. Abandon it and plan again.');
    }
    if (currentStageName !== 'parity') await assertCurrentClientDesignReference(this.db, s, reference);
    const packagedKaae = reference.status === 'reference_for_draft_not_release_approval';
    if (isPipelineV3Run(run) && !packagedKaae) {
      throw new CanvaFlowError(422, 'CLIENT_V3_PROFILE_REQUIRED',
        'This client has no admitted Studio v3 font and exemplar profile.');
    }
    let referencePack: ReferencePack;
    let promotedRules: string;
    let latinFont: string;
    let arabicFont: string;
    let exemplarPolicySha256: string | undefined;
    let exemplarManifest: unknown;
    let exemplarRetrieval: StageContext['exemplarRetrieval'];

    if (packagedKaae) {
      // Read the way the qualification reads it (shared), so both design with the same rules.
      const rules = studioReferenceFromRaw(reference);
      // ADR-238: the packaged reference's own logo rules (KAAE: 80px, clear space the height of its K)
      // and its admitted display faces, which hard QA then enforces as it does for a DNA client.
      const logoRules = reference.rules?.logoConstraints as { minimumWidthPx?: number; clearSpacePx?: number; clearSpaceShareOfHeight?: number } | undefined;
      const admitted = packagedAdmittedDisplayFonts(reference);
      referencePack = { palette: rules.palette, referenceFonts: { latin: rules.latinFont, arabic: rules.arabicFont },
        clientId: reference.clientId, referenceHash: request.referenceHash,
        ...(admitted ? { admittedDisplayFonts: admitted } : {}),
        ...(logoRules ? { logoConstraints: logoRules } : {}) };
      latinFont = rules.latinFont;
      arabicFont = rules.arabicFont;
      promotedRules = rules.promotedRules;
      // The client's own confirmed set, as its pack names it (ADR-127): the same KAAE manifest file,
      // so its policy hash is unchanged. No pack, or a pack naming no set, is refused rather than
      // designed on no exemplars (as a missing manifest was refused before the packs).
      let exemplarManifestPath: string;
      try {
        exemplarManifestPath = packagedReferenceExemplarManifest(run.client_id);
      } catch (err) {
        if (err instanceof ClientExemplarsUnavailableError) throw new CanvaFlowError(503, err.code, err.message);
        throw err;
      }
      exemplarManifest = JSON.parse(readFileSync(exemplarManifestPath, 'utf8'));
      exemplarPolicySha256 = hash(canonicalCallJson(exemplarManifest));
    } else {
      latinFont = reference.rules.typography.formalBody.latin;
      arabicFont = reference.rules.typography.formalBody.arabic;
      const admittedDisplayFonts = qualifiedStudioFonts(reference, request.copyBlocks as CopyBlock[]);
      referencePack = { palette: reference.rules.palette,
        referenceFonts: { latin: latinFont, arabic: arabicFont }, clientId: reference.clientId,
        admittedDisplayFonts,
        clientName: reference.clientName, dnaVersion: reference.dnaVersion,
        dnaContentHash: reference.dnaContentHash, logoAssetId: reference.logoAssetId,
        logoSha256: reference.logoSha256, logoConstraints: reference.rules.logoConstraints };
      promotedRules = JSON.stringify(reference.rules.layoutRules || []);
    }

    const exemplars: Array<{ path: string; label: string; sha256?: string; bytes?: Buffer; mimeType?: string }> = [];
    if (packagedKaae && !skipExemplarRetrieval) try {
      const retrievalIndex = new ExemplarRetrievalIndex({ manifest: exemplarManifest });
      // ADR-170: a brief with photos is shown the office's photo designs, of the recipes its photos
      // allow and the subject the brief names; one without keeps the typographic set, as before.
      const recordedBrief = runStages(run).brief as CreativeBrief | undefined;
      const photoCount = typeof recordedBrief?.photosSent === 'number' ? recordedBrief.photosSent : 0;
      const briefQuery = {
        text: [request.instructions, ...request.copyBlocks.map((b: CopyBlock) => b.text)].join('\n'),
        format: request.width === request.height ? '1:1' : request.width / request.height === 0.8 ? '4:5' : undefined,
        ...(photoCount > 0 ? {
          photoCount,
          subjects: recordedBrief?.subjectTags ?? [],
          eligibleRecipes: eligibleRecipes(briefPhotoFacts(recordedBrief, runStages(run).cutoutsWanted === true)),
        } : {}),
      };
      const available = new Map<string, { path: string; bytes: Buffer; sha256: string }>();
      const unavailableIds: string[] = [], availabilityWarnings: string[] = [];
      for (const item of retrievalIndex.getConfirmedExemplars()) {
        const archived = resolve(process.cwd(), item.path);
        const imgPath = creativeAssetPath(`exemplars/${item.filename}`, { optional: true }) ??
          (existsSync(archived) ? archived : undefined);
        let bytes: Buffer | undefined;
        if (imgPath) try { bytes = readFileSync(imgPath); } catch { /* Recorded below; never condition on unreadable bytes. */ }
        if (!bytes || !item.sha256 || hash(bytes) !== item.sha256) {
          unavailableIds.push(item.id);
          availabilityWarnings.push(`${bytes ? 'EXEMPLAR_BYTES_UNVERIFIED' : 'EXEMPLAR_FILE_MISSING'}:${item.id}`);
          continue;
        }
        available.set(item.id, { path: imgPath!, bytes, sha256: item.sha256 });
      }
      const retrieval = retrievalIndex.retrieveTopExemplars(briefQuery, 3, [...available.keys()]);
      exemplarRetrieval = { ...retrieval.evidence, loadedIds: retrieval.retrievedIds, unavailableIds,
        warnings: [...retrieval.evidence.warnings, ...availabilityWarnings] };
      for (const item of retrieval.retrievedExemplars) {
        const verified = available.get(item.id)!;
        // ADR-170: a photo exemplar's recipe is named with it, so the art director reads which technique it shows.
        const recipe = (item as { recipe?: string }).recipe;
        exemplars.push({ ...verified, label: `${item.filename}${recipe && recipe !== 'typographic' ? ` [recipe ${recipe}]` : ''}: ${item.descriptor}` });
      }
    } catch (err: any) {
      exemplarRetrieval = { algorithm: EXEMPLAR_RETRIEVAL_VERSION, manifestSha256: hash(JSON.stringify(exemplarManifest)),
        mode: 'empty', queryTokenCount: 0, matchedTokenCount: 0, eligibleCount: 0, matches: [], loadedIds: [], unavailableIds: [],
        warnings: ['EXEMPLAR_RETRIEVAL_FAILED: no verified selection was available.'] };
      log.error(
        `[design-studio] Exemplar images could not be loaded (${err?.message || err}); ` +
          `this design is being generated without exemplar conditioning.`
      );
    }
    if (packagedKaae && !skipExemplarRetrieval && !exemplars.length) {
      // In production this was silent: the layout model was conditioned on nothing and no one
      // could tell from the logs that the run had seen no exemplar at all.
      log.error(
        `[design-studio] No exemplar image resolved under ${creativeAssetPath('exemplars', { optional: true }) || 'packages/creative/assets/exemplars'}; ` +
          `run ${run.id} is being conditioned on no exemplar.`
      );
    }

    const logo = { bytes: logoBytes, sha256: reference.logoSha256, mimeType: 'image/png' as const };

    // The client's playbook (ADR-127). A thumbnail client's stages are all told the thumbnail rules
    // through the rules every stage reads, and its hard QA checks them. An announcement client's
    // rules, and so its pinned visual policy, are unchanged.
    // Who the client is goes to the v3 layout generator and the judge by name (its pack's profile):
    // their shared prompts no longer name KAAE. It is not added to the rules every stage reads, so a
    // client's pinned visual policy (ADR-112) does not change with it.
    const pack = clientPackOf(run.client_id);
    const playbook = pack?.playbook;
    const clientProfile = pack?.profile;
    if (playbook === 'video-thumbnail') {
      promotedRules = `${promotedRules}\n\n${thumbnailPlaybookPrompt({ width: request.width, height: request.height })}`;
    }

    const ctx: StageContext = {
      runId: run.id,
      tenantId: s.tenantId,
      taskId: run.task_id,
      clientId: run.client_id,
      actorId: s.actorId,
      width: request.width,
      height: request.height,
      tier: parseStudioTier(run.tier) ?? 'standard',
      instructions: request.instructions,
      copyBlocks: request.copyBlocks,
      referencePack,
      promotedRules,
      ...(clientProfile ? { clientProfile } : {}),
      ...(playbook === 'video-thumbnail' ? { playbook } : {}),
      latinFont,
      arabicFont,
      logoAspect: request.logoAspect || 1.0,
      logo,
      exemplars,
      exemplarPolicySha256,
      exemplarRetrieval,
      client: ledgerClient as any,
      artProvider: ledgerArtProvider as any,
      pipelineV3: isPipelineV3Run(run),
      imageryStrategy: (runStages(run).brief as CreativeBrief | undefined)?.imageryStrategy,
      requestedBackground: requestedBackgroundFor(runStages(run).brief, referencePack.palette),
      ornament: packagedKaae ? ornamentSettings() : undefined,
      // ADR-238: the client's page grammar, when its reference names one (KAAE's 2025 guideline).
      ...(packagedKaae && pageGrammarFromRaw(reference) ? { pageGrammar: pageGrammarFromRaw(reference) } : {}),
      style: (runStages(run).brief as CreativeBrief | undefined)?.styleSpec,
      // ADR-170: the client's house art-direction rules and the brief's subject, for the art director.
      artDirectionRules: artDirectionRulesFromRaw(reference),
      subjectTags: (runStages(run).brief as CreativeBrief | undefined)?.subjectTags,
      unconsumedRetainedCalls: () => replayLedger.unconsumed(),
    };
    boundContext = ctx;
    return ctx;
  }

  /**
   * Advances a design studio run by exactly one stage.
   * Interrupted runs resume from the current stage without duplicating prior stage calls.
   * Concurrent requests for the same run share the in-flight promise to prevent race conditions.
   */
  private async assertTaskCanGenerate(s: Scope, taskId: string, historicalParent?: unknown): Promise<void> {
    await this.tx(s, async db => {
      const task = (await sql<{state:string}>`SELECT state FROM hawa.tasks
        WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      assertTaskGenerationAllowed(task?.state);
      await assertNativeRevisionAdmission(db, s.tenantId, taskId, historicalParent);
    });
  }

  public async resume(s: Scope, taskId: string, runId: string): Promise<StudioResumeResult> {
    const lockKey = `${s.tenantId}:${taskId}:${runId}:${s.actorId}:${s.role || ""}`;
    const existing = this.inFlightResumes.get(lockKey);
    if (existing) {
      return await existing;
    }
    const execPromise = this.doResume(s, taskId, runId);
    this.inFlightResumes.set(lockKey, execPromise);
    try {
      return await execPromise;
    } finally {
      this.inFlightResumes.delete(lockKey);
    }
  }

  private async doResume(s: Scope, taskId: string, runId: string): Promise<StudioResumeResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) {
      throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    }
    if (run.task_id && taskId && run.task_id !== taskId) {
      throw new CanvaFlowError(403, 'TASK_SCOPE_MISMATCH', 'The studio run belongs to a different task.');
    }
    if (run.actor_id && s.actorId && run.actor_id !== s.actorId && s.role !== 'administrator' && s.role !== 'art_director') {
      throw new CanvaFlowError(403, 'ACTOR_SCOPE_MISMATCH', 'Studio run can only be resumed by the initiating actor or an administrator/art director.');
    }

    // Terminal statuses
    if (['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status)) {
      return {
        runId,
        status: run.status,
        planId: run.plan_id || undefined,
        message: run.diagnostic || `Run is ${run.status}.`,
        diagnostic: run.diagnostic || undefined,
      };
    }

    const nativeParent = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request)?.directed?.parentTaskId;
    await this.assertTaskCanGenerate(s, taskId, nativeParent);
    if (run.status === 'awaiting_selection') {
      await this.assertTaskCanGenerate(s, taskId);
      return {
        runId,
        status: 'awaiting_selection',
        message: 'Awaiting candidate selection before Canva transfer.',
      };
    }

    // A previous worker may have died after the provider accepted a call but before it saved the
    // answer. Its pre-dispatch row survives the restart. Never pay for that logical stage again
    // until an operator reconciles the unknown provider outcome.
    const priorCalls = await this.repo.getCallsForRun(runId, s.tenantId, undefined, s.actorId);
    const unresolvedCall = priorCalls.find((call) => call.status === 'uncertain');
    if (unresolvedCall) {
      throw new CanvaFlowError(409, 'MODEL_CALL_UNCERTAIN',
        `The ${unresolvedCall.stage} model call has an unknown outcome. Reconcile its provider result before resuming this run.`);
    }
    const stageCalls = priorCalls.filter((call) => call.stage === run.status || (run.status === 'laying_out' && call.stage === 'art'));
    // Legacy successes and billed errors without validated reusable output still require review.
    const alreadyPaid = stageCalls.find((call) =>
      (call.status === 'ok' && !call.has_retained_result) || (call.status === 'error' && Number(call.usd_estimate) > 0));
    if (alreadyPaid) {
      throw new CanvaFlowError(409, 'MODEL_STAGE_REPLAY_UNSAFE',
        `The ${run.status} stage has a recorded paid model call but no saved stage result. Review that call before starting a new run.`);
    }

    await this.assertTaskCanGenerate(s, taskId);

    const stages = runStages(run);
    const budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number } =
      typeof run.budget === 'string' ? JSON.parse(run.budget) : run.budget;
    // The whole stage is the replay pool; it replays only when it holds a retained result.
    if (stageCalls.some((call) => call.has_retained_result)) {
      const usage = await this.repo.getBudgetUsage(runId, s.tenantId, s.actorId);
      if (!usage || usage.accountedUsd === null || (usage.blocker && usage.blocker !== 'BUDGET_EXHAUSTED')) throw new CanvaFlowError(409, 'MODEL_STAGE_REPLAY_UNSAFE', 'The saved result budget history is incomplete.');
      budget.spentUsd = usage.accountedUsd;
      budget.calls = usage.admittedCalls;
    }

    const onSpendUpdate = async (cost: number) => {
      budget.spentUsd += cost;
      await this.repo.updateRunStatus(runId, s.tenantId, run.status, { budget });
    };

    const pinnedVisualInputs = await this.visualInputRepo.get(s, runId).catch(() => {
      throw new CanvaFlowError(409, 'STUDIO_VISUAL_INPUTS_UNSAFE', 'The saved visual basis cannot be read and verified. Restore its original storage before continuing.');
    });
    if (!pinnedVisualInputs && !['briefing', 'conceiving', 'laying_out'].includes(run.status)) {
      throw new CanvaFlowError(409, 'STUDIO_VISUAL_INPUTS_UNSAFE', 'This historical run has no pinned visual basis. Review its existing result before requesting a new revision.');
    }

    // Building the context reads the client's reference pack, and a missing pack now throws rather
    // than designing with defaults. Outside the try below that left the run in 'briefing' for the
    // worker to retry for ever, so it is marked failed here with the reason.
    let ctx: StageContext;
    try {
      ctx = await this.withClientRules(s, await this.createStageContext(s, run, run.status, budget, onSpendUpdate, stageCalls, Boolean(pinnedVisualInputs), priorCalls), run.created_at);
    } catch (err: any) {
      if (pinnedVisualInputs) throw new CanvaFlowError(409, 'STUDIO_VISUAL_INPUTS_UNSAFE',
        'The pinned design policy cannot currently be verified. Restore its original authorized inputs before continuing.');
      const diagnostic = `Stage context could not be built: ${err?.message || err}`;
      await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
      throw err;
    }
    // The handler at the end covers the reads and the re-briefs before the stage as well. An
    // exception from them (the image re-brief's model call, a picture that would not decode) used
    // to leave the run at its stage for the worker to poll until it gave up on it as stuck.
    try {
      if (pinnedVisualInputs) restoreVisualInputs(ctx, stages, pinnedVisualInputs);
      else {
        // An image the requester attached reaches the brief, which says what it is; a style reference
        // then reaches the layout generator, the critique and the judge. It was saved with every
        // Telegram task but only the legacy planner ever read it.
        // What each image is, the model decides by looking at it: the brief classifies every image the
        // request carries (photo to place, design to follow, logo). "I attached the panelists pictures
        // and a reference for the graphic" with three images is two photos and one reference; until
        // 2026-09-22 every image was a reference, and then a keyword turned every image into a photo.
        let briefSoFar = runStages(run).brief as LateReferenceBrief | undefined;
        if (run.status === 'briefing') await this.settleAlbum(s, run.task_id);
        // Turned upright once, here, so the brief, the face detector, the cut-out, the preview and the deck
        // all see a phone photo the right way up (the renderer ignores a JPEG's orientation tag).
        const images = await Promise.all(
          (await this.imagesForRun(s, run).catch(optionalImages)).map((url) => uprightPhotoDataUrl(url).catch(() => url))
        );
        const roles = briefSoFar?.imageRoles;
        let classified = false;
        if (
          roles && roles.length > 0 && images.length > roles.length && run.status === 'conceiving' &&
          !(briefSoFar as { imagesRebrief?: boolean } | undefined)?.imagesRebrief
        ) {
          // A picture joined the request after its brief was written and before any layout (the
          // reference sent a few seconds after the album): the brief is written again, once, looking at
          // every picture, so each is classified instead of guessed from the request's words.
          ctx.requestImages = images;
          ctx.attachedImage = undefined;
          const reread = await inStudioSubstep('brief/images-rebrief', () => runBriefStage(ctx));
          const photosSent = (reread.imageRoles || []).filter((r) => r.role === 'content_photo').length;
          stages.brief = { ...reread, photosSent, photoSelection: photoSelectionFromInstructions(ctx.instructions, photosSent), imagesRebrief: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'conceiving', { stages, budget });
          stages.brief = await this.briefAsStored(s, runId, stages.brief);
          briefSoFar = stages.brief as LateReferenceBrief;
          ctx.requestImages = undefined;
        }
        const rolesNow = briefSoFar?.imageRoles;
        if (rolesNow && images.length > 0 && rolesNow.length === images.length) {
          classified = true;
          ctx.photos = rolesNow.filter((r) => r.role === 'content_photo').map((r) => ({
            ...contentPhotoFromDataUrl(images[r.index]),
            notes: r.notes,
            // ADR-170: the brief's photo review, for the art director's hero choice.
            ...(r.subjectFit || r.shot || r.quietArea ? { review: { ...(r.subjectFit ? { subjectFit: r.subjectFit } : {}), ...(r.shot ? { shot: r.shot } : {}), ...(r.quietArea ? { quietArea: r.quietArea } : {}) } } : {}),
          }));
          const ref = rolesNow.find((r) => r.role === 'style_reference');
          ctx.attachedImage = ref ? images[ref.index] : undefined;
          if (ref) ctx.reference = { dataUrl: images[ref.index], notes: ref.notes || briefSoFar?.referenceNotes || '' };
        } else if (images.length > 1 && run.status === 'briefing') {
          // The brief below looks at all of them.
          ctx.requestImages = images;
          ctx.attachedImage = undefined;
        } else if (images.length > 1) {
          // A brief written before images were classified, or images that arrived after it: the request's
          // own words decide, as before.
          if (asksForPictures(ctx.instructions)) ctx.photos = images.map((dataUrl) => contentPhotoFromDataUrl(dataUrl));
          else ctx.attachedImage = images[images.length - 1];
        } else {
          // Upright and renderable like the run's other images: this one image went to the brief sideways.
          const own = await this.attachedImage(s, run.task_id);
          ctx.attachedImage = own ? await uprightPhotoDataUrl(own).catch(() => own) : undefined;
        }
        // A photo that arrived after the brief ran came without a caption, right after the request, so
        // it was sent to be followed. Taken here because the re-read below sets referenceSeen true.
        const joinedLate = briefSoFar?.referenceSeen === false || Boolean(briefSoFar?.referenceRebrief);
        // At 'briefing' the brief has not been written yet and the stage below reads the image itself.
        if (!classified && ctx.attachedImage && run.status !== 'briefing' && briefSoFar?.referenceSeen === false && !briefSoFar.referenceRebrief) {
          briefSoFar = await this.rereadBriefWithLateReference(s, run, ctx, stages, budget, briefSoFar);
        }
        // Only the brief calling the photo the client's own logo stops the run from following it.
        if (!classified && ctx.attachedImage && (briefSoFar?.referenceRole === 'style_reference' || (joinedLate && briefSoFar?.referenceRole !== 'logo'))) {
          ctx.reference = { dataUrl: ctx.attachedImage, notes: briefSoFar?.referenceNotes || '' };
        }

        ctx.photoSelection = recordedPhotoSelection(stages.brief, ctx.photos?.length ?? 0); // ADR-157

        // People cut out of their photos (ADR-032), when the request, the brief's reading of the
        // reference, or the design being changed calls for them. They are made once, at the layout
        // stage, and read back from the store at every stage after it, so the design a run shows never
        // changes under it. A photo whose cut-out failed its checks stays framed, and the note says why.
        if (ctx.photos?.length && this.cutouts.configured && run.status !== 'briefing') {
          if (stages.cutoutsWanted === undefined) stages.cutoutsWanted = await this.cutoutsWanted(s, run, ctx, stages);
          if (stages.cutoutsWanted) {
            const loaded = await this.cutouts.forPhotos((fn) => this.tx(s, fn), s.tenantId, ctx.photos, { compute: run.status === 'laying_out' });
            ctx.photoCutouts = loaded.assets;
            ctx.cutoutOutcomes = loaded.outcomes;
            if (run.status === 'laying_out') stages.cutouts = loaded.outcomes;
          }
          // Where the people are in each photo, so a framed photo is cropped around faces rather than
          // from its centre (a tall portrait in a square box lost the heads). Found once, at the layout.
          if (run.status === 'laying_out' && !Array.isArray(stages.photoFocus)) {
            stages.photoFocus = (await this.cutouts.focusFor(ctx.photos)).map((f) => f ?? null);
          }
          // Each photo's own pixel size, so the requester can be told when one is shown much larger than
          // it is and will look soft (plan 4.4); nothing invents the missing detail on a person's photo.
          if (run.status === 'laying_out' && !Array.isArray(stages.photoSizes)) {
            stages.photoSizes = ctx.photos.map((p) => (p.width && p.height ? { width: p.width, height: p.height } : null));
          }
        }

        if (run.status === 'laying_out') {
          const proposed = await captureVisualInputs(ctx, stages);
          let saved;
          try { saved = await this.visualInputRepo.pin(s, runId, proposed); }
          catch { throw new StudioVisualInputsError('Visual inputs could not be committed. No layout call is permitted until they are retained.'); }
          restoreVisualInputs(ctx, stages, saved);
        }
      }

      // Included in the run's normal stage snapshot for operator diagnostics; the
      // immutable visual bundle remains the authority after layout preparation.
      if (ctx.exemplarRetrieval) stages.exemplarRetrieval = ctx.exemplarRetrieval;

      // The copy as this run changed it (a change of wording, or one an earlier round made): every
      // stage after the edit renders, checks and transfers these words, not the request's.
      if (Array.isArray(stages.effectiveCopy) && stages.effectiveCopy.length === ctx.copyBlocks.length) ctx.copyBlocks = stages.effectiveCopy;

      switch (run.status) {
        case 'briefing': {
          // A change to a design the client received keeps that design's brief: the same reading of
          // its pictures (which are photos, which is the reference) and the same style decisions.
          // Briefing it afresh could sort the pictures differently, and the edit would then be
          // refused for a photo count that no longer matches the design.
          const directedBrief = await this.parentBrief(s, run);
          if (directedBrief) {
            stages.brief = { ...directedBrief, briefFromParent: true };
            await this.repo.updateRunStatus(runId, s.tenantId, 'conceiving', { stages, budget });
            return { runId, status: 'conceiving', stage: 'brief', spentUsd: budget.spentUsd };
          }
          // A parent still being made has no brief yet; this run waits for it rather than pay for one
          // of its own that could read the pictures differently.
          const directedParent = (
            (typeof run.request === 'string' ? JSON.parse(run.request) : run.request) as { directed?: { parentTaskId?: unknown } } | undefined
          )?.directed?.parentTaskId;
          if (ctx.pipelineV3 && typeof directedParent === 'string') await this.refuseWhileParentRuns(s, directedParent);
          const brief = await inStudioSubstep('brief/request', () => runBriefStage(ctx));
          // Recorded on the run so the requester's note can say what became of their photos.
          const photosSent = (brief.imageRoles || []).filter((r) => r.role === 'content_photo').length || (ctx.photos?.length ?? 0);
          // ADR-157: "choose the best photos" and its like, read from the requester's words, no call.
          const photoSelection = photoSelectionFromInstructions(ctx.instructions, photosSent);
          stages.brief = { ...brief, photosSent, photoSelection };
          await this.repo.updateRunStatus(runId, s.tenantId, 'conceiving', { stages, budget });
          return { runId, status: 'conceiving', stage: 'brief', spentUsd: budget.spentUsd };
        }

        case 'conceiving': {
          const brief: CreativeBrief = stages.brief;
          // A revision edits the design the client received, when that design can be found.
          const directedRequest = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request)?.directed;
          if (ctx.pipelineV3 && directedRequest && !stages.directedFailed) {
            const parent = await this.parentWinner(s, directedRequest.parentTaskId);
            if (parent) {
              const id = randomUUID();
              await this.repo.insertCandidate({ id, runId: run.id, tenantId: s.tenantId, ordinal: 0, concept: parent.concept as Record<string, unknown>, status: 'draft' });
              stages.concepts = [];
              stages.directed = { parentRunId: parent.runId, parentCandidateId: parent.candidateId, candidateId: id, directive: await this.directiveWithAlbumCaptions(s, run.task_id, directedRequest.revisionDirective) };
              await this.repo.updateRunStatus(runId, s.tenantId, 'laying_out', { stages, budget });
              return { runId, status: 'laying_out', stage: 'concepts', spentUsd: budget.spentUsd };
            }
            await this.refuseWhileParentRuns(s, directedRequest.parentTaskId);
            log.warn(`[studio] run ${run.id}: no finished design found for parent task ${directedRequest.parentTaskId}; the revision is designed afresh.`);
          }
          // A v3 run's layout call invents its own three archetypes and never reads these
          // concepts, so it spends nothing here: it reserves a row per layout the generator
          // returns, and each row's concept is filled from what the generator produced.
          const concepts = ctx.pipelineV3 ? [] : await inStudioSubstep('concepts/board', () => runConceptsStage(ctx, brief));
          stages.concepts = concepts;
          const slots = ctx.pipelineV3 ? V3_CANDIDATE_SLOTS : concepts.length;

          // Create candidates in DB
          for (let i = 0; i < slots; i++) {
            await this.repo.insertCandidate({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              ordinal: i,
              concept: (concepts[i] ?? pendingV3Concept(i)) as any,
              status: 'draft',
            });
          }

          await this.repo.updateRunStatus(runId, s.tenantId, 'laying_out', { stages, budget });
          return { runId, status: 'laying_out', stage: 'concepts', spentUsd: budget.spentUsd };
        }

        case 'laying_out': {
          const brief: CreativeBrief = stages.brief;
          const concepts: Concept[] = stages.concepts;
          // Every run records the negative-space policy its layouts are asked for and scored by, a
          // directed revision included (ADR-125); an afresh run's contract carries it as well.
          stages.policies = [negativeSpacePolicyIdentity()];
          let inherited: CopyBlock[] | undefined;
          if (stages.directed && !stages.directedFailed) {
            const parent = await this.parentWinner(s, undefined, stages.directed.parentCandidateId);
            try {
              if (!parent) throw new Error('The design being revised could not be read.');
              const directedRequest = (typeof run.request === 'string' ? JSON.parse(run.request) : run.request)?.directed;
              const earlier = await this.earlierAsks(s, directedRequest?.parentTaskId).catch(() => [] as string[]);
              // The copy of the design being changed, with any wording an earlier round changed: a
              // revision's task carries the first request's copy, and would put the old words back.
              const parentRun = await this.repo.getRunById(parent.runId, s.tenantId).catch(() => undefined);
              const parentStages = parentRun ? (typeof parentRun.stages === 'string' ? JSON.parse(parentRun.stages) : parentRun.stages) : undefined;
              inherited = Array.isArray(parentStages?.effectiveCopy) && parentStages.effectiveCopy.length === ctx.copyBlocks.length ? parentStages.effectiveCopy : undefined;
              if (inherited) ctx.copyBlocks = inherited;
              const edited = await runDirectedEditStage(ctx, parent, stages.directed.directive, earlier, {
                mayAsk: directedRequest?.clarified !== true,
                ...(typeof directedRequest?.reformat === 'string' ? { reformat: directedRequest.reformat } : {}),
              });
              if (inherited || edited.copyEdits.length) stages.effectiveCopy = edited.copyBlocks;
              if (edited.copyEdits.length) stages.directed = { ...stages.directed, copyEdits: edited.copyEdits };
              await this.repo.updateCandidate(stages.directed.candidateId, s.tenantId, {
                layouts: [edited.layout as unknown as Record<string, unknown>],
                previewPng: edited.previewPng,
                previewSha256: edited.previewSha256,
                compositePng: edited.compositePng ?? null,
                metrics: edited.metrics as unknown as Record<string, unknown>,
                artPng: parent.artPng ?? null,
                status: 'winner',
                rank: 1,
              });
              // What the design shows of the request, and what it does not: the sender's note reads both.
              stages.directed = {
                ...stages.directed,
                changes: edited.changes,
                unmade: edited.unmade,
                unchanged: edited.unchanged,
                asks: edited.asks,
                ...(typeof directedRequest?.reformat === 'string' ? { reformat: directedRequest.reformat, size: { width: ctx.width, height: ctx.height } } : {}),
                ...(edited.sideEffects.length ? { sideEffects: edited.sideEffects } : {}),
                ...(edited.frustrated ? { frustrated: true } : {}),
              };
              stages.layouts = { count: 1, directed: true };
              // The client's own design with their change: no rival layouts to critique or judge.
              await this.repo.updateRunStatus(runId, s.tenantId, 'qa', { stages, budget, winnerCandidateId: stages.directed.candidateId, judgeStatus: 'SKIPPED' });
              return { runId, status: 'qa', stage: 'edit', winnerCandidateId: stages.directed.candidateId, spentUsd: budget.spentUsd };
            } catch (caught) {
              const err = caught as Error;
              if (isModelCallHoldError(caught)) throw caught;
              if (caught instanceof StudioBudgetExhaustedError) throw caught;
              if (caught instanceof DirectedEditRefusal) {
                // Nothing asked for is within the edit's means, or the design's photos are missing: a
                // design made afresh has the same means and the same photos, so the run ends here, before
                // the edit is paid for, and the sender is told plainly what needs a designer.
                // A question is not a failure of the design: the run ends here and the requester's answer
                // starts the change again, as a new revision of the same design.
                const diagnostic = caught.code === 'NEEDS_CLARIFICATION'
                  ? `Studio v3 stopped at stage laying_out: ${caught.message}`
                  : `Studio v3 failed at stage laying_out: ${caught.message} It was not designed afresh.`;
                stages.directed = {
                  ...stages.directed,
                  asks: caught.asks,
                  refused: caught.code,
                  ...(caught.clarify ? { clarify: caught.clarify } : {}),
                  ...(caught.frustrated ? { frustrated: true } : {}),
                };
                await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
                return { runId, status: 'failed', stage: 'edit', diagnostic, message: diagnostic, code: caught.code, spentUsd: budget.spentUsd };
              }
              if (isModelTransportError(caught)) {
                // A timeout, an HTTP error or an exhausted quota says nothing about whether the change
                // fits the design, and the three new layouts would go to the same provider: every edit
                // failure used to be designed afresh, paying for three candidates behind a call that
                // was failing anyway. The run ends here and says why; the sender can ask again.
                const detail = `${err?.name || 'Error'}: ${err?.message || err}`;
                const diagnostic = `Studio v3 failed at stage laying_out: the requested change was not made because the model call failed (${detail}). It was not designed afresh; send the change again to retry.`;
                stages.directed = { ...stages.directed, error: detail };
                await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
                return { runId, status: 'failed', stage: 'edit', diagnostic, message: diagnostic, code: 'MODEL_UNAVAILABLE', spentUsd: budget.spentUsd };
              }
              // The change could not be made to the design as it stands: the revision is designed
              // afresh with the change in its instructions, which is how every revision used to run.
              log.warn(`[studio] run ${run.id}: directed edit failed (${err?.message || err}); designing the revision afresh.`);
              stages.directedFailed = err?.message || String(err);
              // The afresh design lays out the copy the client received, so every later stage (and
              // the brief contract) must read that copy as this run's, not the request's.
              if (inherited) stages.effectiveCopy = inherited;
              // A resumed stage replays the failed edit and reaches here again: the slots are
              // reserved once (run_id, ordinal is unique).
              const reserved = new Set((await this.repo.getCandidatesForRun(run.id, s.tenantId)).map((r) => r.ordinal));
              for (let i = 1; i < V3_CANDIDATE_SLOTS; i++) {
                if (reserved.has(i)) continue;
                await this.repo.insertCandidate({ id: randomUUID(), runId: run.id, tenantId: s.tenantId, ordinal: i, concept: pendingV3Concept(i) as unknown as Record<string, unknown>, status: 'draft' });
              }
            }
          }
          // The executable brief contract is recorded before the paid layout call; a conflict no
          // layout can satisfy stops the run here with its explanation (ADR-125).
          const requestCopy = ((typeof run.request === 'string' ? JSON.parse(run.request) : run.request)?.copyBlocks ?? []) as CopyBlock[];
          const contractStop = await this.admitBriefContract(s, runId, ctx, brief, stages, budget, requestCopy);
          if (contractStop) return contractStop;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          // ADR-170: the faces in each photo, for the recipe solver's crops.
          if (Array.isArray(stages.photoFocus)) ctx.photoFaces = stages.photoFocus;

          const candidateStates = await runLayoutsStage(
            ctx,
            brief,
            concepts,
            candidateRows.map((r) => ({ id: r.id, ordinal: r.ordinal }))
          );
          // A framed photo is cropped around its faces (stages.photoFocus), and framed portraits side by
          // side show their heads at one size (alignFramedHeads); the layout model sets neither.
          const focus: Array<PhotoFaces | null> = Array.isArray(stages.photoFocus) ? stages.photoFocus : [];
          const sizes: Array<{ width: number; height: number } | null> = Array.isArray(stages.photoSizes) ? stages.photoSizes : [];
          for (const cand of candidateStates) {
            // ADR-170: a recipe's crops, photo boxes and cut-outs are the solver's.
            if (photoRecipeOf(cand.currentLayout)) continue;
            for (const p of cand.currentLayout.photos ?? []) {
              const f = focus[p.photoIndex];
              if (f && p.treatment !== 'cutout') p.focus = { x: f.x, y: f.y };
            }
            // A row of framed photos divided closer to each photo's own shape, so less is cropped away (ADR-157).
            fitPhotoBoxesToImages(cand.currentLayout, sizes, copyForStageV3(ctx), focus);
          }
          // Every photo with a cut-out is shown cut out, set as a designer sets people: standing on
          // the bottom edge, heads matched, clear of the text. Before the art, which works around them.
          if (ctx.photoCutouts?.some(Boolean)) {
            for (const cand of candidateStates) {
              if (photoRecipeOf(cand.currentLayout)) continue;
              // A person cut out has their own edge: a frame's mask and crop no longer apply.
              for (const p of cand.currentLayout.photos ?? []) {
                if (!ctx.photoCutouts[p.photoIndex]) continue;
                p.treatment = 'cutout';
                delete p.mask;
                delete p.zoom;
              }
              cand.currentLayout = settlePhotos(arrangeCutouts(cand.currentLayout, ctx.photoCutouts, ctx.cutoutOutcomes));
            }
          }
          // Heads matched across the framed photos only, once the people who are cut out are known: a
          // photo matched to a face that then became a cut-out was cropped to the limit for nothing.
          for (const cand of candidateStates) if (!photoRecipeOf(cand.currentLayout)) alignFramedHeads(cand.currentLayout, focus, sizes);
          const artCandidates = await runArtStage(ctx, candidateStates);

          return await this.finishLayoutsStage(s, runId, stages, budget, candidateRows, artCandidates, Boolean(ctx.pipelineV3));
        }

        case 'rendering': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates with layouts for rendering');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              critiques: [],
              status: row.status as DesignStudioCandidateStatus,
              artPng: row.art_png ? Buffer.from(row.art_png) : undefined,
            };
          });

          const renderedCandidates = await runRenderStage(ctx, candidateStates);
          for (let i = 0; i < renderedCandidates.length; i++) {
            const cand = renderedCandidates[i];
            await this.repo.updateCandidate(cand.id, s.tenantId, {
              previewPng: cand.previewPng,
              previewSha256: cand.previewSha256,
              compositePng: cand.compositePng,
              metrics: cand.metrics as any,
            });
          }

          stages.render = { count: renderedCandidates.length };
          await this.repo.updateRunStatus(runId, s.tenantId, 'critiquing', { stages, budget });
          return { runId, status: 'critiquing', stage: 'render', spentUsd: budget.spentUsd };
        }

        case 'critiquing': {
          const brief: CreativeBrief = stages.brief;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for critiquing');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              artPng: row.art_png ? Buffer.from(row.art_png) : undefined,
              artSha256: row.art_sha256,
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques: [],
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          if (ctx.pipelineV3) {
            // P05, as the qualification runs it: one box-grounded critique of the top-ranked
            // candidate, rendered with its copy. Every candidate's score becomes its composite,
            // the measure v3 ranks on.
            try {
              const { candidate, critique, compositeScores } = await runCritiqueStageV3(ctx, candidateStates);
              await this.repo.insertJudgment({
                id: randomUUID(),
                runId: run.id,
                tenantId: s.tenantId,
                kind: 'critique',
                candidateA: candidate.id,
                // No annotated render to hash: the critique is measured from the run's own hard QA
                // and metrics rather than written by a model, so there is no image it looked at.
                // The winner's own preview is still stored on the candidate row.
                verdict: { pipeline: 'v3', ...critique } as any,
              });
              for (const cand of candidateStates) {
                await this.repo.updateCandidate(cand.id, s.tenantId, { score: compositeScores.get(cand.id) ?? null });
              }
              stages.critique = { completed: true, pipeline: 'v3', candidateId: candidate.id };
              // ADR-237: the top model looks at the renders the judge will choose between and says
              // what to fix. The fixes are applied, re-rendered and checked in the revise stage.
              const reviewSettings = resolveVisualReviewSettings();
              if (reviewSettings.rounds > 0) {
                const spend = { label: 'visual review', capUsd: reviewSettings.maxUsd, spentUsd: 0 };
                const visual = await inStudioSpendCap(spend, () =>
                  runVisualReviewStageV3(ctx, candidateStates, reviewSettings, (stages.brief || {}) as Partial<CreativeBrief>));
                for (const review of visual.reviews) {
                  await this.repo.insertJudgment({
                    id: randomUUID(),
                    runId: run.id,
                    tenantId: s.tenantId,
                    kind: 'critique',
                    candidateA: review.candidateId,
                    verdict: {
                      pipeline: 'v3', kind: 'visual_review', promptVersion: review.promptVersion,
                      reviewedLayoutSha256: review.reviewedLayoutSha256, overallAssessment: review.review.assessment,
                      fixes: review.review.fixes, discarded: review.discarded, receipt: review.receipt,
                    } as any,
                  });
                }
                stages.critique.visualReview = { ...visual, spentUsd: spend.spentUsd };
              }
            } catch (err) {
              if (isModelCallHoldError(err)) throw err;
              if (err instanceof StudioBudgetExhaustedError) throw err;
              // The critique informs the Desk; refinement critiques for itself. A missing one is
              // recorded, not fatal.
              const message = err instanceof Error ? err.message : String(err);
              stages.critique = { completed: false, pipeline: 'v3', error: message };
              await this.repo.updateRunStatus(runId, s.tenantId, 'revising', {
                stages,
                budget,
                diagnostic: `v3 critique unavailable: ${message}`,
              });
              return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
            }
            await this.repo.updateRunStatus(runId, s.tenantId, 'revising', { stages, budget });
            return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
          }

          let critiquedCandidates: CandidateState[];
          try {
            critiquedCandidates = await runCritiqueStage(ctx, brief, candidateStates);
          } catch (err) {
            if (isModelCallHoldError(err)) throw err;
            // Rung 3: Critic unavailable -> skip critique, note judge unavailable
            await this.repo.updateRunStatus(runId, s.tenantId, 'revising', {
              judgeStatus: 'SKIPPED',
              diagnostic: 'Critic unavailable; skipped to layout revision.',
            });
            return { runId, status: 'revising', stage: 'critique', judgeStatus: 'SKIPPED' };
          }

          for (const cand of critiquedCandidates) {
            const critique = cand.critiques[cand.critiques.length - 1];
            if (critique) {
              await this.repo.insertJudgment({
                id: randomUUID(),
                runId: run.id,
                tenantId: s.tenantId,
                kind: 'critique',
                candidateA: cand.id,
                verdict: critique as any,
              });
              await this.repo.updateCandidate(cand.id, s.tenantId, {
                critiques: cand.critiques as any,
                score: cand.score,
              });
            }
          }

          stages.critique = { completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'revising', { stages, budget });
          return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
        }

        case 'revising': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for revising');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            const critiques = (row.critiques as any[] || []).map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              artPng: row.art_png ? Buffer.from(row.art_png) : undefined,
              artSha256: row.art_sha256,
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques,
              score: row.score ? parseFloat(row.score.toString()) : undefined,
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          const visualReview = ctx.pipelineV3 ? stages.critique?.visualReview as (VisualReviewStageRecord & { spentUsd?: number }) | undefined : undefined;
          if (visualReview?.reviews?.length) {
            // ADR-237: the reviewed candidates get their fixes in one controlled pass (by default),
            // re-rendered and re-checked; a refinement is kept only if QA passes and the measures do
            // not regress or the judge prefers it. This replaces the gated repair for these runs.
            const spend = { label: 'visual review', capUsd: visualReview.settings.maxUsd, spentUsd: Number(visualReview.spentUsd) || 0 };
            try {
              const outcomes = await inStudioSpendCap(spend, () =>
                runVisualRefinementStageV3(ctx, candidateStates, visualReview, (stages.brief || {}) as Partial<CreativeBrief>));
              for (const o of outcomes) {
                if (!o.adopted || !o.refined) continue;
                await this.repo.updateCandidate(o.candidateId, s.tenantId, {
                  layouts: o.refined.layouts as any,
                  previewPng: o.refined.previewPng,
                  previewSha256: o.refined.previewSha256,
                  compositePng: o.refined.compositePng,
                  metrics: o.refined.metrics as any,
                  score: o.score ?? null,
                });
              }
              stages.revise = {
                completed: true,
                pipeline: 'v3',
                visual: { outcomes: outcomes.map(({ refined: _refined, ...rest }) => rest), spentUsd: spend.spentUsd },
              };
            } catch (err) {
              if (isModelCallHoldError(err)) throw err;
              if (err instanceof StudioBudgetExhaustedError) throw err;
              // The reviewed designs still stand as they were; the run records why they were not refined.
              stages.revise = { completed: false, pipeline: 'v3', visual: { spentUsd: spend.spentUsd }, error: err instanceof Error ? err.message : String(err) };
            }
            await this.repo.updateRunStatus(runId, s.tenantId, 'judging', { stages, budget });
            return { runId, status: 'judging', stage: 'revise', spentUsd: budget.spentUsd };
          }

          if (ctx.pipelineV3) {
            // P06, as the qualification runs it: the engine refines the top-ranked candidate only
            // if it fails a metric or sits below the band, and a repair is kept only if it
            // measures better. The outcome is recorded either way.
            try {
              const { candidate, outcome, layout } = await runReviseStageV3(ctx, candidateStates);
              stages.revise = {
                completed: true,
                pipeline: 'v3',
                candidateId: candidate.id,
                adopted: outcome.adopted,
                reason: outcome.reason,
                stopReason: outcome.result.stopReason,
                rounds: outcome.result.rounds.map((r) => ({
                  round: r.round,
                  preScore: r.preScore,
                  postScore: r.postScore,
                  stopReason: r.stopReason,
                  ...(r.repairPolicy ? { repairPolicy: r.repairPolicy } : {}),
                  ...(r.rejection ? { rejection: r.rejection } : {}),
                  calls: r.calls.map((c) => ({ stage: c.stage, model: c.model, responseId: c.responseId, costUsd: c.costUsd })),
                })),
              };
              if (outcome.adopted) {
                const row = activeRows.find((r) => r.id === candidate.id);
                const [rendered] = await runRenderStage(ctx, [
                  {
                    ...candidate,
                    layouts: [...candidate.layouts, layout],
                    currentLayout: layout,
                    artPng: row?.art_png ? Buffer.from(row.art_png) : undefined,
                  },
                ]);
                await this.repo.updateCandidate(candidate.id, s.tenantId, {
                  layouts: rendered.layouts as any,
                  previewPng: rendered.previewPng,
                  previewSha256: rendered.previewSha256,
                  compositePng: rendered.compositePng,
                  metrics: rendered.metrics as any,
                  score: outcome.metrics.compositeScore,
                });
              }
            } catch (err) {
              if (isModelCallHoldError(err)) throw err;
              if (err instanceof StudioBudgetExhaustedError) throw err;
              // The unrefined candidate still stands; the run records why it was not refined.
              stages.revise = { completed: false, pipeline: 'v3', error: err instanceof Error ? err.message : String(err) };
            }
            await this.repo.updateRunStatus(runId, s.tenantId, 'judging', { stages, budget });
            return { runId, status: 'judging', stage: 'revise', spentUsd: budget.spentUsd };
          }

          const revisedCandidates = await runReviseStage(ctx, candidateStates, 1);
          for (let i = 0; i < revisedCandidates.length; i++) {
            const cand = revisedCandidates[i];
            const originalRow = activeRows.find((r) => r.id === cand.id);
            if (originalRow && cand.layouts.length > (originalRow.layouts as any[]).length) {
              await this.repo.updateCandidate(cand.id, s.tenantId, {
                layouts: cand.layouts as any,
                previewPng: cand.previewPng,
                previewSha256: cand.previewSha256,
                compositePng: cand.compositePng,
                metrics: cand.metrics as any,
              });
            }
          }

          stages.revise = { completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'judging', { stages, budget });
          return { runId, status: 'judging', stage: 'revise', spentUsd: budget.spentUsd };
        }

        case 'judging': {
          const brief: CreativeBrief = stages.brief;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for judging');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            const critiques = (row.critiques as any[] || []).map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              artPng: row.art_png ? Buffer.from(row.art_png) : undefined,
              artSha256: row.art_sha256,
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques,
              score: row.score ? parseFloat(row.score.toString()) : undefined,
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          if (ctx.pipelineV3) {
            // Awaited, so a failure in it reaches the handler below instead of leaving the run here.
            return await this.judgeV3(s, run, ctx, stages, budget, candidateStates);
          }

          let tournamentResult;
          try {
            tournamentResult = await runTournamentStage(ctx, brief, candidateStates);
          } catch (err) {
            if (isModelCallHoldError(err)) throw err;
            // Rung 3: Judge unavailable -> rank by deterministic metrics
            const sorted = [...candidateStates].sort(
              (a, b) => (b.metrics?.alignmentScore || 0) - (a.metrics?.alignmentScore || 0)
            );
            const winner = sorted[0];
            await this.repo.updateRunStatus(runId, s.tenantId, 'qa', {
              winnerCandidateId: winner.id,
              judgeStatus: 'SKIPPED',
              diagnostic: 'Judge unavailable during tournament; ranked by layout metrics.',
            });
            return { runId, status: 'qa', stage: 'tournament', winnerCandidateId: winner.id };
          }

          // Record pairwise judgments
          for (const match of tournamentResult.pairwiseJudgments) {
            await this.repo.insertJudgment({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              kind: 'pairwise',
              candidateA: match.candidateAId,
              candidateB: match.candidateBId,
              orderSwapped: match.orderSwapped,
              verdict: match.verdict as any,
            });
          }

          // Update candidate statuses in DB
          const winnerCandidate = tournamentResult.winnerCandidate;
          for (const cand of candidateStates) {
            const isWinner = cand.id === winnerCandidate.id;
            await this.repo.updateCandidate(cand.id, s.tenantId, {
              status: isWinner ? 'winner' : 'runner_up',
              rank: isWinner ? 1 : 2,
            });
          }

          // Execute Canary Stage on winner
          let canaryPassed = true;
          try {
            const canaryResult = await runCanaryStage(ctx, brief, winnerCandidate);
            canaryPassed = canaryResult.passed;

            await this.repo.insertJudgment({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              kind: 'canary',
              candidateA: winnerCandidate.id,
              verdict: canaryResult as any,
            });
          } catch (err) {
            if (isModelCallHoldError(err)) throw err;
            canaryPassed = false;
          }

          const judgeStatus: DesignStudioJudgeStatus = canaryPassed ? 'RELIABLE' : 'UNRELIABLE';
          stages.tournament = { winnerId: winnerCandidate.id };
          stages.canary = { passed: canaryPassed };

          await this.repo.updateRunStatus(runId, s.tenantId, 'qa', {
            stages,
            budget,
            winnerCandidateId: winnerCandidate.id,
            judgeStatus,
            diagnostic: canaryPassed ? null : 'Canary detected visual judge degradation.',
          });

          return {
            runId,
            status: 'qa',
            stage: 'judging',
            winnerCandidateId: winnerCandidate.id,
            judgeStatus,
            spentUsd: budget.spentUsd,
          };
        }

        case 'qa': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          const winnerRow = activeRows.find((r) => r.id === run.winner_candidate_id) || activeRows[0];
          if (!winnerRow) {
            return this.executeRung4Fallback(s, run, 'No valid candidate found for QA stage');
          }
          const layouts = (winnerRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));

          const winnerState: CandidateState = {
            id: winnerRow.id,
            ordinal: winnerRow.ordinal,
            concept: typeof winnerRow.concept === 'string' ? JSON.parse(winnerRow.concept) : winnerRow.concept,
            layouts,
            currentLayout: layouts[layouts.length - 1],
            metrics: typeof winnerRow.metrics === 'string' ? JSON.parse(winnerRow.metrics) : winnerRow.metrics,
            previewPng: winnerRow.preview_png ? Buffer.from(winnerRow.preview_png) : undefined,
            compositePng: winnerRow.composite_png ? Buffer.from(winnerRow.composite_png) : undefined,
            ...candidateArt(winnerRow),
            critiques: [],
            status: 'winner',
          };

          const qaResult = await runQAStage(ctx, winnerState);
          stages.qa = { ...qaResult, candidateId: winnerRow.id };
          const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;

          if (!qaResult.passed) {
            // Attempt to find any other candidate that passes QA
            for (const otherRow of activeRows) {
              if (otherRow.id === winnerRow.id) continue;
              const otherLayouts = (otherRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
              if (otherLayouts.length === 0) continue;
              const otherState: CandidateState = {
                id: otherRow.id,
                ordinal: otherRow.ordinal,
                concept: typeof otherRow.concept === 'string' ? JSON.parse(otherRow.concept) : otherRow.concept,
                layouts: otherLayouts,
                currentLayout: otherLayouts[otherLayouts.length - 1],
                ...candidateArt(otherRow),
                critiques: [],
                status: 'runner_up',
              };
              const otherQA = await runQAStage(ctx, otherState);
              if (otherQA.passed) {
                stages.qa = { ...otherQA, candidateId: otherRow.id };
                stages.qaReplacedWinner = { ...qaResult, candidateId: winnerRow.id };
                const nextStatus = request.holdForSelection ? 'awaiting_selection' : 'transferring';
                await this.repo.updateRunStatus(runId, s.tenantId, nextStatus, {
                  winnerCandidateId: otherRow.id,
                  stages,
                  budget,
                });
                return { runId, status: nextStatus, stage: 'qa', winnerCandidateId: otherRow.id };
              }
            }

            // Rung 4 fallback: trigger planner fallback
            return this.executeRung4Fallback(s, run, `Winner failed hard QA: ${qaResult.defectCodes.join(', ')}`);
          }

          // Check if operator requested holdForSelection
          if (request.holdForSelection) {
            await this.repo.updateRunStatus(runId, s.tenantId, 'awaiting_selection', { stages, budget });
            return { runId, status: 'awaiting_selection', stage: 'qa', spentUsd: budget.spentUsd };
          }

          await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', { stages, budget });
          return { runId, status: 'transferring', stage: 'qa', spentUsd: budget.spentUsd };
        }

        case 'transferring': {
          // A transfer resumed after Canva was slow, or after a restart, continues with its own plan and
          // its own import. Until 2026-09-24 every attempt rendered a new deck and imported it under a
          // new key, which Canva Connect refused (409 CANVA_CREATE_CONFLICT) while the first import was
          // still settling, and a second attempt's plan row could not be written at all.
          const planKey = 'studio-' + run.request_key;
          const ownPlan = await this.tx(s, async (db) =>
            (await sql<{ id: string; source_content: Buffer; source_sha256: string; result: string | { manifest?: Record<string, unknown> } | null }>`SELECT id, source_content, source_sha256, result FROM hawa.canva_design_plans
              WHERE tenant_id=${s.tenantId}::uuid AND task_id=${run.task_id}::uuid AND request_key=${planKey} AND status='planned'`.execute(db)).rows[0]
          );
          let planId: string;
          let source: { bytes: Buffer; sha256: string; manifest: Record<string, unknown> };
          if (ownPlan) {
            const result: { manifest?: Record<string, unknown> } | null = typeof ownPlan.result === 'string' ? JSON.parse(ownPlan.result) : ownPlan.result;
            planId = ownPlan.id;
            // The stored file when there is one, else the row's bytes (a plan from before the store).
            const bytes = await readPreferringStore(this.blobs, ownPlan.source_sha256, ownPlan.source_content);
            if (!bytes) return this.executeRung4Fallback(s, run, 'The saved studio plan has no source to import');
            source = { bytes, sha256: ownPlan.source_sha256, manifest: result?.manifest || {} };
          } else {
            const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
            const activeRows = candidateRows.filter(
              (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
            );
            const winnerRow = activeRows.find((r) => r.id === run.winner_candidate_id) || activeRows[0];
            if (!winnerRow) {
              return this.executeRung4Fallback(s, run, 'No valid candidate found for transfer stage');
            }
            const layouts = (winnerRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));

            const winnerState: CandidateState = {
              id: winnerRow.id,
              ordinal: winnerRow.ordinal,
              concept: typeof winnerRow.concept === 'string' ? JSON.parse(winnerRow.concept) : winnerRow.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              metrics: typeof winnerRow.metrics === 'string' ? JSON.parse(winnerRow.metrics) : winnerRow.metrics,
              previewPng: winnerRow.preview_png ? Buffer.from(winnerRow.preview_png) : undefined,
              compositePng: winnerRow.composite_png ? Buffer.from(winnerRow.composite_png) : undefined,
              artPng: winnerRow.art_png ? Buffer.from(winnerRow.art_png) : undefined,
              critiques: [],
              status: 'winner',
            };

            const transferResult = await runTransferStage(ctx, winnerState);

            // Hard QA verification on v2 PPTX bytes
            const pptxCheck = checkCanvaPptx(
              new Uint8Array(transferResult.pptxBytes),
              ctx.copyBlocks.map((b) => b.text),
              ctx.latinFont || 'Verdana',
              {
                documentKind: (ctx as any).documentKind || 'design_piece',
                scriptFonts: { arabic: ctx.arabicFont || 'Noto Sans Arabic' },
              }
            );

            if (!pptxCheck.copyPass) {
              throw new Error('PPTX_TRANSFER_CORRUPTED: copyPass failed on generated PPTX');
            }

            // Save plan row in hawa.canva_design_plans
            planId = randomUUID();
            const evidence = {
              manifest: transferResult.manifest,
              receipt: {
                source: 'design_studio_v2',
                runId: run.id,
                winnerCandidateId: winnerRow.id,
                completedAt: new Date().toISOString(),
              },
            };

            // The deck to the file store before the plan row names it (ADR-035); its bytes stay in the row too.
            await putToStore(this.blobs, transferResult.pptxBytes, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a studio plan source');
            await this.tx(s, async (db) => {
              // An earlier studio run's plan for this task (that run has ended: a task has one unfinished
              // run) is retired, so this run's plan can be written (canva_one_active_plan).
              await sql`UPDATE hawa.canva_design_plans SET status='abandoned', diagnostic=${`Superseded by studio run ${run.id}`}, updated_at=now()
                WHERE tenant_id=${s.tenantId}::uuid AND task_id=${run.task_id}::uuid AND status IN ('planned','uncertain')
                  AND request_key LIKE 'studio-%' AND request_key <> ${planKey}`.execute(db);
              await sql`INSERT INTO hawa.canva_design_plans(
                id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request,
                status, result, source_content, source_sha256, paid_protocol, studio_run_id
              ) VALUES(
                ${planId}::uuid, ${s.tenantId}::uuid, ${run.task_id}::uuid, ${run.client_id}::uuid, ${s.actorId},
                ${planKey}, ${run.request_hash}, ${JSON.stringify(transferResult.plan)}::jsonb,
                'planned', ${JSON.stringify(evidence)}::jsonb, ${transferResult.pptxBytes}, ${transferResult.sha256}, 'studio-transfer-v1', ${run.id}::uuid
              )`.execute(db);
            });
            source = { bytes: transferResult.pptxBytes, sha256: transferResult.sha256, manifest: transferResult.manifest };
          }

          let designId: string | undefined;
          if (this.canva) {
            // Keyed by the run, so every attempt of this run's transfer follows the same import.
            let imported = await this.canva.importEditableDesign(s, run.task_id, 'studio-' + run.id, source);
            const opId = (imported as any).operationId;
            let attempts = 0;
            while (
              imported.status === 'submitted' &&
              !(imported as any).designId &&
              attempts < 30 &&
              opId &&
              typeof (this.canva as any).resumeImport === 'function'
            ) {
              await new Promise((r) => setTimeout(r, 1500));
              attempts++;
              imported = await this.canva.resumeImport(s, run.task_id, opId);
            }
            if (imported.status !== 'retrieved' && !(imported as any).designId) {
              if (imported.status === 'submitted') {
                // Canva is still importing: not a failure. The run stays at this stage and the next
                // resume follows the same import. It used to fail the run here, and the requester was
                // told the design failed while Canva was still making it.
                stages.transfer = { planId, importOperationId: opId, completed: false };
                await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', { stages, budget });
                return {
                  runId,
                  status: 'transferring',
                  stage: 'transfer',
                  planId,
                  spentUsd: budget.spentUsd,
                  message: 'Canva is still importing the editable design; resume to follow it.',
                };
              }
              throw new Error(
                `Canva PPTX import did not settle: status=${imported.status} ${'message' in imported ? (imported as any).message : ''}`
              );
            }
            designId = (imported as any).designId;
          }

          stages.transfer = { planId, designId, completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'transferred', {
            stages,
            budget,
            planId,
          });

          return {
            runId,
            status: 'transferred',
            stage: 'transfer',
            planId,
            designId,
            spentUsd: budget.spentUsd,
            message: 'Design Studio v2 transferred editable PPTX to Canva.',
          };
        }

        default:
          return { runId, status: run.status };
      }
    } catch (err: any) {
      if (['TASK_PAUSED', 'TASK_GENERATION_BLOCKED', 'STUDIO_BUDGET_INVALID', 'STUDIO_BUDGET_HISTORY_INCOMPLETE',
        'STUDIO_BUDGET_UNQUOTABLE', 'STUDIO_BUDGET_RESERVATION_EXCEEDED'].includes(err?.code)) {
        throw new CanvaFlowError(409, err.code, err.message);
      }
      if (isModelCallHoldError(err)) {
        if (['STUDIO_VISUAL_INPUTS_UNSAFE', 'BRIEF_CONTRACT_CHANGED', 'STUDIO_RUN_STATUS_CHANGED'].includes(err.code)) throw new CanvaFlowError(409, err.code, err.message);
        if (err instanceof CanvaFlowError && err.code === 'MODEL_STAGE_REPLAY_UNSAFE') throw err;
        const code = ['MODEL_CALL_ADMISSION_CONFLICT', 'MODEL_CALL_FINALIZATION_CONFLICT', 'MODEL_CALL_ACCOUNTING_FAILED'].includes(err?.code)
          ? err.code : 'MODEL_CALL_UNCERTAIN';
        throw new CanvaFlowError(409, code,
          'A Studio model call may have been accepted or another process already recorded its outcome. Reconcile the call before continuing this run.');
      }
      // Not a failure: the run waits at its stage for the design it revises, and a later resume
      // makes the edit. So does a transfer Canva refused with its rate limit (nothing was created):
      // the worker waits the time named and resumes, and the import is sent again under the run's key.
      if (err instanceof CanvaFlowError && (err.code === 'PARENT_STILL_RUNNING' || err.code === 'CANVA_RATE_LIMITED')) throw err;
      if (err instanceof StudioBudgetExhaustedError) {
        // Budget exhausted: gracefully handle by selecting best candidate so far
        return this.handleBudgetExhaustion(s, run, ctx, budget, err);
      }

      // The request's own photos could not be read: no pipeline designs it without them.
      if (ctx.pipelineV3 || err instanceof RequestOwnedImageUnavailable) {
        const errorMsg = err.message || String(err);
        await this.repo.updateRunStatus(runId, s.tenantId, 'failed', {
          diagnostic: `Studio v3 failed at stage ${run.status}: ${errorMsg}`,
        });
        return {
          runId,
          status: 'failed',
          stage: run.status,
          diagnostic: `Studio v3 failed: ${errorMsg}`,
          message: errorMsg,
        };
      }

      // If failure happened during generation stages, execute Rung 4 fallback
      return this.executeRung4Fallback(s, run, err.message || 'Studio stage failed');
    } finally {
      // ADR-122: saved paid work this resume bypassed stays visible to the operator. A result
      // already applied in the stored stage (a persisted rebrief) is listed too; the operator
      // compares it with the stage before settling or discarding it.
      const unread = ctx.unconsumedRetainedCalls?.() ?? [];
      if (unread.length) {
        log.warn(`[studio] run ${runId}: the ${run.status} resume did not read ${unread.length} saved result(s): ` +
          unread.map((call) => `${call.callId} (${call.substep ?? 'ordered prefix'} attempt ${call.attempt ?? '-'})`).join(', ') + '.');
      }
    }
  }

  /**
   * Re-reads the brief with a reference photo that reached the run after the first brief, and
   * returns the brief the rest of the resume must use.
   *
   * The brief is the only stage that turns the image into a StyleSpec, the values preparation
   * enforces: title scale and weight, typeface, alignment, gold last title line, button, logo
   * corner, texture, dividers, panels, composition. Intake joins a caption-less photo to the request
   * it followed while the run is still at 'briefing' or 'conceiving' (chat-intake.ts, 3b4d7f2), so a
   * photo sent as its own Telegram message routinely lands after the brief has been written:
   * referenceSeen false and the spec neutral, leaving the design to follow the reference through
   * prose notes alone. That is the "doesn't look like the reference" the owner reported on task
   * 89c242f2 (2026-09-19, f80733c).
   *
   * One extra brief call buys those enforced values, so it is spent at most once per run and only
   * while the layouts have not been generated: after that nothing that draws would read the new
   * spec, so the run keeps the design it has and records why in its diagnostic. The marker is
   * stored with the new brief under the run's current status, so a resume that replays this status
   * does not pay for a second one.
   */
  private async rereadBriefWithLateReference(
    s: Scope,
    run: any,
    ctx: StageContext,
    stages: Record<string, any>,
    budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    stored: LateReferenceBrief
  ): Promise<LateReferenceBrief> {
    // The layouts are written into the candidates when the run leaves 'laying_out'.
    const beforeLayouts = ['conceiving', 'laying_out'].includes(run.status) && !stages.layouts;
    if (!beforeLayouts) {
      const note =
        `The client's reference image reached this run at '${run.status}', after its layouts were generated, ` +
        `so its style values were not enforced on them; the design follows the image only through the brief's notes.`;
      log.warn(`[studio] run ${run.id}: ${note}`);
      const noted: LateReferenceBrief = { ...stored, referenceRebrief: 'too_late' };
      stages.brief = noted;
      // Whatever the run already reported still matters; this note is written once, so it is added.
      const diagnostic = [run.diagnostic, note].filter(Boolean).join(' ');
      await this.repo.updateRunStatus(run.id, s.tenantId, run.status, { stages, budget, diagnostic });
      return noted;
    }

    let reread: CreativeBrief;
    try {
      reread = await inStudioSubstep('brief/late-reference', () => runBriefStage(ctx, { lateReference: true }));
    } catch (err: any) {
      if (isModelCallHoldError(err)) throw err;
      // The stored brief still designs the request, so an extra call that failed must not fail the
      // run. Nothing is recorded, which leaves one more attempt at the next stage before layouts.
      log.error(
        `[studio] run ${run.id}: the brief could not be re-read with the reference image that arrived after it: ${err?.message || err}`
      );
      return stored;
    }

    const brief: LateReferenceBrief = { ...reread, referenceRebrief: 'applied' };
    stages.brief = brief;
    // The context was built from the blind brief a few lines above, so the values it already
    // carries into this same resume are the neutral ones.
    ctx.style = brief.styleSpec;
    ctx.requestedBackground = requestedBackgroundFor(brief, ctx.referencePack.palette);
    await this.repo.updateRunStatus(run.id, s.tenantId, run.status, { stages, budget });
    log.warn(
      `[studio] run ${run.id}: brief re-read at '${run.status}' with the reference image that arrived after it (referenceRole ${brief.referenceRole}).`
    );
    stages.brief = await this.briefAsStored(s, run.id, brief);
    return stages.brief as LateReferenceBrief;
  }

  /**
   * ADR-122: a brief persisted inside a stage continues in its stored form, exactly as a resume
   * reads it back. PostgreSQL jsonb reorders keys and later prompts embed the brief's JSON text,
   * so the in-memory form would make the same work unreplayable. Only the form is adopted:
   * stored content that differs from what was just written is never substituted.
   */
  private async briefAsStored<T>(s: Scope, runId: string, written: T): Promise<T> {
    const stored = runStages((await this.repo.getRunById(runId, s.tenantId)) ?? {}).brief;
    return stored !== undefined && canonicalCallJson(stored) === canonicalCallJson(written) ? stored as T : written;
  }

  /**
   * Graceful budget exhaustion handling: selects best candidate so far that passes hard QA.
   */
  private async handleBudgetExhaustion(
    s: Scope,
    run: any,
    ctx: StageContext,
    budget?: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    error?: StudioBudgetExhaustedError
  ): Promise<StudioResumeResult> {
    const reason = error?.message;
    // The cap and what reached it, in the run's own record: with the caps lowered to a few designs'
    // worth, the operator needs to see which one a run hit.
    const cap = budget
      ? ` at stage ${run.status} ($${Number(budget.spentUsd).toFixed(2)} of $${budget.maxUsd}, ${budget.calls} of ${budget.maxCalls} calls)`
      : '';
    const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
    let bestCandidate: any = null;

    for (const row of candidateRows) {
      const layouts = (row.layouts as any[] || []).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
      if (layouts.length === 0) continue;

      const state: CandidateState = {
        id: row.id,
        ordinal: row.ordinal,
        concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
        layouts,
        currentLayout: layouts[layouts.length - 1],
        critiques: [],
        status: row.status as DesignStudioCandidateStatus,
      };

      // A candidate QA cannot even read is not the best so far; it must not strand the run either.
      const qa = await runQAStage(ctx, state).catch(() => undefined);
      if (qa?.passed) {
        bestCandidate = row;
        break;
      }
    }

    const exhausted = error?.code ?? 'BUDGET_EXHAUSTED';
    if (bestCandidate) {
      await this.repo.updateRunStatus(run.id, s.tenantId, 'transferring', {
        winnerCandidateId: bestCandidate.id,
        diagnostic: `${exhausted}${cap}${reason ? `: ${reason}` : ''}: proceeded with best candidate passing hard QA.`,
      });
      return {
        runId: run.id,
        status: 'transferring',
        diagnostic: exhausted,
        winnerCandidateId: bestCandidate.id,
      };
    }

    // ADR-159: the shared office day is used up, not this run's limit, and nothing QA refused. The
    // office is told that, and when the day resets; it was reported as "no candidates passed hard QA".
    if (error instanceof OfficeDayExhaustedError) {
      const diagnostic = `${OFFICE_DAY_EXHAUSTED} at stage ${run.status}: ${error.message} Nothing was sent for the next ` +
        `model request. Retry the design after the reset, or raise the daily limit in the spending policy.`;
      await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', { diagnostic });
      return { runId: run.id, status: 'failed', stage: run.status, code: OFFICE_DAY_EXHAUSTED, diagnostic, message: diagnostic,
        ...(budget ? { spentUsd: budget.spentUsd } : {}) };
    }

    // ADR-142: one request larger than what the run has left, with no candidate made yet, is not a run
    // that spent its limit on candidates QA refused (the owner's report cover of 2026-09-29 was told
    // "no candidate passed hard QA" before any layout existed). Nothing was sent for that request.
    const shortfall = error?.shortfall;
    const laidOut = (row: { layouts?: unknown }) => {
      const layouts = typeof row.layouts === 'string' ? JSON.parse(row.layouts) : row.layouts;
      return Array.isArray(layouts) && layouts.length > 0;
    };
    if (shortfall && !candidateRows.some(laidOut)) {
      const limit = shortfall.maxUsd ?? budget?.maxUsd;
      const diagnostic = `${STUDIO_RUN_LIMIT_TOO_SMALL} at stage ${run.status}: the next model request needs a ` +
        `$${shortfall.reservedUsd.toFixed(2)} advance reservation and the run has $${shortfall.remainingUsd.toFixed(2)} ` +
        `of its $${limit} limit left ($${Number(shortfall.accountedUsd ?? budget?.spentUsd ?? 0).toFixed(2)} spent). ` +
        `Nothing was sent for it and no layout was made. Retry the design once the run limit (DESIGN_STUDIO_MAX_USD) fits the request.`;
      await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', { diagnostic });
      return { runId: run.id, status: 'failed', stage: run.status, code: STUDIO_RUN_LIMIT_TOO_SMALL, diagnostic, message: diagnostic,
        ...(budget ? { spentUsd: budget.spentUsd } : {}) };
    }

    await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
      diagnostic: `BUDGET_EXHAUSTED${cap}${reason ? `: ${reason}` : ''}: no candidates passed hard QA before budget cap was reached.`,
    });
    return {
      runId: run.id,
      status: 'failed',
      diagnostic: 'BUDGET_EXHAUSTED',
      message: 'Budget exhausted without a valid candidate passing hard QA.',
    };
  }

  /** Persist the pre-art gate, including refused source layouts, before advancing the run. */
  private async finishLayoutsStage(
    s: Scope, runId: string, stages: Record<string, unknown>,
    budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    candidateRows: Array<{ id: string; ordinal: number }>, artCandidates: CandidateState[], pipelineV3: boolean,
  ): Promise<StudioResumeResult> {
    for (const row of candidateRows) {
      const cand = artCandidates.find((c) => c.ordinal === row.ordinal);
      if (cand) {
        await this.repo.updateCandidate(row.id, s.tenantId, {
          layouts: [cand.currentLayout] as any,
          status: cand.status === 'eliminated' ? 'eliminated' : 'draft',
          artPng: cand.artPng,
          artSha256: cand.artSha256,
          artProvenance: cand.artProvenance as any,
          ...(pipelineV3 ? { concept: cand.concept as any } : {}),
        });
      } else {
        await this.repo.updateCandidate(row.id, s.tenantId, {
          status: 'eliminated',
        });
      }
    }

    const survivors = artCandidates.filter((candidate) => candidate.status !== 'eliminated');
    stages.layouts = { count: survivors.length, preArtRejected: artCandidates
      .filter((candidate) => candidate.status === 'eliminated')
      .map((candidate) => ({ candidateId: candidate.id, ordinal: candidate.ordinal, defectCodes: candidate.diagnostics ?? [] })) };
    if (!survivors.length) {
      const diagnostic = 'NO_FEASIBLE_CANDIDATE: geometry/copy preflight rejected every candidate before artwork; review the recorded defects.';
      await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
      return { runId, status: 'failed', stage: 'layouts', diagnostic, spentUsd: budget.spentUsd };
    }
    await this.repo.updateRunStatus(runId, s.tenantId, 'rendering', { stages, budget });
    return { runId, status: 'rendering', stage: 'layouts', spentUsd: budget.spentUsd };
  }

  /**
   * Records the run's executable brief contract once, before the first layout call, and reuses
   * that record on resume. A blocking conflict stops the run with the contract's explanation and
   * authorized choices, before any provider call and without shrinking, omitting or rewording the
   * copy (ADR-125).
   *
   * On resume the recorded contract must be intact. If its authorities (identity digest) differ
   * from the run's, the run holds (BRIEF_CONTRACT_CHANGED). If only environment evidence changed
   * (policy versions, font measurement), the contract is re-admitted under the current environment
   * and the change is recorded, so a deploy does not hold every in-flight run for good.
   *
   * The write is the stage's only mid-stage snapshot. It leaves out directedFailed: a resumed stage
   * must replay the failed directed edit its retained calls begin with, lay out the same copy and
   * rebuild the same contract. It is conditional on the run still laying out.
   */
  private async admitBriefContract(
    s: Scope, runId: string, ctx: StageContext, brief: CreativeBrief, stages: Record<string, any>,
    budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number }, requestCopy: CopyBlock[],
  ): Promise<StudioResumeResult | undefined> {
    // The authority is what the run lays out: the copy this run recorded as its own, else the request's.
    const sameCopy = (a: unknown, b: CopyBlock[]) => Array.isArray(a) && a.length === b.length &&
      a.every((x: CopyBlock, i) => x?.text === b[i].text && x?.script === b[i].script);
    const authority = sameCopy(stages.effectiveCopy, ctx.copyBlocks) ? 'run_effective_copy'
      : sameCopy(requestCopy, ctx.copyBlocks) ? 'source_copy' : undefined;
    if (!authority) {
      throw new StudioBriefContractError('The copy this run would lay out is neither the request copy nor copy the run recorded as its own. Review the run before any layout call.');
    }
    const built = buildRunBriefContract(ctx, (brief ?? {}) as unknown as BriefProposalInput, authority);
    const recorded = stages.briefContract as ExecutableBriefContract | undefined;
    if (recorded !== undefined && (!verifyBriefContractIntegrity(recorded) || briefContractIdentitySha256(recorded) !== briefContractIdentitySha256(built))) {
      throw new StudioBriefContractError('The recorded brief contract does not match this run: its copy, assets, brief or relations changed. Review the run before any layout call.');
    }
    if (recorded?.sha256 === built.sha256) {
      ctx.briefContract = recorded;
    } else {
      if (recorded) {
        log.warn(`[studio] run ${runId}: brief contract re-admitted; policy or measurement evidence changed (${recorded.sha256.slice(0, 12)} -> ${built.sha256.slice(0, 12)}).`);
        stages.briefContractReadmissions = [...(Array.isArray(stages.briefContractReadmissions) ? stages.briefContractReadmissions : []), {
          previousSha256: recorded.sha256, sha256: built.sha256, identitySha256: briefContractIdentitySha256(built),
          previousPolicies: recorded.policies, policies: built.policies, reason: 'environment_evidence_changed' }];
      }
      stages.briefContract = built;
      ctx.briefContract = built;
      const { directedFailed: _inMemoryUntilStageSnapshot, ...snapshot } = stages;
      const written = await this.repo.updateRunStatus(runId, s.tenantId, 'laying_out', { stages: snapshot, expectedStatus: 'laying_out' });
      if (!written) {
        throw new StudioRunStatusChangedError('The run left laying_out while its brief contract was being recorded. Nothing was written and no layout call was made.');
      }
    }
    const blocking = blockingBriefConflicts(ctx.briefContract);
    if (!blocking.length) return undefined;
    const diagnostic = `BRIEF_CONTRACT_CONFLICT: ${blocking
      .map((c) => `${c.explanation} Authorized choices: ${c.authorizedChoices.join(' or ')}.`).join(' ')}`;
    await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
    return { runId, status: 'failed', stage: 'brief_contract', diagnostic, message: diagnostic, code: 'BRIEF_CONTRACT_CONFLICT', spentUsd: budget.spentUsd };
  }

  /**
   * P07 for a v3 run, as the qualification runs it: the judge compares the top two candidates in
   * both orders, and its pick stands only if it holds in both and the judge then beats a degraded
   * copy of it in both. Every judgement is stored, the canary's against the candidate it tested.
   */
  private async judgeV3(
    s: Scope,
    run: any,
    ctx: StageContext,
    stages: Record<string, any>,
    budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    candidateStates: CandidateState[]
  ): Promise<StudioResumeResult> {
    let outcome: Awaited<ReturnType<typeof runJudgeStageV3>>;
    const stopWithoutEligible = async (error: NoEligibleCandidateError): Promise<StudioResumeResult> => {
      stages.tournament = { pipeline: 'v3', decidedBy: 'no_eligible_candidate', candidates: error.candidates };
      for (const candidate of candidateStates) await this.repo.updateCandidate(candidate.id, s.tenantId, { status: 'eliminated', rank: null });
      await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', { stages, budget, diagnostic: error.message, judgeStatus: 'SKIPPED', winnerCandidateId: null });
      return { runId: run.id, status: 'failed', stage: 'judging', diagnostic: error.message, judgeStatus: 'SKIPPED', spentUsd: budget.spentUsd };
    };
    const excludedEvidence = (ranked: ReturnType<typeof rankStudioCandidatesV3>) => ranked
      .filter((r) => r.hardQa?.passed !== true)
      .map((r) => ({ candidateId: r.candidate.id, sourceIndex: r.sourceIndex, qa: r.hardQa ? 'failed' : 'unknown', defectCodes: r.hardQa?.defectCodes ?? [] }));
    // ADR-124: the flag is read when the judge stage runs and recorded with its outcome. An unknown
    // value is refused below as an unavailable judge, visibly, with no model call.
    let judgeProtocol: StudioJudgeProtocol = 'incumbent';
    let judgeProtocolResolved = false;
    try {
      judgeProtocol = resolveStudioJudgeProtocol(process.env.HAWA_STUDIO_JUDGE_PROTOCOL);
      judgeProtocolResolved = true;
      // ADR-157: both protocols read the request; the incumbent carries it in the calls it already makes.
      outcome = await runJudgeStageV3(ctx, candidateStates, {
        ...(judgeProtocol === 'incumbent' ? {} : { protocol: judgeProtocol }),
        brief: judgeBriefForStageV3(ctx, (stages.brief || {}) as Partial<CreativeBrief>),
        ...(Array.isArray(stages.brief?.subjectTags) ? { subjects: stages.brief.subjectTags as string[] } : {}),
      });
    } catch (err) {
      if (isModelCallHoldError(err)) throw err;
      if (err instanceof StudioBudgetExhaustedError) throw err;
      if (err instanceof NoEligibleCandidateError) return stopWithoutEligible(err);
      // Judge unavailable: only an explicitly eligible candidate may stand on its metrics.
      const message = err instanceof Error ? err.message : String(err);
      const allRanked = rankStudioCandidatesV3(ctx, candidateStates);
      if (!allRanked.some((r) => r.hardQa?.passed === true)) return stopWithoutEligible(new NoEligibleCandidateError(allRanked));
      const ranked = eligibleCandidatesV3(allRanked).map((r) => r.candidate);
      const winner = ranked[0];
      await this.recordV3Ranking(s, ranked, winner, allRanked.filter((r) => r.hardQa?.passed !== true).map((r) => r.candidate));
      // ADR-124: the refusal's code is recorded so an inapplicable request class can be counted, and
      // with no automated preference a person should choose.
      const errorCode = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null;
      stages.tournament = { pipeline: 'v3', winnerId: winner.id, decidedBy: 'composite_judge_unavailable', error: message, errorCode,
        ...(judgeProtocolResolved ? { judgeProtocol } : {}), humanChoiceRecommended: true, excludedCandidates: excludedEvidence(allRanked) };
      await this.repo.updateRunStatus(run.id, s.tenantId, 'qa', {
        stages,
        budget,
        winnerCandidateId: winner.id,
        judgeStatus: 'SKIPPED',
        diagnostic: `v3 judge unavailable (${message}); the higher composite stands.`,
      });
      return { runId: run.id, status: 'qa', stage: 'judging', winnerCandidateId: winner.id, judgeStatus: 'SKIPPED', spentUsd: budget.spentUsd };
    }

    const { selection, winner, ranked } = outcome;
    const idFor = (judgeId: string | number) =>
      ranked.find((x) => `candidate_${x.sourceIndex}` === String(judgeId))?.candidate.id;

    if (selection.match) {
      const orders = [
        [selection.match.orderAB, false],
        [selection.match.orderBA, true],
      ] as const;
      for (const [order, swapped] of orders) {
        await this.repo.insertJudgment({
          id: randomUUID(),
          runId: run.id,
          tenantId: s.tenantId,
          kind: 'pairwise',
          candidateA: idFor(order.candidateAId),
          candidateB: idFor(order.candidateBId),
          orderSwapped: swapped,
          verdict: {
            pipeline: 'v3',
            votes: order.votes,
            rationales: order.rationales,
            winnerVotesA: order.winnerVotesA,
            winnerVotesB: order.winnerVotesB,
            majorityWinner: order.majorityWinner,
            winnerCandidateId: idFor(order.winnerCandidateId),
            receipt: order.receipt,
            // ADR-170: a photo brief's weighted totals, its art-direction checklist and the baseline named.
            ...(order.photoBrief ? { photoBrief: true, weights: order.weights, weightedVotesA: order.weightedVotesA, weightedVotesB: order.weightedVotesB } : {}),
            ...(order.artDirection ? { artDirection: order.artDirection } : {}),
            ...(order.baselineCandidateId !== undefined ? { baselineCandidateId: idFor(order.baselineCandidateId) ?? null } : {}),
          } as any,
        });
      }
    }
    if (selection.briefBound) {
      // ADR-124 challenger: each order keeps its exact packet identity, the validated verdict with
      // its three separate dimensions and localized findings, and the receipt.
      const { match: pair, canaryMatch, canaryPassed, canaryUnavailable, subject: canarySubject } = selection.briefBound;
      const orderRecord = (order: typeof pair.orderAB) => ({
        pipeline: 'v3',
        protocol: order.promptVersion,
        packetSha256: order.packetSha256,
        imageASha256: order.imageASha256,
        imageBSha256: order.imageBSha256,
        verdict: order.verdict,
        receipt: order.receipt,
      });
      for (const [order, swapped] of [[pair.orderAB, false], [pair.orderBA, true]] as const) {
        await this.repo.insertJudgment({
          id: randomUUID(),
          runId: run.id,
          tenantId: s.tenantId,
          kind: 'pairwise',
          candidateA: idFor(order.candidateAId),
          candidateB: idFor(order.candidateBId),
          orderSwapped: swapped,
          verdict: { ...orderRecord(order), decision: pair.decision,
            winnerCandidateId: pair.winnerId === 'UNCERTAIN' ? null : idFor(pair.winnerId) } as any,
        });
      }
      const subject = ranked.find((x) => x.sourceIndex === canarySubject.sourceIndex)!.candidate;
      await this.repo.insertJudgment({
        id: randomUUID(),
        runId: run.id,
        tenantId: s.tenantId,
        kind: 'canary',
        candidateA: subject.id,
        verdict: (canaryMatch ? {
          pipeline: 'v3',
          protocol: canaryMatch.orderAB.promptVersion,
          passed: canaryPassed,
          decision: canaryMatch.decision,
          orderAB: orderRecord(canaryMatch.orderAB),
          orderBA: orderRecord(canaryMatch.orderBA),
        } : {
          // No canary call was made: the degraded copy was the same image, so the pick went untested.
          pipeline: 'v3',
          protocol: pair.orderAB.promptVersion,
          passed: null,
          unavailable: canaryUnavailable,
        }) as any,
      });
    }
    if (selection.canary) {
      const subject = ranked.find((x) => x.sourceIndex === selection.canary!.subject.sourceIndex)!.candidate;
      const m = selection.canary.match;
      await this.repo.insertJudgment({
        id: randomUUID(),
        runId: run.id,
        tenantId: s.tenantId,
        kind: 'canary',
        candidateA: subject.id,
        verdict: {
          pipeline: 'v3',
          passed: selection.canary.passed,
          consistentWinner: m.winnerId,
          orderAB: { votes: m.orderAB.votes, majorityWinner: m.orderAB.majorityWinner, receipt: m.orderAB.receipt },
          orderBA: { votes: m.orderBA.votes, majorityWinner: m.orderBA.majorityWinner, receipt: m.orderBA.receipt },
        } as any,
      });
    }

    await this.recordV3Ranking(s, [winner, ...eligibleCandidatesV3(ranked).map((r) => r.candidate).filter((c) => c.id !== winner.id)], winner,
      ranked.filter((r) => r.hardQa?.passed !== true).map((r) => r.candidate));

    const judgeStatus: DesignStudioJudgeStatus =
      selection.judgeReliable === null ? 'SKIPPED' : selection.judgeReliable ? 'RELIABLE' : 'UNRELIABLE';
    stages.tournament = {
      pipeline: 'v3',
      winnerId: winner.id,
      decidedBy: selection.decidedBy,
      judgeWinner: selection.match ? idFor(selection.match.winnerId) ?? selection.match.winnerId
        : selection.briefBound && selection.briefBound.match.winnerId !== 'UNCERTAIN'
          ? idFor(selection.briefBound.match.winnerId) ?? null : null,
      consistent: selection.match?.isConsistent ?? (selection.briefBound ? !selection.briefBound.match.decision.uncertain : null),
      judgeProtocol: selection.protocol,
      humanChoiceRecommended: selection.humanChoiceRecommended,
      excludedCandidates: excludedEvidence(ranked),
      // ADR-170: why the house prior chose, when the judge left the pair undecided.
      ...(selection.prior ? { prior: selection.prior } : {}),
    };
    stages.canary = { passed: selection.canary?.passed ?? selection.briefBound?.canaryPassed ?? null,
      ...(selection.briefBound?.canaryUnavailable ? { unavailable: selection.briefBound.canaryUnavailable } : {}) };

    await this.repo.updateRunStatus(run.id, s.tenantId, 'qa', {
      stages,
      budget,
      winnerCandidateId: winner.id,
      judgeStatus,
      diagnostic:
        selection.judgeReliable === false
          ? 'The judge did not beat a degraded copy of its choice in both orders; the higher composite stands.'
          : null,
    });
    return { runId: run.id, status: 'qa', stage: 'judging', winnerCandidateId: winner.id, judgeStatus, spentUsd: budget.spentUsd };
  }

  /** Winner first, then the rest in the order given; every candidate keeps a rank. */
  private async recordV3Ranking(s: Scope, ordered: CandidateState[], winner: CandidateState, excluded: CandidateState[] = []): Promise<void> {
    for (const candidate of excluded) await this.repo.updateCandidate(candidate.id, s.tenantId, { status: 'eliminated', rank: null });
    for (let i = 0; i < ordered.length; i++) {
      await this.repo.updateCandidate(ordered[i].id, s.tenantId, {
        status: ordered[i].id === winner.id ? 'winner' : 'runner_up',
        rank: i + 1,
      });
    }
  }

  /**
   * Degradation ladder Rung 4: Studio stage fails after retries -> fallback to single-shot planner path.
   */
  /**
   * What this run has actually spent, read back from the row rather than from the caller's copy.
   *
   * Every terminal return below used to omit `spentUsd` altogether, so the operator driving a run
   * by hand saw a figure for each stage that advanced and nothing at all for the stage that failed
   * — and the failing stage is often the expensive one, because it is the one that retried. A real
   * recovery run on 2026-09-21 reported $0.054, then $0.17, then nothing, while the run's own
   * ledger finished at $0.8365 over 12 calls. Reporting no number for the costliest step is worse
   * than reporting a wrong one: it reads as free.
   *
   * `onSpendUpdate` persists the budget after every call, so the row is the truth here; the `run`
   * object in hand was loaded before the stage ran and is stale by definition.
   */
  private async spentSoFar(s: Scope, runId: string, fallback: any): Promise<number | undefined> {
    try {
      const row = await this.repo.getRunById(runId, s.tenantId);
      const budget = typeof row?.budget === 'string' ? JSON.parse(row.budget) : row?.budget;
      if (typeof budget?.spentUsd === 'number') return budget.spentUsd;
    } catch {
      // Fall through to the caller's copy: a stale number beats none on a failure path.
    }
    const stale = typeof fallback === 'string' ? JSON.parse(fallback) : fallback;
    return typeof stale?.spentUsd === 'number' ? stale.spentUsd : undefined;
  }

  private async executeRung4Fallback(s: Scope, run: any, reason: string): Promise<StudioResumeResult> {
    if (isPipelineV3Run(run)) {
      await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
        diagnostic: `Studio v3 failed: ${reason}. Legacy single-shot fallback is disabled for v3 runs.`,
      });
      return {
        runId: run.id,
        status: 'failed',
        diagnostic: `Studio v3 failed: ${reason}`,
        spentUsd: await this.spentSoFar(s, run.id, run.budget),
      };
    }
    const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
    const planner =
      this.options.planner ||
      (this.canva
        ? new CanvaDesignPlanner(this.db, this.canva, {
            apiKey: this.options.apiKey,
            fetcher: this.options.fetcher,
          })
        : null);

    if (planner) {
      try {
        const fallbackKey = `fb-${run.request_key}`.slice(0, 128);
        let fallbackResult: any = await planner.generate(s, run.task_id, fallbackKey, request.width, request.height);

        // If Canva import is submitted, poll until retrieved so designId is acquired
        let attempts = 0;
        while (fallbackResult.status === 'submitted' && attempts < 30 && this.canva) {
          await new Promise((r) => setTimeout(r, 2000));
          attempts++;
          fallbackResult = await this.canva.resumeImport(s, run.task_id, fallbackResult.operationId);
        }

        await this.repo.updateRunStatus(run.id, s.tenantId, 'degraded', {
          planId: fallbackResult.planId,
          diagnostic: `Rung 4 studio fallback: ${reason}. Single-shot planner called (studioFallback: true).`,
        });

        return {
          runId: run.id,
          status: 'degraded',
          planId: fallbackResult.planId,
          designId: fallbackResult.designId,
          message: `Rung 4 studio fallback: single-shot planner called with studioFallback: true (${reason}).`,
          diagnostic: `Rung 4 fallback: ${reason}`,
          spentUsd: await this.spentSoFar(s, run.id, run.budget),
        };
      } catch (fbErr: any) {
        // Fallback also failed
        await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
          diagnostic: `Studio failed (${reason}) and Rung 4 fallback failed (${fbErr.message}).`,
        });
        return {
          runId: run.id,
          status: 'failed',
          diagnostic: `Studio failed (${reason}) and Rung 4 fallback failed: ${fbErr.message}`,
          spentUsd: await this.spentSoFar(s, run.id, run.budget),
        };
      }
    }

    await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
      diagnostic: `Studio stage failed: ${reason}.`,
    });
    return {
      runId: run.id,
      status: 'failed',
      diagnostic: reason,
      spentUsd: await this.spentSoFar(s, run.id, run.budget),
    };
  }

  /**
   * Selects a candidate when run is in awaiting_selection.
   */
  public async selectCandidate(s: Scope, taskId: string, runId: string, candidateId: string): Promise<StudioResumeResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    if (run.task_id && taskId && run.task_id !== taskId) {
      throw new CanvaFlowError(403, 'TASK_SCOPE_MISMATCH', 'The studio run belongs to a different task.');
    }
    if (run.actor_id && s.actorId && run.actor_id !== s.actorId && s.role !== 'administrator' && s.role !== 'art_director') {
      throw new CanvaFlowError(403, 'ACTOR_SCOPE_MISMATCH', 'Studio candidate selection can only be performed by the initiating actor or an administrator/art director.');
    }
    if (run.status !== 'awaiting_selection') {
      throw new CanvaFlowError(409, 'NOT_AWAITING_SELECTION', `Run is in status '${run.status}', not 'awaiting_selection'.`);
    }

    const candidates = await this.repo.getCandidatesForRun(runId, s.tenantId);
    const candidate = candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new CanvaFlowError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found for this run.');

    await this.tx(s, async db => {
      const task = (await sql<{state:string}>`SELECT state FROM hawa.tasks
        WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      assertTaskGenerationAllowed(task?.state);
      await assertNativeRevisionAdmission(db, s.tenantId, taskId,
        (typeof run.request === 'string' ? JSON.parse(run.request) : run.request)?.directed?.parentTaskId);
      await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', { winnerCandidateId: candidateId }, db);
    });

    try {
      return await this.resume(s, taskId, runId);
    } catch (err) {
      if (err instanceof CanvaFlowError && err.code === 'TASK_GENERATION_BLOCKED') throw err;
      return {
        runId,
        status: 'transferring',
        winnerCandidateId: candidateId,
        message: 'Candidate selected; ready for Canva transfer.',
      };
    }
  }

  /**
   * Stops future admission; unresolved provider calls remain held at task scope.
   */
  public async abandon(s: Scope, taskId: string, runId: string, reason: string): Promise<StudioResumeResult> {
    const why = String(reason || '').trim();
    if (why.length < 3 || why.length > 500) {
      throw new CanvaFlowError(422, 'REASON_REQUIRED', 'Give a short reason (3-500 chars) for abandoning this studio run.');
    }

    return this.tx(s, async (db) => {
      await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db);
      const run = await this.repo.getRunById(runId, s.tenantId, db);
      if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
      if (run.task_id && taskId && run.task_id !== taskId) {
        throw new CanvaFlowError(403, 'TASK_SCOPE_MISMATCH', 'The studio run belongs to a different task.');
      }
      if (run.actor_id && s.actorId && run.actor_id !== s.actorId && s.role !== 'administrator' && s.role !== 'art_director') {
        throw new CanvaFlowError(403, 'ACTOR_SCOPE_MISMATCH', 'Studio run can only be abandoned by the initiating actor or an administrator/art director.');
      }
      if (['transferred', 'abandoned', 'failed', 'degraded'].includes(run.status)) {
        throw new CanvaFlowError(409, 'CANNOT_ABANDON', `Cannot abandon run in status '${run.status}'.`);
      }

      await this.repo.updateRunStatus(runId, s.tenantId, 'abandoned', {
        diagnostic: `Abandoned by ${s.actorId}: ${why}`,
      }, db);

      return {
        runId,
        status: 'abandoned',
        message: 'Studio run abandoned. Unresolved model calls still require reconciliation before new paid work.',
      };
    });
  }

  /**
   * P8 — Canva parity check on the exported Canva PNG.
   * Compares the winner preview PNG with the exported Canva PNG.
   */
  public async runParityCheck(s: Scope, runId: string): Promise<ParityResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    if (!run.winner_candidate_id) {
      throw new CanvaFlowError(422, 'NO_WINNER_CANDIDATE', 'Studio run has no selected winner candidate.');
    }

    const candidate = await this.repo.getCandidateById(run.winner_candidate_id, s.tenantId);
    if (!candidate?.preview_png) {
      throw new CanvaFlowError(404, 'PREVIEW_NOT_FOUND', 'Winner candidate has no rendered preview image.');
    }

    const canvaExportRow = await this.tx(s, async (db) =>
      (await sql<any>`SELECT content FROM hawa.canva_export_bytes
        WHERE task_id = ${run.task_id}::uuid AND tenant_id = ${s.tenantId}::uuid AND format = 'png'
        ORDER BY created_at DESC LIMIT 1`.execute(db)).rows[0]
    );
    if (!canvaExportRow?.content) {
      throw new CanvaFlowError(404, 'CANVA_PNG_NOT_FOUND', 'Exported Canva PNG not found for task.');
    }

    // Three of the five answers parity used to ask a vision model for are already known exactly.
    // The PPTX export is parsed by checkCanvaPptx, which reads the slide XML: whether every copy
    // string survived word for word, whether each text object kept the typeface it was sent in, and
    // whether right-to-left runs stayed right-to-left. That check already gates delivery — the
    // worker refuses on copyPass or fontPass (canva-draft-workflow.ts) — so parity was paying the
    // top-tier model to squint at a picture and re-guess facts the pipeline had in hand, less
    // reliably than the XML states them. They are now handed over as stated facts, leaving the
    // model only the question the bytes cannot answer: did the arrangement survive the round trip.
    const contentCheck = await this.tx(s, async (db) =>
      (await sql<any>`SELECT content_check FROM hawa.canva_export_bytes
        WHERE task_id = ${run.task_id}::uuid AND tenant_id = ${s.tenantId}::uuid
          AND format = 'pptx' AND content_check IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`.execute(db)).rows[0]?.content_check
    );

    const budget = parseStudioBudget(run.budget);
    // The parity call's cost reaches the run's stored budget, as every stage's does (doResume's
    // onSpendUpdate). It was added to this in-memory copy only until 2026-09-24, and counted as a
    // second call on top of the ledger wrapper's own count. The budget alone is written: the run's
    // status and liveness (updated_at) are not the parity check's to change. A completed run is
    // immutable (trigger immutable_design_studio_run), so a transferred run's parity cost stays on the
    // calls ledger (design_studio_calls), which the Desk's total adds up.
    const stageCtx = await this.createStageContext(s, run, 'parity', budget, async (cost) => {
      budget.spentUsd += cost;
      await this.tx(s, (db) =>
        sql`UPDATE hawa.design_studio_runs SET budget = ${JSON.stringify(budget)}::jsonb
          WHERE tenant_id = ${s.tenantId}::uuid AND id = ${runId}::uuid
            AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')`.execute(db)
      );
    });
    const parityResult = await runParityStage(
      stageCtx,
      candidate.preview_png,
      canvaExportRow.content,
      typeof contentCheck === 'string' ? JSON.parse(contentCheck) : contentCheck
    );

    // Record judgment in append-only table
    await this.repo.insertJudgment({
      id: randomUUID(),
      runId: run.id,
      tenantId: s.tenantId,
      kind: 'parity',
      candidateA: run.winner_candidate_id,
      candidateB: null,
      orderSwapped: false,
      verdict: parityResult as any,
    });

    if (!['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status)) {
      const stages = typeof run.stages === 'string' ? JSON.parse(run.stages || '{}') : run.stages || {};
      stages.parity = parityResult;
      await this.repo.updateRunStatus(runId, s.tenantId, run.status, { stages });
    }

    return parityResult;
  }
}
