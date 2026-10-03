import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { analysePixels, ANALYSIS_EDGE } from './art-direction/photo-analysis.js';
import { PHOTO_SHOTS } from './art-direction/recipes.js';
import { imageFileExtension, sniffImageType } from './image-type.js';
import { imagePixelSize } from './photo-crop.js';
import { uprightPhoto } from './photo-upright.js';
import { svgToPngAsync } from './render-layout-v2.js';
import {
  OFFICE_PHOTO_ALLOWED_TYPES,
  OFFICE_PHOTO_CONSENT,
  OFFICE_PHOTO_FEATURES_VERSION,
  OFFICE_PHOTO_LIBRARY_MANIFEST,
  OFFICE_PHOTO_LIBRARY_VERSION,
  OFFICE_PHOTO_LIMITS,
  officePhotoExclusions,
  officePhotoTagsSchema,
  orientationOf,
  parseOfficePhotoLibrary,
  type OfficePhotoEntry,
  type OfficePhotoFeatures,
  type OfficePhotoLibrary,
  type OfficePhotoMimeType,
  type OfficePhotoTags,
} from './office-photo-library.js';

/**
 * ADR-280: the office photo library on disk. Ingestion (scripts/office_photo_library_ingest.ts),
 * the manifest reader and the verified photo loader Core uses. Everything stays on this machine:
 * nothing is uploaded and no model is called.
 *
 * Layout of one client's library (outside git; `data/` is gitignored):
 *   <library dir>/<clientId>/library.json        the manifest (office-photo-library.ts schema)
 *   <library dir>/<clientId>/photos/<sha256>.jpg the stored upright photos, named by the source hash
 *   <library dir>/<clientId>/tags-template.csv   every photo with its current tags, for a person to fill in
 */

export const OFFICE_PHOTO_LIBRARY_DIR_ENV = 'HAWA_OFFICE_PHOTO_LIBRARY_DIR';
export const OFFICE_PHOTO_LIBRARY_DEFAULT_DIR = 'data/office-photo-library';
export const OFFICE_PHOTO_TAG_TEMPLATE = 'tags-template.csv';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The root folder holding every client's library: the env setting, else data/office-photo-library. */
export function officePhotoLibraryRoot(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const configured = env[OFFICE_PHOTO_LIBRARY_DIR_ENV]?.trim();
  return path.resolve(cwd, configured || OFFICE_PHOTO_LIBRARY_DEFAULT_DIR);
}

/** One client's library folder. The client id is checked so it can never name a path outside the root. */
export function officePhotoClientDir(root: string, clientId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clientId)) throw new Error(`OFFICE_PHOTO_LIBRARY_CLIENT_INVALID: ${JSON.stringify(clientId).slice(0, 90)}`);
  return path.join(root, clientId);
}

/** The client's manifest, strictly parsed; undefined when the client has no library. */
export async function readOfficePhotoLibrary(clientDir: string): Promise<{ library: OfficePhotoLibrary; sha256: string } | undefined> {
  const file = path.join(clientDir, OFFICE_PHOTO_LIBRARY_MANIFEST);
  let stat;
  try { stat = await fs.stat(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!stat.isFile()) throw new Error('OFFICE_PHOTO_LIBRARY_INVALID: library.json is not a file');
  if (stat.size > OFFICE_PHOTO_LIMITS.maxManifestBytes) throw new Error(`OFFICE_PHOTO_LIBRARY_INVALID: library.json is ${stat.size} bytes, over the ${OFFICE_PHOTO_LIMITS.maxManifestBytes} limit`);
  const text = await fs.readFile(file, 'utf8');
  let json: unknown;
  try { json = JSON.parse(text); } catch (err) { throw new Error(`OFFICE_PHOTO_LIBRARY_INVALID: library.json is not JSON (${(err as Error).message})`); }
  return { library: parseOfficePhotoLibrary(json), sha256: sha256(text) };
}

/**
 * A stored library photo's bytes, verified: inside the client's folder, within the size limit, of an
 * allowed type, and hashing to the sha256 the manifest recorded. Anything else throws.
 */
export async function loadOfficeLibraryPhoto(clientDir: string, entry: Pick<OfficePhotoEntry, 'id' | 'file' | 'storedSha256' | 'mimeType'>): Promise<{ bytes: Buffer; mimeType: OfficePhotoMimeType }> {
  const root = path.resolve(clientDir);
  const file = path.resolve(root, entry.file);
  if (!file.startsWith(root + path.sep)) throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${entry.id} names a file outside its library`);
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${entry.id} is missing from the library folder`);
  if (stat.size > OFFICE_PHOTO_LIMITS.maxFileBytes) throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${entry.id} is over the size limit`);
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== entry.storedSha256) throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${entry.id} does not match its recorded sha256`);
  const type = sniffImageType(bytes);
  if (!type || type !== entry.mimeType || !(OFFICE_PHOTO_ALLOWED_TYPES as readonly string[]).includes(type)) {
    throw new Error(`OFFICE_PHOTO_UNAVAILABLE: ${entry.id} is not the ${entry.mimeType} it was recorded as`);
  }
  return { bytes, mimeType: type as OfficePhotoMimeType };
}

// ---------------------------------------------------------------------------------------------
// Deterministic features
// ---------------------------------------------------------------------------------------------

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();

/**
 * The photo's measured features: drawn at ANALYSIS_EDGE by the renderer's own rsvg-convert, then the
 * art-direction analysis (sharpness, the calm third, salient point) plus the mean luminance and the
 * five most common colours (3 bits a channel). Same bytes and rasteriser, same numbers.
 */
export async function computeOfficePhotoFeatures(bytes: Buffer, options: { rsvgConvertPath?: string } = {}): Promise<{ width: number; height: number; features: OfficePhotoFeatures }> {
  const type = sniffImageType(bytes);
  const size = imagePixelSize(bytes);
  if (!type || !size) throw new Error('OFFICE_PHOTO_UNREADABLE: the photo type or size could not be read');
  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(size.width, size.height));
  const width = Math.max(8, Math.round(size.width * scale));
  const height = Math.max(8, Math.round(size.height * scale));
  const file = `photo.${imageFileExtension(type)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}"><image xlink:href="${file}" width="${width}" height="${height}" preserveAspectRatio="none"/></svg>`;
  const pngBytes = await svgToPngAsync(svg, width, height, options.rsvgConvertPath ? { rsvgConvertPath: options.rsvgConvertPath } : undefined, { [file]: bytes });
  const png = PNG.sync.read(pngBytes);
  const analysis = analysePixels(png, size);
  let lum = 0;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const pixels = png.width * png.height;
  for (let i = 0; i < pixels; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  const dominantColors = [...bins.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0] - b[0])
    .slice(0, 5)
    .map(([, v]) => ({ hex: `#${hex2(v.r / v.n)}${hex2(v.g / v.n)}${hex2(v.b / v.n)}`, share: round3(v.n / pixels) }));
  return {
    width: size.width,
    height: size.height,
    features: {
      version: OFFICE_PHOTO_FEATURES_VERSION,
      meanLuminance: round3(lum / Math.max(1, pixels)),
      sharpness: analysis.sharpness,
      soft: analysis.sharpness < OFFICE_PHOTO_LIMITS.softSharpness,
      quietArea: analysis.quiet,
      quietLuminance: Math.max(0, Math.min(1, analysis.quietLuminance)),
      bands: analysis.bands,
      salient: { x: Math.max(0, Math.min(1, analysis.salient.x)), y: Math.max(0, Math.min(1, analysis.salient.y)) },
      dominantColors,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tag sheets
// ---------------------------------------------------------------------------------------------

/** One row a person filled in: which photo (by id, source hash or source file name) and its tags. */
export interface OfficePhotoTagRow {
  id?: string;
  sha256?: string;
  source?: string;
  tags: Partial<OfficePhotoTags>;
}

export const OFFICE_PHOTO_TAG_COLUMNS = ['id', 'sha256', 'source', 'description', 'subjects', 'events', 'keywords', 'shot', 'people', 'consent', 'usable', 'generated', 'date', 'note'] as const;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const list = (v: string) => v.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
function yesNo(v: string, column: string, line: number): boolean | undefined {
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw new Error(`OFFICE_PHOTO_TAGS_INVALID: line ${line} column ${column}: "${v}" is not yes or no`);
}

/** A tag sheet's rows. CSV with the OFFICE_PHOTO_TAG_COLUMNS header, or JSON: an array of rows. */
export function parseOfficePhotoTagSheet(text: string, format: 'csv' | 'json'): OfficePhotoTagRow[] {
  if (format === 'json') {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) throw new Error('OFFICE_PHOTO_TAGS_INVALID: a JSON tag sheet is an array of rows');
    return data.map((raw, i) => {
      const { id, sha256: hash, source, ...tags } = (raw ?? {}) as Record<string, unknown>;
      const parsed = officePhotoTagsSchema.partial().strict().safeParse(tags);
      if (!parsed.success) throw new Error(`OFFICE_PHOTO_TAGS_INVALID: row ${i + 1}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      return { ...(typeof id === 'string' ? { id } : {}), ...(typeof hash === 'string' ? { sha256: hash } : {}), ...(typeof source === 'string' ? { source } : {}), tags: stripDefaults(parsed.data, tags) };
    });
  }
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => h && !(OFFICE_PHOTO_TAG_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) throw new Error(`OFFICE_PHOTO_TAGS_INVALID: unknown columns ${unknown.join(', ')}; the columns are ${OFFICE_PHOTO_TAG_COLUMNS.join(', ')}`);
  return rows.slice(1).map((cells, r) => {
    const line = r + 2;
    const get = (name: string) => (header.indexOf(name) >= 0 ? (cells[header.indexOf(name)] ?? '').trim() : '');
    const tags: Partial<OfficePhotoTags> = {};
    if (get('description')) tags.description = get('description');
    if (get('subjects')) tags.subjects = list(get('subjects'));
    if (get('events')) tags.events = list(get('events'));
    if (get('keywords')) tags.keywords = list(get('keywords'));
    if (get('shot')) {
      const shot = get('shot').toLowerCase().replace(/[\s-]+/g, '_');
      if (!(PHOTO_SHOTS as readonly string[]).includes(shot)) throw new Error(`OFFICE_PHOTO_TAGS_INVALID: line ${line} column shot: "${get('shot')}" is not one of ${PHOTO_SHOTS.join(', ')}`);
      tags.shot = shot as OfficePhotoTags['shot'];
    }
    const people = yesNo(get('people'), 'people', line);
    if (people !== undefined) tags.peoplePresent = people;
    if (get('consent')) {
      const consent = get('consent').toLowerCase().replace(/[\s-]+/g, '_');
      if (!(OFFICE_PHOTO_CONSENT as readonly string[]).includes(consent)) throw new Error(`OFFICE_PHOTO_TAGS_INVALID: line ${line} column consent: "${get('consent')}" is not one of ${OFFICE_PHOTO_CONSENT.join(', ')}`);
      tags.consent = consent as OfficePhotoTags['consent'];
    }
    const usable = yesNo(get('usable'), 'usable', line);
    if (usable !== undefined) tags.usable = usable;
    const generated = yesNo(get('generated'), 'generated', line);
    if (generated !== undefined) tags.generated = generated;
    if (get('date')) tags.date = get('date');
    if (get('note')) tags.note = get('note');
    const checked = officePhotoTagsSchema.partial().strict().safeParse(tags);
    if (!checked.success) throw new Error(`OFFICE_PHOTO_TAGS_INVALID: line ${line}: ${checked.error.issues[0]?.path.join('.')} ${checked.error.issues[0]?.message}`);
    return { ...(get('id') ? { id: get('id') } : {}), ...(get('sha256') ? { sha256: get('sha256').toLowerCase() } : {}), ...(get('source') ? { source: get('source') } : {}), tags: stripDefaults(checked.data, tags) };
  });
}

/** zod fills defaults for absent fields; a row only changes the fields it names. */
function stripDefaults(parsed: Partial<OfficePhotoTags>, given: Record<string, unknown>): Partial<OfficePhotoTags> {
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in given)) as Partial<OfficePhotoTags>;
}

/** Every photo with its current tags, as a CSV a person fills in and passes back with --tags. */
export function officePhotoTagTemplate(library: OfficePhotoLibrary): string {
  const lines = [OFFICE_PHOTO_TAG_COLUMNS.join(',')];
  const yn = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no');
  for (const p of library.photos) {
    const t = p.tags;
    lines.push([p.id, p.sha256, p.sourceName, t.description ?? '', t.subjects.join('; '), t.events.join('; '), t.keywords.join('; '),
      t.shot ?? '', yn(t.peoplePresent), t.consent, yn(t.usable), yn(t.generated), t.date ?? '', t.note ?? ''].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------------------------

export interface OfficePhotoIngestOptions {
  sourceDir: string;
  /** The root holding every client's library (officePhotoLibraryRoot()). */
  libraryRoot: string;
  clientId: string;
  tagRows?: OfficePhotoTagRow[];
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  now?: () => Date;
  rsvgConvertPath?: string;
}

export interface OfficePhotoIngestReport {
  clientDir: string;
  manifestPath: string;
  added: string[];
  unchanged: string[];
  updated: string[];
  skipped: Array<{ source: string; reason: string }>;
  tagRowsApplied: number;
  tagRowsUnmatched: Array<{ id?: string; sha256?: string; source?: string }>;
  usable: number;
  excluded: number;
  wrote: boolean;
}

async function listFiles(dir: string, skip: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (path.resolve(full) === skip) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function applyTags(base: OfficePhotoTags, patch: Partial<OfficePhotoTags>): OfficePhotoTags {
  return officePhotoTagsSchema.parse({ ...base, ...patch });
}

/**
 * Reads a folder of the office's raw photos into the client's library. Idempotent by the source
 * file's sha256: a photo already in the library keeps its tags and features (features are recomputed
 * only under a new features version), and a second run over the same folder writes nothing. Tags
 * from a sheet are merged field by field. Photos are copied upright into the library; nothing is
 * uploaded anywhere.
 */
export async function ingestOfficePhotoFolder(options: OfficePhotoIngestOptions): Promise<OfficePhotoIngestReport> {
  const now = options.now ?? (() => new Date());
  const clientDir = officePhotoClientDir(path.resolve(options.libraryRoot), options.clientId);
  const manifestPath = path.join(clientDir, OFFICE_PHOTO_LIBRARY_MANIFEST);
  const existing = await readOfficePhotoLibrary(clientDir);
  if (existing && existing.library.clientId !== options.clientId) throw new Error(`OFFICE_PHOTO_LIBRARY_INVALID: ${manifestPath} belongs to ${existing.library.clientId}`);
  const bySha = new Map<string, OfficePhotoEntry>((existing?.library.photos ?? []).map((p) => [p.sha256, p]));
  const report: OfficePhotoIngestReport = { clientDir, manifestPath, added: [], unchanged: [], updated: [], skipped: [], tagRowsApplied: 0, tagRowsUnmatched: [], usable: 0, excluded: 0, wrote: false };
  const stamp = now().toISOString();
  const pendingFiles = new Map<string, Buffer>();

  for (const file of await listFiles(path.resolve(options.sourceDir), path.resolve(clientDir))) {
    const sourceName = path.relative(path.resolve(options.sourceDir), file).split(path.sep).join('/');
    const stat = await fs.stat(file);
    if (stat.size > OFFICE_PHOTO_LIMITS.maxFileBytes) { report.skipped.push({ source: sourceName, reason: `over the ${OFFICE_PHOTO_LIMITS.maxFileBytes} byte limit` }); continue; }
    const bytes = await fs.readFile(file);
    const type = sniffImageType(bytes);
    if (!type) {
      const heic = bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp';
      report.skipped.push({ source: sourceName, reason: heic ? 'HEIC/HEIF is not supported; export it as JPEG first' : 'not an image' });
      continue;
    }
    if (!(OFFICE_PHOTO_ALLOWED_TYPES as readonly string[]).includes(type)) { report.skipped.push({ source: sourceName, reason: `type ${type} is not allowed (JPEG, PNG or WebP only)` }); continue; }
    const hash = sha256(bytes);
    const prior = bySha.get(hash);
    if (prior && prior.features.version === OFFICE_PHOTO_FEATURES_VERSION) { report.unchanged.push(prior.id); continue; }
    if (report.added.includes(`olp_${hash.slice(0, 16)}`)) { report.skipped.push({ source: sourceName, reason: 'duplicate of a photo already in this folder' }); continue; }
    const upright = await uprightPhoto(bytes, options.rsvgConvertPath ? { rsvgConvertPath: options.rsvgConvertPath } : undefined);
    const storedType = sniffImageType(upright.bytes);
    if (!storedType || !(OFFICE_PHOTO_ALLOWED_TYPES as readonly string[]).includes(storedType)) { report.skipped.push({ source: sourceName, reason: 'could not be prepared for rendering' }); continue; }
    let measured;
    try { measured = await computeOfficePhotoFeatures(upright.bytes, options); } catch (err) {
      report.skipped.push({ source: sourceName, reason: `unreadable (${(err as Error).message})` });
      continue;
    }
    if (Math.max(measured.width, measured.height) > OFFICE_PHOTO_LIMITS.maxSide) { report.skipped.push({ source: sourceName, reason: 'larger than the pixel limit' }); continue; }
    const stored = `photos/${hash}.${imageFileExtension(storedType)}`;
    pendingFiles.set(stored, upright.bytes);
    const entry: OfficePhotoEntry = {
      id: `olp_${hash.slice(0, 16)}`, sha256: hash, storedSha256: sha256(upright.bytes), file: stored, sourceName: prior?.sourceName ?? sourceName,
      mimeType: storedType as OfficePhotoMimeType, fileBytes: upright.bytes.length, width: measured.width, height: measured.height,
      orientation: orientationOf(measured.width, measured.height), features: measured.features,
      tags: prior?.tags ?? officePhotoTagsSchema.parse({}), status: 'usable', excludedReasons: [], ingestedAt: prior?.ingestedAt ?? stamp,
    };
    bySha.set(hash, entry);
    (prior ? report.updated : report.added).push(entry.id);
  }

  for (const row of options.tagRows ?? []) {
    const target = [...bySha.values()].find((p) => (row.id && p.id === row.id) || (row.sha256 && p.sha256 === row.sha256) || (!row.id && !row.sha256 && row.source && p.sourceName === row.source));
    if (!target) { report.tagRowsUnmatched.push({ ...(row.id ? { id: row.id } : {}), ...(row.sha256 ? { sha256: row.sha256 } : {}), ...(row.source ? { source: row.source } : {}) }); continue; }
    const tags = applyTags(target.tags, row.tags);
    if (JSON.stringify(tags) !== JSON.stringify(target.tags)) {
      bySha.set(target.sha256, { ...target, tags });
      if (!report.added.includes(target.id) && !report.updated.includes(target.id)) {
        report.updated.push(target.id);
        report.unchanged = report.unchanged.filter((id) => id !== target.id);
      }
    }
    report.tagRowsApplied++;
  }

  const photos = [...bySha.values()].map((p) => {
    const excludedReasons = officePhotoExclusions(p);
    return { ...p, excludedReasons, status: excludedReasons.length ? 'excluded' as const : 'usable' as const };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  report.usable = photos.filter((p) => p.status === 'usable').length;
  report.excluded = photos.length - report.usable;
  const unchangedManifest = existing && JSON.stringify(existing.library.photos) === JSON.stringify(photos);
  if (unchangedManifest || options.dryRun) return report;

  const library = parseOfficePhotoLibrary({ version: OFFICE_PHOTO_LIBRARY_VERSION, clientId: options.clientId, updatedAt: stamp, photos });
  await fs.mkdir(path.join(clientDir, 'photos'), { recursive: true });
  for (const [rel, bytes] of pendingFiles) {
    const target = path.join(clientDir, rel);
    const current = await fs.readFile(target).catch(() => undefined);
    if (!current || !current.equals(bytes)) await fs.writeFile(target, bytes, { mode: 0o600 });
  }
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(library, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, manifestPath);
  await fs.writeFile(path.join(clientDir, OFFICE_PHOTO_TAG_TEMPLATE), officePhotoTagTemplate(library), { mode: 0o600 });
  report.wrote = true;
  return report;
}
