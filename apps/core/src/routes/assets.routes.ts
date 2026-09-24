import crypto from 'node:crypto';
import { validateUploadedAsset, sanitizeSvg } from '@hawa/domain';
import type { RouteContext } from './types.js';
import { DEFAULT_CLIENT_ID } from '../core-context.js';

/**
 * Asset upload and SVG sanitising, and the voice-brief transcriber. Moved out of app.ts by group G1
 * (leaves) of the split (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerAssetsRoutes(ctx: RouteContext): void {
  const { registerRoute, problem, uploadedAssets, voiceTranscriber, broadcastEvent: broadcast } = ctx;
  const defaultClientId = DEFAULT_CLIENT_ID;

  // Asset Security & Ingestion
  registerRoute('post', '/assets/upload', async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.filename || !body.mimeType) {
      return problem(c, 400, 'Invalid Asset Request', 'filename and mimeType are required');
    }

    const validation = validateUploadedAsset({
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes || (body.content ? (typeof body.content === 'string' ? Buffer.byteLength(body.content) : body.content.length) : 1024),
      content: body.content,
    });

    if (!validation.ok) {
      return problem(c, 400, 'Asset Security Policy Violation', validation.violations.join('; '));
    }

    const assetId = crypto.randomUUID();
    const storageKey = `assets/${validation.sha256}/${body.filename}`;
    const clientId = body.clientId || defaultClientId;
    const category = body.category || 'asset';
    const record = {
      assetId,
      clientId,
      category,
      filename: body.filename,
      mimeType: validation.mimeType,
      sha256: validation.sha256,
      storageKey,
      sanitized: Boolean(validation.sanitizedContent),
      sanitizedContent: validation.sanitizedContent,
      createdAt: new Date().toISOString(),
    };
    uploadedAssets.set(assetId, record);

    broadcast('asset:ingested', { assetId, clientId, filename: record.filename, sha256: record.sha256 });

    return c.json(record, 201);
  });

  registerRoute('post', '/assets/sanitize-svg', async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.svg !== 'string') {
      return problem(c, 400, 'Invalid SVG Request', 'svg string is required');
    }

    const res = sanitizeSvg(body.svg);
    return c.json(res);
  });

  // Transcribe Kurdish Voice Message into Normalized Brief & Protected Tokens (FR-013, FR-014)
  registerRoute('post', '/assets/transcribe-brief', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const textHint = body.text || body.transcript;
    const duration = body.durationSeconds || 12;

    const result = await voiceTranscriber.transcribe(
      {
        audioBase64: body.audioBase64,
        audioMimeType: body.audioMimeType || 'audio/ogg',
        durationSeconds: duration,
        languageHint: 'ckb',
      },
      textHint
    );

    return c.json(result, 200);
  });

  // List All Admitted & Verified Assets (FR-018, Gate A & B)
  registerRoute('get', '/assets', async (c: any) => {
    const clientId = c.req.query('clientId');
    let all = Array.from(uploadedAssets.values());
    if (clientId && clientId !== 'all') {
      all = all.filter((a: any) => !a.clientId || a.clientId === clientId);
    }
    return c.json(all, 200);
  });
}
