import { createApp, computeDnaHash, type CreateAppOptions } from '../../src/app.js';
import { seedClientDnaFixtures } from './client-dna-fixtures.js';

/**
 * createApp with the invented offices of client-dna-fixtures.ts in its DNA map, for a test that
 * names one of them (client-office-1, client-drustee, client-aster, ...). Core seeds nothing on its
 * own (architecture programme 1.3, SPLIT_PLAN.md section 6, stage 2).
 */
export function createAppWithClientFixtures(options?: CreateAppOptions): ReturnType<typeof createApp> {
  return createApp({
    ...options,
    seedClientDna: (clientDnas, clientSnapshots) => seedClientDnaFixtures(clientDnas, clientSnapshots, computeDnaHash),
  });
}
