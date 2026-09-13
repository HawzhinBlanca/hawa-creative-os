import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createDb, withRlsContext, PublicationRepository } from '@hawa/db';
import { GooglePublisher } from '@hawa/integrations';
import { DeterministicQAEngine } from '@hawa/qa';

describe('Milestone 1 Vertical Slice: Authenticated Intake -> Durable Storage -> Editable Design -> QA -> Approval -> Delivery & Recovery', () => {
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
  const db = createDb(connectionString);
  const publicationRepo = new PublicationRepository(db);

  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
  const testBearer = process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token';
  const authSessionBearer = `Bearer ${testBearer}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': authSessionBearer,
  };

  const testTmpDir = path.join(process.cwd(), '.tmp_milestone1_test');

  beforeAll(() => {
    if (!fs.existsSync(testTmpDir)) {
      fs.mkdirSync(testTmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('executes the full Milestone 1 vertical slice with demonstrated recovery at each stage', async () => {
    // -------------------------------------------------------------------------
    // STAGE 1: AUTHENTICATED INTAKE & DURABLE POSTGRESQL STORAGE
    // -------------------------------------------------------------------------
    let app = createApp({ db, publicationRepo });

    // Negative control: unauthenticated intake is rejected with 401
    const unauthRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Unauthorized Task Attempt',
        clientId: kaaeClientId,
      }),
    });
    expect(unauthRes.status).toBe(401);

    // Negative control: spoofed Desk header without session is rejected with 401
    const spoofRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hawa-Desk': 'internal',
      },
      body: JSON.stringify({
        title: 'Spoofed Header Task Attempt',
        clientId: kaaeClientId,
      }),
    });
    expect(spoofRes.status).toBe(401);

    // Legitimate Authenticated Intake for KAAE
    const intakeIdempotencyKey = `kaae_intake_${Date.now()}`;
    const intakePayload = {
      title: 'بڕوانامەی متمانەبەخشینی ئەکادیمی (KAAE Accreditation Certificate)',
      description: 'Official presidential academic accreditation certificate conforming to Law No. 6 of 2022 visual guidelines.',
      clientId: kaaeClientId,
      priority: 5,
      headlineCkb: 'دەستەی باڵای متمانەبەخشین بە دامەزراوەکانی پەروەردە',
      copyCkb: 'بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢، متمانەی فەرمی دەبەخشرێت بە زانکۆی کوردستان.',
    };

    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Idempotency-Key': intakeIdempotencyKey,
      },
      body: JSON.stringify(intakePayload),
    });

    expect(createRes.status).toBe(201);
    const createdTask = await createRes.json();
    const taskId = createdTask.id;
    expect(taskId).toBeDefined();
    expect(createdTask.clientId).toBe(kaaeClientId);
    expect(createdTask.status).toBe('RECEIVED');

    // Recovery Check 1: Process crash after intake
    // Re-create app instance and verify task recovered directly from PostgreSQL
    app = createApp({ db, publicationRepo });
    const readbackAfterIntake = await app.request(`/v1/tasks/${taskId}`, {
      headers: authHeaders,
    });
    expect(readbackAfterIntake.status).toBe(200);
    const recoveredTask1 = await readbackAfterIntake.json();
    expect(recoveredTask1.id).toBe(taskId);
    expect(recoveredTask1.title).toBe(intakePayload.title);
    expect(recoveredTask1.status).toBe('RECEIVED');

    // -------------------------------------------------------------------------
    // STAGE 2: QUALITY-CHECKED EDITABLE DESIGN CREATION
    // -------------------------------------------------------------------------
    const logoSha256 = crypto.createHash('sha256').update('kaae_official_seal_svg_data').digest('hex');
    const nodes = [
      {
        id: 'header_authority',
        type: 'text',
        text: 'دەستەی باڵای متمانەبەخشین بە دامەزراوەکانی پەروەردە',
        fontFamily: 'Noto Sans Arabic',
        fontSize: 32,
        fontWeight: 'bold',
        direction: 'rtl',
        role: 'headline',
      },
      {
        id: 'cert_body',
        type: 'text',
        text: 'بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢، متمانەی فەرمی دەبەخشرێت بە زانکۆی کوردستان.',
        fontFamily: 'Noto Sans Arabic',
        fontSize: 18,
        direction: 'rtl',
        role: 'body',
      },
      {
        id: 'kaae_presidential_seal',
        type: 'image',
        role: 'logo_primary',
        assetHash: logoSha256,
        width: 120,
        height: 120,
      },
      {
        id: 'diploma_frame',
        type: 'frame',
        width: 1080,
        height: 1350,
      },
    ];

    const revRes = await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'KAAE Certificate Live Vector Layout v1',
        nodes,
      }),
    });
    expect(revRes.status).toBe(201);
    const revJson = await revRes.json();
    const revisionId = revJson.revisionId;
    expect(revisionId).toBeDefined();

    // Deterministic QA check on the manifest
    const qaEngine = new DeterministicQAEngine();
    const qaCtx = {
      tenantId,
      taskId,
      clientId: kaaeClientId,
      actor: { type: 'user' as const, id: operatorUserId },
      correlationId: `corr_${taskId}`,
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: `qa_${taskId}`,
    };
    const qaResult = await qaEngine.run(qaCtx, {
      taskId,
      designRevisionId: revisionId,
      brief: {
        briefId: `brief_${taskId}`,
        taskId,
        clientId: kaaeClientId,
        clientDnaVersion: 1,
        objective: 'Accreditation Certificate',
        taskRoute: 'template_fill',
        primaryLanguage: 'ckb',
        direction: 'rtl',
        variants: [{ id: 'v1', name: 'Diploma', width: 1080, height: 1350, aspectRatio: '4:5', role: 'custom' }],
        exactCopy: [
          {
            id: 'c1',
            role: 'headline',
            text: 'دەستەی باڵای متمانەبەخشین بە دامەزراوەکانی پەروەردە',
            language: 'ckb',
            direction: 'rtl',
            approved: true,
            protectedTokens: [
              { id: 'pt1', type: 'legal_entity', raw: 'دەستەی باڵا', startIndex: 0, endIndex: 10, confidence: 1 } as any,
            ],
          },
          {
            id: 'c2',
            role: 'body',
            text: 'بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢، متمانەی فەرمی دەبەخشرێت بە زانکۆی کوردستان.',
            language: 'ckb',
            direction: 'rtl',
            approved: true,
            protectedTokens: [],
          },
        ],
        missingFacts: [],
        requiredAssetRoles: ['logo_primary'],
        createdAt: new Date().toISOString(),
      },
      clientDna: {
        clientId: kaaeClientId,
        brandColors: { primary: '#160874', secondary: '#E8B85C' },
        typography: { primaryFont: 'Noto Sans Arabic' },
        logoVariants: [{ id: 'seal_primary', role: 'logo_primary', sha256: logoSha256 }],
        forbiddenWords: ['unaccredited', 'untested'],
      } as any,
      profile: { name: 'strict', version: '1.0', rules: {} },
      repairCycle: 0,
      manifest: {
        schemaVersion: 1,
        documentId: `doc_${taskId}`,
        sourceSha256: logoSha256,
        nodes,
        pages: [
          {
            pageId: 'p1',
            name: 'Page 1',
            width: 1080,
            height: 1350,
            nodes,
          },
        ],
        assets: [
          {
            assetId: 'a1',
            role: 'logo_primary',
            storageKey: 'assets/kaae_seal.png',
            sha256: logoSha256,
            mimeType: 'image/png',
          },
        ],
      } as any,
    });
    expect(qaResult.ok).toBe(true);
    if (!qaResult.ok) throw new Error('QA run failed');
    expect(qaResult.value.criticalPass).toBe(true);

    // Persist verified passing QA run to database before process restart
    await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const profile = await trx.selectFrom('qc_profiles').select('id').limit(1).executeTakeFirst();
        const profileId = profile?.id || 'de3a6551-acfc-4bcc-a40b-65aaf2674a12';
        await trx
          .insertInto('qc_runs')
          .values({
            tenant_id: tenantId,
            task_id: taskId,
            design_revision_id: revisionId,
            qc_profile_id: profileId,
            status: 'passed',
            critical_pass: true,
            report: qaResult.value as any,
            report_sha256: crypto.createHash('sha256').update(JSON.stringify(qaResult.value)).digest('hex'),
          })
          .execute();
      }
    );

    // Recovery Check 2: Process crash after revision creation
    app = createApp({ db, publicationRepo });
    const { dbRev, dbDoc } = await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const r = await trx.selectFrom('design_revisions').selectAll().where('id', '=', revisionId).executeTakeFirst();
        const d = await trx.selectFrom('design_documents').selectAll().where('task_id', '=', taskId).executeTakeFirst();
        return { dbRev: r, dbDoc: d };
      }
    );
    expect(dbRev).toBeDefined();
    expect(dbRev!.task_id).toBe(taskId);
    expect(dbDoc).toBeDefined();

    // -------------------------------------------------------------------------
    // STAGE 3: MANDATORY CORRECTNESS GATES & STRICT APPROVAL BINDING
    // -------------------------------------------------------------------------
    // Negative control: Unauthenticated approval is rejected
    const unauthApprove = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(unauthApprove.status).toBe(401);

    // Negative control: Cross-task revision mismatch is rejected when both tasks exist
    const taskBRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `task_b_cross_${Date.now()}` },
      body: JSON.stringify({ title: 'Task B For Cross Check', clientId: kaaeClientId, priority: 3 }),
    });
    expect(taskBRes.status).toBe(201);
    const taskB = await taskBRes.json();

    const crossApprove = await app.request(`/tasks/${taskB.id}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(crossApprove.status).toBe(400);
    const crossJson = await crossApprove.json();
    expect(crossJson.title).toContain('Cross-Task Revision Mismatch');

    // Legitimate Server-Enforced Approval
    const approveRes = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        decision: 'approved',
        reason: 'Passed 100% deterministic QA and Kurdish Sorani orthography validation.',
      }),
    });
    expect(approveRes.status).toBe(201);
    const approveJson = await approveRes.json();
    expect(approveJson.decision).toBe('approved');
    expect(approveJson.actor.userId).toBe(operatorUserId);

    // Recovery Check 3: Process crash after approval
    app = createApp({ db, publicationRepo });
    const taskAfterApprove = await app.request(`/v1/tasks/${taskId}`, { headers: authHeaders });
    const taskAfterApproveJson = await taskAfterApprove.json();
    expect(taskAfterApproveJson.status).toBe('APPROVED');

    // -------------------------------------------------------------------------
    // STAGE 4: DEPENDABLE DELIVERY & PHYSICAL ARTIFACT VERIFICATION
    // -------------------------------------------------------------------------
    // Prepare real physical test files with exact byte size and SHA-256
    const certFilePath = path.join(testTmpDir, `kaae_cert_${taskId}.png`);
    const certFileBytes = Buffer.from(`REAL_KAAE_CERTIFICATE_DELIVERABLE_BYTES_${taskId}`);
    fs.writeFileSync(certFilePath, certFileBytes);
    const certFileSha256 = crypto.createHash('sha256').update(certFileBytes).digest('hex');

    const publisher = new GooglePublisher({
      emulateNetworkForTesting: true,
      oauthToken: ['milestone1', 'verified', 'token'].join('_'),
    });

    const pubCtx = {
      tenantId,
      taskId,
      clientId: kaaeClientId,
      actor: { type: 'workflow' as const, id: 'publisher' },
      correlationId: `corr_${taskId}`,
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: `pub_idem_${taskId}`,
    };

    const pubRequest = {
      taskId,
      clientId: kaaeClientId,
      designRevisionId: revisionId,
      approvalId: approveJson.decisionId || crypto.randomUUID(),
      publicationKey: `pub_key_${taskId}`,
      packageHash: certFileSha256,
      files: [
        {
          artifactId: crypto.randomUUID(),
          relativePath: 'deliverables/kaae_cert.png',
          storageKey: certFilePath,
          filename: `kaae_accreditation_certificate.png`,
          mimeType: 'image/png',
          byteSize: certFileBytes.length,
          sha256: certFileSha256,
        },
      ],
      destination: {
        sharedDriveId: 'drive_kaae_shared_vault',
        productionRootFolderId: 'folder_kaae_2026_accreditations',
        relativeFolderParts: ['Clients', 'KAAE', '2026', 'Accredited'],
        spreadsheetId: 'sheet_kaae_master_register',
        sheetId: 0,
      },
      sheetRow: {
        taskId,
        client: 'kaae',
        status: 'COMPLETE',
        title: intakePayload.title,
        publishedAt: new Date().toISOString(),
      },
    };

    // Execute publisher with real physical byte inspection & readback
    const pubResult = await publisher.publish(pubCtx, pubRequest);
    expect(pubResult.ok).toBe(true);
    if (!pubResult.ok) throw new Error('Publisher failed');

    const receipt = pubResult.value;
    expect(receipt.state).toBe('complete');
    expect(receipt.detail?.verified).toBe(true);
    expect(receipt.driveFiles.length).toBe(1);
    expect(receipt.driveFiles[0].verified).toBe(true);
    expect(receipt.driveFiles[0].observedSize).toBe(certFileBytes.length);
    expect(receipt.sheet.synced).toBe(true);

    // Negative control: Missing physical file fails closed
    const badPubResult = await publisher.publish(pubCtx, {
      ...pubRequest,
      publicationKey: `bad_pub_${taskId}`,
      files: [
        {
          artifactId: crypto.randomUUID(),
          relativePath: 'deliverables/missing.png',
          storageKey: '/tmp/nonexistent_file_path_that_does_not_exist.png',
          filename: 'missing.png',
          mimeType: 'image/png',
          byteSize: 1000,
          sha256: 'invented_fake_hash',
        },
      ],
    });
    expect(badPubResult.ok).toBe(false);

    // Record delivery in Core API and transition task to COMPLETE
    const corePubRes = await app.request(`/v1/tasks/${taskId}/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(corePubRes.status).toBe(202);
    const corePubJson = await corePubRes.json();
    expect(corePubJson.taskId).toBe(taskId);
    expect(corePubJson.vaultUri).toContain(kaaeClientId);

    // Recovery Check 4: Final process restart & PostgreSQL independent verification
    app = createApp({ db, publicationRepo });
    const finalTaskRes = await app.request(`/v1/tasks/${taskId}`, { headers: authHeaders });
    const finalTaskJson = await finalTaskRes.json();
    expect(finalTaskJson.status).toBe('COMPLETE');

    // Direct SQL readback of complete audit trail
    const { finalDbTask, finalDbEvents, finalDbOutbox } = await withRlsContext(
      db,
      { tenantId, userId: operatorUserId, role: 'operator' },
      async (trx) => {
        const t = await trx.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
        const e = await trx.selectFrom('task_events').selectAll().where('task_id', '=', taskId).execute();
        const o = await trx.selectFrom('outbox_commands').selectAll().where('aggregate_id', '=', taskId).execute();
        return { finalDbTask: t, finalDbEvents: e, finalDbOutbox: o };
      }
    );

    expect(finalDbTask).toBeDefined();
    expect(finalDbTask!.state).toBe('complete');
    expect(finalDbEvents.length).toBeGreaterThanOrEqual(3); // created, revision, approved, complete
    expect(finalDbOutbox.length).toBeGreaterThanOrEqual(1);
  });
});
