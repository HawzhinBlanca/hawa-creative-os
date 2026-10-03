import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { OFFICE_POSTS } from './fixtures/office-posts/office-posts.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { applyShapingControl, type ShapingControl } from './fixtures/shaping-controls.js';
import { renderLayoutV2, svgToPngAsync, type RenderLayoutV2Result } from '../src/studio/render-layout-v2.js';
import { textShapingBlocks } from '../src/studio/export-text-shaping.js';
import { runTextShapingJob, type TextShapingJob, type TextShapingOutcome } from '../src/studio/text-shaping-job.js';
import { TextShapingPool, textShapingPoolOptionsFromEnv } from '../src/studio/text-shaping-pool.js';

/**
 * ADR-290 addendum: the Sorani shaping check on a worker thread gives the report the in-process check
 * gives (every verdict, score, width ratio and detail; only the wall time differs), keeps the caller's
 * event loop turning, and answers a timeout, a dead worker, a full queue or a shutdown as "not
 * measured" without throwing. The fixtures are ADR-290's: the Sorani office posts rendered by the
 * Studio renderer, broken renders of them, and real Canva exports on record.
 */

const SORANI_POSTS = OFFICE_POSTS.filter((p) => p.language !== 'en');
const copyOf = (copy: string[]) => Object.fromEntries(copy.map((c, i) => [i, c]));
const withoutTime = (r: TextShapingOutcome) => ('measured' in r ? r : { ...r, ms: 0 });
const faulty = resolve(__dirname, 'fixtures/text-shaping-faulty-worker.mjs');
const canvaRoot = resolve(__dirname, '../../../output/acceptance/2026-09-27-canva-multilingual');
const canvaFixtures = JSON.parse(readFileSync(`${canvaRoot}/fixtures.json`, 'utf8'));
const CANVA: Record<string, string> = { 'group-1': 'group-1-round-2-canva.png', 'group-2': 'group-2-canva.png', 'group-3': 'group-3-canva.png', 'group-4': 'group-4-canva.png' };
function canvaJob(id: string, copy?: string[]): TextShapingJob {
  const group = canvaFixtures.groups.find((g: { id: string }) => g.id === id);
  return { picture: readFileSync(`${canvaRoot}/${CANVA[id]}`), layout: group.manifest.plan, copyText: copyOf(copy ?? group.manifest.copy), planWidth: group.manifest.plan.width };
}

const renders = new Map<string, RenderLayoutV2Result>();
function render(id: string) {
  const post = SORANI_POSTS.find((p) => p.id === id)!;
  const copyText = copyOf(post.copy);
  if (!renders.has(id)) {
    const photoFiles = (post.layout.photos ?? []).map((_, i) => ({ bytes: syntheticPhoto(600, 400, i + 3) }));
    renders.set(id, renderLayoutV2(post.layout, { copyText, logoDataUri: KAAE_TEST_LOGO, photoFiles }));
  }
  return { layout: post.layout, copyText, out: renders.get(id)! };
}

// One pool for the parity cases, with a deadline no fixture comes near (the first job also loads the module).
const pool = new TextShapingPool({ timeoutMs: 120_000 });
afterAll(() => pool.close());

async function sameReport(job: TextShapingJob): Promise<TextShapingOutcome> {
  const inProcess = runTextShapingJob(job);
  const run = await pool.run(job);
  if (!run.ran) throw new Error(`the worker did not run the check: ${run.reason}`);
  expect(withoutTime(run.result)).toEqual(withoutTime(inProcess));
  return run.result;
}

describe('parity: the worker reports exactly what the in-process check reports', () => {
  it.each(SORANI_POSTS.map((p) => p.id))('%s, read exactly and by colour', async (id) => {
    const { layout, copyText, out } = render(id);
    const exact = await sameReport({ picture: out.png, background: out.noTextPng, layout, copyText });
    const byColour = await sameReport({ picture: out.png, layout, copyText });
    expect(exact).toMatchObject({ pass: true });
    expect(byColour).toMatchObject({ pass: true });
  }, 120_000);

  const controls: ShapingControl[] = ['unjoined', 'one-join-broken', 'reversed', 'substituted-face', 'rewrapped', 'missing-glyph'];
  it.each(controls)('a broken render (%s), read exactly and by colour', async (control) => {
    const { layout, copyText, out } = render('photo08_prime_minister_meeting_scrim_ckb');
    const svg = textShapingBlocks(layout, copyText).map((block) => {
      const t = layout.text.find((x) => `text-copy-${x.copyIndex}` === block.id)!;
      return applyShapingControl(out.svg, block.id, block.rtl, control,
        { substitute: t.fontFamily === 'Noto Sans Arabic' ? 'Vazirmatn' : 'Noto Sans Arabic', pitchPx: t.lineHeight * block.fontSizePx });
    }).find(Boolean);
    expect(svg).toBeDefined();
    const broken = await svgToPngAsync(svg!, layout.width, layout.height, {}, out.files);
    const exact = await sameReport({ picture: broken, background: out.noTextPng, layout, copyText });
    await sameReport({ picture: broken, layout, copyText });
    expect(exact).toMatchObject({ pass: false });
  }, 120_000);

  it.each(Object.keys(CANVA))('Canva export %s, read by colour', async (id) => {
    const report = await sameReport(canvaJob(id));
    expect(report).toMatchObject({ pass: true });
  }, 120_000);

  it('a Canva export checked against copy it does not show', async () => {
    const group = canvaFixtures.groups.find((g: { id: string }) => g.id === 'group-2');
    const copy: string[] = [...group.manifest.copy];
    [copy[3], copy[4]] = [copy[4], copy[3]];
    const report = await sameReport(canvaJob('group-2', copy));
    expect(report).toMatchObject({ pass: false });
  }, 120_000);

  it('a check that throws is answered with its message, as the callers recorded it in-process', async () => {
    const { layout, copyText, out } = render('photo02_k12_field_visit_report_ckb');
    const small = new PNG({ width: 10, height: 10 });
    const job: TextShapingJob = { picture: out.png, background: PNG.sync.write(small), layout, copyText };
    expect(() => runTextShapingJob(job)).toThrow('The text-free picture is not the size of the picture');
    expect(await pool.run(job)).toEqual({ ran: false, reason: 'Not measured: The text-free picture is not the size of the picture' });
  }, 120_000);

  it('a design with no Arabic-script copy is not measured, in the same words', async () => {
    const { out } = render('photo02_k12_field_visit_report_ckb');
    const job: TextShapingJob = { picture: out.png, layout: { text: [] }, copyText: {} };
    expect(await pool.run(job)).toEqual({ ran: true, result: runTextShapingJob(job) });
    expect(runTextShapingJob(job)).toEqual({ measured: false, reason: 'The design has no Kurdish or Arabic text to check.' });
  }, 120_000);
});

describe('the caller\'s event loop keeps turning while a check runs', () => {
  it('a 50 ms interval never waits as long as the check takes', async () => {
    const job = canvaJob('group-4');
    const own = new TextShapingPool({ timeoutMs: 120_000 });
    try {
      await own.run(job); // warm: the worker has loaded its module and parsed the faces
      const watch = async (work: () => Promise<unknown>) => {
        let last = performance.now(), maxGap = 0;
        const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 50);
        await new Promise((r) => setTimeout(r, 60));
        const started = performance.now();
        await work();
        const took = performance.now() - started;
        await new Promise((r) => setTimeout(r, 60));
        clearInterval(tick);
        return { maxGap, took };
      };
      const inProcess = await watch(async () => runTextShapingJob(job));
      const offThread = await watch(async () => {
        const run = await own.run(job);
        expect(run.ran).toBe(true);
      });
      process.stderr.write(`[text-shaping-pool] max interval gap: in-process ${Math.round(inProcess.maxGap)} ms over a ${Math.round(inProcess.took)} ms check; ` +
        `on the worker ${Math.round(offThread.maxGap)} ms over a ${Math.round(offThread.took)} ms check\n`);
      expect(inProcess.maxGap).toBeGreaterThan(inProcess.took * 0.8);
      expect(offThread.took).toBeGreaterThan(300);
      expect(offThread.maxGap).toBeLessThan(Math.min(250, offThread.took / 3));
    } finally {
      await own.close();
    }
  }, 120_000);
});

describe('a check that does not run is recorded as not measured, never thrown', () => {
  it('times out a running check, terminates its worker, and starts a new one for the next', async () => {
    const own = new TextShapingPool({ workerFile: faulty });
    const events: string[] = [];
    const watched = new TextShapingPool({ workerFile: faulty, timeoutMs: 100, onEvent: (e) => events.push(e.kind) });
    try {
      expect(await watched.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'hang' } })).toEqual({ ran: false, reason: 'timeout' });
      expect(events).toEqual(['timeout']);
      expect(watched.threads).toBe(0);
      expect(await watched.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } })).toEqual({ ran: true, result: { measured: false, reason: 'fixture answered ok' } });
      expect(watched.threads).toBe(1);
      // The default deadline is 5 s; one call may set its own.
      expect(own.timeoutMs).toBe(5000);
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'hang' } }, { timeoutMs: 50 })).toEqual({ ran: false, reason: 'timeout' });
    } finally {
      await Promise.all([own.close(), watched.close()]);
    }
  });

  it('times out a check still queued behind another, without stopping the running one', async () => {
    const own = new TextShapingPool({ workerFile: faulty, timeoutMs: 300 });
    try {
      const first = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'hang' } });
      const second = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } }, { timeoutMs: 50 });
      expect(await second).toEqual({ ran: false, reason: 'timeout' });
      expect(own.threads).toBe(1);
      expect(await first).toEqual({ ran: false, reason: 'timeout' });
    } finally {
      await own.close();
    }
  });

  it.each(['exit', 'throw'])('a worker that dies (%s) answers worker-failed, and the next job gets a new one', async (fault) => {
    const events: Array<{ kind: string; detail?: string }> = [];
    const own = new TextShapingPool({ workerFile: faulty, onEvent: (e) => events.push(e) });
    try {
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: fault } })).toEqual({ ran: false, reason: 'worker-failed' });
      expect(events[0]).toMatchObject({ kind: 'worker-failed' });
      expect(own.threads).toBe(0);
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } })).toEqual({ ran: true, result: { measured: false, reason: 'fixture answered ok' } });
    } finally {
      await own.close();
    }
  });

  it('a job that cannot be copied to the thread is not measured, and the worker stays', async () => {
    const own = new TextShapingPool({ workerFile: faulty });
    try {
      const uncloneable = { picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' }, colors: { 0: [() => '#000'] } } as unknown as TextShapingJob;
      expect(await own.run(uncloneable)).toMatchObject({ ran: false, reason: expect.stringMatching(/^Not measured: /) });
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } })).toEqual({ ran: true, result: { measured: false, reason: 'fixture answered ok' } });
      expect(own.threads).toBe(1);
    } finally {
      await own.close();
    }
  });

  it('a worker entry that is not there answers worker-failed', async () => {
    const own = new TextShapingPool({ workerFile: resolve(__dirname, 'fixtures/no-such-worker.mjs') });
    try {
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: {} })).toEqual({ ran: false, reason: 'worker-failed' });
    } finally {
      await own.close();
    }
  });

  it('answers queue-full at once past the bounded queue', async () => {
    const onEvent = vi.fn();
    const own = new TextShapingPool({ workerFile: faulty, maxQueue: 1, timeoutMs: 300, onEvent });
    try {
      const running = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'hang' } });
      const queued = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } });
      expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } })).toEqual({ ran: false, reason: 'queue-full' });
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'queue-full' }));
      await Promise.all([running, queued]);
    } finally {
      await own.close();
    }
  });

  it('close() answers waiting and running checks shut-down and leaves no thread behind', async () => {
    const resources = () => process.getActiveResourcesInfo().filter((r) => /Worker|MessagePort/.test(r)).length;
    const before = resources();
    const own = new TextShapingPool({ workerFile: faulty });
    const running = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'hang' } });
    const queued = own.run({ picture: new Uint8Array(), layout: {}, copyText: { 0: 'ok' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(own.threads).toBe(1);
    await own.close();
    expect(await running).toEqual({ ran: false, reason: 'shut-down' });
    expect(await queued).toEqual({ ran: false, reason: 'shut-down' });
    expect(own.threads).toBe(0);
    expect(await own.run({ picture: new Uint8Array(), layout: {}, copyText: {} })).toEqual({ ran: false, reason: 'shut-down' });
    expect(resources()).toBe(before);
  });
});

describe('pool settings', () => {
  it('reads the size, deadline and queue from the environment, and ignores what it cannot use', () => {
    expect(textShapingPoolOptionsFromEnv({})).toEqual({});
    expect(textShapingPoolOptionsFromEnv({ HAWA_TEXT_SHAPING_WORKERS: '2', HAWA_TEXT_SHAPING_TIMEOUT_MS: '8000', HAWA_TEXT_SHAPING_QUEUE: '0' }))
      .toEqual({ size: 2, timeoutMs: 8000, maxQueue: 0 });
    expect(textShapingPoolOptionsFromEnv({ HAWA_TEXT_SHAPING_WORKERS: '0', HAWA_TEXT_SHAPING_TIMEOUT_MS: 'soon', HAWA_TEXT_SHAPING_QUEUE: '-1' })).toEqual({});
    const defaults = new TextShapingPool();
    expect([defaults.size, defaults.timeoutMs, defaults.maxQueue, defaults.threads]).toEqual([1, 5000, 8, 0]);
  });
});
