/** Full deployed application rehearsal. External adapters are explicit fakes; Docling is real. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAOS_DIR, REPO_ROOT, compose, deploymentReceipt, fakes, kill, query, secrets, sql, start, waitHealthy } from './stack.js';
import { KAAE_CLIENT_ID } from './provision.js';
import { captureForReview } from '../../../../apps/desk/src/services/canvaCapture.js';
import { checkedCanvaExportFixture } from '../../src/canva-export-fixture.js';
import { computeDnaHash } from '../../../../apps/core/src/core-helpers.js';
import { restorePendingDelivery } from './candidate-recovery.js';
import { candidateEvaluationSettlement } from './evaluation-settlement.js';
import { candidateStudioSettlement } from './studio-settlement.js';
import { appendFixtureCopy } from './fixture-native-edit.js';
import { retainCandidateAssetSources } from './candidate-asset-sources.js';
import { chatInboxInvocations, designOutcome, RequestEndedError, imageDocumentUpdate, sendToChatInbox, tasksOfChat, textUpdate, waitUntil,
  type InvariantResult } from './scenario.js';

const origin = 'http://127.0.0.1:56081';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Request = { request_id: string; current_task_id: string; rev: string; stage: string };

export async function candidateSources(chat: string, events: string[], suiteStarted: number,
  checks: InvariantResult[] = []): Promise<InvariantResult[]> {
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
  for (const service of ['core', 'worker-blue']) {
    const probe = compose(['exec', '-T', service, 'node', '-e',
      "process.stdout.write(JSON.stringify({privateRunDirectory:require('node:fs').existsSync('/app/packages/testkit/chaos/.run')}))"]);
    const observed = JSON.parse(probe.stdout) as {privateRunDirectory: boolean};
    check(`${service} image excludes private test-run files`, observed.privateRunDirectory === false,
      `privateRunDirectory=${observed.privateRunDirectory}`);
  }
  check('provider callers and the real parser have only internal networks',
    deployment.networks.includes('hawa-chaos_chaos|true') && deployment.networks.includes('hawa-chaos_parser|true') &&
    ['core', 'worker-blue', 'docling'].every(service => deployment.containers[service]?.networks.length > 0 &&
      deployment.containers[service].networks.every((network: string) => ['hawa-chaos_chaos', 'hawa-chaos_parser'].includes(network))),
    deployment.networks.join(', '));
  check('running nginx validates the production configuration and its mounted office proof',
    compose(['exec', '-T', 'nginx', 'nginx', '-t']).status === 0, 'nginx -t passed');
  const boundaryProbe = compose(['exec', '-T', 'worker-blue', 'node', '--input-type=module', '-e', `
    const {createDb, sql} = await import('/app/packages/db/dist/index.js');
    const db = createDb();
    try {
      const result = await sql\`SELECT current_user AS identity,
        pg_has_role(current_user,'hawa_app','MEMBER') AS app_member,
        has_table_privilege(current_user,'hawa.approvals','INSERT') AS approval_write,
        has_table_privilege(current_user,'hawa.tasks','UPDATE') AS task_write,
        has_schema_privilege(current_user,'hawa','CREATE') AS schema_create,
        has_database_privilege(current_user,current_database(),'TEMPORARY') AS temp_create\`.execute(db);
      const operatorEnvironment = ['HAWA_BEARER_TOKEN','HAWA_API_KEY','HAWA_ADMIN_KEY','HAWA_ART_DIRECTOR_KEY',
        'OPENAI_API_KEY','CANVA_CLIENT_SECRET','CANVA_TOKEN_ENCRYPTION_KEY','GOOGLE_APPLICATION_CREDENTIALS']
        .some(key => !!process.env[key]);
      const response = await fetch('http://core:3001/v1/tasks', {
        headers: {Authorization: 'Bearer ' + process.env.HAWA_DESIGN_WORKER_TOKEN}});
      process.stdout.write(JSON.stringify({...result.rows[0],operatorEnvironment,taskListStatus:response.status}));
    } finally { await db.destroy(); }
  `]);
  const workerBoundary = JSON.parse(boundaryProbe.stdout) as {
    identity: string; app_member: boolean; approval_write: boolean; task_write: boolean;
    schema_create: boolean; temp_create: boolean; operatorEnvironment: boolean; taskListStatus: number;
  };
  check('running worker has only its restricted database identity', workerBoundary.identity === 'hawa_worker_login' &&
    ['app_member', 'approval_write', 'task_write', 'schema_create', 'temp_create'].every(key =>
      workerBoundary[key as keyof typeof workerBoundary] === false), JSON.stringify(workerBoundary));
  check('running worker has no operator/provider environment and cannot list tasks',
    workerBoundary.operatorEnvironment === false && [401, 403].includes(workerBoundary.taskListStatus),
    `operatorEnvironment=${workerBoundary.operatorEnvironment}; taskListStatus=${workerBoundary.taskListStatus}`);
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
  const verifyRetainedAssets = await retainCandidateAssetSources(origin, session.token!, checks);
  const get = (path: string) => fetch(`${origin}/v1${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  const action = async (path: string, body: unknown, key: string = randomUUID(), token = secrets().CHAOS_REVIEWER_KEY,
    headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/v1${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers,
    }, body: JSON.stringify(body) });
    const json = await response.json() as any;
    if (!response.ok) throw new Error(`Desk action ${path}: HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  const requests = () => query<Request>(sql`SELECT request_id,current_task_id,rev,stage FROM hawa.requests WHERE chat_id=${chat}`);
  const review = (revision: number) => waitUntil(`request review at rev ${revision}`, async () => {
    const [r] = await requests();
    if (r?.stage === 'in_review' && Number(r.rev) === revision) return r;
    if (r?.current_task_id) {
      const outcome = await designOutcome(r.current_task_id);
      if (outcome && outcome !== 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') {
        throw new RequestEndedError(`task ${r.current_task_id}: candidate design ended as ${outcome} at ${r.stage} rev ${r.rev}`);
      }
    }
    return null;
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
  const manualChild = await waitUntil('revision native handoff at rev 5', async () => {
    const [r] = await requests();
    return r?.stage === 'manual' && Number(r.rev) === 5 && r.current_task_id !== first.current_task_id ? r : null;
  });
  const [handoffReason] = await query<{code: string}>(sql`SELECT data->>'code' AS code FROM hawa.task_events
    WHERE task_id=${manualChild.current_task_id}::uuid AND data->>'code'='NATIVE_REVISION_HANDOFF_REQUIRED'`);
  check('linked revision holds for current-native handoff before fresh generation',
    handoffReason?.code === 'NATIVE_REVISION_HANDOFF_REQUIRED', 'current native revision admission enforced');
  const nativeEffectsBefore=(await fakes.canvaLedger()).filter(entry=>['import','design'].includes(entry.kind)).length;
  const modelCallsBefore=(await fakes.modelLedger()).ledger.length;
  const manualHeaders = {'X-Hawa-Manual-Request-Id':manualChild.request_id,'X-Hawa-Manual-Request-Rev':String(manualChild.rev)};
  const nativeState = async () => (await get(`/tasks/${manualChild.current_task_id}/canva`)).json() as Promise<any>;
  const unlinked = await nativeState();
  check('handoff resolves the current same-client parent native master',
    unlinked.revisionHandoff?.available === true && unlinked.revisionHandoff.parentTaskId === first.current_task_id &&
    unlinked.revisionHandoff.nativeRecovery?.rev === 5, 'current parent and durable owner scope');
  const copied = await fakes.canvaManualCopy(unlinked.revisionHandoff.parentDesignId);
  const sourceBytes = Buffer.from(copied.json.contentBase64, 'base64');
  check('synthetic operator copies the existing source bytes to a separate native identity', copied.status === 200 &&
    copied.json.designId !== unlinked.revisionHandoff.parentDesignId && hash(sourceBytes) === copied.json.sourceSha256,
    `fixture SHA-256 ${hash(sourceBytes)}; synthetic operator only`);
  const editedBytes = appendFixtureCopy(sourceBytes, copy, 'Revised for 27 September 2026');
  await fakes.canvaManualEdit({designId:copied.json.designId,contentBase64:editedBytes.toString('base64')});
  await action(`/tasks/${manualChild.current_task_id}/canva-binding`,
    {editUrl:`https://www.canva.com/design/${copied.json.designId}/edit`},randomUUID(),session.token,manualHeaders);
  const linked = await nativeState();
  const confirmationBody = {expectedTaskVersion:linked.revisionHandoff.taskVersion,basisSha256:linked.revisionHandoff.basisSha256,
    copy:[revisedCopy],reviewedCurrentDesign:true,preservedUnrequestedChanges:true};
  const confirmationKey=randomUUID();
  const confirmation = await action(`/tasks/${manualChild.current_task_id}/canva/revision-copy`,confirmationBody,
    confirmationKey,session.token,manualHeaders);
  const confirmationReplay = await action(`/tasks/${manualChild.current_task_id}/canva/revision-copy`,confirmationBody,
    confirmationKey,session.token,manualHeaders);
  check('synthetic operator exact-copy confirmation replays one immutable event',
    !!confirmation.confirmationEventId && confirmationReplay.confirmationEventId === confirmation.confirmationEventId &&
    confirmationReplay.replayed === true,'human preparation is not approval');
  let checkedArtifact: {id:string;sha256:string} | undefined;
  for (const format of ['png','pptx'] as const) {
    const started = await action(`/tasks/${manualChild.current_task_id}/canva/exports`,
      {format,expectedVersion:linked.binding.version},randomUUID(),session.token,manualHeaders);
    const captured = await action(`/tasks/${manualChild.current_task_id}/canva/exports/${started.operationId}/resume`,
      {},randomUUID(),session.token,manualHeaders);
    check(`native revision ${format} fixture capture is retained`,captured.status === 'retrieved' &&
      !!captured.artifact?.sha256 && captured.artifact.format === format,`captured ${format}; synthetic Canva transport`);
    if (format === 'pptx') {
      checkedArtifact=captured.artifact;
      check('capture does not independently advance the durable owner',captured.review?.status === 'blocked',
        'explicit signed review submission remains required');
    }
  }
  const beforeReview=await nativeState();
  const reviewKey=randomUUID();
  const reviewBody={requestId:manualChild.request_id,expectedRev:5,expectedTaskVersion:beforeReview.revisionHandoff.taskVersion,
    artifactId:checkedArtifact!.id,confirmationEventId:confirmation.confirmationEventId};
  const submission=await action(`/tasks/${manualChild.current_task_id}/native-review`,reviewBody,reviewKey,session.token);
  const submissionReplay=await action(`/tasks/${manualChild.current_task_id}/native-review`,reviewBody,reviewKey,session.token);
  check('signed native review and replay adopt one owner revision without approval',submission.accepted === true &&
    submission.rev === 6 && submissionReplay.revisionId === submission.revisionId && submissionReplay.rev === 6,
    'manual rev 5 to in_review rev 6');
  const child = await review(6);
  check('native handoff reaches review without fresh generation or model calls',
    (await fakes.canvaLedger()).filter(entry=>['import','design'].includes(entry.kind)).length === nativeEffectsBefore &&
    (await fakes.modelLedger()).ledger.length === modelCallsBefore,'existing editable master only; fake-provider ledger');
  events.push(`voice ${voiceId} → separate fixture copy → signed owner review of task ${child.current_task_id}`);
  const [revision] = await query<{id: string}>(sql`SELECT current_design_revision_id AS id FROM hawa.tasks WHERE id=${child.current_task_id}::uuid`);
  const [qc] = await query<{status: string;critical_pass: boolean;report: any}>(sql`SELECT status,critical_pass,report FROM hawa.qc_runs
    WHERE task_id=${child.current_task_id}::uuid AND design_revision_id=${revision.id}::uuid ORDER BY started_at DESC LIMIT 1`);
  check('revised simulated Canva export passes configured QA', qc?.status === 'passed' && qc.critical_pass && !!qc.report?.exportArtifactId, `QC ${qc?.status}`);
  const approval = await action(`/tasks/${child.current_task_id}/revisions/${revision.id}/decisions`, {
    action: 'approve', reason: 'Synthetic workflow qualification; not a human creative-quality review.', pinnedExportIds: [qc.report.exportArtifactId],
  });
  await waitUntil('owned approval committed', async () => { const [r] = await requests(); return r?.stage === 'approved' && Number(r.rev) === 7 ? r : null; });
  const recovery = process.env.HAWA_CHAOS_RECOVERY === '1';
  if (recovery) await fakes.hold('core.delivery.after-drive', {mode: 'workflow'});
  await action(`/tasks/${child.current_task_id}/publish`, { approvalId: approval.decisionId });
  if (recovery) await restorePendingDelivery(child.current_task_id, chat, suiteStarted, events, checks, verifyRetainedAssets);
  const delivered = await waitUntil('reviewed source request delivered', async () => { const [r] = await requests(); return r?.stage === 'delivered' ? r : null; });
  const tasks = await tasksOfChat(chat);
  check('PDF new request and voice revision reach one logical simulated delivery', tasks.length === 2 && tasks[1].state === 'complete' &&
    Number(delivered.rev) === (recovery ? 10 : 9) && delivered.current_task_id === child.current_task_id, JSON.stringify({tasks, delivered}));
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

  // The actual control endpoint closes a synthetic task before any generation admission.
  const closed=await action('/tasks',{...intake,title:'Candidate cancelled generation controls'},randomUUID(),session.token);
  const closeKey=randomUUID(),closeInput={reason:'Synthetic cancelled-task qualification',expectedVersion:closed.version};
  const closedReceipt=await action(`/tasks/${closed.id}/cancel`,closeInput,closeKey,session.token);
  const replayedClose=await action(`/tasks/${closed.id}/cancel`,closeInput,closeKey,session.token);
  check('cancel commits terminal state and replays the same durable receipt',closedReceipt.status==='CANCELLED' &&
    closedReceipt.commandId===replayedClose.commandId && replayedClose.replayed===true,`task ${closed.id}`);
  for (const endpoint of ['studio','generate','design']) {
    const response=await fetch(`${origin}/v1/tasks/${closed.id}/canva/${endpoint}`,{method:'POST',headers:{
      Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID(),
    },body:JSON.stringify({width:1080,height:1350})});
    const result=await response.json();
    check(`cancelled task refuses deployed ${endpoint} admission`,response.status===409 &&
      JSON.stringify(result).includes('TASK_GENERATION_BLOCKED'),`HTTP ${response.status}`);
  }
  const [closedEffects]=await query<{runs:string;plans:string;operations:string}>(sql`
    SELECT (SELECT count(*) FROM hawa.design_studio_runs WHERE task_id=${closed.id}::uuid) AS runs,
      (SELECT count(*) FROM hawa.canva_design_plans WHERE task_id=${closed.id}::uuid) AS plans,
      (SELECT count(*) FROM hawa.canva_remote_operations WHERE task_id=${closed.id}::uuid) AS operations`);
  check('closed-task refusals admit no run, plan or remote operation',Object.values(closedEffects).every(value=>Number(value)===0),JSON.stringify(closedEffects));
  events.push(`Synthetic cancelled task ${closed.id}: all three deployed generation entry points refused`);

  const blankClient=randomUUID(),tenantId='00000000-0000-4000-a000-000000000001';
  const blankDna={tenantId,clientId:blankClient,name:'Synthetic blank-design client',code:blankClient,version:1,status:'active',
    defaultLocale:'en',defaultDirection:'ltr',updatedAt:new Date().toISOString(),colors:[],assets:[],
    guidelines:{voiceAndTone:'Synthetic fixture',prohibitedPhrases:[],requiredDisclaimers:[],layoutRules:[]},
    fonts:[{family:'Verdana',style:'Regular',weight:400,role:'body',license:'Synthetic rehearsal fixture',supportedLocales:['en']}],
    destinations:{productionFolderId:'chaos-blank-production',spreadsheetId:'chaos-blank-tracker',sheetId:0},
    approvalPolicy:{requiredRoles:['art_director'],allowAutoApproval:false,autoApprovalEligibleTemplates:[]}};
  await query(sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${blankClient}::uuid,${tenantId}::uuid,${blankClient},'Synthetic blank-design client')`);
  await query(sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
    VALUES(${tenantId}::uuid,${blankClient}::uuid,1,'active',${JSON.stringify(blankDna)}::jsonb,${computeDnaHash(blankDna)},'00000000-0000-4000-b000-000000000001'::uuid)`);
  const directory=await (await get('/clients')).json() as Array<{clientId:string;name:string;code:string;defaultLocale:string;status:string}>;
  check('synthetic blank client remains usable in the Desk directory',directory.some(client=>client.clientId===blankClient &&
    client.name===blankDna.name && client.code===blankDna.code && client.defaultLocale==='en' && client.status==='active'),`client ${blankClient}`);
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
  await candidateEvaluationSettlement(events,checks);
  await candidateStudioSettlement(events,checks);
  const modelLedger=await fakes.modelLedger();
  check('candidate request and recovery paths have no unconfigured model calls',
    !modelLedger.ledger.some((entry: {route:string})=>entry.route.startsWith('unmatched')), 'Intentional evaluation503 failures are separately armed and checked');
  return checks;
}
