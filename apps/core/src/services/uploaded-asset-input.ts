/** Pure upload parsing and validation; no HTTP, provider, storage or authorization authority. */
import { validateUploadedAsset } from '@hawa/domain';
import { sniffBlobMediaType, type BlobMediaType } from '@hawa/contracts';
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_JSON_MAX_BYTES = Math.ceil(ASSET_MAX_BYTES / 3) * 4 + 4096;
export class AssetUploadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function parseAssetUpload(input: unknown) {
  const fail = (message: string): never => { throw new AssetUploadError(422, 'ASSET_INPUT_INVALID', message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Supply an asset object with actual file content.');
  const body = input as Record<string, unknown>;
  if (typeof body.clientId !== 'string' || !body.clientId.trim() || body.clientId.length > 128)
    throw new AssetUploadError(422, 'CLIENT_REQUIRED', 'Name the client this asset belongs to.');
  if (typeof body.filename !== 'string' || !body.filename || body.filename.length > 255 || /[\x00-\x1f\x7f]/.test(body.filename)) return fail('Supply a valid filename.');
  if (typeof body.mimeType !== 'string') return fail('Supply a supported media type.');
  if (body.category !== undefined && (typeof body.category !== 'string' || !body.category.trim() || body.category.length > 80)) return fail('Supply a bounded asset category.');
  let sourceBytes: Buffer;
  if (body.content !== undefined) {
    if (body.contentBase64 !== undefined || body.mimeType !== 'image/svg+xml' || typeof body.content !== 'string') return fail('Use UTF-8 content for SVG, or canonical contentBase64 for binary files.');
    sourceBytes = Buffer.from(body.content, 'utf8');
  } else {
    if (typeof body.contentBase64 !== 'string' || !body.contentBase64 || body.contentBase64.length > ASSET_JSON_MAX_BYTES) return fail('Actual file content is required.');
    sourceBytes = Buffer.from(body.contentBase64, 'base64');
    if (sourceBytes.toString('base64') !== body.contentBase64) return fail('Use canonical padded base64 without prefixes or whitespace.');
  }
  if (sourceBytes.length < 1 || sourceBytes.length > ASSET_MAX_BYTES) return fail('Asset files must be between one byte and 10 MiB.');
  if (body.sizeBytes !== undefined && (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes !== sourceBytes.length)) return fail('The claimed size must equal the actual file size.');
  if (sniffBlobMediaType(sourceBytes) !== body.mimeType) return fail('The supplied bytes do not match the declared media type.');
  if (body.mimeType === 'image/svg+xml') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes); } catch { return fail('SVG must be valid UTF-8.'); }
  }
  const validation = validateUploadedAsset({ filename: body.filename, mimeType: body.mimeType, sizeBytes: sourceBytes.length, content: sourceBytes });
  if (!validation.ok) return fail(validation.violations.join('; '));
  const admittedBytes = validation.sanitizedContent === undefined ? sourceBytes : Buffer.from(validation.sanitizedContent, 'utf8');
  return { clientId: body.clientId.trim(), filename: body.filename, mimeType: body.mimeType as BlobMediaType,
    category: typeof body.category === 'string' ? body.category.trim() : 'asset', sourceBytes, admittedBytes,
    sanitized: validation.sanitizedContent !== undefined };
}
