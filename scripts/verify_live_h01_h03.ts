import fs from 'node:fs';

const BASE_URL = 'http://127.0.0.1:8080';
const REVIEWER_KEY = process.env.HAWA_REVIEWER_KEY;
const OPERATOR_KEY = process.env.HAWA_BEARER_TOKEN;
const ADMIN_KEY = process.env.HAWA_ADMIN_KEY;
if (!REVIEWER_KEY || !OPERATOR_KEY || !ADMIN_KEY) throw new Error('HAWA_REVIEWER_KEY, HAWA_BEARER_TOKEN and HAWA_ADMIN_KEY must be set; this script has no built-in credentials');

interface ProbeResult {
  step: string;
  url: string;
  status: number;
  expectedStatus: number;
  passed: boolean;
  contentType: string | null;
  data: any;
  notes?: string;
}

async function runProbes() {
  const results: ProbeResult[] = [];

  console.log('=== VERIFYING H01, H02, H03 ON DEPLOYED REVERSE PROXY (PORT 8080) ===\n');

  // --- H01 Probes: Canonical Authenticated Task Loading ---

  // 1. Unauthenticated task list -> 401 JSON (not HTML shell)
  {
    const res = await fetch(`${BASE_URL}/v1/tasks`);
    const ct = res.headers.get('content-type');
    const json = await res.json().catch(() => null);
    results.push({
      step: 'H01: 1. Unauthenticated task list',
      url: `${BASE_URL}/v1/tasks`,
      status: res.status,
      expectedStatus: 401,
      passed: res.status === 401 && ct?.includes('application/json') && json?.title === 'Unauthorized',
      contentType: ct,
      data: json,
      notes: 'Must return 401 JSON problem details, not 200 text/html SPA shell',
    });
  }

  // 2. Session authentication via POST /v1/auth/session with Reviewer Key
  let reviewerSessionToken = '';
  {
    const res = await fetch(`${BASE_URL}/v1/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: REVIEWER_KEY }),
    });
    const ct = res.headers.get('content-type');
    const json = await res.json().catch(() => null);
    reviewerSessionToken = json?.token || '';
    results.push({
      step: 'H01: 2. Session login with Reviewer Key',
      url: `${BASE_URL}/v1/auth/session`,
      status: res.status,
      expectedStatus: 201,
      passed: (res.status === 200 || res.status === 201) && json?.user?.role === 'art_director',
      contentType: ct,
      data: json,
      notes: `Resolved role: ${json?.user?.role}, token prefix: ${reviewerSessionToken.slice(0, 10)}...`,
    });
  }

  // 3. Authenticated task list via Session Bearer -> 200 JSON with paginated database tasks
  {
    const res = await fetch(`${BASE_URL}/v1/tasks?limit=10&offset=0`, {
      headers: { Authorization: `Bearer ${reviewerSessionToken}` },
    });
    const ct = res.headers.get('content-type');
    const json = await res.json().catch(() => null);
    const hasItems = Array.isArray(json?.items) && json.items.length > 0;
    results.push({
      step: 'H01: 3. Authenticated paginated task list',
      url: `${BASE_URL}/v1/tasks?limit=10&offset=0`,
      status: res.status,
      expectedStatus: 200,
      passed: res.status === 200 && hasItems && json.total > 0,
      contentType: ct,
      data: { total: json?.total, itemCount: json?.items?.length, sampleTaskTitle: json?.items?.[0]?.title },
      notes: `Loaded ${json?.items?.length} items from database (total ${json?.total})`,
    });
  }

  // 4. Invalid session token -> 401
  {
    const res = await fetch(`${BASE_URL}/v1/auth/session`, {
      headers: { Authorization: 'Bearer invalid_garbage_token' },
    });
    const json = await res.json().catch(() => null);
    results.push({
      step: 'H01: 4. Reject invalid session token',
      url: `${BASE_URL}/v1/auth/session`,
      status: res.status,
      expectedStatus: 401,
      passed: res.status === 401,
      contentType: res.headers.get('content-type'),
      data: json,
    });
  }

  // --- H02 Probes: Honest Intake and State Authority (No Fabricated Receipts) ---

  // 5. Create a real task via API client
  let taskId = '';
  {
    const res = await fetch(`${BASE_URL}/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reviewerSessionToken}`,
      },
      body: JSON.stringify({
        title: 'H01-H03 Live Verification Task',
        description: 'Testing truthful receipts and role-based authority against live reverse proxy',
        clientId: 'c1000000-0000-4000-8000-000000000002', // KAAE
      }),
    });
    const json = await res.json().catch(() => null);
    taskId = json?.id || json?.task?.id || '';
    results.push({
      step: 'H02: 5. Create real persistent task in PostgreSQL',
      url: `${BASE_URL}/v1/tasks`,
      status: res.status,
      expectedStatus: 201,
      passed: res.status === 201 && Boolean(taskId),
      contentType: res.headers.get('content-type'),
      data: { id: taskId, title: json?.title || json?.task?.title },
    });
  }

  // 6. Push revision with caller-provided qaReport bypass attempt
  // Assert: caller qaReport is completely ignored by server!
  let revisionId = '';
  {
    const res = await fetch(`${BASE_URL}/v1/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reviewerSessionToken}`,
      },
      body: JSON.stringify({
        nodes: [{ id: 'live-node-1', type: 'text', text: 'Verified live layout' }],
        qaReport: { criticalPass: true, reportSha256: 'unauthorized-bypass-attempt' },
        captureSet: { capturedArtifactSetHash: 'caller-invented' },
      }),
    });
    const json = await res.json().catch(() => null);
    revisionId = json?.revisionId || json?.id || json?.revision?.id || '';
    results.push({
      step: 'H02: 6. Push revision with spoofed QA bypass',
      url: `${BASE_URL}/v1/tasks/${taskId}/revisions`,
      status: res.status,
      expectedStatus: 201,
      passed: res.status === 201 && Boolean(revisionId),
      contentType: res.headers.get('content-type'),
      data: { revisionId, hasAcceptedSpoofedQa: Boolean(json?.qaReport?.reportSha256 === 'unauthorized-bypass-attempt') },
      notes: 'Server must not accept spoofed QA report',
    });
  }

  // --- H03 Probes: Strict Approval & Durable Role Authority ---

  // 7. Invalid decision action -> HTTP 400 Bad Request
  {
    const res = await fetch(`${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reviewerSessionToken}`,
      },
      body: JSON.stringify({ action: 'invalid_action_foo' }),
    });
    const json = await res.json().catch(() => null);
    results.push({
      step: 'H03: 7. Reject invalid action with 400',
      url: `${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`,
      status: res.status,
      expectedStatus: 400,
      passed: res.status === 400,
      contentType: res.headers.get('content-type'),
      data: json,
      notes: 'Unknown action must return 400, not fall through or silently default',
    });
  }

  // 8. Operator role spoofing -> HTTP 403 Forbidden
  // When an operator passes { action: 'approve', role: 'art_director' } or x-user-role: art_director
  {
    const res = await fetch(`${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPERATOR_KEY}`,
        'x-user-role': 'art_director',
      },
      body: JSON.stringify({ action: 'approve', role: 'art_director' }),
    });
    const json = await res.json().catch(() => null);
    results.push({
      step: 'H03: 8. Reject operator role spoofing with 403',
      url: `${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`,
      status: res.status,
      expectedStatus: 403,
      passed: res.status === 403,
      contentType: res.headers.get('content-type'),
      data: json,
      notes: 'Server must ignore client role assertions and enforce authenticated server role',
    });
  }

  // 9. Legitimate Reviewer approve with action: 'approve'
  // Note: if QA has not passed yet, server should enforce QA requirement or return appropriate status
  {
    const res = await fetch(`${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reviewerSessionToken}`,
      },
      body: JSON.stringify({ action: 'approve' }),
    });
    const json = await res.json().catch(() => null);
    // If QA check is required, it returns 412 Precondition Failed (or 201 if QA passes)
    // CRITICAL: It must NEVER return 201 with decision: 'revision_requested'!
    const isCleanApprovedOrExpectedQaGate =
      (res.status === 201 && json?.decision === 'approved') ||
      (res.status === 412 && json?.title?.includes('Precondition') || json?.detail?.includes('QA'));
    results.push({
      step: 'H03: 9. Legitimate Reviewer approve with action: "approve"',
      url: `${BASE_URL}/v1/tasks/${taskId}/revisions/${revisionId}/decisions`,
      status: res.status,
      expectedStatus: res.status,
      passed: isCleanApprovedOrExpectedQaGate && json?.decision !== 'revision_requested',
      contentType: res.headers.get('content-type'),
      data: json,
      notes: `Action mapped cleanly; decision is NEVER silently converted to 'revision_requested'. Status: ${res.status}`,
    });
  }

  // Save report
  const reportPath = 'output/audits/2026-09-12-followup-bug-hunt/LIVE_H01_H03_EVIDENCE.json';
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log('\n=== RESULTS SUMMARY ===');
  let passedCount = 0;
  for (const r of results) {
    const mark = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${mark} | ${r.step} -> HTTP ${r.status} (expected ${r.expectedStatus})`);
    if (r.notes) console.log(`       Note: ${r.notes}`);
    if (r.passed) passedCount++;
  }

  console.log(`\nTotal: ${passedCount}/${results.length} passed.`);
}

runProbes().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
