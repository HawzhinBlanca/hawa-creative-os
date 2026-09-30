import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { officeAccessPolicy, validateOfficeBind } from '../apps/core/src/services/office-access.js';

const env: NodeJS.ProcessEnv = {};
// Match Core's ordered env files. Never print the server-only proof or credentials.
const canonical = process.argv[2];
const boundaries = join(dirname(canonical), '.env.service-boundaries');
for (const file of [canonical, ...(existsSync(boundaries) ? [boundaries] : [])]) {
  const seen = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^(HAWA_DESK_AUTH_MODE|HAWA_TRUSTED_OFFICE_ORIGIN|HAWA_OFFICE_PROXY_PROOF|HAWA_DESIGN_WORKER_TOKEN|HAWA_WORKER_TOKEN|HAWA_WORKER_TOKEN_PREVIOUS|HAWA_API_KEY|HAWA_BEARER_TOKEN|HAWA_ADMIN_KEY|HAWA_ART_DIRECTOR_KEY|HAWA_REVIEWER_KEY|HAWA_DESK_SECRET)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (seen.has(match[1])) throw new Error(`Duplicate office configuration field: ${match[1]}`);
    seen.add(match[1]);
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
validateOfficeBind(officeAccessPolicy(env), process.argv[3]);
console.log('Office access configuration and network bind agree.');
