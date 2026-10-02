import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { admitPageGrammarFromReference, creativeAssetPath, PageGrammarInvalidError } from '@hawa/creative';
import { sniffBlobMediaType } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { computeDnaHash, isValidUuid } from '../core-helpers.js';
import { blobStoreFor } from './blob-store-context.js';
import { CanvaFlowError } from './canva-connect-service.js';
import { onboardingGapOf } from './client-packs.js';

type Scope = { tenantId: string; actorId: string };
type Resolved = { reference: Record<string, any>; logo: Buffer };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
/** WCAG relative luminance of a #rrggbb colour. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The colours a planner falls back to, from a DNA's colour roles: the first text and accent colours,
 * and the LIGHTEST background colour (ADR-236, light first). It took the first background listed, and
 * KAAE's DNA listed its midnight navy first, so every repaired ground was navy while the brand
 * guideline's own pages are white and cream.
 */
export function paletteFallbacksOf(colors: unknown[]): { background?: string; text?: string; accent?: string } {
  const valid = colors.filter((color: any) => hexColor(color?.hex)) as Array<{ hex: string; role?: unknown }>;
  const colorFor = (role: string) => valid.find((color) => color.role === role)?.hex;
  const background = valid.filter((color) => color.role === 'background').map((color) => color.hex)
    .sort((a, b) => relativeLuminance(b) - relativeLuminance(a))[0];
  return { background, text: colorFor('text'), accent: colorFor('accent') };
}

/** The package reference is a transitional, KAAE-only draft input. It never serves another client. */
async function packagedKaaeReference(clientId: string): Promise<Resolved | null> {
  const reference = JSON.parse(await readFile(creativeAssetPath('kaae-reference.json'), 'utf8'));
  if (clientId !== reference.clientId) return null;
  try {
    admitPageGrammarFromReference(reference);
  } catch (error) {
    if (error instanceof PageGrammarInvalidError) throw new CanvaFlowError(422, error.code, error.message);
    throw error;
  }
  const logo = await readFile(creativeAssetPath('logos/kaae-official-logo.png'));
  if (sha256(logo) !== reference.logoSha256 || sniffBlobMediaType(logo) !== 'image/png') {
    throw new CanvaFlowError(409, 'LOGO_CHANGED', 'The packaged client logo no longer matches its reference hash.');
  }
  return { reference, logo };
}

/** Resolve a versioned client reference and exact logo bytes from the office blob store.
 * A requested historical version is for recovery reads; callers must separately check that it
 * is still current before making a new design or side effect.
 */
export async function resolveClientDesignReference(
  db: Kysely<Database>, scope: Scope, clientId: string, historicalVersion?: number
): Promise<Resolved> {
  if (!isValidUuid(clientId)) throw new CanvaFlowError(422, 'CLIENT_REQUIRED', 'The task needs a recorded client ID.');
  if (historicalVersion !== undefined && (!Number.isInteger(historicalVersion) || historicalVersion < 1)) {
    throw new CanvaFlowError(422, 'CLIENT_REFERENCE_INVALID', 'The saved client reference version is invalid.');
  }
  const packaged = await packagedKaaeReference(clientId);
  if (packaged) return packaged;

  const row = await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: 'operator' }, async trx =>
    (await sql<{ dna: unknown; version: number; content_hash: string; status: string }>`
      SELECT dna, version, content_hash, status FROM hawa.client_dna_versions
      WHERE tenant_id = ${scope.tenantId}::uuid AND client_id = ${clientId}::uuid
        AND (${historicalVersion ?? null}::integer IS NULL AND status = 'active'
          OR version = ${historicalVersion ?? null}::integer AND status IN ('active','superseded'))
      ORDER BY version DESC LIMIT 1`.execute(trx)).rows[0]);
  if (!row) {
    // A client still being set up says what it lacks (ADR-127); the refusal itself is unchanged.
    const gap = onboardingGapOf(clientId);
    throw new CanvaFlowError(422, 'CLIENT_REFERENCE_REQUIRED',
      `${gap ? `${gap} ` : ''}This client needs an active versioned design reference before planning.`);
  }
  const dna = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
  if (!dna || typeof dna !== 'object') throw new CanvaFlowError(422, 'CLIENT_REFERENCE_INVALID', 'The client reference is not a structured record.');
  const d = dna as Record<string, any>;
  const hashable = { ...d };
  delete hashable.__commitMessage;
  delete hashable.__createdBy;
  if (d.tenantId !== scope.tenantId || d.clientId !== clientId || d.status !== 'active' ||
      Number(d.version) !== Number(row.version) || computeDnaHash(hashable) !== row.content_hash) {
    throw new CanvaFlowError(409, 'CLIENT_REFERENCE_CHANGED', 'The active client reference identity or content hash does not match its version.');
  }

  const colors = Array.isArray(d.colors) ? d.colors : [];
  const palette = [...new Set(colors.map((color: any) => color?.hex).filter(hexColor))];
  const paletteFallbacks = paletteFallbacksOf(colors);
  if (palette.length < 2 || !paletteFallbacks.background || !paletteFallbacks.text || !paletteFallbacks.accent) {
    throw new CanvaFlowError(422, 'BRAND_PALETTE_REQUIRED', 'The active client reference needs background, text and accent colors.');
  }
  const fonts = Array.isArray(d.fonts) ? d.fonts : [];
  const supports = (font: any, locale: string) => Array.isArray(font?.supportedLocales) && font.supportedLocales.includes(locale);
  const latin = fonts.find((font: any) => font?.role === 'body' && supports(font, 'en'))?.family;
  const arabic = fonts.find((font: any) => font?.role === 'body' && (supports(font, 'ckb') || supports(font, 'ar')))?.family;
  const admitted = [...new Set(fonts.filter((font: any) => font?.role === 'display' && typeof font?.family === 'string').map((font: any) => font.family))] as string[];
  if (!latin || !arabic || admitted.length === 0) {
    throw new CanvaFlowError(422, 'BRAND_FONTS_REQUIRED', 'The active client reference needs Latin and Sorani/Arabic body fonts and a display font.');
  }

  const logoAsset = Array.isArray(d.assets) ? d.assets.find((asset: any) => asset?.role === 'logo_primary') : null;
  if (!logoAsset || !isValidUuid(logoAsset.assetId) || !/^[0-9a-f]{64}$/i.test(logoAsset.sha256 || '') ||
      logoAsset.mimeType !== 'image/png' || logoAsset.storageKey !== `sha256:${logoAsset.sha256}`) {
    throw new CanvaFlowError(422, 'CLIENT_LOGO_REQUIRED', 'The active client reference needs a hashed primary PNG logo asset.');
  }
  const minimumWidthPx = logoAsset.minimumWidthPx ?? 100;
  const clearSpacePx = logoAsset.clearSpacePx ?? 0;
  // A client's own minimum may be under the house's 100px (ADR-238: KAAE's 2025 guideline says 80px
  // digital, p.4); hard QA still applies the stronger of the two. Under a favicon's 16px is no rule.
  if (!Number.isInteger(minimumWidthPx) || minimumWidthPx < 16 || minimumWidthPx > 2400 ||
      !Number.isInteger(clearSpacePx) || clearSpacePx < 0 || clearSpacePx > 1200) {
    throw new CanvaFlowError(422, 'CLIENT_LOGO_RULES_INVALID', 'The primary logo has invalid minimum width or clear space rules.');
  }
  const store = blobStoreFor(db);
  if (!store) throw new CanvaFlowError(503, 'CLIENT_LOGO_UNAVAILABLE', 'The content-addressed logo store is unavailable.');
  let logo: Buffer;
  try { logo = await store.read(logoAsset.sha256, { verify: true }); }
  catch { throw new CanvaFlowError(503, 'CLIENT_LOGO_UNAVAILABLE', 'The official client logo bytes are missing or corrupt.'); }
  if (sha256(logo) !== logoAsset.sha256 || sniffBlobMediaType(logo) !== 'image/png') {
    throw new CanvaFlowError(409, 'LOGO_CHANGED', 'The official client logo bytes do not match the active reference.');
  }

  return {
    reference: {
      clientId, clientName: d.name, dnaVersion: row.version, dnaContentHash: row.content_hash,
      // This identifies the reference format, not the mutable row lifecycle. Keep a saved run's
      // reference hash stable if its DNA row is later superseded; currentness is checked separately.
      status: 'active_client_dna',
      logoAssetId: logoAsset.assetId, logoSha256: logoAsset.sha256,
      rules: {
        palette, paletteFallbacks,
        typography: { display: { admitted }, formalBody: { latin, arabic } },
        scriptFonts: { arabic },
        logoConstraints: { minimumWidthPx, clearSpacePx },
        layoutRules: Array.isArray(d.guidelines?.layoutRules) ? d.guidelines.layoutRules : [],
      },
    },
    logo,
  };
}

/** A saved draft may be imported only while the version it planned against is still active. */
export async function assertCurrentClientDesignReference(
  db: Kysely<Database>, scope: Scope, reference: Record<string, any>
): Promise<void> {
  if (reference.dnaVersion == null) return; // Packaged KAAE reference has no DNA version.
  if (!isValidUuid(reference.clientId) || !Number.isInteger(reference.dnaVersion) ||
      typeof reference.dnaContentHash !== 'string') {
    throw new CanvaFlowError(409, 'CLIENT_REFERENCE_CHANGED', 'The saved client reference identity is invalid.');
  }
  const row = await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: 'operator' }, async trx =>
    (await sql<{ version: number; content_hash: string }>`
      SELECT version, content_hash FROM hawa.client_dna_versions
      WHERE tenant_id = ${scope.tenantId}::uuid AND client_id = ${reference.clientId}::uuid AND status = 'active'
      ORDER BY version DESC LIMIT 1`.execute(trx)).rows[0]);
  if (!row || Number(row.version) !== reference.dnaVersion || row.content_hash !== reference.dnaContentHash) {
    throw new CanvaFlowError(409, 'CLIENT_REFERENCE_CHANGED', 'The client brand reference changed. Abandon this draft and plan again with the current version.');
  }
}
