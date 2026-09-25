import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startFakes, type Fakes } from '../fakes/server.ts';
import { plannerLayout } from '../fakes/models.ts';
import { chaosPoint } from '../../../observability/src/chaos-point.js';

/**
 * The fakes run in-process here, on ephemeral ports. Calls to the provider hosts go over TLS to
 * 127.0.0.1 with the host's name, trusting only the fakes' CA: what Core and the workers do inside
 * the chaos project, where extra_hosts sends those names to the fakes container.
 */
let fakes: Fakes;
let httpBase: string;
let httpsPort: number;

type Answer = { status: number; json: any; error?: string };
function provider(host: string, path: string, init: { method?: string; body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port: httpsPort, servername: host, ca: fakes.caPem, path, method: init.method || 'GET', headers: { host, ...init.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, json: null, error: err.message }));
    if (init.body) req.write(init.body);
    req.end();
  });
}
const tg = (method: string, body?: unknown) =>
  provider('api.telegram.org', `/bot123:chaos/${method}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const admin = async (path: string, body?: unknown) => {
  const res = await fetch(`${httpBase}/__fakes${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json() as Promise<any>;
};

beforeAll(async () => {
  fakes = await startFakes({ httpPort: 0, httpsPort: 0, host: '127.0.0.1' });
  httpBase = `http://127.0.0.1:${(fakes.http.address() as AddressInfo).port}`;
  httpsPort = (fakes.https.address() as AddressInfo).port;
});
afterAll(async () => fakes?.close());

describe('fake Telegram', () => {
  it('hands out scripted updates until the bot confirms them with a higher offset', async () => {
    await admin('/reset', {});
    const { updateIds } = await admin('/telegram/updates', { updates: [{ message: { message_id: 1, chat: { id: 91 }, text: 'a' } }, { message: { message_id: 2, chat: { id: 92 }, text: 'b' } }] });
    const first = await tg('getUpdates?offset=0&timeout=0');
    expect(first.json.result.map((u: any) => u.update_id)).toEqual(updateIds);
    const second = await tg(`getUpdates?offset=${updateIds[0] + 1}&timeout=0`);
    expect(second.json.result.map((u: any) => u.update_id)).toEqual([updateIds[1]]);
    const third = await tg(`getUpdates?offset=${updateIds[1] + 1}&timeout=0`);
    expect(third.json.result).toEqual([]);
  });

  it('logs every send with a text hash, answers a 429 with retry_after, and can drop the answer after delivering', async () => {
    await admin('/reset', {});
    await admin('/telegram/faults', { method: 'sendMessage', chat: '91', kind: '429', n: 1, retryAfter: 3 });
    await admin('/telegram/faults', { method: 'sendMessage', chat: '92', kind: 'drop-after-processing', n: 1 });
    const limited = await tg('sendMessage', { chat_id: 91, text: 'draft ready' });
    expect(limited.status).toBe(429);
    expect(limited.json.parameters.retry_after).toBe(3);
    const ok = await tg('sendMessage', { chat_id: 91, text: 'draft ready' });
    expect(ok.json.ok).toBe(true);
    expect(ok.json.result.chat.id).toBe(91);
    const dropped = await tg('sendMessage', { chat_id: 92, text: 'delivered' });
    expect(dropped.status).toBe(0);
    const { sent } = await admin('/telegram/sent');
    expect(sent.map((s: any) => [s.chat_id, s.fault, s.delivered])).toEqual([
      ['91', '429', false],
      ['91', null, true],
      ['92', 'drop-after-processing', true],
    ]);
    expect(sent[0].textHash).toBe(crypto.createHash('sha256').update('draft ready').digest('hex'));
  });

  it('records uploaded documents by content hash', async () => {
    await admin('/reset', {});
    const form = new FormData();
    form.append('chat_id', '91');
    form.append('document', new Blob([new Uint8Array([1, 2, 3])]), 'design.pdf');
    const encoded = new Response(form);
    const body = Buffer.from(await encoded.arrayBuffer());
    const res = await provider('api.telegram.org', '/bot1:x/sendDocument', { method: 'POST', body, headers: { 'content-type': encoded.headers.get('content-type')! } });
    expect(res.json.ok).toBe(true);
    const { sent } = await admin('/telegram/sent');
    expect(sent[0]).toMatchObject({ method: 'sendDocument', chat_id: '91', fileName: 'design.pdf', documentSha256: crypto.createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex') });
  });

  it('serves a file of the configured size after the configured delay', async () => {
    await admin('/reset', {});
    await admin('/telegram/files', { file_id: 'big', size: 2_000_000, mime: 'image/jpeg', delayMs: 300 });
    const meta = await tg('getFile?file_id=big');
    expect(meta.json.result.file_size).toBe(2_000_000);
    const started = Date.now();
    const res = await new Promise<{ status: number; bytes: number; head: string }>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: httpsPort, servername: 'api.telegram.org', ca: fakes.caPem, path: `/file/bot1:x/${meta.json.result.file_path}`, headers: { host: 'api.telegram.org' } }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: r.statusCode || 0, bytes: b.length, head: b.subarray(0, 3).toString('hex') }); });
      }).on('error', reject);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(res).toEqual({ status: 200, bytes: 2_000_000, head: 'ffd8ff' });
  });
});

describe('fake models and the paid-call ledger', () => {
  const chat = (schema: string | null, user: string, extra: Record<string, unknown> = {}) =>
    provider('api.openai.com', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: user }], ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema } } } : {}), ...extra }),
    });

  it('answers the intake classifier from fixtures and counts each fingerprint', async () => {
    await admin('/reset', {});
    const brief = await chat('telegram_classifier', 'Incoming message: KAAE ceremony');
    expect(JSON.parse(brief.json.choices[0].message.content).kind).toBe('new_brief');
    expect(brief.json.model).toBe('gpt-test');
    const change = await chat('telegram_classifier', 'please make the logo bigger');
    expect(JSON.parse(change.json.choices[0].message.content).kind).toBe('feedback');
    await chat('telegram_classifier', 'please make the logo bigger');
    const { paid } = await admin('/models/ledger');
    expect(Object.values(paid).map((p: any) => p.n).sort()).toEqual([1, 2]);
  });

  it('refuses, and records as unmatched, a call no fixture covers', async () => {
    await admin('/reset', {});
    const res = await chat('studio_layout_v3', 'x');
    expect(res.status).toBe(500);
    const gemini = await provider('generativelanguage.googleapis.com', '/v1beta/models/gemini:generateContent', { method: 'POST', body: '{}' });
    expect(gemini.status).toBe(500);
    const { ledger } = await admin('/models/ledger');
    expect(ledger.map((l: any) => l.route)).toEqual(['unmatched', 'unmatched:/v1beta/models/gemini:generateContent']);
  });

  it('answers the planner for a revision, whose request follows "Design Brief:" (slice 2.3 change rounds)', async () => {
    await admin('/reset', {});
    const request = { width: 1080, height: 1350, copy: ['Title', 'Body'], copyScripts: ['latin', 'latin'], logoAspect: 1.37, formalBodyFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' }, reference: { rules: { palette: ['#0A1628'] } } };
    const res = await chat('canva_design_plan', `Design Brief:\n${JSON.stringify(request)}\n\nOperator Revision Directive: "make the logo bigger"\n\nRule: Change what the feedback asks; keep copy and brand.`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.json.choices[0].message.content).text.map((t: any) => t.copyIndex)).toEqual([0, 1]);
    const { ledger } = await admin('/models/ledger');
    expect(ledger.map((l: any) => l.route)).toEqual(['canva_design_plan']);
  });

  it('builds a planner layout that places every copy block once, at the logo aspect Core checks', () => {
    const plan: any = plannerLayout({ width: 1080, height: 1350, copy: ['Title', 'Body one', 'Body two'], copyScripts: ['latin', 'latin', 'latin'], logoAspect: 1.37, formalBodyFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' }, reference: { rules: { palette: ['#0A1628', '#FDF8F3'] } } });
    expect(plan.text.map((t: any) => t.copyIndex)).toEqual([0, 1, 2]);
    expect(Math.abs(plan.logo.width / plan.logo.height - 1.37) / 1.37).toBeLessThan(0.01);
    expect(plan.logo.width).toBeGreaterThanOrEqual(100);
    for (const t of plan.text) expect(t.y + t.height).toBeLessThanOrEqual(1350);
  });
});

describe('fake Canva', () => {
  it('imports a deck, exports it back as the same PPTX bytes from the admitted download host, and ledgers each creation', async () => {
    await admin('/reset', {});
    const deck = Buffer.from('PK\u0003\u0004 chaos deck bytes that are longer than thirty-two bytes');
    const created = await fetch(`${httpBase}/canva/rest/v1/imports`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'import-metadata': JSON.stringify({ title_base64: Buffer.from('t').toString('base64') }) }, body: deck }).then((r) => r.json() as Promise<any>);
    const job = await fetch(`${httpBase}/canva/rest/v1/imports/${created.job.id}`).then((r) => r.json() as Promise<any>);
    const designId = job.job.result.designs[0].id;
    expect(designId).toMatch(/^DA[A-Za-z0-9_-]+$/);
    const exp = await fetch(`${httpBase}/canva/rest/v1/exports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ design_id: designId, format: { type: 'pptx' } }) }).then((r) => r.json() as Promise<any>);
    const done = await fetch(`${httpBase}/canva/rest/v1/exports/${exp.job.id}`).then((r) => r.json() as Promise<any>);
    const url = new URL(done.job.urls[0]);
    expect(url.hostname).toBe('export-download.canva.com');
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: httpsPort, servername: url.hostname, ca: fakes.caPem, path: url.pathname, headers: { host: url.hostname } }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    expect(bytes.equals(deck)).toBe(true);
    const { ledger } = await admin('/canva/ledger');
    expect(ledger.map((l: any) => l.kind)).toEqual(['import', 'export', 'download']);
  });

  it('answers 5xx and 429 faults on the paths they name, then recovers', async () => {
    await admin('/reset', {});
    await admin('/canva/faults', { method: 'POST', path: '^/exports$', kind: '5xx', n: 2 });
    await admin('/canva/faults', { method: 'POST', path: '^/exports$', kind: '429', n: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${httpBase}/canva/rest/v1/exports`, { method: 'POST', body: '{"design_id":"none"}' })).status);
    expect(statuses).toEqual([503, 503, 429, 404]);
  });
});

describe('chaos control with chaosPoint()', () => {
  it('lets a point pass when nothing is armed, and holds an armed one until released', async () => {
    await admin('/reset', {});
    vi.stubEnv('HAWA_CHAOS_CONTROL_URL', `${httpBase}/__chaos`);
    vi.stubEnv('HAWA_CHAOS_SERVICE', 'worker-blue');
    try {
      await chaosPoint('worker.outbox.after-claim', { commandType: 'task.created' });
      await fetch(`${httpBase}/__chaos/hold`, { method: 'POST', body: JSON.stringify({ point: 'worker.step.after-action', match: { step: 'canva-create' } }) });
      // A different step passes; the armed one is held.
      await chaosPoint('worker.step.after-action', { step: 'canva-verify-task-scope' });
      let passed = false;
      const held = chaosPoint('worker.step.after-action', { step: 'canva-create-draft' }).then(() => { passed = true; });
      const reached = await fetch(`${httpBase}/__chaos/wait?point=worker.step.after-action&timeoutMs=5000`).then((r) => r.json() as Promise<any>);
      expect(reached).toMatchObject({ point: 'worker.step.after-action', service: 'worker-blue', held: true, detail: { step: 'canva-create-draft' } });
      expect(passed).toBe(false);
      await fetch(`${httpBase}/__chaos/release`, { method: 'POST', body: '{}' });
      await held;
      expect(passed).toBe(true);
      const { reached: log } = await fetch(`${httpBase}/__chaos/reached`).then((r) => r.json() as Promise<any>);
      expect(log.map((r: any) => [r.point, r.held])).toEqual([
        ['worker.outbox.after-claim', false],
        ['worker.step.after-action', false],
        ['worker.step.after-action', true],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
