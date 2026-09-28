import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The task controls are four explicit routes (apps/core/src/routes/controls.routes.ts). The published
 * contract must describe those four paths and nothing else: studio-v2 found its OpenAPI file still
 * described a `{control}` catch-all with `replay` (644fd8dd), and this branch carried the same stale
 * entry beside the explicit pause/resume/cancel paths, with retry undocumented.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const openapi = readFileSync(path.join(root, 'api', 'openapi.yaml'), 'utf8');
const controls = JSON.parse(readFileSync(path.join(root, 'api', 'task-controls.openapi.json'), 'utf8')) as {
  paths: Record<string, { post?: { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> } }>;
};
const routes = readFileSync(path.join(root, 'apps', 'core', 'src', 'routes', 'controls.routes.ts'), 'utf8');

describe('task control contract', () => {
  it('has no {control} catch-all path', () => {
    expect(openapi).not.toMatch(/\/v1\/tasks\/\{taskId\}\/\{control\}:/);
    expect(openapi).not.toMatch(/controlTaskWorkflow/);
  });

  it('documents every control the Core route registers, each once', () => {
    const registered = /for \(const control of \[([^\]]+)\] as const\) registerRoute\('post', `\/tasks\/:taskId\/\$\{control\}`/.exec(routes);
    expect(registered, 'controls.routes.ts no longer registers the controls in one loop').not.toBeNull();
    const names = registered![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(names).toEqual(['pause', 'resume', 'cancel', 'retry']);
    for (const name of names) {
      const p = `/v1/tasks/{taskId}/${name}`;
      expect(controls.paths[p]?.post, `${p} missing from api/task-controls.openapi.json`).toBeDefined();
      const refs = openapi.split('\n').filter((line) => line === `  ${p}:`);
      expect(refs, `${p} must appear once in api/openapi.yaml`).toHaveLength(1);
    }
  });

  it('describes retry as the refusal Core answers, not as a state change', () => {
    const retry = controls.paths['/v1/tasks/{taskId}/retry']?.post;
    expect(retry?.operationId).toBe('retryTask');
    expect(retry?.requestBody).toBeUndefined();
    expect(Object.keys(retry?.responses ?? {})).toContain('409');
    expect(Object.keys(retry?.responses ?? {})).not.toContain('202');
    expect(JSON.stringify(retry)).toMatch(/RECOVERY_CHECKPOINT_REQUIRED/);
  });
});
