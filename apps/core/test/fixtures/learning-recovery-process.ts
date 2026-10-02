/** Separate disposable Core process: no providers, production database or office dotenv. */
import { basename } from 'node:path';
import { serve } from '@hono/node-server';
import { createDb } from '@hawa/db';
import { assertTestDatabaseEnv, connectionTargetOf } from '../../../../packages/db/src/test-database-guard.js';
assertTestDatabaseEnv(process.env);
const target=connectionTargetOf(process.env.TEST_DATABASE_URL ?? '');
if(process.env.HAWA_LEARNING_RECOVERY!=='1' || !basename(process.cwd()).startsWith('hawa-learning-recovery-') ||
  !['127.0.0.1','localhost'].includes(target.host ?? '') || Number(target.port)!==55432 ||
  !/^hawa_t_[a-z0-9_]+$/.test(target.database ?? '')) throw new Error('Isolated learning recovery target required');
globalThis.fetch=()=>Promise.reject(new Error('Learning recovery process refuses provider/network calls'));
const {createAppWithClientFixtures}=await import('./app-with-client-fixtures.js');
const db=createDb(process.env.TEST_DATABASE_URL!);
const app=createAppWithClientFixtures({db,skipPaidModelProbe:true,skipTelegramProbe:true,
  enableBillingProbeSchedule:false,enableCanvaSweeper:false});
await app.clientDnaHydrated;
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},info=>process.send?.({port:info.port}));
process.on('SIGTERM',()=>{
  server.close(()=>void db.destroy().finally(()=>process.exit(0)));
  if('closeAllConnections' in server) server.closeAllConnections();
});
