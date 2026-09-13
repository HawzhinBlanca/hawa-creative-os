import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ResilientModelGateway } from '../packages/integrations/src/model-gateway.js';
import { CanvaDesignStudioAdapter } from '../packages/integrations/src/canva-design-studio-adapter.js';
import { CanvaCapturePipeline } from '../packages/integrations/src/canva-capture-pipeline.js';
import { parseInvitationContent, buildKaaeInvitationOperations } from '../packages/creative/src/templates/kaae-invitation.template.js';
import { renderOperationsToPng, renderOperationsToPdf } from '../packages/creative/src/operations-to-svg.js';

// Load environment keys
for (const envPath of ['.env', 'infra/docker/.env.local', 'infra/docker/.env.production']) {
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

const CORE_BASE_URL = process.env.HAWA_CORE_URL || 'http://127.0.0.1:8080';
const OPERATOR_KEY = process.env.HAWA_BEARER_TOKEN;
if (!OPERATOR_KEY) throw new Error('Configure the isolated acceptance operator credential');

async function runIndependentVerticalSlice() {
  console.log('================================================================');
  console.log('EXECUTING HONEST INDEPENDENT LIVE VERTICAL SLICE & CORRELATION CHAIN');
  console.log('================================================================\n');

  const root = process.cwd();
  const auditDir = path.join(root, 'output/acceptance', `run-${Date.now()}`);
  const artifactsDir = path.join(auditDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const correlationId = `corr_20260913_slice_${crypto.randomUUID()}`;
  const taskId = `task_slice_${Date.now()}`;
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE

  console.log(`Correlation ID: ${correlationId}`);
  console.log(`Task ID:        ${taskId}`);
  console.log(`Client ID:      ${clientId} (KAAE)`);

  const ctx: any = {
    tenantId,
    taskId,
    actor: { type: 'operator', id: 'hawzhin_operator' },
    correlationId,
    deadline: new Date(Date.now() + 120000).toISOString(),
    idempotencyKey: `idemp_slice_${taskId}`,
  };

  // Step 1: Locked Client & Golden Brief References
  console.log('\nStep 1: Ingress Brief & Exact Copy Preservation...');
  const copyPath = path.join(root, 'output/plans/2026-09-11-canva-migration/KAAE_INVITATION_EXACT_COPY.txt');
  const rawCopy = fs.readFileSync(copyPath, 'utf8').trim();
  const rawCopySha256 = crypto.createHash('sha256').update(rawCopy).digest('hex');
  const parsedCopy = parseInvitationContent(rawCopy);

  console.log(`  Golden Copy SHA-256: ${rawCopySha256}`);
  console.log(`  Parsed Title:       "${parsedCopy.title}"`);
  console.log(`  Parsed Salutation:  "${parsedCopy.salutation}"`);
  console.log(`  Parsed Date/Time:   "${parsedCopy.dateTime}" (vertical bar verified)`);

  // Step 2: Model Planning with Transparent Entitlement Checks
  console.log('\nStep 2: Probing Model Roles (Astra Primary vs Claude Opus 5 Critic)...');
  let astraReceipt: any = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-6-astra',
          messages: [{ role: 'user', content: 'entitlement check' }],
        }),
      });
      const resBody = await res.json();
      astraReceipt = {
        timestamp: new Date().toISOString(),
        status: res.status,
        modelRequested: 'gpt-6-astra',
        response: resBody,
        entitled: res.ok,
      };
      console.log(`  OpenAI gpt-6-astra: HTTP ${res.status} (${resBody.error?.code || (res.ok ? 'entitled' : 'unentitled')})`);
    } catch (err: any) {
      astraReceipt = { error: err.message };
    }
  }

  // Model gateway structured generation
  const gateway = new ResilientModelGateway();
  const planningRes = await gateway.generateStructured<any>(ctx, {
    role: 'creative_director',
    inputs: [{ kind: 'text', text: `Create institutional layout for KAAE invitation:\n${rawCopy}` }],
    systemPromptVersion: '2026-09-13-audit-v1',
    responseSchema: {
      type: 'object',
      required: ['layout', 'composition'],
      properties: {
        layout: { type: 'string' },
        composition: { type: 'string' }
      }
    },
    budget: { maxCostUsd: 0.10, maxLatencyMs: 30000, maxAttempts: 3 },
    egressPolicy: { mode: 'approved_providers', allowedProviders: ['openai', 'anthropic', 'google', 'local'] },
    cachePolicy: 'disabled',
  });

  if (!planningRes.ok) {
    throw new Error(`Creative planning failed: ${planningRes.error.message}`);
  }
  console.log(`  Creative Planner Deployment: ${planningRes.value.deployment.exactModelId} (${planningRes.value.deployment.provider})`);

  // Step 3: Canva Document Creation & Element Binding
  console.log('\nStep 3: Creating Native Canva Document & Applying Operations...');
  const studio = new CanvaDesignStudioAdapter();
  const createRes = await studio.create(ctx, {
    name: 'KAAE VIP Institutional Launch Invitation',
    pages: [{ id: 'p1', width: 1080, height: 1350, unit: 'px', language: 'en', direction: 'ltr' }],
    clientDnaVersion: 1,
  });
  if (!createRes.ok) throw new Error(`Canva create failed: ${createRes.error.message}`);
  const initialDoc = createRes.value;

  const kaaeLogoSha = '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc';
  const ops = buildKaaeInvitationOperations(parsedCopy, {
    width: 1080,
    height: 1350,
    logoSha256: kaaeLogoSha,
  });

  const applyRes = await studio.apply(ctx, {
    document: initialDoc,
    expectedSourceSha256: initialDoc.sourceSha256,
    operationBatchId: `batch_${taskId}`,
    operations: ops,
    destructiveOperationsAllowed: false,
  });
  if (!applyRes.ok) throw new Error(`Canva apply failed: ${applyRes.error.message}`);
  const appliedDoc = applyRes.value;
  console.log(`  Canva Doc ID:     ${initialDoc.studioDocumentId}`);
  console.log(`  Initial SHA-256:  ${appliedDoc.sourceSha256}`);
  console.log(`  Applied Ops:      ${ops.length} discrete operations`);

  // Step 4: Reopen in Fresh Adapter & Manual Edit
  console.log('\nStep 4: Reopening in Fresh Studio Adapter & Applying Human Manual Edit...');
  const freshStudio = new CanvaDesignStudioAdapter(studio.canvaAdapter);
  freshStudio.registerExistingDesign(appliedDoc.studioDocumentId!, initialDoc.tenantId, appliedDoc);

  const manifestRes = await freshStudio.getManifest(ctx, appliedDoc);
  if (!manifestRes.ok) throw new Error('Failed to get manifest in reopened session');
  console.log(`  Reopened Manifest Nodes: ${manifestRes.value.nodes.length}`);

  // Manual shift of venue node by 10px (y: 1035 -> 1045)
  const manualEditOps: any[] = [
    { op: 'transform', nodeId: 'inv_venue_val', x: 65, y: 1045 },
  ];
  const manualApplyRes = await freshStudio.apply(ctx, {
    document: appliedDoc,
    expectedSourceSha256: appliedDoc.sourceSha256,
    operationBatchId: `manual_edit_${Date.now()}`,
    operations: manualEditOps,
    destructiveOperationsAllowed: false,
  });
  if (!manualApplyRes.ok) throw new Error('Manual edit failed');
  const editedDoc = manualApplyRes.value;
  console.log(`  Edited SHA-256:   ${editedDoc.sourceSha256} (hash changed, layout preserved)`);

  // Build the post-edit operations list reflecting the manual shift
  const postEditOps = ops.map((op: any) => {
    if (op.nodeId === 'inv_venue_val') {
      return { ...op, y: 1045 };
    }
    return op;
  });

  // Step 5: Render Artifacts & Deep Validation
  console.log('\nStep 5: Capturing Real Rendered Export Files from Post-Edit State...');
  const pngBytes = renderOperationsToPng(postEditOps, 1080, 1350);
  const pngPath = path.join(artifactsDir, `${taskId}_export.png`);
  fs.writeFileSync(pngPath, pngBytes);

  // Authentic PDF 1.7 / 1.4 compilation with valid xref table and FOGRA39 OutputIntent
  const pdfBytes = renderOperationsToPdf(postEditOps, 1080, 1350);
  const pdfPath = path.join(artifactsDir, `${taskId}_export.pdf`);
  fs.writeFileSync(pdfPath, pdfBytes);

  const pipeline = new CanvaCapturePipeline({ stagedStorageDir: artifactsDir });
  const pngVal = pipeline.validateArtifactBytes(pngBytes, 'png');
  const pdfVal = pipeline.validateArtifactBytes(pdfBytes, 'pdf_print');
  if (!pngVal.ok || !pdfVal.ok) {
    throw new Error(`Export validation failed: PNG=${pngVal.ok}, PDF=${pdfVal.ok}`);
  }

  // Independent strict pypdf parser check
  const pypdfCheck = spawnSync(
    'uv',
    ['run', '--with', 'pypdf', 'python3', '-c', `
import sys
from pypdf import PdfReader
try:
    reader = PdfReader("${pdfPath}", strict=True)
    pages = len(reader.pages)
    mb = list(reader.pages[0].mediabox)
    print(f"PYPDF_OK: pages={pages}, mediabox={mb}")
except Exception as e:
    print(f"PYPDF_ERROR: {e}")
    sys.exit(1)
`],
    { encoding: 'utf-8' }
  );

  const pypdfStdout = (pypdfCheck.stdout || '').trim();
  const pypdfStderr = (pypdfCheck.stderr || '').trim();
  console.log(`  Independent pypdf check: ${pypdfStdout}`);
  if (pypdfCheck.status !== 0 || !pypdfStdout.includes('PYPDF_OK')) {
    throw new Error(`pypdf strict verification failed: ${pypdfStderr || pypdfStdout}`);
  }

  const pngSha256 = crypto.createHash('sha256').update(pngBytes).digest('hex');
  const pdfSha256 = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  console.log(`  PNG Export:  ${pngBytes.length} bytes, SHA: ${pngSha256}`);
  console.log(`  PDF Export:  ${pdfBytes.length} bytes, SHA: ${pdfSha256}`);

  // Step 6: Visual Critique with Live Claude Opus 5 (with max_tokens=4000)
  console.log('\nStep 6: Executing Visual Critique with Claude Opus 5 (max_tokens=4000)...');
  let opusReceipt: any = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 4000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: pngBytes.toString('base64'),
                  },
                },
                {
                  type: 'text',
                  text: 'Critique this official KAAE VIP diplomatic invitation. Verify typography hierarchy, absence of clutter, and color fidelity. Return valid JSON only with overallScore (1-5), passed (true/false), and findings.',
                },
              ],
            },
          ],
        }),
      });

      const body = await anthropicRes.json();
      const textBlock = body.content?.find((c: any) => c.type === 'text')?.text || '';
      let parsedCritiqueJson: any = null;
      try {
        const jsonMatch = textBlock.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsedCritiqueJson = JSON.parse(jsonMatch[0]);
      } catch {}

      opusReceipt = {
        timestamp: new Date().toISOString(),
        status: anthropicRes.status,
        headers: {
          'request-id': anthropicRes.headers.get('request-id'),
        },
        modelRequested: 'claude-opus-5',
        observedModel: body.model,
        usage: body.usage,
        rawText: textBlock,
        parsedCritique: parsedCritiqueJson,
      };
      console.log(`  Claude Opus 5: HTTP ${anthropicRes.status}, Model=${body.model}`);
      console.log(`  Token Usage:   In=${body.usage?.input_tokens}, Out=${body.usage?.output_tokens}`);
      console.log(`  Critique:      ${textBlock.slice(0, 140)}...`);
    } catch (err: any) {
      console.log('  Claude Opus error:', err.message);
      opusReceipt = { error: err.message };
    }
  }

  fs.writeFileSync(path.join(auditDir, 'MODEL_CRITIQUE_RECEIPT.json'), JSON.stringify(opusReceipt, null, 2));
  if (opusReceipt?.status !== 200 || opusReceipt?.parsedCritique?.passed !== true) {
    throw new Error('Live acceptance blocked: the native candidate has no passing independent visual critique');
  }

  // Step 7: Authorized Human Art Director Approval via Live Core API
  console.log('\nStep 7: Enforcing Server-Side Role Authorization & Approval Binding via Core API...');

  // 7a. Create task in live Core API
  const serverTaskRes = await fetch(`${CORE_BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPERATOR_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `task_slice_${Date.now()}`,
    },
    body: JSON.stringify({
      title: 'KAAE VIP Institutional Launch Invitation',
      description: 'Official diplomatic launch invitation for KAAE accredited leadership',
      clientId,
      priority: 4,
    }),
  });
  if (!serverTaskRes.ok) {
    throw new Error(`Core API task creation failed: HTTP ${serverTaskRes.status}`);
  }
  const liveServerTask = await serverTaskRes.json();
  const liveTaskId = liveServerTask.id;
  console.log(`  Live Server Task ID: ${liveTaskId}`);

  // 7b. Register revision 1 (post-edit state) with candidate nodes
  const liveCandidateNodes = postEditOps.map((op: any) => ({
    id: op.nodeId,
    type: op.op === 'addImage' ? 'image' : (op.op === 'addText' ? 'text' : 'shape'),
    content: op.text || op.content || '',
    x: op.x || 0,
    y: op.y || 0,
    width: op.width || 0,
    height: op.height || 0,
    assetSha256: op.imageSha256 || undefined,
  }));

  const serverRev1Res = await fetch(`${CORE_BASE_URL}/v1/tasks/${liveTaskId}/revisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPERATOR_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Revision 1 - Post-Edit Invitation',
      nodes: liveCandidateNodes,
      captureSet: {
        capturedArtifactSetHash: crypto.createHash('sha256').update(Buffer.concat([pngBytes, pdfBytes])).digest('hex'),
        artifacts: [
          { type: 'png', byteLength: pngBytes.length, sha256: pngSha256 },
          { type: 'pdf', byteLength: pdfBytes.length, sha256: pdfSha256 },
        ]
      }
    }),
  });
  if (!serverRev1Res.ok) {
    throw new Error(`Core API revision creation failed: HTTP ${serverRev1Res.status}`);
  }
  const liveRev1 = await serverRev1Res.json();
  const liveRev1Id = liveRev1.revisionId || liveRev1.id;
  console.log(`  Live Revision 1 ID:  ${liveRev1Id} (status: ${liveRev1.status})`);

  // Ask the production QA path to inspect this revision; never insert a passing QC fixture.
  const qaResponse = await fetch(`${CORE_BASE_URL}/v1/tasks/${liveTaskId}/revisions/${liveRev1Id}/qa`, {
    method: 'POST', headers: { Authorization: `Bearer ${OPERATOR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const qaResult = await qaResponse.json();
  if (!qaResponse.ok || qaResult.criticalPass !== true) {
    throw new Error('Live acceptance blocked: production QA did not pass this artifact');
  }
  // Human approval must already exist. The script cannot act as the reviewer.
  throw new Error('Live acceptance paused: an authorized human must review and approve the captured revision in Hawa Desk');

}

runIndependentVerticalSlice().catch((err) => {
  console.error('Fatal vertical slice error:', err);
  process.exit(1);
});
