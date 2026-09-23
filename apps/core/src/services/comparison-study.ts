import crypto from 'node:crypto';
import { PNG } from '@hawa/creative';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

/**
 * The blinded head-to-head comparison of Hawa with the office's designer (output/plans/
 * 2026-09-23-designer-grade-revisions/PLAN.md, "Blinded comparison with the office designer:
 * protocol"). The claim "Hawa designs better" is decided by people who cannot tell which design is
 * which, never by a model: the requesters and outside designers each see the two finished designs
 * for a request side by side, in an order and on sides nobody chose, and pick one or neither.
 *
 * This module holds the study's rules and its statistics as pure functions, and the reads and writes
 * as functions of a Kysely database and a scope, every one under row-level security. A study is a
 * draft until it is locked; from then on its pre-registration and its pairs cannot change (the
 * database refuses too), judgements are append-only, and the claim is decided only by the
 * pre-registered analysis on the pre-registered sample.
 */

export type Arm = 'hawa' | 'designer';
export type Side = 'left' | 'right';
export type Choice = 'left' | 'right' | 'none';
export type JudgeKind = 'requester' | 'designer';
export type StudyStatus = 'draft' | 'judging' | 'closed';

export interface ComparisonScope {
  tenantId: string;
  userId?: string;
  role?: string;
  /** Who is acting, recorded on the study as its author. */
  actorId?: string;
}

/** The written plan, fixed before any pair is judged. */
export interface Preregistration {
  /** Which requests, how chosen, how many. */
  sample: string;
  /** Who judges, how many judgements per pair. */
  judges: string;
  /** The primary outcome and how it is computed. */
  analysis: string;
  /** The claim holds only if the lower bound of the 95% interval is above this share. */
  threshold: number;
  /** Decisive judgements (a design picked) needed before the claim is decided. */
  minDecisive: number;
  /** Judgements every pair needs before the claim is decided. */
  minJudgesPerPair: number;
  /** Pairs the sample was planned to have. */
  plannedPairs: number;
}

/** A refusal the office or a judge is told in plain words; `status` is the HTTP status it maps to. */
export class ComparisonError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 422, message: string) {
    super(message);
    this.name = 'ComparisonError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const otherArm = (arm: Arm): Arm => (arm === 'hawa' ? 'designer' : 'hawa');
const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// ---------------------------------------------------------------------------------------------
// Statistics (pure)
// ---------------------------------------------------------------------------------------------

/** The two-sided 95% normal quantile. */
export const Z95 = 1.959963984540054;

/**
 * The Wilson score interval for a binomial proportion. It is used rather than the plain normal
 * interval because it stays inside 0..1 and keeps its coverage near the edges and at small counts,
 * which is where an early or lopsided study lives.
 */
export function wilsonInterval(successes: number, n: number, z = Z95): { low: number; high: number } | null {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n <= 0 || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Which arm a choice prefers, given which arm was on the left. Mirrors the database's generated column. */
export function preferredArm(shownLeft: Arm, choice: Choice): Arm | null {
  if (choice === 'none') return null;
  return choice === 'left' ? shownLeft : otherArm(shownLeft);
}

/** One recorded judgement, with what the analysis needs to know about its judge. */
export interface JudgmentFact {
  pairId: string;
  judgeId: string;
  judgeKind: JudgeKind;
  judgeRevoked: boolean;
  shownLeft: Arm;
  choice: Choice;
  seenBefore: boolean;
}

export interface ShareSummary {
  /** Every judgement, "no preference" included. */
  judgements: number;
  /** Judgements that picked a design. */
  decisive: number;
  hawa: number;
  designer: number;
  none: number;
  /** Share of decisive judgements that preferred Hawa; null with none decisive. */
  hawaShare: number | null;
  /** Wilson 95% interval of that share. */
  interval: { low: number; high: number } | null;
  /** Share of all judgements that were "no preference". */
  tieRate: number | null;
}

export function shareOf(facts: JudgmentFact[]): ShareSummary {
  let hawa = 0;
  let designer = 0;
  let none = 0;
  for (const f of facts) {
    const preferred = preferredArm(f.shownLeft, f.choice);
    if (preferred === 'hawa') hawa += 1;
    else if (preferred === 'designer') designer += 1;
    else none += 1;
  }
  const decisive = hawa + designer;
  return {
    judgements: facts.length,
    decisive,
    hawa,
    designer,
    none,
    hawaShare: decisive ? hawa / decisive : null,
    interval: wilsonInterval(hawa, decisive),
    tieRate: facts.length ? none / facts.length : null,
  };
}

export interface PairTally {
  pairId: string;
  label: string;
  judgements: number;
  hawa: number;
  designer: number;
  none: number;
  seenBefore: number;
  /** The arm most decisive judgements of this pair preferred; 'none' when no judge picked one. */
  majority: Arm | 'tie' | 'none';
}

export interface ClaimVerdict {
  threshold: number;
  lowerBound: number | null;
  lowerBoundAboveThreshold: boolean;
  decisive: number;
  minDecisive: number;
  /** Pairs with fewer judgements than the pre-registration requires. */
  pairsBelowMinJudges: number;
  sampleComplete: boolean;
  closed: boolean;
  /** The pre-registered claim: lower bound above the threshold, on the complete sample, study closed. */
  holds: boolean;
  verdict: string;
}

export interface StudyResults {
  status: StudyStatus;
  pairs: number;
  /** The primary outcome: every judgement recorded, as pre-registered. */
  primary: ShareSummary;
  byJudgeKind: { requester: ShareSummary; designer: ShareSummary };
  /** The primary outcome without the pairs a judge had received themselves, and those alone. */
  excludingSeenBefore: ShareSummary;
  seenBefore: ShareSummary;
  /** Judgements made through links revoked since; counted in the primary outcome, shown so they can be questioned. */
  fromRevokedJudges: number;
  /** Position check: how often Hawa was on the left, and how often the left design was picked. */
  position: { shown: number; hawaShownLeft: number; decisive: number; leftChosen: number };
  perPair: PairTally[];
  claim: ClaimVerdict;
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/**
 * The study's results from its judgements. Every judgement counts in the primary outcome, including
 * those of judges revoked later: dropping a judge after seeing their picks would be choosing the
 * result. Revoked judges' judgements are counted separately so the office can see them.
 */
export function summariseStudy(input: {
  status: StudyStatus;
  preregistration: Preregistration;
  pairs: Array<{ id: string; label: string }>;
  facts: JudgmentFact[];
}): StudyResults {
  const { status, preregistration, pairs, facts } = input;
  const primary = shareOf(facts);
  const perPair: PairTally[] = pairs.map((pair) => {
    const own = facts.filter((f) => f.pairId === pair.id);
    const s = shareOf(own);
    return {
      pairId: pair.id,
      label: pair.label,
      judgements: s.judgements,
      hawa: s.hawa,
      designer: s.designer,
      none: s.none,
      seenBefore: own.filter((f) => f.seenBefore).length,
      majority: s.decisive === 0 ? 'none' : s.hawa > s.designer ? 'hawa' : s.designer > s.hawa ? 'designer' : 'tie',
    };
  });
  const decisiveFacts = facts.filter((f) => f.choice !== 'none');
  const pairsBelowMinJudges = perPair.filter((p) => p.judgements < preregistration.minJudgesPerPair).length;
  const lowerBound = primary.interval ? primary.interval.low : null;
  const lowerBoundAboveThreshold = lowerBound !== null && lowerBound > preregistration.threshold;
  const sampleComplete = pairs.length > 0 && primary.decisive >= preregistration.minDecisive && pairsBelowMinJudges === 0;
  const closed = status === 'closed';
  const holds = lowerBoundAboveThreshold && sampleComplete && closed;
  const bound = lowerBound === null ? '' : ` (${pct(lowerBound)})`;
  const missing = [
    ...(closed ? [] : ['the study is not closed']),
    ...(primary.decisive >= preregistration.minDecisive ? [] : [`${primary.decisive} of ${preregistration.minDecisive} decisive judgements`]),
    ...(pairsBelowMinJudges ? [`${pairsBelowMinJudges} ${pairsBelowMinJudges === 1 ? 'pair has' : 'pairs have'} fewer than ${preregistration.minJudgesPerPair} judgements`] : []),
  ];
  const verdict =
    primary.decisive === 0
      ? 'No decisive judgements yet.'
      : holds
        ? `Hawa is preferred: the lower bound of the 95% interval${bound} is above ${pct(preregistration.threshold)}, on the complete pre-registered sample.`
        : !lowerBoundAboveThreshold
          ? `Not shown: the lower bound of the 95% interval${bound} is not above ${pct(preregistration.threshold)}.`
          : `Not decided yet: the lower bound${bound} is above ${pct(preregistration.threshold)} so far, but the claim is decided only on the complete pre-registered sample (${missing.join('; ')}).`;
  return {
    status,
    pairs: pairs.length,
    primary,
    byJudgeKind: {
      requester: shareOf(facts.filter((f) => f.judgeKind === 'requester')),
      designer: shareOf(facts.filter((f) => f.judgeKind === 'designer')),
    },
    excludingSeenBefore: shareOf(facts.filter((f) => !f.seenBefore)),
    seenBefore: shareOf(facts.filter((f) => f.seenBefore)),
    fromRevokedJudges: facts.filter((f) => f.judgeRevoked).length,
    position: {
      shown: facts.length,
      hawaShownLeft: facts.filter((f) => f.shownLeft === 'hawa').length,
      decisive: decisiveFacts.length,
      leftChosen: decisiveFacts.filter((f) => f.choice === 'left').length,
    },
    perPair,
    claim: {
      threshold: preregistration.threshold,
      lowerBound,
      lowerBoundAboveThreshold,
      decisive: primary.decisive,
      minDecisive: preregistration.minDecisive,
      pairsBelowMinJudges,
      sampleComplete,
      closed,
      holds,
      verdict,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Order, sides and tokens (pure)
// ---------------------------------------------------------------------------------------------

const digest = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\u0000')).digest();

/**
 * The key a judge's pairs are sorted by. It is derived from the judge and the pair rather than drawn
 * at request time, so the order is random across judges yet the same on every reload, and a judge
 * who stops halfway comes back to the same next pair.
 */
export function judgeOrderKey(judgeId: string, pairId: string): string {
  return digest('hawa.comparison.order', judgeId, pairId).toString('hex');
}

/** Which arm this judge sees on the left for this pair: a stable coin, independent of the order. */
export function shownLeftFor(judgeId: string, pairId: string): Arm {
  return (digest('hawa.comparison.side', judgeId, pairId)[0] & 1) === 0 ? 'hawa' : 'designer';
}

export function armForSide(judgeId: string, pairId: string, side: Side): Arm {
  const left = shownLeftFor(judgeId, pairId);
  return side === 'left' ? left : otherArm(left);
}

export function orderPairsForJudge<T extends { id: string }>(judgeId: string, pairs: T[]): T[] {
  return pairs
    .map((pair) => ({ pair, key: judgeOrderKey(judgeId, pair.id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.pair);
}

/** A judge's link token: 32 random bytes, base64url. Only its SHA-256 is ever stored. */
export const newJudgeToken = () => crypto.randomBytes(32).toString('base64url');
export const JUDGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const tokenSha256 = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** SHA-256 of the pre-registration as stored, so the plan can be published and checked later. */
export function preregistrationSha256(p: Preregistration): string {
  const canonical = JSON.stringify({
    sample: p.sample,
    judges: p.judges,
    analysis: p.analysis,
    threshold: p.threshold,
    minDecisive: p.minDecisive,
    minJudgesPerPair: p.minJudgesPerPair,
    plannedPairs: p.plannedPairs,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** The protocol's own numbers (PLAN.md): 50 pairs, at least 4 judges each, about 194 decisive judgements. */
export const PROTOCOL_DEFAULTS = { threshold: 0.5, minDecisive: 194, minJudgesPerPair: 4, plannedPairs: 50 } as const;

export function parsePreregistration(input: unknown): Preregistration {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const written = (key: 'sample' | 'judges' | 'analysis') => {
    const value = typeof raw[key] === 'string' ? String(raw[key]).trim() : '';
    if (value.length < 10) throw new ComparisonError(400, `The pre-registration needs its ${key} written down (at least a sentence).`);
    if (value.length > 4000) throw new ComparisonError(400, `The pre-registration's ${key} is longer than 4000 characters.`);
    return value;
  };
  const number = (key: keyof typeof PROTOCOL_DEFAULTS, ok: (n: number) => boolean, rule: string) => {
    const value = raw[key] === undefined || raw[key] === null || raw[key] === '' ? PROTOCOL_DEFAULTS[key] : Number(raw[key]);
    if (!Number.isFinite(value) || !ok(value)) throw new ComparisonError(400, `The pre-registration's ${key} must be ${rule}.`);
    return value;
  };
  return {
    sample: written('sample'),
    judges: written('judges'),
    analysis: written('analysis'),
    threshold: number('threshold', (n) => n >= 0.5 && n < 1, 'a share from 0.5 up to (not including) 1'),
    minDecisive: number('minDecisive', (n) => Number.isInteger(n) && n >= 1 && n <= 100000, 'a whole number from 1'),
    minJudgesPerPair: number('minJudgesPerPair', (n) => Number.isInteger(n) && n >= 1 && n <= 100, 'a whole number from 1'),
    plannedPairs: number('plannedPairs', (n) => Number.isInteger(n) && n >= 2 && n <= 10000, 'a whole number from 2'),
  };
}

// ---------------------------------------------------------------------------------------------
// Images (pure)
// ---------------------------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Guards the decoder: a small file can declare an enormous canvas. 40 megapixels is well past any poster export. */
export const MAX_IMAGE_PIXELS = 40_000_000;

export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'unknown' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return 'unknown';
}

/** Decodes an uploaded image sent as base64 (a data: URL prefix is accepted), refusing oversize files before decoding. */
export function decodeBase64Image(value: unknown, what: string): Buffer {
  if (typeof value !== 'string' || !value.trim()) throw new ComparisonError(400, `The ${what} is missing.`);
  const body = value.trim().replace(/^data:[a-z/+.-]+;base64,/i, '');
  if (body.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new ComparisonError(413, `The ${what} is larger than 15 MB.`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body.replace(/\s+/g, ''))) throw new ComparisonError(400, `The ${what} is not valid base64.`);
  return Buffer.from(body, 'base64');
}

export interface CleanPng {
  png: Buffer;
  width: number;
  height: number;
  sha256: string;
}

/**
 * Re-encodes a PNG so nothing but its pixels reaches a judge. A PNG can carry text chunks (the
 * program that made it, an author, a date), an eXIf chunk and a colour profile named after the
 * machine it came from; any of them could tell a judge which arm is which, and the protocol requires
 * each arm's design "with its metadata removed". Decoding to pixels and writing a fresh RGBA PNG
 * keeps only IHDR, IDAT and IEND, and gives both arms the same encoder, so the files do not differ
 * in how they were compressed either. A JPEG is refused: there is no JPEG decoder here to strip its
 * EXIF, and a JPEG export would also look different from a PNG one.
 */
export function cleanPng(bytes: Buffer, what: string): CleanPng {
  const kind = sniffImage(bytes);
  if (kind === 'jpeg') {
    throw new ComparisonError(415, `The ${what} is a JPEG. Only PNG is accepted: export the design as PNG. A JPEG carries camera and software details that could tell a judge who made it, and this server cannot remove them.`);
  }
  if (kind !== 'png') throw new ComparisonError(415, `The ${what} is not a PNG. Export the design as PNG.`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ComparisonError(413, `The ${what} is larger than 15 MB.`);
  if (bytes.length < 33 || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new ComparisonError(422, `The ${what} could not be read as a PNG.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new ComparisonError(413, `The ${what} is ${width}×${height} pixels; the limit is 40 megapixels. Export it at the size it is delivered.`);
  }
  let decoded: ReturnType<typeof PNG.sync.read>;
  try {
    decoded = PNG.sync.read(bytes);
  } catch {
    throw new ComparisonError(422, `The ${what} could not be read as a PNG.`);
  }
  // A gamma value would be written back as a gAMA chunk; the pixels are shown as sRGB either way.
  decoded.gamma = 0;
  const png = PNG.sync.write(decoded, { colorType: 6, deflateLevel: 6 });
  return { png, width: decoded.width, height: decoded.height, sha256: crypto.createHash('sha256').update(png).digest('hex') };
}

// ---------------------------------------------------------------------------------------------
// Office: studies, pairs, judges (database)
// ---------------------------------------------------------------------------------------------

export interface StudySummary {
  id: string;
  name: string;
  status: StudyStatus;
  preregistration: Preregistration;
  preregistrationSha256: string;
  lockedAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  pairs: number;
  judges: number;
  activeJudges: number;
  judgements: number;
}

export interface PairSummary {
  id: string;
  label: string;
  taskId: string | null;
  width: number;
  height: number;
  hawaSha256: string;
  designerSha256: string;
  judgements: number;
  createdAt: string;
}

export interface JudgeSummary {
  id: string;
  name: string;
  kind: JudgeKind;
  createdAt: string;
  revokedAt: string | null;
  judgements: number;
}

export interface StudyDetail extends StudySummary {
  pairList: PairSummary[];
  judgeList: JudgeSummary[];
}

interface StudyRow {
  id: string;
  name: string;
  status: StudyStatus;
  preregistration: Preregistration | string;
  locked_at: Date | null;
  closed_at: Date | null;
  created_by: string;
  created_at: Date;
  pairs: number;
  judges: number;
  active_judges: number;
  judgements: number;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const rls = (scope: ComparisonScope) => ({ tenantId: scope.tenantId, userId: scope.userId, role: scope.role });

function studyFromRow(row: StudyRow): StudySummary {
  const preregistration = (typeof row.preregistration === 'string' ? JSON.parse(row.preregistration) : row.preregistration) as Preregistration;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    preregistration,
    preregistrationSha256: preregistrationSha256(preregistration),
    lockedAt: iso(row.locked_at),
    closedAt: iso(row.closed_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
    pairs: Number(row.pairs) || 0,
    judges: Number(row.judges) || 0,
    activeJudges: Number(row.active_judges) || 0,
    judgements: Number(row.judgements) || 0,
  };
}

const studySelect = (tenantId: string) => sql`SELECT s.id::text AS id, s.name, s.status, s.preregistration, s.locked_at, s.closed_at, s.created_by, s.created_at,
    (SELECT count(*)::int FROM hawa.comparison_pairs p WHERE p.study_id = s.id) AS pairs,
    (SELECT count(*)::int FROM hawa.comparison_judges j WHERE j.study_id = s.id) AS judges,
    (SELECT count(*)::int FROM hawa.comparison_judges j WHERE j.study_id = s.id AND j.revoked_at IS NULL) AS active_judges,
    (SELECT count(*)::int FROM hawa.comparison_judgments m WHERE m.study_id = s.id) AS judgements
  FROM hawa.comparison_studies s WHERE s.tenant_id = ${tenantId}::uuid`;

export async function createStudy(
  db: Kysely<Database>,
  scope: ComparisonScope,
  input: { name?: unknown; preregistration?: unknown }
): Promise<StudySummary> {
  const name = text(input.name);
  if (!name || name.length > 120) throw new ComparisonError(400, 'The study needs a name of up to 120 characters.');
  const preregistration = parsePreregistration(input.preregistration);
  return withRlsContext(db, rls(scope), async (trx) => {
    const id = (
      await sql<{ id: string }>`INSERT INTO hawa.comparison_studies (tenant_id, name, preregistration, created_by)
        VALUES (${scope.tenantId}::uuid, ${name}, ${JSON.stringify(preregistration)}::jsonb, ${scope.actorId || scope.userId || 'office'})
        RETURNING id::text AS id`.execute(trx)
    ).rows[0].id;
    const row = (await sql<StudyRow>`${studySelect(scope.tenantId)} AND s.id = ${id}::uuid`.execute(trx)).rows[0];
    return studyFromRow(row);
  });
}

export async function listStudies(db: Kysely<Database>, scope: ComparisonScope): Promise<StudySummary[]> {
  return withRlsContext(db, rls(scope), async (trx) =>
    (await sql<StudyRow>`${studySelect(scope.tenantId)} ORDER BY s.created_at DESC LIMIT 200`.execute(trx)).rows.map(studyFromRow)
  );
}

export async function getStudy(db: Kysely<Database>, scope: ComparisonScope, studyId: string): Promise<StudyDetail> {
  if (!isUuid(studyId)) throw new ComparisonError(404, 'No such study.');
  return withRlsContext(db, rls(scope), async (trx) => {
    const row = (await sql<StudyRow>`${studySelect(scope.tenantId)} AND s.id = ${studyId}::uuid`.execute(trx)).rows[0];
    if (!row) throw new ComparisonError(404, 'No such study.');
    const pairList = (
      await sql<{ id: string; label: string; task_id: string | null; width: number; height: number; hawa_sha256: string; designer_sha256: string; judgements: number; created_at: Date }>`
        SELECT p.id::text AS id, p.label, p.task_id::text AS task_id, p.width, p.height, p.hawa_sha256, p.designer_sha256, p.created_at,
          (SELECT count(*)::int FROM hawa.comparison_judgments m WHERE m.pair_id = p.id) AS judgements
        FROM hawa.comparison_pairs p WHERE p.study_id = ${studyId}::uuid AND p.tenant_id = ${scope.tenantId}::uuid
        ORDER BY p.label`.execute(trx)
    ).rows.map((p) => ({
      id: p.id,
      label: p.label,
      taskId: p.task_id,
      width: p.width,
      height: p.height,
      hawaSha256: p.hawa_sha256,
      designerSha256: p.designer_sha256,
      judgements: Number(p.judgements) || 0,
      createdAt: iso(p.created_at) as string,
    }));
    // The token's hash never leaves the database: a judge is known to the office by name only.
    const judgeList = (
      await sql<{ id: string; name: string; kind: JudgeKind; created_at: Date; revoked_at: Date | null; judgements: number }>`
        SELECT j.id::text AS id, j.name, j.kind, j.created_at, j.revoked_at,
          (SELECT count(*)::int FROM hawa.comparison_judgments m WHERE m.judge_id = j.id) AS judgements
        FROM hawa.comparison_judges j WHERE j.study_id = ${studyId}::uuid AND j.tenant_id = ${scope.tenantId}::uuid
        ORDER BY j.created_at`.execute(trx)
    ).rows.map((j) => ({ id: j.id, name: j.name, kind: j.kind, createdAt: iso(j.created_at) as string, revokedAt: iso(j.revoked_at), judgements: Number(j.judgements) || 0 }));
    return { ...studyFromRow(row), pairList, judgeList };
  });
}

/** Locks the study row for this transaction: adding a pair, locking and closing never interleave. */
async function studyForUpdate(trx: Kysely<Database>, scope: ComparisonScope, studyId: string) {
  if (!isUuid(studyId)) throw new ComparisonError(404, 'No such study.');
  const row = (
    await sql<{ status: StudyStatus }>`SELECT status FROM hawa.comparison_studies
      WHERE id = ${studyId}::uuid AND tenant_id = ${scope.tenantId}::uuid FOR UPDATE`.execute(trx)
  ).rows[0];
  if (!row) throw new ComparisonError(404, 'No such study.');
  return row;
}

export interface AddPairInput {
  label?: unknown;
  taskId?: unknown;
  /** Take Hawa's design from the task's final export instead of an upload. */
  fromTask?: unknown;
  hawaPng?: Buffer;
  designerPng?: Buffer;
}

export async function addPair(db: Kysely<Database>, scope: ComparisonScope, studyId: string, input: AddPairInput): Promise<PairSummary> {
  const fromTask = input.fromTask === true;
  const taskId = input.taskId === undefined || input.taskId === null || input.taskId === '' ? null : input.taskId;
  if (taskId !== null && !isUuid(taskId)) throw new ComparisonError(400, 'The task id is not a valid id.');
  if (fromTask && !taskId) throw new ComparisonError(400, "To take Hawa's design from a task, give the task id.");
  if (fromTask && input.hawaPng) throw new ComparisonError(400, "Give Hawa's design as an upload or take it from the task, not both.");
  if (!fromTask && !input.hawaPng) throw new ComparisonError(400, "Hawa's design is missing: upload its PNG or take it from the task.");
  if (!input.designerPng) throw new ComparisonError(400, "The designer's design is missing: upload its PNG.");
  const label = input.label === undefined || input.label === null || input.label === '' ? null : text(input.label);
  if (label !== null && !/^[A-Za-z0-9-]{1,12}$/.test(label)) {
    throw new ComparisonError(400, 'A label is a short neutral code of letters, digits and dashes, such as P07.');
  }
  if (!isUuid(studyId)) throw new ComparisonError(404, 'No such study.');
  // Read the study and the task's export in a short transaction, then decode and re-encode both
  // images outside any transaction: a large PNG takes seconds of CPU, and a connection left idle in
  // a transaction that long is cut off by the pool's idle_in_transaction_session_timeout.
  const hawaSource = await withRlsContext(db, rls(scope), async (trx) => {
    const study = (
      await sql<{ status: StudyStatus }>`SELECT status FROM hawa.comparison_studies WHERE id = ${studyId}::uuid AND tenant_id = ${scope.tenantId}::uuid`.execute(trx)
    ).rows[0];
    if (!study) throw new ComparisonError(404, 'No such study.');
    if (study.status !== 'draft') throw new ComparisonError(409, 'Pairs cannot be added once judging has started.');
    if (!fromTask) return input.hawaPng as Buffer;
    // The design the requester was sent: the task's newest PNG export, as Core reads it for delivery.
    const row = (
      await sql<{ content: Buffer }>`SELECT content FROM hawa.canva_export_bytes
        WHERE tenant_id = ${scope.tenantId}::uuid AND task_id = ${taskId}::uuid AND format = 'png'
        ORDER BY created_at DESC LIMIT 1`.execute(trx)
    ).rows[0];
    if (!row?.content) throw new ComparisonError(422, `No PNG export of task ${taskId} is stored. Export the design as PNG first, or upload it.`);
    return row.content;
  });
  const designer = cleanPng(input.designerPng, "designer's design");
  const hawa = cleanPng(hawaSource, "Hawa's design");
  if (hawa.width !== designer.width || hawa.height !== designer.height) {
    throw new ComparisonError(
      422,
      `The two designs must be the same size, as the protocol requires: Hawa's is ${hawa.width}×${hawa.height}, the designer's is ${designer.width}×${designer.height}. Export the designer's at ${hawa.width}×${hawa.height}.`
    );
  }
  if (hawa.sha256 === designer.sha256) throw new ComparisonError(422, 'The two images are the same picture.');
  return withRlsContext(db, rls(scope), async (trx) => {
    // Checked again under the row lock: the study may have been locked while the images were prepared.
    const study = await studyForUpdate(trx, scope, studyId);
    if (study.status !== 'draft') throw new ComparisonError(409, 'Pairs cannot be added once judging has started.');
    let finalLabel = label;
    if (!finalLabel) {
      const used = (
        await sql<{ label: string }>`SELECT label FROM hawa.comparison_pairs WHERE study_id = ${studyId}::uuid`.execute(trx)
      ).rows.map((r) => r.label);
      let n = used.length + 1;
      while (used.includes(`P${String(n).padStart(2, '0')}`)) n += 1;
      finalLabel = `P${String(n).padStart(2, '0')}`;
    } else {
      const taken = (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.comparison_pairs WHERE study_id = ${studyId}::uuid AND label = ${finalLabel}`.execute(trx)
      ).rows[0];
      if (taken && Number(taken.n) > 0) throw new ComparisonError(409, `A pair labelled ${finalLabel} already exists in this study.`);
    }
    const row = (
      await sql<{ id: string; created_at: Date }>`INSERT INTO hawa.comparison_pairs
          (study_id, tenant_id, task_id, label, width, height, hawa_png, designer_png, hawa_sha256, designer_sha256)
        VALUES (${studyId}::uuid, ${scope.tenantId}::uuid, ${taskId}::uuid, ${finalLabel}, ${hawa.width}, ${hawa.height},
          ${hawa.png}, ${designer.png}, ${hawa.sha256}, ${designer.sha256})
        RETURNING id::text AS id, created_at`.execute(trx)
    ).rows[0];
    return {
      id: row.id,
      label: finalLabel,
      taskId: taskId as string | null,
      width: hawa.width,
      height: hawa.height,
      hawaSha256: hawa.sha256,
      designerSha256: designer.sha256,
      judgements: 0,
      createdAt: iso(row.created_at) as string,
    };
  });
}

/** One arm's stored PNG, for the office only. */
export async function readPairImage(db: Kysely<Database>, scope: ComparisonScope, studyId: string, pairId: string, arm: Arm): Promise<Buffer | null> {
  if (!isUuid(studyId) || !isUuid(pairId)) return null;
  return withRlsContext(db, rls(scope), async (trx) => {
    const row = (
      await sql<{ png: Buffer }>`SELECT CASE WHEN ${arm} = 'hawa' THEN hawa_png ELSE designer_png END AS png
        FROM hawa.comparison_pairs WHERE id = ${pairId}::uuid AND study_id = ${studyId}::uuid AND tenant_id = ${scope.tenantId}::uuid`.execute(trx)
    ).rows[0];
    return row?.png ?? null;
  });
}

/** Starts judging. From here the plan and the pairs are fixed; the database refuses changes too. */
export async function lockStudy(db: Kysely<Database>, scope: ComparisonScope, studyId: string): Promise<StudyDetail> {
  await withRlsContext(db, rls(scope), async (trx) => {
    const study = await studyForUpdate(trx, scope, studyId);
    if (study.status !== 'draft') throw new ComparisonError(409, `The study is already ${study.status === 'judging' ? 'judging' : 'closed'}.`);
    const counts = (
      await sql<{ pairs: number; judges: number }>`SELECT
          (SELECT count(*)::int FROM hawa.comparison_pairs WHERE study_id = ${studyId}::uuid) AS pairs,
          (SELECT count(*)::int FROM hawa.comparison_judges WHERE study_id = ${studyId}::uuid AND revoked_at IS NULL) AS judges`.execute(trx)
    ).rows[0];
    if (Number(counts.pairs) < 2) throw new ComparisonError(422, `Judging needs at least 2 pairs; this study has ${Number(counts.pairs)}.`);
    if (Number(counts.judges) < 1) throw new ComparisonError(422, 'Judging needs at least one judge; add the judges first.');
    await sql`UPDATE hawa.comparison_studies SET status = 'judging', locked_at = now() WHERE id = ${studyId}::uuid`.execute(trx);
  });
  return getStudy(db, scope, studyId);
}

export async function closeStudy(db: Kysely<Database>, scope: ComparisonScope, studyId: string): Promise<StudyDetail> {
  await withRlsContext(db, rls(scope), async (trx) => {
    const study = await studyForUpdate(trx, scope, studyId);
    if (study.status !== 'judging') {
      throw new ComparisonError(409, study.status === 'draft' ? 'The study has not started judging; there is nothing to close.' : 'The study is already closed.');
    }
    await sql`UPDATE hawa.comparison_studies SET status = 'closed', closed_at = now() WHERE id = ${studyId}::uuid`.execute(trx);
  });
  return getStudy(db, scope, studyId);
}

/** Adds a judge and returns their link token, once: only its SHA-256 is stored. */
export async function addJudge(
  db: Kysely<Database>,
  scope: ComparisonScope,
  studyId: string,
  input: { name?: unknown; kind?: unknown }
): Promise<{ judge: JudgeSummary; token: string }> {
  const name = text(input.name);
  if (!name || name.length > 80) throw new ComparisonError(400, "The judge needs a name of up to 80 characters (the office's own record; judges never see it).");
  if (input.kind !== 'requester' && input.kind !== 'designer') {
    throw new ComparisonError(400, "A judge is either a 'requester' (sent a brief) or a 'designer' (from outside the office).");
  }
  const kind: JudgeKind = input.kind;
  const token = newJudgeToken();
  const judge = await withRlsContext(db, rls(scope), async (trx) => {
    const study = await studyForUpdate(trx, scope, studyId);
    if (study.status === 'closed') throw new ComparisonError(409, 'The study is closed; no judges can be added.');
    const row = (
      await sql<{ id: string; created_at: Date }>`INSERT INTO hawa.comparison_judges (study_id, tenant_id, name, kind, token_sha256)
        VALUES (${studyId}::uuid, ${scope.tenantId}::uuid, ${name}, ${kind}, ${tokenSha256(token)})
        RETURNING id::text AS id, created_at`.execute(trx)
    ).rows[0];
    return { id: row.id, name, kind, createdAt: iso(row.created_at) as string, revokedAt: null, judgements: 0 };
  });
  return { judge, token };
}

/** Revokes a judge's link. Their judgements stay in the study (see summariseStudy); the link answers 404 from now on. */
export async function revokeJudge(db: Kysely<Database>, scope: ComparisonScope, studyId: string, judgeId: string): Promise<{ revokedAt: string; already: boolean }> {
  if (!isUuid(studyId) || !isUuid(judgeId)) throw new ComparisonError(404, 'No such judge.');
  return withRlsContext(db, rls(scope), async (trx) => {
    const row = (
      await sql<{ revoked_at: Date | null }>`SELECT revoked_at FROM hawa.comparison_judges
        WHERE id = ${judgeId}::uuid AND study_id = ${studyId}::uuid AND tenant_id = ${scope.tenantId}::uuid FOR UPDATE`.execute(trx)
    ).rows[0];
    if (!row) throw new ComparisonError(404, 'No such judge.');
    if (row.revoked_at) return { revokedAt: iso(row.revoked_at) as string, already: true };
    const updated = (
      await sql<{ revoked_at: Date }>`UPDATE hawa.comparison_judges SET revoked_at = now() WHERE id = ${judgeId}::uuid RETURNING revoked_at`.execute(trx)
    ).rows[0];
    return { revokedAt: iso(updated.revoked_at) as string, already: false };
  });
}

export async function studyResults(db: Kysely<Database>, scope: ComparisonScope, studyId: string): Promise<StudyResults & { studyId: string; name: string; preregistration: Preregistration; preregistrationSha256: string }> {
  if (!isUuid(studyId)) throw new ComparisonError(404, 'No such study.');
  return withRlsContext(db, rls(scope), async (trx) => {
    const row = (await sql<StudyRow>`${studySelect(scope.tenantId)} AND s.id = ${studyId}::uuid`.execute(trx)).rows[0];
    if (!row) throw new ComparisonError(404, 'No such study.');
    const study = studyFromRow(row);
    const pairs = (
      await sql<{ id: string; label: string }>`SELECT id::text AS id, label FROM hawa.comparison_pairs
        WHERE study_id = ${studyId}::uuid AND tenant_id = ${scope.tenantId}::uuid ORDER BY label`.execute(trx)
    ).rows;
    const facts = (
      await sql<{ pair_id: string; judge_id: string; kind: JudgeKind; revoked: boolean; shown_left: Arm; choice: Choice; seen_before: boolean }>`
        SELECT m.pair_id::text AS pair_id, m.judge_id::text AS judge_id, j.kind, (j.revoked_at IS NOT NULL) AS revoked,
          m.shown_left, m.choice, m.seen_before
        FROM hawa.comparison_judgments m JOIN hawa.comparison_judges j ON j.id = m.judge_id
        WHERE m.study_id = ${studyId}::uuid AND m.tenant_id = ${scope.tenantId}::uuid`.execute(trx)
    ).rows.map((f) => ({
      pairId: f.pair_id,
      judgeId: f.judge_id,
      judgeKind: f.kind,
      judgeRevoked: f.revoked,
      shownLeft: f.shown_left,
      choice: f.choice,
      seenBefore: f.seen_before,
    }));
    return {
      studyId,
      name: study.name,
      preregistration: study.preregistration,
      preregistrationSha256: study.preregistrationSha256,
      ...summariseStudy({ status: study.status, preregistration: study.preregistration, pairs, facts }),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Judges: the link's side (database)
// ---------------------------------------------------------------------------------------------

export interface JudgeSession {
  tenantId: string;
  studyId: string;
  judgeId: string;
}

/** A judge's reads run under their study's tenant, like any request; the judge is not a user. */
const judgeRls = (session: JudgeSession) => ({ tenantId: session.tenantId, role: 'comparison_judge' });

/** The judge behind a link token, or null for a malformed, unknown or revoked one. */
export async function resolveJudge(db: Kysely<Database>, token: string): Promise<JudgeSession | null> {
  if (!JUDGE_TOKEN.test(token)) return null;
  const row = (
    await sql<{ tenant_id: string; study_id: string; judge_id: string }>`SELECT tenant_id::text AS tenant_id, study_id::text AS study_id, judge_id::text AS judge_id
      FROM hawa.comparison_judge_by_token(${tokenSha256(token)})`.execute(db)
  ).rows[0];
  return row ? { tenantId: row.tenant_id, studyId: row.study_id, judgeId: row.judge_id } : null;
}

export type JudgeNext =
  | { status: 'not_started' }
  | { status: 'closed' | 'done'; judged: number; total: number }
  | { status: 'judging'; judged: number; total: number; pairId: string };

/**
 * The judge's next pair: the first, in this judge's own stable order, that they have not judged.
 * Nothing about the pair but its id leaves here; which arm is on which side is decided per request
 * by shownLeftFor and never sent.
 */
export async function judgeNext(db: Kysely<Database>, session: JudgeSession): Promise<JudgeNext> {
  return withRlsContext(db, judgeRls(session), async (trx) => {
    const study = (
      await sql<{ status: StudyStatus }>`SELECT status FROM hawa.comparison_studies WHERE id = ${session.studyId}::uuid AND tenant_id = ${session.tenantId}::uuid`.execute(trx)
    ).rows[0];
    if (!study || study.status === 'draft') return { status: 'not_started' };
    const pairs = (
      await sql<{ id: string }>`SELECT id::text AS id FROM hawa.comparison_pairs WHERE study_id = ${session.studyId}::uuid AND tenant_id = ${session.tenantId}::uuid`.execute(trx)
    ).rows;
    const judged = new Set(
      (
        await sql<{ pair_id: string }>`SELECT pair_id::text AS pair_id FROM hawa.comparison_judgments
          WHERE judge_id = ${session.judgeId}::uuid AND study_id = ${session.studyId}::uuid`.execute(trx)
      ).rows.map((r) => r.pair_id)
    );
    const total = pairs.length;
    const done = pairs.filter((p) => judged.has(p.id)).length;
    if (study.status === 'closed') return { status: 'closed', judged: done, total };
    const next = orderPairsForJudge(session.judgeId, pairs).find((p) => !judged.has(p.id));
    return next ? { status: 'judging', judged: done, total, pairId: next.id } : { status: 'done', judged: done, total };
  });
}

/** The image shown on one side of a pair for this judge, while the study is judging. */
export async function judgeImage(db: Kysely<Database>, session: JudgeSession, pairId: string, side: Side): Promise<Buffer | null> {
  if (!isUuid(pairId)) return null;
  const arm = armForSide(session.judgeId, pairId, side);
  return withRlsContext(db, judgeRls(session), async (trx) => {
    const row = (
      await sql<{ png: Buffer }>`SELECT CASE WHEN ${arm} = 'hawa' THEN p.hawa_png ELSE p.designer_png END AS png
        FROM hawa.comparison_pairs p JOIN hawa.comparison_studies s ON s.id = p.study_id
        WHERE p.id = ${pairId}::uuid AND p.study_id = ${session.studyId}::uuid AND p.tenant_id = ${session.tenantId}::uuid
          AND s.status = 'judging'`.execute(trx)
    ).rows[0];
    return row?.png ?? null;
  });
}

/**
 * Records a judge's pick. The side-to-arm mapping is recomputed here, never taken from the page.
 * A second pick for the same pair changes nothing and says so: the first answer stands, which makes
 * a retried or double-tapped submission safe.
 */
export async function recordJudgment(
  db: Kysely<Database>,
  session: JudgeSession,
  input: { pairId?: unknown; choice?: unknown; seenBefore?: unknown }
): Promise<{ recorded: true; already: boolean }> {
  if (!isUuid(input.pairId)) throw new ComparisonError(400, 'Which pair is this choice for?');
  if (input.choice !== 'left' && input.choice !== 'right' && input.choice !== 'none') throw new ComparisonError(400, 'Choose left, right or no preference.');
  if (input.seenBefore !== undefined && typeof input.seenBefore !== 'boolean') throw new ComparisonError(400, 'seenBefore must be true or false.');
  const pairId = input.pairId;
  const choice: Choice = input.choice;
  const seenBefore = input.seenBefore === true;
  return withRlsContext(db, judgeRls(session), async (trx) => {
    // Shared locks: closing the study or revoking this judge waits for this pick to commit, and a
    // pick never lands in a study that has just closed or through a link that has just been revoked.
    const study = (
      await sql<{ status: StudyStatus }>`SELECT status FROM hawa.comparison_studies WHERE id = ${session.studyId}::uuid AND tenant_id = ${session.tenantId}::uuid FOR SHARE`.execute(trx)
    ).rows[0];
    if (!study) throw new ComparisonError(404, 'Not found.');
    if (study.status === 'draft') throw new ComparisonError(409, 'Judging has not started yet.');
    if (study.status === 'closed') throw new ComparisonError(409, 'Judging has closed.');
    const judge = (
      await sql<{ revoked_at: Date | null }>`SELECT revoked_at FROM hawa.comparison_judges WHERE id = ${session.judgeId}::uuid FOR SHARE`.execute(trx)
    ).rows[0];
    if (!judge || judge.revoked_at) throw new ComparisonError(404, 'Not found.');
    const pair = (
      await sql<{ id: string }>`SELECT id::text AS id FROM hawa.comparison_pairs WHERE id = ${pairId}::uuid AND study_id = ${session.studyId}::uuid`.execute(trx)
    ).rows[0];
    if (!pair) throw new ComparisonError(404, 'Not found.');
    const inserted = (
      await sql<{ id: string }>`INSERT INTO hawa.comparison_judgments (study_id, pair_id, judge_id, tenant_id, shown_left, choice, seen_before)
        VALUES (${session.studyId}::uuid, ${pairId}::uuid, ${session.judgeId}::uuid, ${session.tenantId}::uuid,
          ${shownLeftFor(session.judgeId, pairId)}, ${choice}, ${seenBefore})
        ON CONFLICT (pair_id, judge_id) DO NOTHING
        RETURNING id::text AS id`.execute(trx)
    ).rows[0];
    return { recorded: true, already: !inserted };
  });
}
