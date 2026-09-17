import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { DesignStudioService } from './dist/services/design-studio/design-studio-service.js';
import { CanvaConnectService } from './dist/services/canva-connect-service.js';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const db = createDb(dbUrl);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const actorId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE
  const scope = { tenantId, actorId };

  console.log('--- STARTING LIVE STUDIO V3 VERIFICATION ---');

  // 1. Create a test task for KAAE with RLS context
  const taskId = randomUUID();
  const taskTitle = '[VERIFY] KAAE: National Standards for Quality Assurance';
  const rawText = `I need an invitation design for Kaae, here is all the information. Make it nice and professional, in english. It needs to go with kaaes brand guidelines, currently we prefer the dark blue navy as a background, feel free to add textures as you see fit in the brand guidelines. Don’t change anything from my content, i only need the design. I have attached the kaae logo as well so please use that.
__________

THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION

Mr. / Ms. / Dr. [Full Name]

The Kurdistan Accrediting Association for Education
cordially requests the honor of your presence at this landmark occasion.

His Excellency Prime Minister Masrour Barzani will officially announce the National Standards for Quality Assurance in Education, marking a defining moment in the advancement of educational quality across the Kurdistan Region. The occasion will bring together government, educational institutions, and international partners around a shared national vision for excellence, accountability, and continuous improvement.

As part of the official launch, the Minister of Education and the Minister of Higher Education and Scientific Research will sign a Memorandum of Understanding (MoU), marking a significant commitment to cooperation and the advancement of quality assurance across the education sector.

September 9, 2026 | 2:30 PM
Saad Abdullah Conference Hall

By Invitation Only

This invitation is personal and non-transferable.
Kindly do not share this invitation.`;

  await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
    await sql`
      INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, sensitivity, version)
      VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, ${taskTitle}, ${rawText}, 'received', 3, 'normal', 1)
    `.execute(trx);
  });
  console.log('Created task:', taskId);

  // 2. Initialize Canva & DesignStudioService
  const canva = new CanvaConnectService(db);
  const studio = new DesignStudioService(db, canva, {
    defaultTier: 'premium',
  });

  const requestKey = `verify-${Date.now()}`;
  const requestInput = {
    tier: 'premium',
    width: 1080,
    height: 1350,
    previews: 3,
    holdForSelection: false,
    copyBlocks: [
      { text: 'THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION', script: 'latin' },
      { text: 'Mr. / Ms. / Dr. [Full Name]', script: 'latin' },
      { text: 'The Kurdistan Accrediting Association for Education\ncordially requests the honor of your presence at this landmark occasion.', script: 'latin' },
      { text: 'His Excellency Prime Minister Masrour Barzani will officially announce the National Standards for Quality Assurance in Education, marking a defining moment in the advancement of educational quality across the Kurdistan Region.', script: 'latin' },
      { text: 'As part of the official launch, the Minister of Education and the Minister of Higher Education and Scientific Research will sign a Memorandum of Understanding (MoU).', script: 'latin' },
      { text: 'September 9, 2026 | 2:30 PM\nSaad Abdullah Conference Hall', script: 'latin' },
      { text: 'By Invitation Only', script: 'latin' },
      { text: 'This invitation is personal and non-transferable.\nKindly do not share this invitation.', script: 'latin' }
    ],
    instructions: 'Professional KAAE VIP invitation in English, dark navy blue background, refined typography, strictly preserve exact text.'
  };

  console.log('Creating Studio run...');
  const { run } = await studio.createOrGetRun(scope, taskId, requestKey, requestInput);
  console.log('Run created:', { runId: run.id, status: run.status });

  let currentStatus = run.status;
  let iterations = 0;
  const start = Date.now();

  while (!['transferred', 'failed', 'degraded'].includes(currentStatus) && iterations < 25) {
    iterations++;
    const stepStart = Date.now();
    console.log(`[Step ${iterations}] Resuming stage: ${currentStatus}...`);
    const step = await studio.resume(scope, taskId, run.id);
    const stepDuration = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(`[Step ${iterations}] Completed in ${stepDuration}s -> Status: ${step.status}, Stage: ${step.stage || 'N/A'}`);
    if (step.diagnostic) console.log(`   Diagnostic: ${step.diagnostic}`);
    if (step.designId) console.log(`   Canva Design ID: ${step.designId}`);
    currentStatus = step.status;
  }

  const totalDuration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n--- EXECUTION FINISHED in ${totalDuration}s with Status: ${currentStatus} ---`);

  if (currentStatus === 'transferred') {
    // Check the binding in hawa.canva_bindings
    const binding = await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      return (await sql`
        SELECT canva_design_id, edit_url, status FROM hawa.canva_bindings
        WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
      `.execute(trx)).rows[0];
    });

    console.log('CANVA BINDING VERIFIED:');
    console.log('  Canva Design ID:', binding?.canva_design_id);
    console.log('  Edit URL:', binding?.edit_url);
    console.log('  Binding Status:', binding?.status);
    console.log('SUCCESS: Studio v3 transferred genuine design to Canva!');
  } else {
    console.error('FAILED: Final status is', currentStatus);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('UNCAUGHT ERROR:', err);
  process.exit(1);
});
