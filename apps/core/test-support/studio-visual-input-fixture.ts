import type { StudioVisualBundle, StudioVisualScope } from '@hawa/db';
import type { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

/** Stage-only harness storage. SQL atomicity, scope and integrity are tested against PostgreSQL. */
export function useMemoryVisualInputs(service: DesignStudioService): void {
  const saved = new Map<string, StudioVisualBundle>();
  const copy = (bundle: StudioVisualBundle): StudioVisualBundle => ({ manifest: structuredClone(bundle.manifest),
    assets: bundle.assets.map(a => ({ key: a.key, bytes: Buffer.from(a.bytes) })) });
  Object.assign(service, { visualInputRepo: {
    get: async (scope: StudioVisualScope, runId: string) => {
      const found = saved.get(`${scope.tenantId}:${runId}`);
      return found ? copy(found) : null;
    },
    pin: async (scope: StudioVisualScope, runId: string, bundle: StudioVisualBundle) => {
      const key = `${scope.tenantId}:${runId}`;
      if (!saved.has(key)) saved.set(key, copy(bundle));
      return copy(saved.get(key)!);
    },
  } });
}
