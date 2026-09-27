/** Full deployed application rehearsal. External adapters are explicit fakes; Docling is real. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAOS_DIR, REPO_ROOT, deploymentReceipt, fakes, kill, query, secrets, sql, start, waitHealthy } from './stack.js';
import { KAAE_CLIENT_ID } from './provision.js';
import { captureForReview } from '../../../../apps/desk/src/services/canvaCapture.js';
import { checkedCanvaExportFixture } from '../../src/canva-export-fixture.js';
import { computeDnaHash } from '../../../../apps/core/src/core-helpers.js';
import { chatInboxInvocations, imageDocumentUpdate, sendToChatInbox, tasksOfChat, textUpdate, waitUntil,
  type InvariantResult } from './scenario.js';

const origin = 'http://127.0.0.1:56081';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Request = { request_id: string; current_task_id: string; rev: string; stage: string };

export async function candidateSources(chat: string, events: string[], suiteStarted: number): Promise<InvariantResult[]> {
  const checks: InvariantResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const deployment = deploymentReceipt();
  check('every candidate container was created after this rehearsal started',
    ['core', 'worker-blue', 'desk', 'docling', 'nginx', 'restate', 'postgres', 'fakes'].every(service =>
      Date.parse(deployment.containers[service]?.createdAt) >= suiteStarted),
    `rehearsal started ${new Date(suiteStarted).toISOString()}`);
  check('Core, worker and Desk image labels match the candidate checkout', ['core', 'worker-blue', 'desk'].every(service =>
    deployment.containers[service]?.buildCommit === deployment.commit && /^sha256:[0-9a-f]{64}$/.test(deployment.containers[service]?.imageId)),
    `build ${deployment.commit}; changed source files=${Object.keys(deployment.sourceChanges).length}`);
  check('provider callers and the real parser have only internal networks',
    deployment.networks.includes('hawa-chaos_chaos|true') && deployment.networks.includes('hawa-chaos_parser|true') &&
    ['core', 'worker-blue', 'docling'].every(service => deployment.containers[service]?.networks.length > 0 &&
      deployment.containers[service].networks.every((network: string) => ['hawa-chaos_chaos', 'hawa-chaos_parser'].includes(network))),
    deployment.networks.join(', '));
  const page = await fetch(origin);
  const html = await page.text(), script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  check('production Desk HTML is served through production nginx', page.ok && !!script, `HTTP ${page.status}`);
  const js = await fetch(new URL(script!, origin));
  check('the built Desk entry asset is present', js.ok && (await js.arrayBuffer()).byteLength > 1000, `HTTP ${js.status}`);
  const login = await fetch(`${origin}/v1/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: secrets().CHAOS_BEARER_TOKEN }) });
  const session = await login.json() as { token?: string; durable?: boolean };
  check('Desk session is persisted by the running Core', login.status === 201 && session.durable === true && !!session.token, `HTTP ${login.status}; durable=${session.durable}`);
  // Temporary synthetic session for optional browser inspection, never release evidence or logs.
  writeFileSync(join(CHAOS_DIR, '.run', 'candidate-session.json'), JSON.stringify({ origin, token: session.token }), { mode: 0o600 });
  const get = (path: string) => fetch(`${origin}/v1${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  const action = async (path: string, body: unknown, key: string = randomUUID(), token = secrets().CHAOS_REVIEWER_KEY) => {
    const response = await fetch(`${origin}/v1${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify(body) });
    const json = await response.json() as any;
    if (!response.ok) throw new Error(`Desk action ${path}: HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  const requests = () => query<Request>(sql`SELECT request_id,current_task_id,rev,stage FROM hawa.requests WHERE chat_id=${chat}`);
  const review = (revision: number) => waitUntil(`request review at rev ${revision}`, async () => {
    const [r] = await requests(); return r?.stage === 'in_review' && Number(r.rev) === revision ? r : null;
  });
  const retained = async (updateId: number) => waitUntil(`retained source ${updateId}`, async () => {
    const response = await get(`/clients/${KAAE_CLIENT_ID}/source-files`);
    if (!response.ok) throw new Error(`source listing: HTTP ${response.status}`);
    const list = await response.json() as { items: Array<{ updateId: number; documentId: string | null; stage: string }> };
    return list.items.find(item => item.updateId === updateId && item.stage === 'ready');
  });
  const confirm = async (messageId: number, copy: string) => {
    const update: {message: Record<string, unknown>} = textUpdate(chat, `/use_source\n${copy}`);
    update.message.reply_to_message = { message_id: messageId };
    const [id] = await fakes.updates([update]); return { ...update, update_id: id };
  };
  const verifyOriginal = async (id: number, bytes: Buffer, mime: string) => {
    const response = await get(`/clients/${KAAE_CLIENT_ID}/source-files/${id}/content`);
    const received = new Uint8Array(await response.arrayBuffer());
    check(`${mime} original crosses nginx byte-identically`, response.ok && hash(received) === hash(bytes) && response.headers.get('content-type') === mime,
      `HTTP ${response.status}; SHA-256 ${hash(received)}`);
  };

  const pdf = readFileSync(join(REPO_ROOT, 'services/docling/fixtures/two-pages.pdf'));
  const fileId = `candidate-pdf-${chat}`;
  await fakes.file({ file_id: fileId, mime: 'application/pdf', contentBase64: pdf.toString('base64') });
  const source = imageDocumentUpdate(chat, fileId, pdf.length, '/new\nClient: KAAE\nSize: 1080x1350\nFormal navy and gold layout; preserve exact factual copy.');
  source.message.document = { ...source.message.document, mime_type: 'application/pdf', file_name: 'two-pages.pdf' };
  const [pdfId] = await fakes.updates([source]);
  const saved = await retained(pdfId);
  check('PDF source review creates no premature task', (await tasksOfChat(chat)).length === 0 && !!saved.documentId, `source ${pdfId}`);
  await verifyOriginal(pdfId, pdf, 'application/pdf');
  const inspected = await get(`/clients/${KAAE_CLIENT_ID}/documents/${saved.documentId}`);
  const document = await inspected.json() as any;
  const extraction = JSON.stringify(document);
  check('real local parser preserves both PDF pages and numeric copy', inspected.ok && extraction.includes('Hawa source page one 123.45') &&
    extraction.includes('Hawa source page two 678.90') && extraction.includes('docling-2.130.0'), `HTTP ${inspected.status}; source ${hash(pdf)}`);
  const copy = 'Hawa source page one 123.45\nHawa source page two 678.90';
  const confirmed = await confirm(source.message.message_id, copy);
  const first = await review(2);
  events.push(`PDF ${pdfId} → request ${first.request_id} → task ${first.current_task_id}`);
  const replayKey = `candidate-source-replay-${confirmed.update_id}`;
  const replay = await sendToChatInbox(chat, confirmed, replayKey);
  await waitUntil('both source confirmations journalled', async () => {
    const rows = (await chatInboxInvocations(chat)).filter(r => r.idempotency_key === `tg-${confirmed.update_id}` || r.idempotency_key === replayKey);
    return rows.length === 2 && rows.every(r => r.status === 'completed') ? rows : null;
  });
  check('duplicate source confirmation produces one task through Restate', [200, 202].includes(replay) && (await tasksOfChat(chat)).length === 1, `replay HTTP ${replay}`);

  kill('restate'); start('restate'); await waitHealthy('restate');
  kill('worker-blue'); start('worker-blue'); await waitHealthy('worker-blue');
  const afterRestart = await review(2);
  check('review wait survives Restate and worker process restart', afterRestart.request_id === first.request_id && afterRestart.current_task_id === first.current_task_id,
    `request ${afterRestart.request_id}; rev ${afterRestart.rev}`);
  events.push('Restate and worker SIGKILL/restart at the PDF review waitpoint');
  const [root] = await query<{revision: string}>(sql`SELECT current_design_revision_id AS revision FROM hawa.tasks WHERE id=${first.current_task_id}::uuid`);
  await action(`/tasks/${first.current_task_id}/revisions/${root.revision}/decisions`, { action: 'revision_requested', revisionRequest: {
    scope: 'copy', category: 'factual_error', targetNodes: ['copy'], priority: 'high', isReusableFeedback: false, comment: 'Use the requester-reviewed voice source for the revised copy.',
  } });
  const notice = await waitUntil('current revision notice is sent', async () => {
    const [r] = await query<{id: string}>(sql`SELECT payload->>'messageId' AS id FROM hawa.inbox_events WHERE source_account_id='telegram_delivery'
      AND event_kind='telegram_message_sent' AND source_event_id=${`lc:${first.request_id}:3:office-revision-notify:send`}`);
    return r?.id ? Number(r.id) : null;
  });
  const audio = readFileSync(join(REPO_ROOT, 'packages/testkit/fixtures/voice/silence-one-second.ogg'));
  const voiceFile = `candidate-voice-${chat}`;
  await fakes.file({ file_id: voiceFile, mime: 'audio/ogg', contentBase64: audio.toString('base64') });
  const voice: {message: Record<string, unknown>} = textUpdate(chat, ''); delete voice.message.text;
  voice.message.voice = { file_id: voiceFile, file_size: audio.length, mime_type: 'audio/ogg', duration: 99999 };
  voice.message.reply_to_message = { message_id: notice };
  const [voiceId] = await fakes.updates([voice]);
  await retained(voiceId); await verifyOriginal(voiceId, audio, 'audio/ogg');
  const voiceResponse = await get(`/clients/${KAAE_CLIENT_ID}/source-files/${voiceId}/review`);
  const voiceReview = await voiceResponse.json() as any;
  check('unapproved voice model remains manual with honest timing and billing', voiceResponse.ok && voiceReview.state === 'manual' &&
    voiceReview.transcript === null && voiceReview.estimatedUsd === null && voiceReview.actualUsd === null && voiceReview.audio?.durationSeconds === 1,
    JSON.stringify(voiceReview));
  check('voice source does not create a child before exact-copy review', (await tasksOfChat(chat)).length === 1, `voice source ${voiceId}`);
  const revisedCopy = `${copy}\nRevised for 27 September 2026`;
  const voiceConfirmation = await confirm(Number(voice.message.message_id), revisedCopy);
  const child = await review(5);
  events.push(`voice ${voiceId} → reviewed revision task ${child.current_task_id}`);
  const [revision] = await query<{id: string}>(sql`SELECT current_design_revision_id AS id FROM hawa.tasks WHERE id=${child.current_task_id}::uuid`);
  const [qc] = await query<{status: string;critical_pass: boolean;report: any}>(sql`SELECT status,critical_pass,report FROM hawa.qc_runs
    WHERE task_id=${child.current_task_id}::uuid AND design_revision_id=${revision.id}::uuid ORDER BY started_at DESC LIMIT 1`);
  check('revised simulated Canva export passes configured QA', qc?.status === 'passed' && qc.critical_pass && !!qc.report?.exportArtifactId, `QC ${qc?.status}`);
  const approval = await action(`/tasks/${child.current_task_id}/revisions/${revision.id}/decisions`, {
    action: 'approve', reason: 'Synthetic workflow qualification; not a human creative-quality review.', pinnedExportIds: [qc.report.exportArtifactId],
  });
  await waitUntil('owned approval committed', async () => { const [r] = await requests(); return r?.stage === 'approved' && Number(r.rev) === 6 ? r : null; });
  await action(`/tasks/${child.current_task_id}/publish`, { approvalId: approval.decisionId });
  const delivered = await waitUntil('reviewed source request delivered', async () => { const [r] = await requests(); return r?.stage === 'delivered' ? r : null; });
  const tasks = await tasksOfChat(chat);
  check('PDF new request and voice revision reach one logical simulated delivery', tasks.length === 2 && tasks[1].state === 'complete' &&
    Number(delivered.rev) === 8 && delivered.current_task_id === child.current_task_id, JSON.stringify({tasks, delivered}));
  const confirmations = await query<{payload: {copy: string; confirmationUpdateId: number}}>(sql`SELECT payload FROM hawa.inbox_events
    WHERE source_account_id='lifecycle_source_confirmation' AND source_event_id IN (${String(pdfId)},${String(voiceId)})`);
  check('retained confirmations preserve exact source copy', confirmations.length === 2 && confirmations.some(c => c.payload.copy === copy) &&
    confirmations.some(c => c.payload.copy === revisedCopy && c.payload.confirmationUpdateId === voiceConfirmation.update_id), 'two immutable confirmations');
  const downloads = (await fakes.polls()).downloads?.filter((id: string) => [fileId, voiceFile].includes(id)) ?? [];
  check('the two source originals were downloaded once each', downloads.length === 2 && new Set(downloads).size === 2, JSON.stringify(downloads));
  const [attempts] = await query<{n: string}>(sql`SELECT count(*) AS n FROM hawa.inbox_events WHERE source_account_id='lifecycle_voice_attempt'`);
  check('manual-only voice caused no paid transcription attempt', Number(attempts.n) === 0, `attempts=${attempts.n}`);

  // The browser rehearsal exposed a real mismatch: current Desk requests have no headlineEn.
  // Exercise that saved shape through nginx and the actual planner, including uncertain-submit replay.
  const deskBody = {
    clientId: KAAE_CLIENT_ID, title: 'Candidate Desk bilingual intake', priority: 'routine',
    copyEn: 'Office trial — 123.45 USD\n27 September 2026', copyCkb: 'تاقیکردنەوە — ١٢٣.٤٥',
    designInstructions: 'Synthetic local trial. Navy and gold, independently editable English and Sorani text. Preserve all numerals and punctuation.',
    referenceAssets: '', workflow: 'canva_manual', source: { platform: 'hawa_desk', externalId: 'operator-desk' },
  };
  const intake = { ...deskBody, description: `${deskBody.copyEn}\n\n${deskBody.copyCkb}` }, intakeKey = randomUUID();
  const manual = await action('/tasks', intake, intakeKey, session.token);
  const repeated = await action('/tasks', intake, intakeKey, session.token);
  check('bilingual Desk intake replay returns one task', !!manual.id && repeated.id === manual.id, `task ${manual.id}`);
  const generationKey = randomUUID();
  const generated = await action(`/tasks/${manual.id}/canva/generate`, { width: 1080, height: 1350 }, generationKey, session.token);
  const resumed = await action(`/tasks/${manual.id}/canva/generate`, { width: 1080, height: 1350 }, generationKey, session.token);
  check('saved bilingual Desk copy imports through the explicit generation action', generated.status === 'retrieved' &&
    !!generated.planId && resumed.planId === generated.planId, `status=${generated.status}; replay=${resumed.status}`);
  const plans = await query<{request: {copy: string[]; instructions: string}; source_sha256: string}>(sql`
    SELECT request,source_sha256 FROM hawa.canva_design_plans WHERE task_id=${manual.id}::uuid`);
  check('the saved plan preserves both exact copy blocks and separate instructions', plans.length === 1 &&
    JSON.stringify(plans[0].request.copy) === JSON.stringify([deskBody.copyEn, deskBody.copyCkb]) &&
    plans[0].request.instructions === deskBody.designInstructions && /^[0-9a-f]{64}$/.test(plans[0].source_sha256),
    `plans=${plans.length}; source=${plans[0]?.source_sha256}`);
  const captureKey = randomUUID();
  const captureApi = {
    taskState: async (id: string) => (await get(`/tasks/${id}/canva`)).json(),
    export: (id: string, format: 'png' | 'pptx', expectedVersion: number, key: string) =>
      action(`/tasks/${id}/canva/exports`, {format,expectedVersion}, key, session.token),
    resume: (id: string, operationId: string) =>
      action(`/tasks/${id}/canva/exports/${operationId}/resume`, {}, randomUUID(), session.token),
  };
  const captured = await captureForReview(captureApi, manual.id, {key:captureKey,waitMs:100});
  check('Desk capture records a review from retained PNG and checked live text', captured.tone === 'success' && captured.completed === true, captured.text);
  const repeatedCapture = await captureForReview(captureApi, manual.id, {key:captureKey,waitMs:100});
  const [manualRevision] = await query<{id:string;neutral_manifest:{nativeVerification:string;nodes:unknown[]};count:string}>(sql`
    SELECT r.id,r.neutral_manifest,(SELECT count(*) FROM hawa.design_revisions WHERE task_id=${manual.id}::uuid) AS count
    FROM hawa.tasks t JOIN hawa.design_revisions r ON r.id=t.current_design_revision_id WHERE t.id=${manual.id}::uuid`);
  check('capture replay preserves one revision without inventing native editability', repeatedCapture.tone === 'success' &&
    Number(manualRevision.count) === 1 && manualRevision.neutral_manifest.nodes.length === 2 &&
    manualRevision.neutral_manifest.nativeVerification === 'unverified', `revisions=${manualRevision.count}`);
  const [manualQc] = await query<{report:{exportArtifactId:string;exportSha256:string;previewArtifactId:string;rtlVisualReviewRequired:boolean}}>(sql`
    SELECT report FROM hawa.qc_runs WHERE design_revision_id=${manualRevision.id}::uuid ORDER BY started_at DESC LIMIT 1`);
  const approved = await action(`/tasks/${manual.id}/revisions/${manualRevision.id}/decisions`, {action:'approve',
    reason:'Synthetic manual workflow rehearsal, not a human creative-quality decision.',
    pinnedExportIds:[manualQc.report.previewArtifactId,manualQc.report.exportArtifactId],
    ...(manualQc.report.rtlVisualReviewRequired ? {rtlVisualReview:{confirmed:true,exportSha256:manualQc.report.exportSha256}} : {}),
  });
  await action(`/tasks/${manual.id}/publish`, {approvalId:approved.decisionId});
  const final = await waitUntil('manual Desk task archived', async () => {
    const [task] = await query<{state:string}>(sql`SELECT state FROM hawa.tasks WHERE id=${manual.id}::uuid`);
    return task?.state === 'complete' ? task : null;
  });
  const [manualReceipts] = await query<{approvals:string;publications:string}>(sql`
    SELECT (SELECT count(*) FROM hawa.approvals WHERE task_id=${manual.id}::uuid AND decision='approved') AS approvals,
      (SELECT count(*) FROM hawa.publications WHERE task_id=${manual.id}::uuid AND state='complete') AS publications`);
  check('manual review reaches one simulated approval and completed archive publication', final.state === 'complete' &&
    Number(manualReceipts.approvals) === 1 && Number(manualReceipts.publications) === 1, JSON.stringify(manualReceipts));
  events.push(`Desk bilingual request ${manual.id} → saved plan ${generated.planId} → simulated Canva import → captured review → simulated approval/publication`);

  const blankClient=randomUUID(),tenantId='00000000-0000-4000-a000-000000000001';
  const blankDna={tenantId,clientId:blankClient,name:'Synthetic blank-design client',code:blankClient,version:1,status:'active',
    fonts:[{family:'Verdana',license:'Synthetic rehearsal fixture',supportedLocales:['en']}],
    destinations:{productionFolderId:'chaos-blank-production',spreadsheetId:'chaos-blank-tracker',sheetId:0},
    approvalPolicy:{requiredRoles:['art_director'],allowAutoApproval:false,autoApprovalEligibleTemplates:[]}};
  await query(sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${blankClient}::uuid,${tenantId}::uuid,${blankClient},'Synthetic blank-design client')`);
  await query(sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
    VALUES(${tenantId}::uuid,${blankClient}::uuid,1,'active',${JSON.stringify(blankDna)}::jsonb,${computeDnaHash(blankDna)},'00000000-0000-4000-b000-000000000001'::uuid)`);
  const blank=await action('/tasks',{...intake,clientId:blankClient,title:'Candidate blank native design',copyEn:'Exact copy 123.45',copyCkb:'',
    description:'Exact copy 123.45'},randomUUID(),session.token);
  const created=await action(`/tasks/${blank.id}/canva/design`,{width:640,height:640},randomUUID(),session.token);
  check('blank design is created through the deployed Canva adapter',created.status==='retrieved' && !!created.designId,`task ${blank.id}; design ${created.designId}`);
  const fixture=await checkedCanvaExportFixture('Exact copy 123.45');
  await fakes.canvaManualEdit({designId:created.designId,contentBase64:fixture.bytes.toString('base64')});
  const blankCapture=await captureForReview(captureApi,blank.id,{key:randomUUID(),waitMs:100});
  const [blankReview]=await query<{revision_id:string;report:{exportArtifactId:string;previewArtifactId:string};sources:string;policy:{kind:string;dnaVersion:number}}>(sql`
    SELECT t.current_design_revision_id AS revision_id,q.report,o.metadata->'checkingPolicy' AS policy,
      (SELECT count(*) FROM hawa.canva_editable_sources WHERE task_id=t.id) AS sources
    FROM hawa.tasks t JOIN hawa.qc_runs q ON q.design_revision_id=t.current_design_revision_id
    JOIN hawa.canva_export_bytes b ON b.id=(q.report->>'exportArtifactId')::uuid
    JOIN hawa.canva_remote_operations o ON o.id=b.operation_id WHERE t.id=${blank.id}::uuid`);
  check('blank design reaches checked review using DNA and no invented imported source',blankCapture.tone==='success' &&
    Number(blankReview?.sources)===0 && blankReview?.policy.kind==='manual_client_dna' && blankReview.policy.dnaVersion===1,blankCapture.text);
  const blankApproval=await action(`/tasks/${blank.id}/revisions/${blankReview.revision_id}/decisions`,{action:'approve',
    reason:'Synthetic blank-design rehearsal; native editability and human quality remain unqualified.',
    pinnedExportIds:[blankReview.report.previewArtifactId,blankReview.report.exportArtifactId]});
  await action(`/tasks/${blank.id}/publish`,{approvalId:blankApproval.decisionId});
  await waitUntil('blank task publication',async()=>{
    const [task]=await query<{state:string}>(sql`SELECT state FROM hawa.tasks WHERE id=${blank.id}::uuid`);
    return task?.state==='complete'?task:null;
  });
  const ledger=(await fakes.canvaLedger()).filter(entry=>entry.designId===created.designId);
  check('blank capture completes simulated publication with one explicit manual edit and no import',
    ledger.filter(entry=>entry.kind==='manual_edit').length===1 && !ledger.some(entry=>entry.kind==='import'),`task ${blank.id}`);
  events.push(`Blank design ${blank.id} → explicit simulated manual edit → DNA-checked review → simulated approval/publication; real native editing remains unverified`);
  return checks;
}
