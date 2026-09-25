import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { creativeAssetPath } from '@hawa/creative';
import { sniffBlobMediaType } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { computeDnaHash, isValidUuid } from '../core-helpers.js';
import { blobStoreFor } from './blob-store-context.js';
import { CanvaFlowError } from './canva-connect-service.js';

type Scope = { tenantId: string; actorId: string };
type Resolved = { reference: Record<string, any>; logo: Buffer };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** The package reference is a transitional, KAAE-only draft input. It never serves another client. */
async function packagedKaaeReference(clientId: string): Promise<Resolved | null> {
  const reference = JSON.parse(await readFile(creativeAssetPath('kaae-reference.json'), 'utf8'));
  if (clientId !== reference.clientId) return null;
  const logo = await readFile(creativeAssetPath('logos/kaae-official-logo.png'));
  if (sha256(logo) !== reference.logoSha256 || sniffBlobMediaType(logo) !== 'image/png') {
    throw new CanvaFlowError(409, 'LOGO_CHANGED', 'The packaged client logo no longer matches its reference hash.');
  }
  return { reference, logo };
}

/** Resolve an active versioned client reference and exact logo bytes from the office blob store. */
export async function resolveClientDesignReference(db: Kysely<Database>, scope: Scope, clientId: string): Promise<Resolved> {
  if (!isValidUuid(clientId)) throw new CanvaFlowError(422, 'CLIENT_REQUIRED', 'The task needs a recorded client ID.');
  const packaged = await packagedKaaeReference(clientId);
  if (packaged) return packaged;

  const row = await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: 'operator' }, async trx =>
    (await sql<{ dna: unknown; version: number; content_hash: string }>`
      SELECT dna, version, content_hash FROM hawa.client_dna_versions
      WHERE tenant_id = ${scope.tenantId}::uuid AND client_id = ${clientId}::uuid AND status = 'active'
      ORDER BY version DESC LIMIT 1`.execute(trx)).rows[0]);
  if (!row) throw new CanvaFlowError(422, 'CLIENT_REFERENCE_REQUIRED', 'This client needs an active versioned design reference before planning.');
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
  const colorFor = (role: string) => colors.find((color: any) => color?.role === role && hexColor(color?.hex))?.hex as string | undefined;
  const paletteFallbacks = { background: colorFor('background'), text: colorFor('text'), accent: colorFor('accent') };
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
  if (!Number.isInteger(minimumWidthPx) || minimumWidthPx < 100 || minimumWidthPx > 2400 ||
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
      status: 'active_client_dna', logoAssetId: logoAsset.assetId, logoSha256: logoAsset.sha256,
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
