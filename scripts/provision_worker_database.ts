import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { provisionWorkerDatabase } from '../packages/db/src/provision-worker-role.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const fields = file ? readFileSync(file, 'utf8').trim().split('\n') : [];
  if (fields.length !== 1 || !fields[0].startsWith('WORKER_DATABASE_URL=') || !process.env.DATABASE_URL) {
    throw new Error('Owner DATABASE_URL and the dedicated worker database file are required');
  }
  provisionWorkerDatabase(process.env.DATABASE_URL, fields[0].slice('WORKER_DATABASE_URL='.length), process.argv.includes('--production'))
    .then(() => console.log('Restricted worker database login verified (values withheld).'))
    .catch(() => { console.error('ERROR: restricted worker database provisioning failed (values withheld).'); process.exitCode = 1; });
}
