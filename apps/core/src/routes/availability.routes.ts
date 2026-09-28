import { availabilityConfig, AvailabilityError, probeOfficeReadiness, readAvailabilityReport, recordAvailabilityObservation } from '../services/availability-observations.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { secretsEqual, isValidUuid } from '../core-helpers.js';
import type { RouteContext } from './types.js';
import type { Context } from 'hono';

/** The collector credential opens exactly these two endpoints; it grants no office role. */
export function registerAvailabilityRoutes({ registerRoute, db, problem }: RouteContext) {
  const authorize = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const config = availabilityConfig();
    const header = c.req.header('Authorization') || '';
    return config && header.startsWith('Bearer ') && secretsEqual(header.slice(7), config.token) ? config : null;
  };
  registerRoute('get', '/monitoring/availability/probe', async (c: Context) => {
    const config = authorize(c);
    if (!config) return problem(c, 401, 'Monitor Authentication Required', 'A distinct configured monitor credential is required.');
    const nonce = c.req.header('X-Hawa-Probe-Nonce');
    if (!nonce || !isValidUuid(nonce)) return problem(c, 400, 'Invalid Probe Nonce', 'Supply a fresh UUID probe nonce.');
    const checks = await probeOfficeReadiness(db, DEFAULT_TENANT_ID, config);
    const commit = process.env.HAWA_BUILD_COMMIT;
    return c.json({ schemaVersion: 1, nonce, monitorId: config.monitorId, targetOrigin: config.targetOrigin,
      checkedAt: new Date().toISOString(), ...checks, buildCommit: commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null }, checks.ready ? 200 : 503);
  });
  registerRoute('post', '/monitoring/availability/observations', async (c: Context) => {
    const config = authorize(c);
    if (!config) return problem(c, 401, 'Monitor Authentication Required', 'A distinct configured monitor credential is required.');
    if (!db) return problem(c, 503, 'Observation Storage Unavailable', 'Retain the original observation and retry it later.');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') || ''))
      return problem(c, 400, 'Invalid Observation', 'Send the saved observation as JSON.');
    // Bound actual streamed bytes, including requests with no Content-Length.
    const reader = c.req.raw.body?.getReader();
    if (!reader) return problem(c, 400, 'Invalid Observation', 'An observation body is required.');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 8192) return problem(c, 413, 'Observation Too Large', 'Observation bodies are limited to 8192 bytes.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return problem(c, 400, 'Invalid Observation', 'The observation must be valid UTF-8 JSON.'); }
    if (!value || typeof value !== 'object' || !('observationId' in value) || c.req.header('Idempotency-Key') !== value.observationId)
      return problem(c, 400, 'Invalid Observation Identity', 'Idempotency-Key must match the saved observation ID.');
    try {
      const receipt = await recordAvailabilityObservation(db, DEFAULT_TENANT_ID, config, value);
      return c.json(receipt, receipt.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof AvailabilityError) return problem(c, error.status, 'Observation Refused', error.message);
      return problem(c, 503, 'Observation Storage Unavailable', 'Retain the original observation and retry it later.');
    }
  });
}

export { availabilityConfig, AvailabilityError, readAvailabilityReport };
