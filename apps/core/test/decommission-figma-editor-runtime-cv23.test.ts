import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';

describe('CV-23: Complete Decommissioning of Figma Bridge and Legacy Editor Runtime (FR-030, FR-064, FR-073, FR-074, FR-075, FR-080, NFR-012, NFR-018, NFR-023)', () => {
  const sampleTaskId = '11111111-2222-3333-4444-555555555555';
  let app: any;

  beforeAll(() => {
    app = createApp();
  });

  it('1. Verifies Canva Native Studio is the sole active studio and Figma provider fallback is removed', async () => {
    const res = await app.request('/system/studio-status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('online');
    expect(body.activeStudio).toBe('canva');
    expect(body.studioVersion).toBe('v2.0.0-canva-cutover');
    expect(body.admittedClients).toEqual(['kaae', 'drustee', 'aster']);
  });

  it('2. Rejects legacy Figma write lease acquisition with HTTP 410 GONE', async () => {
    const res1 = await app.request(`/tasks/${sampleTaskId}/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: 'figma_kaae_master_library', ttlSeconds: 3600 }),
    });
    expect(res1.status).toBe(410);
    const body1 = await res1.json();
    expect(body1.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');
    expect(body1.statusCode).toBe(410);
    expect(body1.decommissionedUnder).toBe('CV-23');

    const res2 = await app.request(`/tasks/${sampleTaskId}/figma/lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: 'figma_kaae_master_library' }),
    });
    expect(res2.status).toBe(410);
    const body2 = await res2.json();
    expect(body2.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');
  });

  it('3. Rejects legacy Figma lease release and mutation requests with HTTP 410 GONE', async () => {
    const delRes = await app.request(`/tasks/${sampleTaskId}/leases/lease_mock_123`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(410);
    const delBody = await delRes.json();
    expect(delBody.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');

    const mutateRes = await app.request(`/tasks/${sampleTaskId}/figma/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'UPDATE_TEXT', args: { text: 'New Copy' } }),
    });
    expect(mutateRes.status).toBe(410);
    const mutateBody = await mutateRes.json();
    expect(mutateBody.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');
  });

  it('4. Rejects legacy Figma inspection routes with HTTP 410 GONE', async () => {
    const res1 = await app.request(`/tasks/${sampleTaskId}/figma/status`);
    expect(res1.status).toBe(410);
    const body1 = await res1.json();
    expect(body1.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');

    const res2 = await app.request('/v1/figma/status');
    expect(res2.status).toBe(410);
    const body2 = await res2.json();
    expect(body2.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');

    const res3 = await app.request('/figma/status');
    expect(res3.status).toBe(410);
    const body3 = await res3.json();
    expect(body3.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');
  });

  it('5. Reports honest decommissioned status via /adapters/figma/cloud-status without live bridge connections', async () => {
    const res = await app.request('/adapters/figma/cloud-status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.figma.status).toBe('decommissioned');
    expect(body.figma.decommissionedUnder).toBe('CV-23');
    expect(body.activeStudio).toBe('canva');
    expect(body.cutoverState).toBe('cutover_complete');
  });

  it('6. Integrations health reports Canva Native Studio healthy and zero active Figma bridge instances', async () => {
    const res = await app.request('/integrations/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    const canvaIntegration = body.items.find((i: any) => i.integrationId === 'int_canva_studio');
    expect(canvaIntegration).toBeDefined();
    expect(canvaIntegration.state).toBe('healthy');
    expect(canvaIntegration.kind).toBe('canva_native_studio');

    const figmaIntegration = body.items.find((i: any) => i.integrationId === 'int_figma_bridge');
    expect(figmaIntegration).toBeUndefined();
  });

  it('7. Confirms all Polotno and custom canvas editor files are completely deleted from Hawa Desk', () => {
    const deskRoot = fs.existsSync(path.resolve(process.cwd(), 'apps/desk'))
      ? path.resolve(process.cwd(), 'apps/desk')
      : path.resolve(process.cwd(), '../desk');
    const deletedPaths = [
      path.join(deskRoot, 'src/screens/ReviewScreen.tsx'),
      path.join(deskRoot, 'src/services/polotnoEngine.ts'),
      path.join(deskRoot, 'src/services/historyTree.ts'),
      path.join(deskRoot, 'src/services/canvasExport.ts'),
      path.join(deskRoot, 'src/services/reflowEngine.ts'),
      path.join(deskRoot, 'src/assets/editorPresets.ts'),
      path.join(deskRoot, 'src/services/cairoFontBase64.ts'),
      path.join(deskRoot, 'src/services/interFontBase64.ts'),
      path.join(deskRoot, 'src/services/vazirmatnFontBase64.ts'),
      path.join(deskRoot, 'scripts/generate_drustee_pilot_campaign.ts'),
      path.join(deskRoot, 'test/canvasExport.test.ts'),
      path.join(deskRoot, 'test/historyTree.test.ts'),
      path.join(deskRoot, 'test/polotnoEngine.test.ts'),
    ];

    for (const p of deletedPaths) {
      expect(fs.existsSync(p), `File ${path.basename(p)} should be deleted`).toBe(false);
    }

    // Verify package.json does not contain polotno
    const pkgJson = JSON.parse(fs.readFileSync(path.join(deskRoot, 'package.json'), 'utf-8'));
    expect(pkgJson.dependencies?.polotno).toBeUndefined();
  });
});
