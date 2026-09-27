import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { read } from '../src/services/statusReport.js';
import { DnaScreen, candidateRuleFromCore, fontInspectionFromCore } from '../src/screens/DnaScreen.js';
import { OpsScreen } from '../src/screens/OpsScreen.js';

/**
 * Core authenticates only by `Authorization: Bearer` (verifyRequestAuth in apps/core/src/app.ts), and
 * every route these screens call is guarded. The DNA, Ops and Eval screens used plain fetch without
 * the token, so in production every read and action was refused with 401.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
const TOKEN = 'operator-token-7f3a';
const SCREENS = path.resolve(__dirname, '../src/screens');
const DESK_SRC = path.resolve(__dirname, '../src');

/** A browser with (or without) a signed-in operator: the token sits where apiClient.auth.login puts it. */
function browserWithToken(token: string | null) {
  const store = new Map<string, string>();
  if (token) store.set('hawa_operator_token', token);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(answer: () => Response = () => json({})) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentRequest(fetchMock: ReturnType<typeof stubFetch>, index = 0) {
  const [url, init = {}] = fetchMock.mock.calls[index];
  return {
    url,
    method: init.method ?? 'GET',
    headers: new Headers(init.headers as Record<string, string>),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Every Core call the three screens make, with what Core must receive.
const CALLS: Array<{ name: string; call: () => Promise<unknown>; method: string; path: string; body?: unknown }> = [
  // DNA
  { name: 'DNA: client list', call: () => apiClient.clients.list(), method: 'GET', path: '/v1/clients' },
  { name: 'DNA: client DNA', call: () => apiClient.clients.dna(KAAE), method: 'GET', path: `/v1/clients/${KAAE}/dna` },
  {
    name: 'DNA: save',
    call: () => apiClient.clients.saveDna(KAAE, { clientId: KAAE, version: 3 }),
    method: 'POST',
    path: `/v1/clients/${KAAE}/dna`,
    body: { clientId: KAAE, version: 3 },
  },
  { name: 'DNA: snapshots', call: () => apiClient.clients.snapshots(KAAE), method: 'GET', path: `/v1/clients/${KAAE}/snapshots` },
  {
    name: 'DNA: snapshot commit',
    call: () => apiClient.clients.commitSnapshot(KAAE, { commitMessage: 'Before the Newroz run', createdBy: 'art_director' }),
    method: 'POST',
    path: `/v1/clients/${KAAE}/snapshots`,
    body: { commitMessage: 'Before the Newroz run', createdBy: 'art_director' },
  },
  { name: 'DNA: candidate rules', call: () => apiClient.clients.candidateRules(KAAE), method: 'GET', path: `/v1/clients/${KAAE}/candidate-rules` },
  {
    name: 'DNA: candidate promote (no role claimed in the body)',
    call: () => apiClient.clients.promoteCandidate(KAAE, 'rule_1'),
    method: 'POST',
    path: `/v1/clients/${KAAE}/candidate-rules/rule_1/promote`,
    body: {},
  },
  {
    name: 'DNA: candidate dismiss',
    call: () => apiClient.clients.dismissCandidate(KAAE, 'rule_1', 'Dismissed by art director'),
    method: 'POST',
    path: `/v1/clients/${KAAE}/candidate-rules/rule_1/dismiss`,
    body: { reason: 'Dismissed by art director' },
  },
  {
    name: 'DNA: font inspect',
    call: () => apiClient.fonts.inspect({ fontBase64: 'AAEC', fontName: 'Rabar_022' }),
    method: 'POST',
    path: '/v1/fonts/inspect',
    body: { fontBase64: 'AAEC', fontName: 'Rabar_022' },
  },
  // Ops
  { name: 'Ops: integrations health', call: () => apiClient.operations.integrationsHealth(), method: 'GET', path: '/v1/integrations/health' },
  { name: 'Ops: design funnel', call: () => apiClient.operations.funnelHealth(), method: 'GET', path: '/v1/system/funnel/health' },
  { name: 'Ops: failures', call: () => apiClient.operations.failures(), method: 'GET', path: '/v1/operations/failures' },
  { name: 'Ops: SLO summary', call: () => apiClient.operations.slo(), method: 'GET', path: '/v1/operations/slo' },
  { name: 'Ops: last reconciliation', call: () => apiClient.operations.reconciliation(), method: 'GET', path: '/v1/operations/reconciliation' },
  { name: 'Ops: budgets', call: () => apiClient.clients.budgets(), method: 'GET', path: '/v1/clients/budgets' },
  {
    name: 'Ops: budget allocate (sends capUsd, the field Core reads)',
    call: () => apiClient.clients.allocateBudget(KAAE, 500),
    method: 'POST',
    path: `/v1/clients/${KAAE}/budget/allocate`,
    body: { capUsd: 500 },
  },
  {
    name: 'Ops: reconciliation audit (never auto-repair)',
    call: () => apiClient.operations.auditReconciliation(),
    method: 'POST',
    path: '/v1/operations/reconciliation/run',
    body: { autoRepair: false },
  },
  // Eval
  { name: 'Eval: datasets', call: () => apiClient.evaluations.datasets(), method: 'GET', path: '/v1/evaluations/datasets' },
  { name: 'Eval: past runs', call: () => apiClient.evaluations.runs(), method: 'GET', path: '/v1/evaluations/runs' },
  { name: 'Eval: dataset cases', call: () => apiClient.evaluations.cases('rtl'), method: 'GET', path: '/v1/evaluations/datasets/rtl/cases' },
  {
    name: 'Eval: tournament run',
    call: () => apiClient.evaluations.run('RTL Golden Suite Automated Tournament', '12345678-1234-4234-8234-123456789abc'),
    method: 'POST',
    path: '/v1/evaluations/runs',
    body: { name: 'RTL Golden Suite Automated Tournament' },
  },
];

describe('the DNA, Ops and Eval screens send the operator token', () => {
  it.each(CALLS)('$name', async ({ call, method, path: expectedPath, body }) => {
    browserWithToken(TOKEN);
    const fetchMock = stubFetch();
    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = sentRequest(fetchMock);
    expect(sent.url).toBe(expectedPath);
    expect(sent.method).toBe(method);
    expect(sent.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    if (body !== undefined) expect(sent.body).toEqual(body);
  });

  it('uses the token the sign-in stored, on the very next call', async () => {
    browserWithToken(null);
    const fetchMock = vi.fn(async (url: string) =>
      url === '/v1/auth/session' ? json({ authenticated: true, token: 'fresh-session-token' }) : json({ items: [] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.auth.login({ key: 'office-key' });
    await apiClient.operations.failures();

    const second = sentRequest(fetchMock as unknown as ReturnType<typeof stubFetch>, 1);
    expect(second.url).toBe('/v1/operations/failures');
    expect(second.headers.get('Authorization')).toBe('Bearer fresh-session-token');
  });

  it('signed out, sends no Authorization header, and the 401 reaches the screen as unknown with Core\'s reason', async () => {
    browserWithToken(null);
    const fetchMock = stubFetch(() => json({ title: 'Authentication Required', detail: 'Sign in to Hawa first' }, 401));

    expect(await read(() => apiClient.clients.dna(KAAE))).toEqual({ state: 'unknown', reason: 'Sign in to Hawa first' });
    expect(sentRequest(fetchMock).headers.has('Authorization')).toBe(false);
  });

  it('sends cookie-session CSRF proof for a Desk mutation without exposing a bearer token', async () => {
    browserWithToken(null);
    vi.stubGlobal('document', { cookie: `hawa_csrf=${'a'.repeat(64)}` });
    const fetchMock = stubFetch();
    await apiClient.clients.allocateBudget(KAAE, 500);
    const sent = sentRequest(fetchMock);
    expect(sent.headers.has('Authorization')).toBe(false);
    expect(sent.headers.get('x-hawa-csrf')).toBe('a'.repeat(64));
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin');
  });

  it('uses a new Google cookie identity ahead of a shared key left in this tab', async () => {
    browserWithToken(TOKEN);
    vi.stubGlobal('document', { cookie: `hawa_csrf=${'b'.repeat(64)}` });
    const fetchMock = stubFetch();
    await apiClient.clients.allocateBudget(KAAE, 500);
    const sent = sentRequest(fetchMock);
    expect(sent.headers.has('Authorization')).toBe(false);
    expect(sent.headers.get('x-hawa-csrf')).toBe('b'.repeat(64));
  });

  it('the three screens make no call of their own: every request goes through apiClient', () => {
    for (const file of ['DnaScreen.tsx', 'OpsScreen.tsx', 'EvalScreen.tsx']) {
      const text = fs.readFileSync(path.join(SCREENS, file), 'utf8');
      expect(text, file).toContain("from '../api/client.js'");
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/fetchJson/);
      // Hand-built API URLs bypass the token; only the public font CDN links are allowed.
      expect(text, file).not.toMatch(/['"`]\/v1\/(?!fonts\/cdn\/)/);
    }
  });
});

describe('actions the owner did not enable make no request', () => {
  it('nothing in the Desk asks Core to auto-repair, run an SLO probe, or onboard a tenant', () => {
    const offenders = sourceFiles(DESK_SRC).filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return /autoRepair:\s*true/.test(text) || /slo\/run/.test(text) || /Math\.random\(\)\.toString\(16\)/.test(text);
    });
    expect(offenders.map((f) => path.relative(DESK_SRC, f))).toEqual([]);
  });

  it('the SLO run and tenant onboarding buttons are disabled and say why', () => {
    const ops = renderToStaticMarkup(React.createElement(OpsScreen));
    expect(ops).toMatch(/<button[^>]*disabled=""[^>]*title="Not enabled: Core&#x27;s SLO probe runs against a fake design studio[^"]*"[^>]*>⚡ Run Synthetic Benchmark \(not enabled\)<\/button>/);
    expect(ops).toContain('It does not read Google Drive or Google Sheets, and repairs nothing.');

    const dna = renderToStaticMarkup(React.createElement(DnaScreen));
    expect(dna).toMatch(/<button[^>]*disabled=""[^>]*><span>\+<\/span><span>Onboard Client Tenant \(not enabled\)<\/span><\/button>/);
    expect(dna).toContain('Onboarding is not enabled: it would create a client with placeholder Drive and Sheet destinations.');
  });
});

describe('the DNA screen shows only what Core returned', () => {
  it('before Core answers, it shows no invented DNA, snapshots, candidate rule or font result', () => {
    const html = renderToStaticMarkup(React.createElement(DnaScreen));
    expect(html).not.toMatch(
      /folder_kaae_certificates|drive_kaae_root|drive_drustee|AAA_COMPLIANT|21-ray sun seal|Vazirmatn Kurdish Display|40dab5f8|LIVE API|tenant-isolated|Kurdistan Accrediting Association/
    );
    expect(html).toContain('<b>DNA not read</b>');
    expect(html).toContain('— Registered');
    expect(html).toContain('— Snapshots');
    expect(html).toContain('Candidate rules unknown: not read yet');
    expect(html).toContain('Snapshots unknown: not read yet');
    // With no DNA read there is nothing to snapshot.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>🛡️ Create Immutable Version<\/button>/);
  });

  it('maps Core\'s candidate rule, and reports what Core did not send as unknown', () => {
    expect(
      candidateRuleFromCore({
        id: 'cand_kaae_gold_divider',
        clientId: KAAE,
        title: 'Gold divider under the headline',
        category: 'layout',
        ruleText: 'Place a thin gold divider under every headline',
        rationale: 'Requested in 3 revisions',
        frequency: 3,
        evidenceTaskIds: ['t1', 't2', 't3'],
        confidence: 0.82,
        status: 'PROPOSED',
      })
    ).toEqual({
      ruleId: 'cand_kaae_gold_divider',
      clientId: KAAE,
      title: 'Gold divider under the headline',
      ruleText: 'Place a thin gold divider under every headline',
      category: 'layout',
      confidence: 0.82,
      occurrences: 3,
      evidenceTasks: 3,
      status: 'proposed',
      rationale: 'Requested in 3 revisions',
    });
    expect(candidateRuleFromCore({ id: 'r2', ruleText: 'x', status: 'PROMOTED' })).toMatchObject({
      title: 'x',
      status: 'promoted',
      confidence: null,
      occurrences: null,
      evidenceTasks: null,
    });
    expect(candidateRuleFromCore({ id: 'r3', status: 'DISMISSED' }).status).toBe('dismissed');
  });

  it('maps Core\'s font coverage result, and treats an answer without coverage as a failed inspection', () => {
    expect(
      fontInspectionFromCore(
        {
          fontName: 'Rabar 022',
          format: 'TrueType',
          metadata: { family: 'Rabar', fullName: 'Rabar 022' },
          totalRequired: 40,
          presentCount: 38,
          coveragePercentage: 95,
          status: 'PARTIAL_COMPLIANT',
          hasZwnj: true,
          missingGlyphs: [{ char: 'ڵ', hex: 'U+06B5', name: 'LAM WITH SMALL V' }],
        },
        51200
      )
    ).toEqual({
      fontFamily: 'Rabar',
      format: 'TrueType',
      totalRequired: 40,
      presentCount: 38,
      coveragePercent: 95,
      status: 'PARTIAL_COMPLIANT',
      hasZwnj: true,
      missingGlyphs: [{ char: 'ڵ', hex: 'U+06B5', name: 'LAM WITH SMALL V' }],
      fileSizeBytes: 51200,
    });
    expect(() => fontInspectionFromCore({ complianceLevel: 'AAA_COMPLIANT', coverageRatio: 1 }, 10)).toThrow(
      'Core answered without a coverage result'
    );
  });
});
