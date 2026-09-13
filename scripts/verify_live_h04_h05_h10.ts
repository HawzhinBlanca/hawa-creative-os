import fs from 'node:fs';
import { renderOperationsToSvg, getKaaeOfficialLogoDataUri } from '../packages/creative/src/operations-to-svg.js';
import { CanvaDesignStudioAdapter } from '../packages/integrations/src/canva-design-studio-adapter.js';
import { CanvaConnectClient } from '../packages/integrations/src/canva-connect-client.js';
import { parseInvitationContent, buildKaaeInvitationOperations } from '../packages/creative/src/templates/kaae-invitation.template.js';

interface TestResult {
  suite: string;
  test: string;
  passed: boolean;
  expected: any;
  actual: any;
  notes?: string;
}

async function run() {
  const results: TestResult[] = [];
  console.log('=== VERIFYING H04, H05, H10 & KEYNOTE PRESERVATION ===\n');

  // --- H10: Client Asset Isolation (Another client logo never replaced with KAAE) ---
  {
    const svg = renderOperationsToSvg([
      {
        op: 'addImage',
        pageId: 'p1',
        nodeId: 'another_client_logo',
        asset: {
          storageKey: 'client-b/approved-logo.png',
          sha256: 'another-client-approved-hash',
          mimeType: 'image/png',
        },
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      } as any,
    ], 200, 200);

    const kaaeLogo = getKaaeOfficialLogoDataUri();
    const replaced = Boolean(kaaeLogo && svg.includes(kaaeLogo));

    results.push({
      suite: 'H10: Client Asset Isolation',
      test: 'Another client logo is not replaced with KAAE logo',
      passed: !replaced,
      expected: false,
      actual: replaced,
      notes: replaced ? 'CRITICAL: Another client logo was replaced with KAAE' : 'Clean: client isolation preserved',
    });
  }

  // --- H05: Scoped Durable Idempotency ---
  {
    const studio = new CanvaDesignStudioAdapter();
    const ctxA: any = {
      tenantId: 'tenant-audit-a',
      taskId: 'task-a',
      actor: { type: 'operator', id: 'op_a' },
      correlationId: 'corr_a',
      idempotencyKey: 'audit-shared-idempotency-key',
      deadline: new Date(Date.now() + 60000).toISOString(),
    };
    const reqA: any = {
      name: 'Initial document payload',
      pages: [{ id: 'p1', width: 1080, height: 1350, unit: 'px', language: 'en', direction: 'ltr' }],
      clientDnaVersion: 1,
    };

    const docA = await studio.create(ctxA, reqA);
    const docB = await studio.create({ ...ctxA, tenantId: 'tenant-audit-b', taskId: 'task-b' }, reqA);
    const docAReplay = await studio.create(ctxA, reqA);
    const docAChanged = await studio.create(ctxA, { ...reqA, name: 'Changed title', pages: [{ ...reqA.pages[0], width: 800 }] });

    const crossTenantLeaked = Boolean(docA.value?.documentId && docA.value?.documentId === docB.value?.documentId);
    results.push({
      suite: 'H05: Scoped Durable Idempotency',
      test: 'Cross-tenant identical key does not leak document between tenants',
      passed: !crossTenantLeaked,
      expected: false,
      actual: crossTenantLeaked,
      notes: `Tenant A doc: ${docA.value?.documentId}, Tenant B doc: ${docB.value?.documentId}`,
    });

    const replayMatched = docA.value?.documentId === docAReplay.value?.documentId;
    results.push({
      suite: 'H05: Scoped Durable Idempotency',
      test: 'Exact same key and payload resolves identical document reference',
      passed: replayMatched,
      expected: true,
      actual: replayMatched,
    });

    const changedPayloadConflicted = !docAChanged.ok && docAChanged.error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    results.push({
      suite: 'H05: Scoped Durable Idempotency',
      test: 'Same key with changed payload returns conflict error',
      passed: changedPayloadConflicted,
      expected: true,
      actual: changedPayloadConflicted,
      notes: `Changed payload response: ok=${docAChanged.ok}, code=${docAChanged.error?.code}`,
    });
  }

  // --- H04: Authentic Canva Adapter with PKCE Authorization ---
  {
    const client = new CanvaConnectClient({
      clientId: 'audit_pkce_client_id',
      clientSecret: 'audit_pkce_client_secret',
    });

    const pkce = client.generatePkceAuthorization({
      redirectUri: 'https://hawa.design/api/oauth/canva/callback',
      scopes: ['design:content:read', 'design:content:write'],
    });

    const validUrl =
      pkce.authorizationUrl.includes('https://www.canva.com/api/oauth/authorize') &&
      pkce.authorizationUrl.includes('code_challenge=') &&
      pkce.authorizationUrl.includes('code_challenge_method=S256');

    results.push({
      suite: 'H04: Authentic Canva Adapter',
      test: 'Generates valid PKCE authorization URL with S256 challenge',
      passed: validUrl && Boolean(pkce.codeVerifier),
      expected: true,
      actual: validUrl,
      notes: `Code challenge: ${pkce.codeChallenge.slice(0, 12)}..., Verifier length: ${pkce.codeVerifier.length}`,
    });
  }

  // --- H08 Preview: Keynote Preservation on Multiple Paragraphs ---
  {
    const originalText = `THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION
Mr. / Ms. / Dr. [Full Name]
The Kurdistan Accrediting Association for Education cordially requests the honor of your presence.
The Prime Minister of the Kurdistan Regional Government will officially announce the National Standards.
September 9, 2026 | 2:30 PM
Saad Abdullah Hall, Erbil`;

    const secondPrimeMinisterText = 'A second Prime Minister address will follow the main event.';
    const parsed = parseInvitationContent(originalText + '\n\n' + secondPrimeMinisterText);
    const operations = buildKaaeInvitationOperations(parsed);
    const texts = operations.filter((o: any) => o.op === 'addText').map((o: any) => o.text);

    const originalKeynotePreserved = texts.some((t: string) => t.includes('will officially announce the National Standards'));
    const secondParagraphPreserved = texts.some((t: string) => t.includes(secondPrimeMinisterText));

    results.push({
      suite: 'H08: Exact Brief & Copy Preservation',
      test: 'Second Prime Minister paragraph does not overwrite the original keynote',
      passed: originalKeynotePreserved && secondParagraphPreserved,
      expected: true,
      actual: originalKeynotePreserved && secondParagraphPreserved,
      notes: `Original preserved: ${originalKeynotePreserved}, Second preserved: ${secondParagraphPreserved}`,
    });
  }

  console.log('=== RESULTS SUMMARY ===');
  let passedCount = 0;
  for (const r of results) {
    const mark = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${mark} | [${r.suite}] ${r.test}`);
    if (r.notes) console.log(`       Note: ${r.notes}`);
    if (r.passed) passedCount++;
  }

  console.log(`\nTotal: ${passedCount}/${results.length} passed.`);

  const outPath = 'output/audits/2026-09-13-h01-h03-repairs/LIVE_H04_H05_H10_EVIDENCE.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
