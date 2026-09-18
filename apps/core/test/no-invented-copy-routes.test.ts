import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// What these routes used to supply when the caller sent no copy.
const INVENTED = [
  'ئۆفەری تایبەتی جەژن بۆ کڕیارانی دەرمانخانە',
  'کەمپینی تایبەت',
  'Special Seasonal Campaign',
  'Exclusive Office Promotion',
  'داشکاندنی سەرەتای وەرز',
  '25,000 IQD',
  '+964 750 000 0000',
];
const expectNothingInvented = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const invented of INVENTED) expect(text).not.toContain(invented);
};

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Ingress rehearsal', () => {
  it('refuses a rehearsal with no message instead of inventing one', async () => {
    const app = createApp();
    const res = await app.request('/v1/ingress/rehearsal', json({ clientId: 'client-drustee' }));
    expect(res.status).toBe(422);
    expect((await res.json()).title).toBe('COPY_REQUIRED');
  });

  it('keeps a Kurdish rehearsal Kurdish, with no English headline or body', async () => {
    const app = createApp();
    const res = await app.request('/v1/ingress/rehearsal', json({ clientId: 'client-drustee', text: 'ڤیتامینی نوێ لە دروستی\nبەردەستە لە هەموو لقەکان' }));
    expect(res.status).toBe(201);
    const { task } = await res.json();

    expect(task.headlineCkb).toBe('ڤیتامینی نوێ لە دروستی');
    expect(task.headlineEn).toBeUndefined();
    expect(task.copyEn).toBeUndefined();
    expectNothingInvented(task);
  });
});

describe('Vision rubric route', () => {
  const headline = { id: 'headline', role: 'headline', x: 100, y: 300, width: 880, height: 120, fontSize: 48, lineHeight: 1.6, color: '#FFFFFF', background: '#0F172A' };

  async function rehearsedTask(app: any) {
    const res = await app.request('/v1/ingress/rehearsal', json({ clientId: 'client-drustee', text: 'ڤیتامینی نوێ لە دروستی\nبەردەستە لە هەموو لقەکان' }));
    return (await res.json()).task;
  }

  it('refuses to score without the revision nodes, and stores no report', async () => {
    const app = createApp();
    const task = await rehearsedTask(app);

    const res = await app.request(`/v1/tasks/${task.id}/revisions/rev_no_nodes/evaluate-rubric`, json({ format: 'feed' }));
    expect(res.status).toBe(422);
    expect((await res.json()).title).toBe('NODES_REQUIRED');
    expect(await (await app.request(`/v1/tasks/${task.id}/rubric-reports`)).json()).toEqual([]);
  });

  it('checks the design against the copy the client sent, with no sample price or phone', async () => {
    const app = createApp();
    const task = await rehearsedTask(app);
    const url = `/v1/tasks/${task.id}/revisions/rev_client_copy/evaluate-rubric`;

    const matching = await (await app.request(url, json({ format: 'story', nodes: [{ ...headline, text: 'ڤیتامینی نوێ لە دروستی' }] }))).json();
    expect(matching.hardFailures).toEqual([]);
    expect(matching.criteriaScores.copyFidelity).toBe(30);
    expectNothingInvented(matching);

    const altered = await (await app.request(url, json({ format: 'story', nodes: [{ ...headline, text: 'سەردێڕێکی تر' }] }))).json();
    expect(altered.findings.some((f: any) => f.category === 'copy' && f.message.includes('ڤیتامینی نوێ لە دروستی'))).toBe(true);
    expectNothingInvented(altered);
  });
});
