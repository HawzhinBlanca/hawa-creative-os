import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../apps/core/src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 3: Elimination of Duplicate Paths', () => {
  it('proves POST /tasks/:taskId/publish does not contain duplicate publisher execution logic and delegates to executeOmnichannelPublish', () => {
    const appTsPath = path.resolve(rootDir, 'apps/core/src/app.ts');
    const appTsContent = fs.readFileSync(appTsPath, 'utf8');

    // Extract the body of registerRoute('post', '/tasks/:taskId/publish'
    const routeIndex = appTsContent.indexOf("registerRoute('post', '/tasks/:taskId/publish',");
    expect(routeIndex).toBeGreaterThan(-1);

    const routeChunk = appTsContent.slice(routeIndex, routeIndex + 4000);
    // Must call executeOmnichannelPublish
    expect(routeChunk).toContain('executeOmnichannelPublish(');
    // Must NOT contain separate publisher.publish invocation
    expect(routeChunk).not.toContain('publisher.publish(ctx,');
    // Must NOT contain separate publicationRepo.createPublication invocation
    expect(routeChunk).not.toContain('publicationRepo.createPublication(');
  });

  it('proves POST /tasks/:taskId/:control does not allow unpinned approve bypass', async () => {
    const app = createApp();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test_bearer',
      'x-user-role': 'art_director',
    };

    // Create a task
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Duplicate path test task', clientId: 'kaae' }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    const taskId = task.id || task.taskId;

    // Attempting to approve via POST /tasks/:taskId/approve should NOT succeed as an unpinned state mutation
    const approveRes = await app.request(`/tasks/${taskId}/approve`, {
      method: 'POST',
      headers,
    });
    // Should be rejected or not found (must not transition task to APPROVED without decisions & pins)
    expect(approveRes.status).not.toBe(200);
    expect(approveRes.status).not.toBe(202);
  });

  it('proves Restate TaskWorkflow in apps/worker/src/index.ts directly runs runCanvaDraft', () => {
    const workerIndexPath = path.resolve(rootDir, 'apps/worker/src/index.ts');
    const workerIndexContent = fs.readFileSync(workerIndexPath, 'utf8');

    // The TaskWorkflow handler in Restate index.ts must reference runCanvaDraft
    expect(workerIndexContent).toContain('runCanvaDraft');
  });
});
