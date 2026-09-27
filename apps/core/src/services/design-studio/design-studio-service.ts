import { reserveStudioText, reserveStudioImage, type OpenAiStructuredResponse } from '@hawa/creative';
import { studioUsdMicros, type StudioCallReservation } from '@hawa/domain';
import { TaskGenerationBlockedError } from '@hawa/db';
import { assertTaskGenerationAllowed, assertStudioCallsResolved } from '../task-generation-guard.js';
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
} from '@hawa/db';
import {
  OpenAiStudioClient,
  OpenAiImageProvider,
  requestStudioArtImage,
  StudioArtAccountingError,
  type StudioLayoutV2,
  ExemplarRetrievalIndex,
  studioReferenceFromRaw,
  creativeAssetPath,
  fontCoversText,
  fontFamilyScript,
  probeFontScripts,
} from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { resolveModel, resolveImageSettings, newStudioBudget, parseStudioBudget, StudioBudgetEvidenceError } from '@hawa/domain';
import { resolveOrnamentSettings, imagePixelSize, settlePhotos, uprightPhotoDataUrl, type OrnamentSettings } from '@hawa/creative';
import { requestedBackgroundFor } from './stages/brief.stage.js';
import { runDirectedEditStage, isModelTransportError, DirectedEditRefusal } from './stages/edit.stage.js';
import { PhotoCutouts, CUTOUT_WORDS, arrangeCutouts, alignFramedHeads, type PhotoFaces } from './photo-cutouts.js';
import { log } from '../../logging.js';
import { blobStoreFor, putToStore, readPreferringStore } from '../blob-store-context.js';
import { assertCurrentClientDesignReference, resolveClientDesignReference } from '../client-design-reference.js';

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
  if (typeof run.stages !== 'string') return (run.stages as Record<string, any>) || {};
  try { return JSON.parse(run.stages); } catch { return {}; }
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
  runJudgeStageV3,
  rankStudioCandidatesV3,
  V3_CANDIDATE_SLOTS,
  pendingV3Concept,
} from './stages/index.js';

export type Scope = { tenantId: string; actorId: string; role?: string; clientId?: string };

class RequestOwnedImageUnavailable extends Error {}

const optionalImages = (error: unknown): string[] => {
  if (error instanceof RequestOwnedImageUnavailable) throw error;
  return [];
};

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

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
  tier?: 'standard' | 'premium';
  imagery?: 'auto' | 'none' | 'generated';
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
      for (const ref of orderedAlbumImages(payload.lifecycleAlbum, refs)) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(ref.media_type)) {
          throw new Error('A request-owned image has an unsupported stored media type');
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
    const copyBlocks: CopyBlock[] = content.copy.map((text, idx) => ({
      text,
      script: copyScripts[idx] === 'arabic' ? 'arabic' : 'latin',
      locale: copyLocales[idx],
      localeCopySha256: createHash('sha256').update(text).digest('hex'),
    }));
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
      (process.env.DESIGN_STUDIO_IMAGERY_DEFAULT as any) ||
      'auto';

    const taskCtx = await this.getTaskContext(s, taskId, params.width, params.height);

    // Which pipeline a run uses is decided once, here, from the chat the task came from, and
    // recorded on the run so every later stage and every resume agrees. The key is omitted rather
    // than written false so a non-v3 run's request hash is unchanged from before it existed.
    const pipelineV3 = runsPipelineV3(taskCtx.task.source?.sourceChannelId);
    if (pipelineV3 && taskCtx.reference.status !== 'reference_for_draft_not_release_approval') {
      throw new CanvaFlowError(422, 'CLIENT_V3_PROFILE_REQUIRED',
        'This client has no admitted Studio v3 font and exemplar profile. Use the standard Studio path until its profile is qualified.');
    }
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
      | { pipelineV3?: boolean; directed?: { parentTaskId?: string; answers?: string } }
      | undefined;
    const own = await this.requestImages(s, run.task_id);
    const parentTaskId = request?.pipelineV3 ? request?.directed?.parentTaskId : undefined;
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
        await sql<{ parent: string | null; answers: string | null }>`SELECT
            COALESCE(e.data->'payload'->'studioOptions'->>'parentTaskId', e.data->'studioOptions'->>'parentTaskId') AS parent,
            COALESCE(e.data->'payload'->'studioOptions'->>'answers', e.data->'studioOptions'->>'answers') AS answers
          FROM hawa.task_events e
          WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid AND e.event_type='task.created'
          ORDER BY e.aggregate_version LIMIT 1`.execute(db)
      ).rows[0]
    );
    const uuid = (v: string | null | undefined) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);
    return { parent: uuid(row?.parent), answers: uuid(row?.answers) };
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
  private async withClientRules(s: Scope, ctx: StageContext): Promise<StageContext> {
    // No database (a unit harness) means no rules to read; with one, a failed read stops the run.
    if (!ctx.clientId || typeof (this.db as { transaction?: unknown })?.transaction !== 'function') return ctx;
    const rules = await this.tx(s, (db) => new ClientRulesRepository(db).listActive(s.tenantId, ctx.clientId));
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
    onSpendUpdate: (cost: number) => Promise<void>
  ): Promise<StageContext> {
    const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
    const fetchFn = this.options.fetcher || fetch;
    const apiKey = this.options.apiKey || process.env.OPENAI_API_KEY || 'mock-key';

    const baseClient = new OpenAiStudioClient({
      apiKey,
      fetcher: fetchFn,
      timeoutMs: 240000,
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
      account(() => this.repo.finalizeCall(params));
    const recordSpend = (cost: number) => account(() => onSpendUpdate(cost));

    // PostgreSQL admits one logical call identity before transport. The ordinal fences two Core
    // processes that read the same run budget; parity is content-keyed because a transferred run's
    // budget is immutable and a changed Canva export must remain independently checkable.
    const admitCall = async (call: {
      id: string; stage: string; provider: string; model: string; input: unknown; reservation: StudioCallReservation;
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
    const complete = async <T>(invoke: (beforeDispatch: (body: string) => Promise<void>) => Promise<OpenAiStructuredResponse<T>>) => {
      if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
        throw new StudioBudgetExhaustedError();
      }
      const callId = randomUUID();
      let reservation: StudioCallReservation | undefined;
      let result: OpenAiStructuredResponse<T>;
      try {
        result = await invoke(async body => {
          const quoted = reserveStudioText(body);
          const model = JSON.parse(body).model as string;
          await admitCall({ id: callId, stage: currentStageName, provider: 'openai', model,
            input: { requestSha256: quoted.requestSha256 }, reservation: quoted });
          reservation = quoted;
        });
      } catch (err: any) {
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
        checkReservation(billedUsd, reservation);
        throw err;
      }
      const cost = result.receipt.costUsd;
      await finalizeCall({ id: callId, tenantId: s.tenantId, responseId: result.receipt.responseId,
        servedModel: result.receipt.servedModel, providerRequestId: result.receipt.xRequestId,
        responseSha256: result.receipt.sha256, latencyMs: result.receipt.latencyMs,
        attempts: result.receipt.attempts, inputTokens: result.receipt.inputTokens,
        cachedInputTokens: result.receipt.cacheReadTokens || 0, outputTokens: result.receipt.outputTokens,
        usdEstimate: cost, costBasis: result.receipt.costBasis ?? 'estimate', status: 'ok' });
      await recordSpend(cost);
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
        const settings = resolveImageSettings();
        return baseArtProvider.generateArt({ ...params, settings, visionClient: ledgerClient,
          requestImage: async (selected, prompt) => {
            if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
              throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
            }
            const callId = randomUUID();
            let reservation: StudioCallReservation | undefined;
            const started = Date.now();
            let result: Awaited<ReturnType<typeof requestStudioArtImage>>;
            try {
              result = await requestStudioArtImage(selected, prompt,
                selected.provider === 'google' ? params.geminiApiKey || process.env.GEMINI_API_KEY || '' : apiKey,
                fetchFn, async body => {
                  const quoted = reserveStudioImage(selected.provider, body);
                  await admitCall({ id: callId, stage: 'art', provider: selected.provider, model: selected.model,
                    input: { requestSha256: quoted.requestSha256 }, reservation: quoted });
                  reservation = quoted;
                });
            } catch (error) {
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
              costBasis: !result ? 'not_accepted' : result.costSource === 'usage' ? 'usage' : 'estimate',
              errorCode: result ? null : 'IMAGE_REQUEST_REJECTED', latencyMs: Date.now() - started, attempts: 1 });
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

    if (packagedKaae) {
      // Read the way the qualification reads it (shared), so both design with the same rules.
      const rules = studioReferenceFromRaw(reference);
      referencePack = { palette: rules.palette, referenceFonts: { latin: rules.latinFont, arabic: rules.arabicFont },
        clientId: reference.clientId, referenceHash: request.referenceHash };
      latinFont = rules.latinFont;
      arabicFont = rules.arabicFont;
      promotedRules = rules.promotedRules;
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
    if (packagedKaae) try {
      const retrievalIndex = new ExemplarRetrievalIndex();
      const briefQuery = {
        text: (s as any).instructions || (s as any).title || (run as any).title || '',
        format: (s as any).format,
        category: (s as any).topic,
      };
      const retrieval = retrievalIndex.retrieveTopExemplars(briefQuery, 3);
      for (const item of retrieval.retrievedExemplars) {
        // The manifest still records the archive path the exemplar was curated from, which is
        // outside the package and absent from the image; the copy in the package's own assets is
        // the one that travels.
        const archived = resolve(process.cwd(), item.path);
        const imgPath =
          creativeAssetPath(`exemplars/${item.filename}`, { optional: true }) ??
          (existsSync(archived) ? archived : undefined);
        if (imgPath) {
          exemplars.push({
            path: imgPath,
            label: item.filename || item.descriptor || 'KAAE Exemplar',
            bytes: readFileSync(imgPath),
            mimeType: 'image/png',
          });
        }
      }
    } catch (err: any) {
      log.error(
        `[design-studio] Exemplar images could not be loaded (${err?.message || err}); ` +
          `this design is being generated without exemplar conditioning.`
      );
    }
    if (packagedKaae && !exemplars.length) {
      // In production this was silent: the layout model was conditioned on nothing and no one
      // could tell from the logs that the run had seen no exemplar at all.
      log.error(
        `[design-studio] No exemplar image resolved under ${creativeAssetPath('exemplars', { optional: true }) || 'packages/creative/assets/exemplars'}; ` +
          `run ${run.id} is being conditioned on no exemplar.`
      );
    }

    const logo = { bytes: logoBytes, sha256: reference.logoSha256, mimeType: 'image/png' as const };

    return {
      runId: run.id,
      tenantId: s.tenantId,
      taskId: run.task_id,
      clientId: run.client_id,
      actorId: s.actorId,
      width: request.width,
      height: request.height,
      tier: run.tier as any,
      instructions: request.instructions,
      copyBlocks: request.copyBlocks,
      referencePack,
      promotedRules,
      latinFont,
      arabicFont,
      logoAspect: request.logoAspect || 1.0,
      logo,
      exemplars,
      client: ledgerClient as any,
      artProvider: ledgerArtProvider as any,
      pipelineV3: isPipelineV3Run(run),
      requestedBackground: requestedBackgroundFor(runStages(run).brief, referencePack.palette),
      ornament: packagedKaae ? ornamentSettings() : undefined,
      style: (runStages(run).brief as CreativeBrief | undefined)?.styleSpec,
    };
  }

  /**
   * Advances a design studio run by exactly one stage.
   * Interrupted runs resume from the current stage without duplicating prior stage calls.
   * Concurrent requests for the same run share the in-flight promise to prevent race conditions.
   */
  private async assertTaskCanGenerate(s: Scope, taskId: string): Promise<void> {
    await this.tx(s, async db => {
      const task = (await sql<{state:string}>`SELECT state FROM hawa.tasks
        WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
      assertTaskGenerationAllowed(task?.state);
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
    const priorCalls = await this.repo.getCallsForRun(runId, s.tenantId);
    const unresolvedCall = priorCalls.find((call) => call.status === 'uncertain');
    if (unresolvedCall) {
      throw new CanvaFlowError(409, 'MODEL_CALL_UNCERTAIN',
        `The ${unresolvedCall.stage} model call has an unknown outcome. Reconcile its provider result before resuming this run.`);
    }
    // If a paid reply was recorded but this stage never advanced, the reply itself is no longer
    // available for replay. The current-stage call is evidence of work already done, not permission
    // to run that stage's model again. Art is recorded under its role name within laying_out.
    const alreadyPaid = priorCalls.find((call) =>
      (call.stage === run.status || (run.status === 'laying_out' && call.stage === 'art')) &&
      (call.status === 'ok' || (call.status === 'error' && Number(call.usd_estimate) > 0)));
    if (alreadyPaid) {
      throw new CanvaFlowError(409, 'MODEL_STAGE_REPLAY_UNSAFE',
        `The ${run.status} stage has a recorded paid model call but no saved stage result. Review that call before starting a new run.`);
    }

    await this.assertTaskCanGenerate(s, taskId);

    const stages: Record<string, any> =
      typeof run.stages === 'string' ? JSON.parse(run.stages || '{}') : run.stages || {};
    const budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number } =
      typeof run.budget === 'string' ? JSON.parse(run.budget) : run.budget;

    const onSpendUpdate = async (cost: number) => {
      budget.spentUsd += cost;
      await this.repo.updateRunStatus(runId, s.tenantId, run.status, { budget });
    };

    // Building the context reads the client's reference pack, and a missing pack now throws rather
    // than designing with defaults. Outside the try below that left the run in 'briefing' for the
    // worker to retry for ever, so it is marked failed here with the reason.
    let ctx: StageContext;
    try {
      ctx = await this.withClientRules(s, await this.createStageContext(s, run, run.status, budget, onSpendUpdate));
    } catch (err: any) {
      const diagnostic = `Stage context could not be built: ${err?.message || err}`;
      await this.repo.updateRunStatus(runId, s.tenantId, 'failed', { stages, budget, diagnostic });
      throw err;
    }
    // The handler at the end covers the reads and the re-briefs before the stage as well. An
    // exception from them (the image re-brief's model call, a picture that would not decode) used
    // to leave the run at its stage for the worker to poll until it gave up on it as stuck.
    try {
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
        const reread = await runBriefStage(ctx);
        const photosSent = (reread.imageRoles || []).filter((r) => r.role === 'content_photo').length;
        stages.brief = { ...reread, photosSent, imagesRebrief: true };
        await this.repo.updateRunStatus(runId, s.tenantId, 'conceiving', { stages, budget });
        briefSoFar = stages.brief as LateReferenceBrief;
        ctx.requestImages = undefined;
      }
      const rolesNow = briefSoFar?.imageRoles;
      if (rolesNow && images.length > 0 && rolesNow.length === images.length) {
        classified = true;
        ctx.photos = rolesNow.filter((r) => r.role === 'content_photo').map((r) => contentPhotoFromDataUrl(images[r.index]));
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
          const brief = await runBriefStage(ctx);
          // Recorded on the run so the requester's note can say what became of their photos.
          const photosSent = (brief.imageRoles || []).filter((r) => r.role === 'content_photo').length || (ctx.photos?.length ?? 0);
          stages.brief = { ...brief, photosSent };
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
          const concepts = ctx.pipelineV3 ? [] : await runConceptsStage(ctx, brief);
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
              const inherited = Array.isArray(parentStages?.effectiveCopy) && parentStages.effectiveCopy.length === ctx.copyBlocks.length ? parentStages.effectiveCopy : undefined;
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
              for (let i = 1; i < V3_CANDIDATE_SLOTS; i++) {
                await this.repo.insertCandidate({ id: randomUUID(), runId: run.id, tenantId: s.tenantId, ordinal: i, concept: pendingV3Concept(i) as unknown as Record<string, unknown>, status: 'draft' });
              }
            }
          }
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);

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
            for (const p of cand.currentLayout.photos ?? []) {
              const f = focus[p.photoIndex];
              if (f && p.treatment !== 'cutout') p.focus = { x: f.x, y: f.y };
            }
          }
          // Every photo with a cut-out is shown cut out, set as a designer sets people: standing on
          // the bottom edge, heads matched, clear of the text. Before the art, which works around them.
          if (ctx.photoCutouts?.some(Boolean)) {
            for (const cand of candidateStates) {
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
          for (const cand of candidateStates) alignFramedHeads(cand.currentLayout, focus, sizes);
          const artCandidates = await runArtStage(ctx, candidateStates);

          for (const row of candidateRows) {
            const cand = artCandidates.find((c) => c.ordinal === row.ordinal);
            if (cand) {
              await this.repo.updateCandidate(row.id, s.tenantId, {
                layouts: [cand.currentLayout] as any,
                status: 'draft',
                artPng: cand.artPng,
                artSha256: cand.artSha256,
                artProvenance: cand.artProvenance as any,
                ...(ctx.pipelineV3 ? { concept: cand.concept as any } : {}),
              });
            } else {
              await this.repo.updateCandidate(row.id, s.tenantId, {
                status: 'eliminated',
              });
            }
          }

          stages.layouts = { count: artCandidates.length };
          await this.repo.updateRunStatus(runId, s.tenantId, 'rendering', { stages, budget });
          return { runId, status: 'rendering', stage: 'layouts', spentUsd: budget.spentUsd };
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
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques,
              score: row.score ? parseFloat(row.score.toString()) : undefined,
              status: row.status as DesignStudioCandidateStatus,
            };
          });

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
            critiques: [],
            status: 'winner',
          };

          const qaResult = await runQAStage(ctx, winnerState);
          stages.qa = qaResult;

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
                critiques: [],
                status: 'runner_up',
              };
              const otherQA = await runQAStage(ctx, otherState);
              if (otherQA.passed) {
                await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', {
                  winnerCandidateId: otherRow.id,
                  stages,
                  budget,
                });
                return { runId, status: 'transferring', stage: 'qa', winnerCandidateId: otherRow.id };
              }
            }

            // Rung 4 fallback: trigger planner fallback
            return this.executeRung4Fallback(s, run, `Winner failed hard QA: ${qaResult.defectCodes.join(', ')}`);
          }

          // Check if operator requested holdForSelection
          const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
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
      if (['TASK_GENERATION_BLOCKED', 'STUDIO_BUDGET_INVALID', 'STUDIO_BUDGET_HISTORY_INCOMPLETE',
        'STUDIO_BUDGET_UNQUOTABLE', 'STUDIO_BUDGET_RESERVATION_EXCEEDED'].includes(err?.code)) {
        throw new CanvaFlowError(409, err.code, err.message);
      }
      if (isModelCallHoldError(err)) {
        const code = ['MODEL_CALL_ADMISSION_CONFLICT', 'MODEL_CALL_FINALIZATION_CONFLICT', 'MODEL_CALL_ACCOUNTING_FAILED'].includes(err?.code)
          ? err.code : 'MODEL_CALL_UNCERTAIN';
        throw new CanvaFlowError(409, code,
          'A Studio model call may have been accepted or another process already recorded its outcome. Reconcile the call before continuing this run.');
      }
      // Not a failure: the run waits at its stage for the design it revises, and a later resume
      // makes the edit.
      if (err instanceof CanvaFlowError && err.code === 'PARENT_STILL_RUNNING') throw err;
      if (err instanceof StudioBudgetExhaustedError) {
        // Budget exhausted: gracefully handle by selecting best candidate so far
        return this.handleBudgetExhaustion(s, run, ctx, budget, err.message);
      }

      if (ctx.pipelineV3) {
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
      reread = await runBriefStage(ctx, { lateReference: true });
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
    return brief;
  }

  /**
   * Graceful budget exhaustion handling: selects best candidate so far that passes hard QA.
   */
  private async handleBudgetExhaustion(
    s: Scope,
    run: any,
    ctx: StageContext,
    budget?: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    reason?: string
  ): Promise<StudioResumeResult> {
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

    if (bestCandidate) {
      await this.repo.updateRunStatus(run.id, s.tenantId, 'transferring', {
        winnerCandidateId: bestCandidate.id,
        diagnostic: `BUDGET_EXHAUSTED${cap}${reason ? `: ${reason}` : ''}: proceeded with best candidate passing hard QA.`,
      });
      return {
        runId: run.id,
        status: 'transferring',
        diagnostic: 'BUDGET_EXHAUSTED',
        winnerCandidateId: bestCandidate.id,
      };
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
    try {
      outcome = await runJudgeStageV3(ctx, candidateStates);
    } catch (err) {
      if (isModelCallHoldError(err)) throw err;
      if (err instanceof StudioBudgetExhaustedError) throw err;
      // Judge unavailable: the higher composite stands, and the run says so.
      const message = err instanceof Error ? err.message : String(err);
      const ranked = rankStudioCandidatesV3(ctx, candidateStates).map((r) => r.candidate);
      const winner = ranked[0];
      await this.recordV3Ranking(s, ranked, winner);
      stages.tournament = { pipeline: 'v3', winnerId: winner.id, decidedBy: 'composite_judge_unavailable', error: message };
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
          } as any,
        });
      }
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

    await this.recordV3Ranking(s, [winner, ...ranked.map((r) => r.candidate).filter((c) => c.id !== winner.id)], winner);

    const judgeStatus: DesignStudioJudgeStatus =
      selection.judgeReliable === null ? 'SKIPPED' : selection.judgeReliable ? 'RELIABLE' : 'UNRELIABLE';
    stages.tournament = {
      pipeline: 'v3',
      winnerId: winner.id,
      decidedBy: selection.decidedBy,
      judgeWinner: selection.match ? idFor(selection.match.winnerId) ?? selection.match.winnerId : null,
      consistent: selection.match?.isConsistent ?? null,
    };
    stages.canary = { passed: selection.canary?.passed ?? null };

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
  private async recordV3Ranking(s: Scope, ordered: CandidateState[], winner: CandidateState): Promise<void> {
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
