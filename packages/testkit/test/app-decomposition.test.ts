import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../apps/core/src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 4: app.ts Modular Route Decomposition', () => {
  it('proves modular route files exist in apps/core/src/routes/', () => {
    const routesDir = path.resolve(rootDir, 'apps/core/src/routes');
    expect(fs.existsSync(path.join(routesDir, 'auth.routes.ts'))).toBe(true);
    expect(fs.existsSync(path.join(routesDir, 'clients.routes.ts'))).toBe(true);
    expect(fs.existsSync(path.join(routesDir, 'evals.routes.ts'))).toBe(true);
    expect(fs.existsSync(path.join(routesDir, 'ingress.routes.ts'))).toBe(true);
  });

  it('proves apps/core/src/app.ts registers auth, clients, evals, and ingress route modules', () => {
    const appTs = fs.readFileSync(path.resolve(rootDir, 'apps/core/src/app.ts'), 'utf8');
    expect(appTs).toContain('registerAuthRoutes');
    expect(appTs).toContain('registerClientsRoutes');
    expect(appTs).toContain('registerEvalsRoutes');
    expect(appTs).toContain('registerIngressRoutes');
  });

  it('verifies decomposed auth, client, and evals routes handle requests properly', async () => {
    const app = createApp();
    
    // Auth route verification
    const authRes = await app.request('/auth/session', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect(authRes.status).toBe(200);
    const authJson = await authRes.json();
    expect(authJson.authenticated).toBe(true);

    // Clients route verification
    const clientsRes = await app.request('/clients', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect([200, 204]).toContain(clientsRes.status);

    // Evals route verification
    const evalsRes = await app.request('/evaluations/runs', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_bearer' },
    });
    expect([200, 204]).toContain(evalsRes.status);
  });
});
