/**
 * ADR-170 live trial: the owner's KAAE K-12 field-visit brief, with its six album photos, through the
 * production path of a photo brief — Telegram album intake, the lifecycle projection, then
 * DesignStudioService on pipeline v3 with the real OpenAI provider and resolveModel() on the
 * production tier — against a throwaway clone of the test template database on hawa-test-postgres
 * (127.0.0.1:55432). Nothing reaches production: no production database, no Canva (the service has
 * no Canva connection, and the loop stops when the run is ready to transfer), no Telegram.
 *
 * The OpenAI key is read in-process from the production env file and handed only to the Studio's
 * fetcher; it is never put in process.env, printed or written. Every outbound request other than
 * that fetcher's OpenAI calls is refused. Each call's usage and cost are recorded, and the trial
 * stops before a call that could take the session over its cap, at the first 429 or other 4xx
 * refusal, and after three 5xx answers.
 *
 *   npx tsx scripts/art_direction_live_trial.ts --task <task.json> --photos <dir> --out <dir>
 *     --runs full,full,cut [--first 1] [--cap 4] [--spent 0] [--cutout-url http://127.0.0.1:<port>]
 *     [--dry [--dry-concepts <concepts.json>]]
 *
 * `--task` is the saved answer of a read-only GET of task ba4469f2 (its copyEn is the caption);
 * `--photos` holds the album as photo0.jpg … photo5.jpg. `full` is the caption with its last sentence
 * completed, `cut` the caption as Telegram delivered it (intake then asks for the rest and, with no
 * answer, opens without the unfinished sentence, ADR-160). `--spent` carries the spend of earlier
 * sessions into the cap. `--dry` answers every model call with a canned reply and needs no key;
 * `--dry-concepts` replays a live run's concepts through today's solver. Each run writes its
 * candidates (labelled by recipe), winner, judge verdicts, QA, receipts and a local transfer PPTX.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createDb, sql } from '../packages/db/dist/index.js';
import { assertTestDatabaseEnv } from '../packages/db/src/test-database-guard.js';
import { cloneTemplate, dropClone, ensureTemplates, withDatabase } from '../packages/db/src/test-template.js';

const ROOT = resolve(import.meta.dirname, '..');
const PRICING = createRequire(import.meta.url)('../packages/creative/src/studio/pricing.json') as {
  models: Record<string, { inputPerMillion?: number; outputPerMillion?: number; cacheReadPerMillion?: number }>;
};

// ---------- arguments ----------
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const OUT = resolve(arg('out') || join(ROOT, 'output/art-direction-live-trial'));
const RUNS = (arg('runs', 'full,full,cut') as string).split(',').map((s) => s.trim()).filter(Boolean);
const CAP = Number(arg('cap', '4'));
const PRIOR_SPENT = Number(arg('spent', '0'));
const FIRST = Number(arg('first', '1'));
const DRY = process.argv.includes('--dry');
if (!arg('photos')) throw new Error('--photos <folder with the album as photo0.jpg … photo5.jpg> is required (client photos are never committed)');
const PHOTO_DIR = resolve(arg('photos')!);
const TASK_JSON = arg('task');
for (const r of RUNS) if (r !== 'full' && r !== 'cut') throw new Error(`--runs takes full or cut, not '${r}'`);

// ---------- the brief ----------
/** Task ba4469f2's copyEn exactly (fetched read-only with GET /v1/tasks/ba4469f2-…), when --task names the saved JSON. */
function caption(variant: 'full' | 'cut'): string {
  let cut: string;
  if (TASK_JSON) cut = JSON.parse(readFileSync(TASK_JSON, 'utf8')).copyEn;
  else throw new Error('--task <saved GET /v1/tasks/ba4469f2… JSON> is required');
  if (!cut.endsWith('next steps toward')) throw new Error('The saved caption no longer ends where Telegram cut it.');
  return variant === 'cut' ? cut : `${cut} education quality improvement.`;
}

// ---------- environment: no key in process.env, no production target ----------
for (const k of Object.keys(process.env)) if (/(_API_KEY|_TOKEN|_SECRET)$/.test(k)) delete process.env[k];

function readProductionKey(): string {
  const file = join(homedir(), '.hawa/shared/infra/docker/.env.production');
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('OPENAI_API_KEY='));
  const value = line?.slice('OPENAI_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '');
  if (!value) throw new Error('OPENAI_API_KEY is not in the production env file');
  return value;
}
const API_KEY = DRY ? 'dry-run' : readProductionKey();

function testDbEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env.test'), 'utf8').split('\n')) {
    const m = /^(TEST_DATABASE_URL|TEST_DATABASE_OWNER_URL)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  if (!out.TEST_DATABASE_URL || !out.TEST_DATABASE_OWNER_URL) throw new Error('.env.test lacks the test database URLs');
  assertTestDatabaseEnv(out);
  return out;
}

const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const BLOB_DIR = join(OUT, '_blobs');
mkdirSync(join(BLOB_DIR, 'sha256'), { recursive: true });
mkdirSync(join(BLOB_DIR, 'tmp'), { recursive: true });
writeFileSync(join(BLOB_DIR, '.hawa-blob-store'), 'sha256-v1\n');
const WORKER_TOKEN = `trial_${randomUUID().replace(/-/g, '')}`;
Object.assign(process.env, {
  HAWA_MODEL_TIER: 'production',
  // Production's switches (infra/docker/.env.production): v3 for the owner's pilot chats only.
  DESIGN_PIPELINE_V3: 'off',
  DESIGN_STUDIO_V2: 'off',
  DESIGN_PIPELINE_V3_CHATS: '7191500129,450405554',
  AUTO_GENERATE_CHAT_DESIGNS: 'true',
  AUTO_GENERATE_DAILY_CAP_GLOBAL: '100000',
  AUTO_GENERATE_DAILY_CAP_PER_SENDER: '10000',
  HAWA_WORKER_TOKEN: WORKER_TOKEN,
  // Throwaway values the app needs to start, as vitest.config.ts sets them; none is a real secret.
  HAWA_ACTION_HMAC_SECRET: `trial_${randomUUID()}`,
  TELEGRAM_WEBHOOK_SECRET: `trial_${randomUUID()}`,
  HAWA_BEARER_TOKEN: `trial_${randomUUID()}`,
  HAWA_ADMIN_KEY: `trial_${randomUUID()}`,
  HAWA_SPEND_STATE_DIR: join(OUT, '_spend'),
  HAWA_BLOB_DIR: BLOB_DIR,
  HAWA_EMULATE_PUBLISHER: 'true',
  // The face detector and cut-out service production runs beside Core (compose `cutout`), as a
  // separate local container of the same image: `--cutout-url http://127.0.0.1:<port>`. Without it
  // the recipes crop on measured detail instead of faces, and no photo is cut-out ready.
  ...(arg('cutout-url') ? { CUTOUT_URL: arg('cutout-url') } : {}),
  LOG_LEVEL: 'warn',
});

// ---------- outbound guard and receipts ----------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) return realFetch(input, init);
  throw new Error(`trial guard: outbound request to ${new URL(url).host} refused (only the Studio's OpenAI fetcher may leave)`);
}) as typeof fetch;

type Receipt = {
  run: number; at: string; path: string; model: string; schema: string; status: number; ms: number;
  inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; usd: number; images: number;
};
const receipts: Receipt[] = [];
let spent = PRIOR_SPENT;
let stop: string | null = null;
let fiveXX = 0;
let currentRun = 0;

const price = (model: string, input: number, cached: number, output: number) => {
  const p = PRICING.models[model];
  if (!p) throw new Error(`no price for ${model}`);
  return ((input - cached) * (p.inputPerMillion ?? 0) + cached * (p.cacheReadPerMillion ?? p.inputPerMillion ?? 0) + output * (p.outputPerMillion ?? 0)) / 1e6;
};

/** What one call could cost at most, taken before it is sent. */
/**
 * What one call could cost at most, taken before it is sent: its output cap at the output price and
 * 40,000 input tokens (the largest request seen was ~12,000 with six photos) at the input price.
 */
const reserveFor = (model: string, body: any) => {
  const p = PRICING.models[model];
  if (!p) return Infinity;
  const maxOut = Number(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 16000);
  return (maxOut * (p.outputPerMillion ?? 0) + 40000 * (p.inputPerMillion ?? 0)) / 1e6;
};

const studioFetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith('https://api.openai.com/')) throw new Error(`trial guard: Studio fetch to ${new URL(url).host} refused`);
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const model = String(body.model || '');
  const schema = String(body.response_format?.json_schema?.name || body.text?.format?.name || 'none');
  const images = (String(init?.body || '').match(/"image_url"/g) || []).length;
  if (stop) throw new Error(`trial stopped: ${stop}`);
  const counting = path.endsWith('/input_tokens');
  if (!counting && spent + reserveFor(model, body) > CAP) {
    stop = `cap: $${spent.toFixed(4)} spent, a ${model} call could take it over $${CAP}`;
    throw new Error(`trial stopped: ${stop}`);
  }
  const started = Date.now();
  if (DRY) return dryReply(path, body, schema, images);
  const res = await realFetch(input, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${API_KEY}` } });
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.clone().text().catch(() => '');
    const snippet = text.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…').slice(0, 300);
    receipts.push({ run: currentRun, at: new Date().toISOString(), path, model, schema, status: res.status, ms, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0, images });
    if (res.status >= 500) { if (++fiveXX >= 3) stop = `three 5xx answers (last ${res.status}: ${snippet})`; }
    else stop = `provider refused (${res.status}): ${snippet}`;
    console.error(`[trial] ${model} ${schema} -> HTTP ${res.status}: ${snippet}`);
    return res;
  }
  if (!counting) {
    const json: any = await res.clone().json().catch(() => ({}));
    const u = json.usage || {};
    const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0);
    const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
    const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0);
    const usd = price(json.model && PRICING.models[json.model] ? json.model : model, input, cached, output);
    spent += usd;
    receipts.push({ run: currentRun, at: new Date().toISOString(), path, model: json.model || model, schema, status: res.status, ms,
      inputTokens: input, cachedTokens: cached, outputTokens: output, reasoningTokens: reasoning, usd, images });
    console.log(`[trial] run ${currentRun} ${schema.padEnd(28)} ${String(json.model || model).padEnd(16)} in ${input} (cached ${cached}) out ${output} (reasoning ${reasoning}) $${usd.toFixed(4)} ${ms}ms — session $${spent.toFixed(4)}`);
  }
  return res;
}) as typeof fetch;

// ---------- dry-run replies (plumbing only; no model) ----------
function dryReply(path: string, body: any, schema: string, images: number): Response {
  if (path.endsWith('/input_tokens')) return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 12000 }), { status: 200 });
  const text = JSON.stringify(body.messages);
  const copyCount = (text.match(/\[Index \d+ - /g) || []).length || (text.match(/- Block \d+ \[role/g) || []).length || 3;
  let data: any = {};
  if (schema === 'CreativeBrief') {
    data = {
      occasion: 'report release', audience: 'education stakeholders', formality: 5, toneWords: ['formal'],
      readingOrder: Array.from({ length: copyCount }, (_, i) => i),
      roles: Array.from({ length: copyCount }, (_, i) => ({ copyIndex: i, role: i === 0 ? 'title' : i === 1 ? 'subtitle' : 'body', importance: 5 - Math.min(i, 3) })),
      must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: '', kurdishLeads: false, riskFlags: [], referenceRole: 'none', referenceNotes: '',
      imageRoles: Array.from({ length: images }, (_, index) => ({ index, role: 'content_photo', notes: '', subjectFit: 4, shot: 'classroom_or_interior', quietArea: 'none' })),
      subjectTags: ['report_release'],
    };
  } else if (schema === 'art_direction_concepts') {
    const c = (id: string, recipe: string, hero: number, texture: number | null) => ({ id, conceptNote: id, recipe, typicality: 0.5,
      heroPhotoIndex: hero, texturePhotoIndex: texture, cutoutPhotoIndex: null, slots: [], titleAccentWords: null,
      fadeShare: null, surfaceTone: 'navy', frame: 'inset', align: 'start' });
    // --dry-concepts replays a live run's concepts (recipe, photos, slots) through today's solver, free.
    data = arg('dry-concepts') ? JSON.parse(readFileSync(resolve(arg('dry-concepts')!), 'utf8'))
      : { concepts: [c('fade', 'hero_fade_report', 0, 4), c('scrim', 'scrim_caption', 5, null), c('card', 'hero_card', 3, null)] };
  } else {
    const dims = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility', 'art_direction'];
    data = { dimensions: Object.fromEntries(dims.map((d) => [d, { winner: 'A', rationale: 'dry' }])), majorityWinner: 'A', summary: 'A', overallAssessment: 'dry', comments: [] };
  }
  return new Response(JSON.stringify({ id: `dry-${randomUUID()}`, model: body.model, choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200, headers: { 'x-request-id': 'dry' } });
}

// ---------- one run ----------
const TENANT = '00000000-0000-4000-a000-000000000001';
const ACTOR = '00000000-0000-4000-b000-000000000001';
const OWNER_CHAT = 7191500129;
const SETTLED = ['transferring', 'awaiting_selection', 'transferred', 'failed', 'degraded', 'abandoned'];

async function oneRun(n: number, variant: 'full' | 'cut', env: Record<string, string>, templates: { test: string }) {
  const clone = `hawa_t_adtrial_${STAMP}_${n}`;
  await cloneTemplate(env.TEST_DATABASE_OWNER_URL, templates.test, clone);
  const appUrl = withDatabase(env.TEST_DATABASE_URL, clone);
  const ownerUrl = withDatabase(env.TEST_DATABASE_OWNER_URL, clone);
  const db = createDb(appUrl);
  const owner = createDb(ownerUrl);
  const dir = join(OUT, `run${n}`);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  currentRun = n;
  try {
    const { createApp } = await import('../apps/core/src/app.js');
    const { DesignStudioService } = await import('../apps/core/src/services/design-studio/design-studio-service.js');
    const photos = [0, 1, 2, 3, 4, 5].map((i) => readFileSync(join(PHOTO_DIR, `photo${i}.jpg`)));
    const text = caption(variant);
    // ---- Telegram album intake, as the sweep and settle calls deliver it ----
    const app = createApp({ db, telegramBridge: {
      downloadFile: async (file: string) => photos[Number(file)],
      dispatchOutboundMessage: async () => ({ success: true }),
    } } as any);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER_TOKEN}` };
    let update = 800_000_000 + n * 100;
    const from = { id: 91000029, first_name: 'Owner' };
    const part = (i: number) => ({ update_id: ++update, message: { message_id: 500 + i, date: Math.floor(Date.now() / 1000), from,
      chat: { id: OWNER_CHAT, type: 'private' }, media_group_id: `trial-${STAMP}-${n}`, photo: [{ file_id: String(i) }], ...(i === 0 ? { caption: text } : {}) } });
    const intake = async (u: unknown, extra: Record<string, unknown> = {}) => {
      const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers, body: JSON.stringify({ v: 1, mode: 'legacy', update: u, languageSiblings: true, ...extra }) });
      if (res.status !== 200) throw new Error(`intake ${res.status}: ${await res.text()}`);
      return res.json() as Promise<any>;
    };
    const parts = [0, 1, 2, 3, 4, 5].map(part);
    for (const p of parts) await intake(p, { briefHold: true });
    let opened = await intake(parts[5], { settle: true, briefHold: true });
    if (opened.lifecycleAction === 'settle-later') {
      // A caption Telegram cut short: intake asks the sender for the rest and holds the album. The
      // sender never answers here, so the hold runs out as the worker's sweep finds it overdue.
      writeFileSync(join(dir, 'intake_hold.json'), JSON.stringify(opened, null, 2));
      console.log(`[trial] run ${n}: intake held the album (${opened.notice?.text ?? 'no notice'}); letting the hold expire`);
      await sql`UPDATE hawa.inbox_events SET received_at = received_at - interval '15 minutes'
        WHERE tenant_id = ${TENANT}::uuid AND payload->>'chatId' = ${String(OWNER_CHAT)}
          AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_brief_held', 'lifecycle_album_cut')`.execute(owner);
      const swept = await app.request('/v1/internal/telegram/settle-sweep', { method: 'POST', headers, body: JSON.stringify({ v: 1 }) });
      const due = (((await swept.json()) as any).due || []).filter((d: any) => d.chatId === String(OWNER_CHAT));
      if (!due.length) throw new Error('the held album was not due after its hold');
      opened = await intake(due[0].update, { settle: true, briefHold: true });
    }
    if (opened.lifecycleAction !== 'open-request') throw new Error(`album did not open a request: ${JSON.stringify(opened).slice(0, 400)}`);
    const projected = await app.request(`/v1/internal/lifecycle/${opened.requestId}/project`, { method: 'POST', headers,
      body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${opened.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: opened.draft }] }) });
    if (projected.status !== 200) throw new Error(`projection ${projected.status}: ${await projected.text()}`);
    const taskId = String(((await projected.json()) as any).taskId);

    // ---- the Studio, as the worker drives it, until the run is ready for Canva ----
    const service = new DesignStudioService(db, undefined, { apiKey: API_KEY, fetcher: studioFetch });
    const scope = { tenantId: TENANT, actorId: ACTOR };
    const { run } = await service.createOrGetRun(scope, taskId, `trial-${STAMP}-${n}`, { width: 1080, height: 1350 });
    let result: any = { status: run.status };
    const trail: any[] = [];
    for (let i = 0; i < 30 && !SETTLED.includes(result.status); i++) {
      result = await service.resume(scope, taskId, run.id);
      trail.push({ at: Date.now() - started, status: result.status, stage: result.stage, spentUsd: result.spentUsd, diagnostic: result.diagnostic });
      console.log(`[trial] run ${n} -> ${result.status}${result.stage ? ` (${result.stage})` : ''}${result.diagnostic ? `: ${String(result.diagnostic).slice(0, 200)}` : ''}`);
      if (stop) break;
    }
    const wallMs = Date.now() - started;
    await collect(n, variant, dir, owner, run.id, taskId, text, trail, wallMs, photos);
  } finally {
    await db.destroy();
    await owner.destroy();
    if (process.env.KEEP_TRIAL_DB !== '1') await dropClone(env.TEST_DATABASE_OWNER_URL, clone);
  }
}

// ---------- evidence ----------
async function collect(n: number, variant: string, dir: string, owner: any, runId: string, taskId: string, text: string,
  trail: any[], wallMs: number, photos: Buffer[]) {
  const { DesignStudioRepository } = await import('../packages/db/dist/index.js');
  const { blobStoreFor } = await import('../apps/core/src/services/blob-store-context.js');
  const { encodeStudioTransferV2, creativeAssetPath } = await import('../packages/creative/dist/index.js');
  const runRow = (await sql<any>`SELECT * FROM hawa.design_studio_runs WHERE id = ${runId}::uuid`.execute(owner)).rows[0];
  const stages = typeof runRow.stages === 'string' ? JSON.parse(runRow.stages) : runRow.stages;
  const repo = new DesignStudioRepository(owner, blobStoreFor(owner));
  const cands = await repo.getCandidatesForRun(runId);
  const ledger = (await sql<any>`SELECT stage, provider, model, requested_model, input_tokens, cached_input_tokens, output_tokens, images,
    usd_estimate::text AS usd, status, error_code, started_at, finished_at FROM hawa.design_studio_calls WHERE run_id = ${runId}::uuid ORDER BY started_at`.execute(owner)).rows;
  const judgments = (await sql<any>`SELECT kind, candidate_a, candidate_b, order_swapped, verdict FROM hawa.design_studio_judgments WHERE run_id = ${runId}::uuid ORDER BY created_at`.execute(owner)).rows;

  const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
  const label: Record<string, string> = {};
  const candidates = cands.map((c: any) => {
    const layouts = (parse(c.layouts) || []).map(parse);
    const layout = layouts.at(-1);
    const recipe = layout?.artDirection?.recipe ?? 'none';
    label[c.id] = `cand${c.ordinal}_${recipe}`;
    if (c.preview_png) writeFileSync(join(dir, `${label[c.id]}_${c.status}.png`), Buffer.from(c.preview_png));
    if (layout) writeFileSync(join(dir, `${label[c.id]}.layout.json`), JSON.stringify(layout, null, 2));
    return { id: c.id, ordinal: c.ordinal, status: c.status, rank: c.rank, score: c.score, recipe, concept: parse(c.concept),
      artDirection: layout?.artDirection, photos: layout?.photos?.map((p: any) => ({ photoIndex: p.photoIndex, role: p.role, x: p.x, y: p.y, width: p.width, height: p.height, crop: p.crop })),
      metrics: parse(c.metrics) };
  });
  const winner = cands.find((c: any) => c.id === runRow.winner_candidate_id);
  if (winner?.preview_png) writeFileSync(join(dir, 'winner.png'), Buffer.from(winner.preview_png));
  const copy = (runRow.request ? parse(runRow.request).copyBlocks : []).map((b: any) => b.text);
  if (winner) {
    const layout = (parse(winner.layouts) || []).map(parse).at(-1);
    try {
      const logo = readFileSync(creativeAssetPath('logos/kaae-official-logo.png'));
      const deck = await encodeStudioTransferV2(JSON.parse(JSON.stringify(layout)), copy, { bytes: logo, mimeType: 'image/png', sha256: createHash('sha256').update(logo).digest('hex') } as any,
        { photos: photos.map((bytes) => ({ bytes, mimeType: 'image/jpeg' as const })) } as any);
      writeFileSync(join(dir, 'winner_transfer.pptx'), deck.bytes);
    } catch (e) {
      writeFileSync(join(dir, 'winner_transfer.error.txt'), String((e as Error).stack || e));
    }
  }
  const verdicts = judgments.map((j: any) => {
    const v = parse(j.verdict) || {};
    return { kind: j.kind, a: label[j.candidate_a] ?? j.candidate_a, b: label[j.candidate_b] ?? j.candidate_b, swapped: j.order_swapped,
      majorityWinner: v.majorityWinner, winner: label[v.winnerCandidateId] ?? v.winnerCandidateId, weightedVotesA: v.weightedVotesA, weightedVotesB: v.weightedVotesB,
      weights: v.weights, votes: v.votes, artDirection: v.artDirection, baseline: label[v.baselineCandidateId] ?? v.baselineCandidateId,
      passed: v.passed, rationales: v.rationales };
  });
  const runReceipts = receipts.filter((r) => r.run === n);
  const ledgerUsd = ledger.reduce((a: number, r: any) => a + Number(r.usd), 0);
  const summary = {
    run: n, variant, taskId, runId, status: runRow.status, diagnostic: runRow.diagnostic, judgeStatus: runRow.judge_status,
    winner: winner ? label[winner.id] : null, wallSeconds: Math.round(wallMs / 100) / 10,
    calls: runReceipts.length, costUsd: Number(runReceipts.reduce((a, r) => a + r.usd, 0).toFixed(5)), ledgerUsd: Number(ledgerUsd.toFixed(5)),
    budget: parse(runRow.budget), copy, caption: text, trail,
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(candidates, null, 2));
  writeFileSync(join(dir, 'judge.json'), JSON.stringify({ tournament: stages.tournament, canary: stages.canary, verdicts }, null, 2));
  writeFileSync(join(dir, 'qa.json'), JSON.stringify({ qa: stages.qa, qaReplacedWinner: stages.qaReplacedWinner, excluded: stages.tournament?.excludedCandidates }, null, 2));
  writeFileSync(join(dir, 'brief.json'), JSON.stringify(stages.brief, null, 2));
  writeFileSync(join(dir, 'stages.json'), JSON.stringify(stages, (k, v) => (typeof v === 'string' && v.length > 4000 ? `${v.slice(0, 200)}…(${v.length})` : v), 2));
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify({ receipts: runReceipts, ledger, totalUsd: summary.costUsd, ledgerUsd: summary.ledgerUsd }, null, 2));
  console.log(`[trial] run ${n} (${variant}): ${summary.status}, winner ${summary.winner}, ${summary.calls} calls, $${summary.costUsd} (ledger $${summary.ledgerUsd}), ${summary.wallSeconds}s`);
}

// ---------- main ----------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const env = testDbEnv();
  const templates = await ensureTemplates(ROOT, env.TEST_DATABASE_OWNER_URL, (l) => console.log(`[trial db] ${l}`));
  console.log(`[trial] ${DRY ? 'DRY' : 'LIVE'} runs ${RUNS.join(',')} cap $${CAP} (already spent $${PRIOR_SPENT}) -> ${OUT}`);
  for (let i = 0; i < RUNS.length; i++) {
    if (stop) { console.error(`[trial] not starting run ${FIRST + i}: ${stop}`); break; }
    try {
      await oneRun(FIRST + i, RUNS[i] as 'full' | 'cut', env, templates);
    } catch (e) {
      console.error(`[trial] run ${FIRST + i} failed:`, (e as Error).stack || e);
    }
  }
  const total = { cap: CAP, priorSpent: PRIOR_SPENT, sessionUsd: Number((spent - PRIOR_SPENT).toFixed(5)), cumulativeUsd: Number(spent.toFixed(5)), stop, receipts };
  writeFileSync(join(OUT, `session_${STAMP}.json`), JSON.stringify(total, null, 2));
  console.log(`[trial] session $${total.sessionUsd} (cumulative $${total.cumulativeUsd})${stop ? `; stopped: ${stop}` : ''}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
