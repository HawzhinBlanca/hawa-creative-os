#!/usr/bin/env tsx
/**
 * Copies the chaos stack's container logs into the layout Vector writes in production
 * (infra/docker/vector.yaml: <dir>/<YYYY-MM-DD>/<service>.ndjson), so scripts/request_logs.ts can be
 * rehearsed on the chaos stack, which runs no Vector:
 *
 *   npx tsx scripts/load/export-chaos-logs.ts <dir>
 *   npx tsx scripts/request_logs.ts <requestId|taskId> --dir <dir>
 *
 * Only containers of the hawa-chaos project are read. Each line is written as Vector's remap writes
 * it: a JSON line (Core, the worker) as the object `log`, anything else as the text `message`, with
 * Docker's own timestamp, the compose service and the container name. Files are appended to; export
 * into a fresh directory.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VectorLine {
  timestamp: string;
  service: string;
  container_name: string;
  log?: Record<string, unknown>;
  message?: string;
}

const CHAOS_SERVICES = ['core', 'worker-blue', 'worker-green', 'postgres', 'restate', 'fakes'] as const;

/** `docker logs --timestamps` output of one container, as Vector's lines. */
export function toVectorLines(service: string, container: string, text: string): VectorLine[] {
  if (!container.startsWith('hawa-chaos-')) throw new Error(`refused: ${container} is not a hawa-chaos container`);
  const out: VectorLine[] = [];
  for (const raw of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) ?(.*)$/.exec(raw);
    if (!m) continue;
    const [, timestamp, message] = m;
    const line: VectorLine = { timestamp, service, container_name: container };
    let parsed: unknown = null;
    if (message.startsWith('{')) {
      try {
        parsed = JSON.parse(message);
      } catch {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) line.log = parsed as Record<string, unknown>;
    else line.message = message;
    out.push(line);
  }
  return out;
}

/** Appends lines to <dir>/<UTC day of the line>/<service>.ndjson. */
export function writeVectorFiles(dir: string, lines: readonly VectorLine[]): void {
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    const file = path.join(dir, line.timestamp.slice(0, 10), `${line.service}.ndjson`);
    const list = byFile.get(file) ?? [];
    list.push(JSON.stringify(line));
    byFile.set(file, list);
  }
  for (const [file, list] of byFile) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${list.join('\n')}\n`);
  }
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: export-chaos-logs.ts <dir>');
    process.exit(64);
  }
  let total = 0;
  for (const service of CHAOS_SERVICES) {
    const container = `hawa-chaos-${service}-1`;
    const res = spawnSync('docker', ['logs', '--timestamps', container], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (res.status !== 0) continue; // not running in this project (worker-green outside a deploy)
    const lines = toVectorLines(service, container, `${res.stdout}\n${res.stderr}`).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    writeVectorFiles(dir, lines);
    total += lines.length;
    console.log(`${service}: ${lines.length} line(s)`);
  }
  console.log(`${total} line(s) written under ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
