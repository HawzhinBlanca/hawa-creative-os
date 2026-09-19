/**
 * Read-only architecture audit: no database, provider, browser or filesystem mutation.
 * Run from repository root:
 *   node --import tsx output/audits/2026-09-19-architecture-reliability/offline-architecture-probe.ts
 * The JSON distinguishes real encoder/HTTP code from the deliberately fake repository.
 */
import { createRequire } from 'node:module';

const root = new URL('../../../', import.meta.url);
delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.VITEST = 'true';
process.env.HAWA_BEARER_TOKEN = 'offline-audit-disposable-operator';
process.env.HAWA_ACTION_HMAC_SECRET = 'offline-audit-disposable-nonproduction-action-key-2026';
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('Network is prohibited by this offline audit probe');
};

const { encodeStudioTransferV2 } = await import(new URL('packages/creative/src/studio/transfer-v2.ts', root).href);
const { createApp } = await import(new URL('apps/core/src/app.ts', root).href);
const { DesignStudioService } = await import(new URL('apps/core/src/services/design-studio/design-studio-service.ts', root).href);
const require = createRequire(new URL('packages/creative/package.json', root));
const { unzipSync, strFromU8 } = require('fflate');

const layout = {
  version: 2, width: 1080, height: 1080, background: { color: '#FFFFFF' },
  grid: { margin: 40, columns: 12, gutter: 12, baseline: 8 },
  shapes: [{ kind: 'ellipse', x: 100, y: 100, width: 120, height: 120,
    color: '#FF0000', opacity: 0.2, rotation: 45, strokeWidth: 5, strokeColor: '#0000FF', role: 'accent' }],
  text: [{ copyIndex: 0, role: 'title', x: 100, y: 300, width: 800, height: 100,
    fontSize: 40, lineHeight: 1.3, fontFamily: 'Arial', color: '#000000', align: 'left', letterSpacing: 0.1, opacity: 0.3 }],
};
const encoded = await encodeStudioTransferV2(layout, ['Audit fixture']);
const xml = strFromU8(unzipSync(new Uint8Array(encoded.bytes))['ppt/slides/slide1.xml']);
const transfer = {
  evidenceType: 'real encoder, in-memory PPTX ZIP/XML inspection',
  expectedShape: layout.shapes[0],
  manifestShape: encoded.manifest.plan.shapes[0],
  actualShapeTypes: [...xml.matchAll(/<a:prstGeom prst="([^"]+)"/g)].map(m => m[1]),
  ellipsePreserved: xml.includes('prst="ellipse"'),
  rotationPreserved: xml.includes('rot="2700000"'),
  shapeOpacityPreserved: xml.includes('<a:alpha val="20000"'),
  blueStrokePreserved: xml.includes('0000FF'),
  textOpacityPreserved: xml.includes('<a:alpha val="30000"'),
  textSpacingPreserved: xml.includes('spc="'),
};

const headers = { Authorization: 'Bearer offline-audit-disposable-operator',
  'Content-Type': 'application/json', 'x-enforce-auth': '1' };
const app = createApp();
const original = await (await app.request('/v1/clients/client-drustee/dna', { headers })).json();
const proposed = { ...original, name: 'Audit Fixture Changed Name', createdBy: 'fabricated-author' };
const write = await app.request('/v1/clients/client-drustee/dna', {
  method: 'POST', headers, body: JSON.stringify(proposed),
});
const after = await (await app.request('/v1/clients/client-drustee/dna', { headers })).json();
const snapshots = await (await app.request('/v1/clients/client-drustee/snapshots', { headers })).json();
const recreated = await (await createApp().request('/v1/clients/client-drustee/dna', { headers })).json();
const clientDna = {
  evidenceType: 'real HTTP handlers with disposable in-memory state; no database',
  writeStatus: write.status, changed: after.name === proposed.name,
  snapshotAuthor: snapshots[0].createdBy,
  recreatedAppPreservedChange: recreated.name === proposed.name,
  originalVersion: original.version, savedVersion: after.version, recreatedVersion: recreated.version,
};

const service = Object.create(DesignStudioService.prototype);
const observed: unknown[] = [];
service.tx = async (_scope: unknown, fn: (db: object) => unknown) => fn({});
service.repo = {
  getRunById: async (id: string, tenant: string) => ({ id, tenant_id: tenant,
    task_id: '11111111-1111-4111-8111-111111111111', actor_id: 'original-actor', status: 'briefing' }),
  updateRunStatus: async (...args: unknown[]) => { observed.push(args); },
};
const abandoned = await service.abandon({ tenantId: 'tenant-fixture', actorId: 'different-actor' },
  '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  'Read-only in-memory audit');

console.log(JSON.stringify({
  networkAttempts,
  transfer,
  clientDna,
  taskBinding: { evidenceType: 'real service method with fake repository; not a live RLS exploit',
    suppliedTaskMatchesRun: false, suppliedActorMatchesRun: false, result: abandoned,
    writesToFakeRepository: observed },
}, null, 2));
if (networkAttempts) process.exitCode = 1;
