import { serve } from '@hono/node-server';
import { createApp } from './app.js';

import fs from 'node:fs';

try {
  if (fs.existsSync('.env')) {
    const envFile = fs.readFileSync('.env', 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val) {
          process.env[key] = val.trim();
        }
      }
    }
  }
} catch {
  // Gracefully continue if .env cannot be read
}

const app = createApp();
const port = Number(process.env.PORT || 3001);
const hostname = process.env.HOST || '0.0.0.0';

console.log(`Starting Hawa Core API on http://${hostname}:${port}...`);
serve({
  fetch: app.fetch,
  port,
  hostname,
});
