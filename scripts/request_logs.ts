#!/usr/bin/env tsx
/**
 * Every log line of one request, across Core, the worker and nginx (architecture programme 1.4).
 *
 *   npx tsx scripts/request_logs.ts <requestId | taskId>
 *   npx tsx scripts/request_logs.ts <id> --json          # the stored lines, unformatted
 *   npx tsx scripts/request_logs.ts <id> --since 2026-09-20 --dir ~/.hawa/logs/containers
 *
 * It reads the daily files Vector writes (infra/docker/vector.yaml: <dir>/<YYYY-MM-DD>/<service>.ndjson),
 * not `docker logs`, so it also finds the lines of containers a deploy has since replaced.
 *
 * A line belongs to the id when the id appears in it as a whole token: Core's and the worker's lines
 * carry requestId (and taskId) fields, nginx's end in rid=<id>, and a line that names a task in its
 * text (a path, a message) names it too. Given a task id, the requests that touched the task are
 * followed as well: every line under a request id found on the task's lines is shown, which brings in
 * the nginx line and the steps of each request that never repeat the task id.
 *
 * Where the id comes from: an `x-request-id` response header (Core returns it on every response), a
 * task event's trace_id, an outbox command's payload.requestId, or tg-<update_id> for a Telegram
 * update the poller handled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface StoredLine {
  /** When Docker received the line (UTC ISO), the order lines are shown in. */
  timestamp: string;
  service: string;
  container?: string;
  /** Core's and the worker's lines, parsed. */
  log?: Record<string, unknown>;
  /** Text lines (nginx, Restate). */
  message?: string;
  file: string;
}

export const DEFAULT_LOG_DIR = path.join(os.homedir(), '.hawa', 'logs', 'containers');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function tokenPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._:-])${escaped}(?![A-Za-z0-9._:-])`);
}

/** The day files to read, oldest first; `since` (YYYY-MM-DD) skips older days. */
export function logFiles(dir: string, since?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const days = fs.readdirSync(dir).filter((d) => DAY.test(d) && (!since || d >= since)).sort();
  const files: string[] = [];
  for (const day of days) {
    const dayDir = path.join(dir, day);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const name of fs.readdirSync(dayDir).sort()) if (name.endsWith('.ndjson')) files.push(path.join(dayDir, name));
  }
  return files;
}

async function scan(files: string[], keep: (raw: string) => boolean, visit: (line: StoredLine) => void): Promise<void> {
  for (const file of files) {
    const reader = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const raw of reader) {
      if (!raw || !keep(raw)) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { continue; }
      visit({
        timestamp: String(event.timestamp ?? ''),
        service: String(event.service ?? path.basename(file, '.ndjson')),
        container: typeof event.container_name === 'string' ? event.container_name : undefined,
        log: event.log && typeof event.log === 'object' ? (event.log as Record<string, unknown>) : undefined,
        message: typeof event.message === 'string' ? event.message : undefined,
        file,
      });
    }
  }
}

function requestIdOf(line: StoredLine): string | undefined {
  if (typeof line.log?.requestId === 'string') return line.log.requestId;
  const rid = line.message ? /\brid=([A-Za-z0-9._:-]+)/.exec(line.message)?.[1] : undefined;
  return rid && rid !== '-' ? rid : undefined;
}

/**
 * The lines that belong to `id`, in time order. With `follow` (the default), the request ids found on
 * those lines are followed too (see the header).
 */
export async function findRequestLines(dir: string, id: string, options: { since?: string; follow?: boolean } = {}): Promise<StoredLine[]> {
  const files = logFiles(dir, options.since);
  const direct = tokenPattern(id);
  const found: StoredLine[] = [];
  await scan(files, (raw) => raw.includes(id) && direct.test(raw), (line) => found.push(line));

  const requests = new Set<string>();
  if (options.follow !== false) for (const line of found) { const r = requestIdOf(line); if (r && r !== id) requests.add(r); }
  if (requests.size > 0) {
    const patterns = [...requests].map((r) => [r, tokenPattern(r)] as const);
    const seen = new Set(found.map((l) => `${l.file}\u0000${l.timestamp}\u0000${l.message ?? JSON.stringify(l.log)}`));
    await scan(
      files,
      (raw) => !direct.test(raw) && patterns.some(([r, p]) => raw.includes(r) && p.test(raw)),
      (line) => {
        const key = `${line.file}\u0000${line.timestamp}\u0000${line.message ?? JSON.stringify(line.log)}`;
        if (requests.has(requestIdOf(line) ?? '') && !seen.has(key)) found.push(line);
      }
    );
  }
  return found.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

const SHOWN_ELSEWHERE = new Set(['level', 'time', 'msg', 'service', 'requestId']);

/** One line for a person: time, service, level, request id, message, then the other fields. */
export function formatLine(line: StoredLine): string {
  const time = line.timestamp.replace('T', ' ').replace(/\.(\d{3})\d*Z$/, '.$1Z');
  if (!line.log) return `${time} ${line.service.padEnd(12)} ${line.message ?? ''}`;
  const { level, msg, requestId } = line.log as { level?: string; msg?: string; requestId?: string };
  const rest = Object.fromEntries(Object.entries(line.log).filter(([k]) => !SHOWN_ELSEWHERE.has(k)));
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${time} ${line.service.padEnd(12)} ${String(level ?? '').padEnd(5)} [${requestId ?? '-'}] ${msg ?? ''}${extra}`;
}

export async function runCli(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }
): Promise<number> {
  let id: string | undefined;
  let dir = process.env.HAWA_CONTAINER_LOGS_DIR || DEFAULT_LOG_DIR;
  let since: string | undefined;
  let json = false;
  let follow = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--no-follow') follow = false;
    else if (a === '--dir') dir = argv[++i] ?? '';
    else if (a === '--since') since = argv[++i];
    else if (!a.startsWith('--') && !id) id = a;
    else { io.err(`unknown argument: ${a}`); return 64; }
  }
  if (!id || id.length < 6) {
    io.err('usage: request_logs.ts <requestId|taskId> [--since YYYY-MM-DD] [--dir DIR] [--json] [--no-follow]');
    return 64;
  }
  if (since && !DAY.test(since)) { io.err('--since takes a day: YYYY-MM-DD'); return 64; }
  const files = logFiles(dir, since);
  if (files.length === 0) { io.err(`no log files under ${dir}`); return 2; }
  const lines = await findRequestLines(dir, id, { since, follow });
  for (const line of lines) {
    if (json) {
      const { file: _file, ...stored } = line;
      io.out(JSON.stringify(stored));
    } else io.out(formatLine(line));
  }
  const services = [...new Set(lines.map((l) => l.service))].sort();
  io.err(`${lines.length} line(s) for ${id} in ${files.length} file(s)${services.length ? `: ${services.join(', ')}` : ''}`);
  return lines.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
