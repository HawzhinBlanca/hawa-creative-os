/**
 * scripts/live_canary.ts (ADR-240): the nightly live canary of the Telegram request path.
 *
 * Plays a fixed conversation as the canary chat (HAWA_CANARY_CHAT_ID, an id no Telegram chat can have)
 * through production's real path: each line is a synthetic Telegram update handed to ChatInbox on
 * Restate's ingress under `tg-<update id>`, as the poller hands a real one. What the bot said is read
 * back from Restate's journal (TelegramSender invocations), and each request from its RequestLifecycle
 * object's state, through Restate's admin SQL. TelegramSender records everything for the canary chat,
 * and every office alert about its requests, instead of sending it (`canary_sink`); the canary checks
 * that first and stops if it is not so. Every request it opens ends withdrawn.
 *
 * Restate's ports are not published, so every call is made by node inside the Core container (as
 * deploy.sh's restate-bluegreen.ts does). Results: <out>/<stamp>.json and <stamp>.txt, and latest.*.
 *
 *   HAWA_CANARY_CHAT_ID=… HAWA_CANARY_CLIENT_ID=… HAWA_CANARY_CLIENT_NAME=… \
 *     node_modules/.bin/tsx scripts/live_canary.ts [--out ~/.hawa/logs/canary] [--container hawa-production-core-1]
 *
 * infra/ops/live_canary.sh runs it nightly (deploy lock, load, backup, alert). Exit 0 passed, 1 failed,
 * 2 could not run (configuration, Core or Restate unreachable).
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { containerFetch, type FetchLike } from './restate-bluegreen.js';
import {
  canaryConfigFromEnv, runCanary, summaryText,
  type BotMessage, type CanaryConfig, type CanaryResult, type CanaryWorld, type OpenDraft, type RequestView,
} from './live_canary_lib.js';

const DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOCATION_ID = /^inv_[0-9A-Za-z]+$/;
const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '');

/** Every string a journal entry carries: Restate writes payloads as byte arrays (sometimes base64). */
export function journalStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    if (value.length > 1 && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      out.push(Buffer.from(value as number[]).toString('utf8'));
    } else for (const v of value) journalStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) journalStrings(v, out);
  } else if (typeof value === 'string' && value.length > 1) {
    out.push(value);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (/^[[{"]/.test(decoded)) out.push(decoded);
    }
  }
  return out;
}

/** The JSON values among an entry's strings. */
export function journalJson(entryJson: unknown): unknown[] {
  const raw = typeof entryJson === 'string' ? (() => { try { return JSON.parse(entryJson); } catch { return entryJson; } })() : entryJson;
  return journalStrings(raw).flatMap((s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
}

const SEND_OUTCOMES = new Set(['canary_sink', 'sent', 'refused', 'uncertain']);

/** A TelegramSender invocation's message (its input) and how its send step answered. */
export function senderJournal(entries: Array<{ index: number; entry_json: unknown }>): { input: Record<string, any> | null; outcome: string | null } {
  const sorted = [...entries].sort((a, b) => Number(a.index) - Number(b.index));
  const input = (journalJson(sorted[0]?.entry_json).find((v: any) => typeof v?.key === 'string' && v?.chatId !== undefined) ?? null) as Record<string, any> | null;
  let outcome: string | null = null;
  for (const entry of sorted.slice(1)) {
    for (const v of journalJson(entry.entry_json) as any[]) if (typeof v?.outcome === 'string' && SEND_OUTCOMES.has(v.outcome)) outcome = v.outcome;
  }
  return { input, outcome };
}

export function restateWorld(config: CanaryConfig, fetcher: FetchLike, options: { admin?: string; ingress?: string; coreHealth?: string; hostFetch?: FetchLike } = {}): CanaryWorld {
  const admin = options.admin ?? 'http://restate:9070';
  const ingress = options.ingress ?? 'http://restate:8080';
  const chat = config.chatId;
  if (!DIGITS.test(chat)) throw new Error('the canary chat id is not a number');
  const query = async <T = Record<string, any>>(sql: string): Promise<T[]> => {
    const res = await fetcher(`${admin}/query`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: sql }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Restate query answered ${res.status}: ${text.slice(0, 200)}`);
    return (JSON.parse(text).rows ?? []) as T[];
  };
  const journal = (id: string) => {
    if (!INVOCATION_ID.test(id)) throw new Error(`not an invocation id: ${id}`);
    return query<{ index: number; entry_json: unknown }>(`SELECT index, entry_json FROM sys_journal WHERE id = '${id}' ORDER BY index`);
  };
  const finished = new Map<string, BotMessage>();
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async health() {
      try {
        const res = await (options.hostFetch ?? fetch)(options.coreHealth ?? 'http://127.0.0.1:8080/v1/health');
        if (!res.ok) return `Core health answered ${res.status}`;
        await query('SELECT count(*) AS n FROM sys_deployment');
        return null;
      } catch (error) {
        return `Core or Restate does not answer: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    async send(updateId, messageId, text) {
      const id = Number(chat);
      const message = { message_id: messageId, from: { id, is_bot: false, first_name: 'Canary', language_code: 'en' },
        chat: { id, type: 'private', first_name: 'Canary' }, date: Math.floor(Date.now() / 1000), text };
      const key = `tg-${updateId}`;
      const res = await fetcher(`${ingress}/ChatInbox/${chat}/handleUpdate/send`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-request-id': key },
        body: JSON.stringify({ v: 1, update: { update_id: updateId, message } }) });
      if (res.status >= 300) throw new Error(`Restate ingress refused update ${updateId}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
    async inboxDone(updateId, sentAtMs) {
      const where = `target_service_name = 'ChatInbox' AND target_service_key = '${chat}' AND target_handler_name = 'handleUpdate'`;
      const rows = await query<{ status: string }>(`SELECT status FROM sys_invocation WHERE ${where} AND idempotency_key = 'tg-${Number(updateId)}'`)
        // A Restate without the column: every update of the chat since this one was sent has finished.
        .catch(() => query<{ status: string }>(`SELECT status FROM sys_invocation WHERE ${where} AND created_at >= '${iso(sentAtMs - 2000)}'`));
      return rows.length > 0 && rows.every((r) => r.status === 'completed');
    },
    async botMessages(sinceMs) {
      const rows = await query<{ id: string; chat: string; created_at: string; status: string }>(`SELECT id, target_service_key AS chat, created_at, status
        FROM sys_invocation WHERE target_service_name = 'TelegramSender' AND created_at >= '${iso(sinceMs - 2000)}' ORDER BY created_at`);
      const out: BotMessage[] = [];
      for (const row of rows) {
        const known = finished.get(row.id);
        if (known) { out.push(known); continue; }
        const { input, outcome } = senderJournal(await journal(row.id));
        const message: BotMessage = { invocationId: row.id, chatId: String(row.chat), createdAtMs: Date.parse(`${String(row.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')}`),
          key: String(input?.key ?? ''), kind: String(input?.kind ?? ''), text: String(input?.text ?? input?.caption ?? ''),
          ...(typeof input?.taskId === 'string' ? { taskId: input.taskId } : {}),
          ...(typeof input?.canaryFor === 'string' ? { canaryFor: input.canaryFor } : {}),
          outcome: (outcome as BotMessage['outcome']) ?? (row.status === 'completed' ? 'unknown' : 'pending') };
        if (row.status === 'completed') finished.set(row.id, message);
        out.push(message);
      }
      return out;
    },
    async canaryRequests() {
      const rows = await query<{ service_key: string; value_utf8: string }>(`SELECT service_key, value_utf8 FROM state
        WHERE service_name = 'RequestLifecycle' AND key = 'lc' AND value_utf8 LIKE '%"chatId":"${chat}"%'`);
      return rows.flatMap((row): RequestView[] => {
        try {
          const s = JSON.parse(row.value_utf8);
          if (String(s?.chatId) !== chat || !UUID.test(String(row.service_key))) return [];
          return [{ requestId: row.service_key, chatId: chat, stage: String(s.stage), rev: Number(s.rev), taskId: String(s.taskId),
            ...(typeof s.title === 'string' ? { title: s.title } : {}) }];
        } catch { return []; }
      });
    },
    async openDraft(requestId): Promise<OpenDraft | null> {
      if (!UUID.test(requestId)) return null;
      const [open] = await query<{ id: string }>(`SELECT id FROM sys_invocation WHERE target_service_name = 'RequestLifecycle'
        AND target_service_key = '${requestId}' AND target_handler_name = 'open' ORDER BY created_at LIMIT 1`);
      if (!open) return null;
      const entries = await journal(open.id);
      const first = [...entries].sort((a, b) => Number(a.index) - Number(b.index))[0];
      const event = journalJson(first?.entry_json).find((v: any) => v?.draft && typeof v.draft === 'object') as { draft: Record<string, any> } | undefined;
      if (!event) return null;
      const d = event.draft;
      return { clientId: typeof d.clientId === 'string' ? d.clientId : null, title: String(d.title ?? ''), rawText: String(d.rawText ?? ''),
        exactCopy: Array.isArray(d.exactCopy) ? d.exactCopy : [], ...(typeof d.headlineEn === 'string' ? { headlineEn: d.headlineEn } : {}),
        ...(typeof d.copyExtraction?.method === 'string' ? { copyMethod: d.copyExtraction.method } : {}) };
    },
    async designSpend(taskId) {
      if (!UUID.test(taskId)) return null;
      const runs = await query<{ id: string }>(`SELECT id FROM sys_invocation WHERE target_service_name = 'DesignRun' AND target_service_key LIKE 'dr-${taskId}%'`);
      let spent: number | null = null;
      for (const run of runs) {
        for (const text of (await journal(run.id)).flatMap((e) => journalStrings(e.entry_json))) {
          for (const m of text.matchAll(/"spentUsd"\s*:\s*([0-9.]+)/g)) spent = Math.max(spent ?? 0, Number(m[1]));
        }
      }
      return spent;
    },
  };
}

function writeResult(out: string, stamp: string, result: CanaryResult): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const put = (name: string, body: string) => { const tmp = path.join(out, `.${name}.tmp`); writeFileSync(tmp, body, { mode: 0o600 }); renameSync(tmp, path.join(out, name)); };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const text = summaryText(result);
  put(`${stamp}.json`, json); put(`${stamp}.txt`, text);
  put('latest.json', json); put('latest.txt', text);
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const out = flag('out', process.env.HAWA_CANARY_OUT_DIR || path.join(os.homedir(), '.hawa', 'logs', 'canary'));
  const stamp = flag('stamp', new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
  const container = flag('container', process.env.HAWA_CANARY_CONTAINER || 'hawa-production-core-1');
  const { config, problems } = canaryConfigFromEnv(process.env);
  const at = new Date().toISOString();
  if (!config) {
    const result: CanaryResult = { v: 1, status: 'error', startedAt: at, finishedAt: at, mode: 'unknown', checks: [], requests: [], spentUsd: null,
      reason: `not configured: ${problems.join('; ')}` };
    writeResult(out, stamp, result);
    process.stdout.write(summaryText(result));
    return 2;
  }
  const result = await runCanary(restateWorld(config, containerFetch(container, undefined, 60_000)), config);
  writeResult(out, stamp, result);
  process.stdout.write(summaryText(result));
  return result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error); process.exit(2); });
}
