/**
 * The module-level helpers app.ts used to hold above createApp, moved here unchanged so that route
 * modules and services can use them without importing app.ts (which imports them back to register or
 * build from them: a cycle). app.ts re-exports the ones it always exported (architecture programme
 * 1.3, SPLIT_PLAN.md F1).
 */
import crypto from 'node:crypto';
import { sql, type Database, type Kysely, type PublicationRepository } from '@hawa/db';
import { checkCanvaPptx } from '@hawa/qa';
import type { TelegramActionTokenService, TelegramBridgeDaemon } from '@hawa/integrations';
import type { CanvaConnectService, CanvaServiceOptions } from './services/canva-connect-service.js';
import type { DesignStudioService, DesignStudioServiceOptions } from './services/design-studio/index.js';
import type { DeliverableStore } from './services/pinned-deliverables.js';
import type { ClientDNA } from '@hawa/domain';
import type { ClientDnaSnapshot } from './routes/types.js';

export function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function computeDnaHash(dna: any): string {
  const canonical = canonicalJson(dna);
  return 'sha256_' + crypto.createHash('sha256').update(canonical).digest('hex');
}

export function isValidUuid(id: unknown): boolean {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

type TaskCopyFields = { headlineEn?: string | null; headlineCkb?: string | null; copyEn?: string | null; copyCkb?: string | null };

/**
 * True when the client sent too little copy for an inline template to design around. Every
 * inline template draws only the copy it is given and leaves an empty slot out. A KAAE design
 * needs a headline. A brand design (FastPay, Aster, Drustee) is laid out around a headline and
 * a body card, so it needs both, in one language. Callers refuse with COPY_REQUIRED.
 */
export function inlineTemplateCopyMissing(template: 'kaae' | 'brand', copy: TaskCopyFields): boolean {
  const has = (text?: string | null) => Boolean(text && text.trim());
  if (template === 'kaae') return !has(copy.headlineCkb) && !has(copy.headlineEn);
  return !(has(copy.headlineCkb) && has(copy.copyCkb)) && !(has(copy.headlineEn) && has(copy.copyEn));
}

export const COPY_REQUIRED_DETAIL = 'The client has not sent the copy this design needs. No placeholder copy will be invented.';

/** Postgres, which holds a task's status, is connected and could not be read: nothing acts on a stale copy. */
export class TaskStoreUnavailableError extends Error {
  constructor(taskId: string, cause: unknown) {
    super(`The task ${taskId} could not be read from the database; try again`);
    this.name = 'TaskStoreUnavailableError';
    (this as { cause?: unknown }).cause = cause;
  }
}

export interface CreateAppOptions {
  evaluationGateway?: import('@hawa/contracts').ModelGateway;
  /** ADR-144: the intake router for messages the rules cannot place; tests pass their own. */
  requesterIntentModel?: import('./services/requester-intent-model.js').RequesterIntentModel | null;
  canvaOptions?: CanvaServiceOptions;
  canvaConnectService?: CanvaConnectService;
  designStudioOptions?: DesignStudioServiceOptions;
  designStudioService?: DesignStudioService;
  db?: Kysely<Database>;
  /** The file store (ADR-035); defaults to HAWA_BLOB_DIR's (services/blob-store-context.ts). */
  blobStore?: import('@hawa/db').BlobStore;
  publicationRepo?: PublicationRepository;
  telegramActionTokenService?: TelegramActionTokenService;
  telegramBridge?: TelegramBridgeDaemon;
  /** Where approved exports are read from; defaults to the Canva export store when a database is connected. */
  deliverableStore?: DeliverableStore;
  /** Injectable QA engine for testing; defaults to DeterministicQAEngine. */
  qaEngine?: any;
  publisher?: any;
  /**
   * Test harness only, passed explicitly by a test. `principal`: every request without a bearer
   * token is this principal (a database-less unit test has no sessions to sign in to).
   * `roleHeader`: the x-user-role header sets the role, so a test can act as several people.
   * Production code has no environment switch that turns either on; there is nothing to leave on.
   */
  testAuth?: { principal?: { role: string; userId?: string; displayName?: string }; roleHeader?: boolean;
    googleOidcProvider?: import('./services/google-oidc.js').OfficeOidcProvider };
  /** @deprecated use testAuth.roleHeader */
  allowRoleHeader?: boolean;
  extraBearerTokens?: Record<string, { role: string; email?: string; sub?: string } | string>;
  bypassAuthWithoutDb?: boolean;
  skipPaidModelProbe?: boolean;
  enableBillingProbeSchedule?: boolean;
  skipTelegramProbe?: boolean;
  /** Settle Canva imports and exports nobody is following any more (sweepStrandedOperations). */
  enableCanvaSweeper?: boolean;
  /** Charge Studio and planner calls with no outcome for hours their whole reservation (ADR-159). */
  enableUncertainCallExpiry?: boolean;
  enablePublicationInspections?: boolean;
  publicationInspector?: import('@hawa/contracts').PublicationInspector;
  persistDnaToDisk?: boolean;
  /**
   * Tests only: fills the client DNA map (and its snapshot list, for a test without a database) before
   * the first request. Core seeds nothing itself; the invented offices a test may name live in
   * apps/core/test/fixtures and come through createAppWithClientFixtures (SPLIT_PLAN.md section 6).
   */
  seedClientDna?: (clientDnas: Map<string, ClientDNA>, clientSnapshots: Map<string, ClientDnaSnapshot[]>) => void;
  verifyProviderKeys?: boolean;
  telegramClassifierOptions?: any;
  emulatePublisher?: boolean;
}

/**
 * The hash that names a QA report: the report's own reportSha256 when it states one, otherwise the
 * SHA-256 of the report as stored (what qc_runs.report_sha256 holds). No report, no hash: approvals
 * used to record the literal 'verified_qc_pass' instead.
 */
export function qaReportSha256(report: any): string | null {
  if (!report) return null;
  if (typeof report.reportSha256 === 'string' && report.reportSha256) return report.reportSha256;
  return crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

/**
 * Compares a presented secret with the configured one in constant time. Both sides are hashed first,
 * so neither the position of the first wrong byte nor the secret's length shows in the timing.
 */
export function secretsEqual(presented: string | undefined | null, configured: string | undefined | null): boolean {
  if (!presented || !configured) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

export type DatabaseProbeStatus = 'connected' | 'disconnected' | 'uninitialized';

/**
 * Whether PostgreSQL answers, for /health. "connected" is a result, never a starting value.
 *
 * The probe used to start at 'connected' and turn to 'disconnected' only for ECONNREFUSED or an
 * error message containing "connect". A wrong password, a missing schema, an exhausted pool, a
 * statement timeout or a hung server all left health green, and the watchdog reads this route.
 * Any failure and any answer slower than the timeout is 'disconnected' now. No handle at all is
 * 'uninitialized', which production treats as unhealthy.
 */
export async function probeDatabase(db: unknown, timeoutMs = 2000): Promise<DatabaseProbeStatus> {
  if (!db) return 'uninitialized';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = sql`SELECT 1`.execute(db as any);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database probe exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([query, timeout]);
    return 'connected';
  } catch {
    return 'disconnected';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CanvaQcEvaluationResult {
  sourceTextObjects?: ReturnType<typeof checkCanvaPptx>['sourceTextObjects'];
  qaReport: {
    status: 'passed' | 'failed';
    criticalPass: boolean;
    passed: boolean;
    bidiIsolation: boolean | null;
    /** Paragraph flags never prove rendered Arabic/Sorani order; a person must inspect the final image. */
    rtlVisualReviewRequired: boolean;
    /** Checks declared PPTX families against the captured policy, not actual rendered fonts. */
    fontFamilyPass: boolean | null;
    /** This evaluator does not measure rendered glyphs, fallback fonts or licenses. */
    fontCoverage: null;
    copyFidelity: boolean;
    /** null = this evaluator did not measure it. It reads the exported PPTX, which carries no pixels or geometry verdict. */
    contrastCompliant: boolean | null;
    safeMargins: boolean | null;
    errors: string[];
    checks: Array<{ name: string; passed: boolean | null; details?: any; observedFonts?: string[] }>;
    exportSha256: string | null;
    exportFormat: string | null;
    /** Added when a stored Canva export is linked to a revision's QC run. */
    exportArtifactId?: string;
    captureVersion?: string | null;
    verifiedAt: string;
  };
  criticalPass: boolean;
  status: 'passed' | 'failed';
}

export function evaluateCanvaExportQc(
  exportRow?: { sha256?: string; format?: string; content?: any; content_check?: any },
  expectedCopy?: Array<string | { text: string }>,
  requiredFont?: string
): CanvaQcEvaluationResult {
  const contentCheck = exportRow?.content_check;
  const errors: string[] = [];

  if (!exportRow) {
    errors.push('No Canva export artifact retrieved for task; quality verification unavailable');
    return {
      status: 'failed',
      criticalPass: false,
      qaReport: {
        status: 'failed',
        criticalPass: false,
        passed: false,
        bidiIsolation: false,
        rtlVisualReviewRequired: false,
        fontFamilyPass: null,
        fontCoverage: null,
        copyFidelity: false,
        contrastCompliant: false,
        safeMargins: false,
        errors,
        checks: [
          { name: 'exportRetrieved', passed: false },
          { name: 'copyPass', passed: false },
          { name: 'fontPass', passed: false },
        ],
        exportSha256: null,
        exportFormat: null,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  const bytes = exportRow.content instanceof Uint8Array ? exportRow.content : undefined;
  const actualSha256 = bytes && crypto.createHash('sha256').update(bytes).digest('hex');
  // Manual Desk recaptures can have no design-plan row. In that case the source copy saved with the
  // capture's inspection is the expected text. A current approved/plan copy always takes priority.
  const savedCopy = expectedCopy?.length ? expectedCopy : contentCheck?.expectedCopy;
  // Task creation stores canonical copy blocks; imported manifests store strings. Read their
  // exact text without trimming or dropping malformed entries, and keep task copy authoritative.
  const copyToCheck = Array.isArray(savedCopy) ? savedCopy.map((part: unknown) =>
    typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : undefined) : undefined;
  if (exportRow.format !== 'pptx' || !bytes?.length ||
      !Array.isArray(copyToCheck) || !copyToCheck.length ||
      !copyToCheck.every((part): part is string => typeof part === 'string') ||
      !/^[0-9a-f]{64}$/.test(exportRow.sha256 || '') ||
      actualSha256 !== exportRow.sha256) {
    errors.push('Canva PPTX export bytes, expected copy, or stored SHA-256 are missing or inconsistent');
    return {
      status: 'failed', criticalPass: false,
      qaReport: {
        status: 'failed', criticalPass: false, passed: false,
        bidiIsolation: false, rtlVisualReviewRequired: false, fontFamilyPass: null, fontCoverage: null, copyFidelity: false,
        contrastCompliant: null, safeMargins: null, errors,
        checks: [
          { name: 'exportRetrieved', passed: Boolean(bytes?.length) },
          { name: 'artifactIntegrity', passed: false },
          { name: 'copyPass', passed: false },
          { name: 'fontPass', passed: false },
        ],
        exportSha256: exportRow.sha256 || null,
        exportFormat: exportRow.format || null,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  // A stored content_check is a receipt from capture, not an authority over later bytes. Re-read
  // the pinned PPTX with its captured font policy and current approved copy on every QC run.
  let resolvedCheck: ReturnType<typeof checkCanvaPptx> | null = null;
  try {
    const perBlockFonts = contentCheck?.fontsByIndex;
    if (perBlockFonts && (!Array.isArray(perBlockFonts) || !perBlockFonts.every((face: unknown) => typeof face === 'string'))) {
      throw new Error('Invalid captured font policy');
    }
    const directionOptions = contentCheck?.directionsByIndex == null ? {} : { directionsByIndex: contentCheck.directionsByIndex };
    resolvedCheck = checkCanvaPptx(bytes, copyToCheck,
      contentCheck?.allowedFontsByScript ? { allowedFontsByScript: contentCheck.allowedFontsByScript, ...directionOptions }
        : perBlockFonts ? { fontsByIndex: perBlockFonts, scriptFonts: contentCheck?.scriptFonts || undefined, ...directionOptions }
        : (requiredFont || contentCheck?.requiredFont || 'Verdana'),
      perBlockFonts ? {} : { scriptFonts: contentCheck?.scriptFonts || undefined, ...directionOptions });
  } catch (err: any) {
    errors.push(`PPTX slide check failed: ${err.message || String(err)}`);
  }

  if (!resolvedCheck) {
    errors.push('No verified copy or font check recorded on Canva export bytes');
    return {
      status: 'failed',
      criticalPass: false,
      qaReport: {
        status: 'failed',
        criticalPass: false,
        passed: false,
        bidiIsolation: false,
        rtlVisualReviewRequired: false,
        fontFamilyPass: null,
        fontCoverage: null,
        copyFidelity: false,
        contrastCompliant: false,
        safeMargins: false,
        errors,
        checks: [
          { name: 'exportRetrieved', passed: true },
          { name: 'copyPass', passed: false },
          { name: 'fontPass', passed: false },
        ],
        exportSha256: exportRow.sha256 || null,
        exportFormat: exportRow.format || null,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  const copyPass = resolvedCheck.copyPass === true;
  const fontPass = resolvedCheck.fontPass === true;
  // The parser distinguishes absent metadata from explicit conflicts. Never waive a real
  // false/invalid flag just because the count of true flags is zero. Even correct flags do not
  // prove rendered bidi/isolation, so every eligible Arabic-script design needs visual review.
  const rtlPass = resolvedCheck.rtlPass === true;
  const rtlVisualReviewRequired = rtlPass && resolvedCheck.rtlVisualReviewRequired === true;
  const checkStatus = contentCheck?.status !== 'failed' && contentCheck?.copyPass !== false &&
    contentCheck?.fontPass !== false && contentCheck?.rtlPass !== false;
  const criticalPass = copyPass && fontPass && rtlPass && checkStatus;
  const status: 'passed' | 'failed' = criticalPass ? 'passed' : 'failed';

  if (!copyPass) {
    errors.push(
      resolvedCheck.offendingObjects && resolvedCheck.offendingObjects.length > 0
        ? `Copy mismatch: ${resolvedCheck.offendingObjects.map((o: any) => o.text || o.reason).join('; ')}`
        : 'Exported copy does not match verified source copy exactly'
    );
  }
  if (!fontPass) {
    errors.push(
      resolvedCheck.offendingObjects && resolvedCheck.offendingObjects.length > 0
        ? `Brand font violation: ${resolvedCheck.offendingObjects.map((o: any) => o.reason || o.observedFont).join('; ')}`
        : 'Exported typography violates brand font policy'
    );
  }
  if (!rtlPass) {
    errors.push('RTL text direction violation detected in exported design');
  }
  if (!checkStatus) errors.push('The capture-time content check recorded a failure');

  return {
    status,
    criticalPass,
    sourceTextObjects: resolvedCheck.sourceTextObjects,
    qaReport: {
      status,
      criticalPass,
      passed: criticalPass,
      bidiIsolation: rtlVisualReviewRequired ? null : rtlPass,
      rtlVisualReviewRequired,
      fontFamilyPass: fontPass,
      fontCoverage: null,
      copyFidelity: copyPass,
      contrastCompliant: null,
      safeMargins: null,
      errors,
      checks: [
        { name: 'exportRetrieved', passed: true },
        { name: 'copyPass', passed: copyPass, details: resolvedCheck.offendingObjects || [] },
        { name: 'fontPass', passed: fontPass, observedFonts: resolvedCheck.observedFonts || [] },
        { name: 'paragraphDirectionMetadata', passed: resolvedCheck.rtlMetadataPass, details: resolvedCheck.paragraphDirections },
        { name: 'bidiIsolation', passed: rtlVisualReviewRequired ? null : rtlPass,
          details: rtlVisualReviewRequired ? 'Unmeasured in Canva PPTX; final image needs human visual review' : undefined },
      ],
      exportSha256: exportRow.sha256 || null,
      exportFormat: exportRow.format || null,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * The first `max` characters of `text`, cut between characters, never inside one: String.slice counts
 * UTF-16 units and left half an emoji at the cut, a lone surrogate that Telegram may refuse along with
 * the whole message (review of 2026-09-24).
 */
/** Direction marks and spaces a line may start with: a Sorani keyboard puts U+200F before Latin copy. */
const LEADING_MARKS = /^[\s\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]+/u;

/** A line without the invisible direction marks and spaces it starts with. */
export function stripLeadingMarks(text: string): string {
  return text.replace(LEADING_MARKS, '');
}

/** Whether a line starts with a name as whole words, ignoring case and leading direction marks. */
export function startsWithName(line: string, name: string): boolean {
  const text = stripLeadingMarks(line);
  const n = name.trim();
  return n.length > 0 && text.slice(0, n.length).toLowerCase() === n.toLowerCase() && !/[\p{L}\p{N}]/u.test(text.charAt(n.length));
}

/**
 * ADR-180: a title "<Client>: <line>" whose line already starts with the client's name or acronym,
 * without the repeat. The office's photo alert read "KAAE: \u200FKAAE K-12 Pilot Study…" (2026-09-30).
 * Any other title is returned as it is.
 */
export function withoutRepeatedClient(title: string): string {
  const m = title.match(/^([^:\n]{1,40}):\s*([\s\S]*)$/u);
  if (!m) return title;
  return startsWithName(m[2], m[1]) ? stripLeadingMarks(m[2]) : title;
}

export function cutText(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join('');
}
