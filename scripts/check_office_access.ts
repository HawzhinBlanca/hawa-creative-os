import { readFileSync } from 'node:fs';
import { officeAccessPolicy, validateOfficeBind } from '../apps/core/src/services/office-access.js';

const env: NodeJS.ProcessEnv = {};
for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const match = /^(HAWA_DESK_AUTH_MODE|HAWA_TRUSTED_OFFICE_ORIGIN)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
validateOfficeBind(officeAccessPolicy(env), process.argv[3]);
console.log('Office access configuration and network bind agree.');
