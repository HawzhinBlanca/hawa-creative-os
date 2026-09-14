import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.HAWA_API_URL || 'http://127.0.0.1:8080';
let token = process.env.HAWA_BEARER_TOKEN;

if (!token) {
  // Read from infra/docker/.env.production if not already in env
  const envPath = path.resolve('infra/docker/.env.production');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HAWA_BEARER_TOKEN=')) {
        token = trimmed.split('=')[1];
        break;
      }
    }
  }
}

if (!token) {
  throw new Error('HAWA_BEARER_TOKEN not found in environment or infra/docker/.env.production');
}

const AUTH_HEADERS = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const PROOFS_DIR = path.resolve('output/proofs/2026-09-14-design-studio-v2/baseline');
fs.mkdirSync(PROOFS_DIR, { recursive: true });

interface Brief {
  id: string;
  name: string;
  language: string;
  clientId: string;
  width: number;
  height: number;
  aspectLabel: string;
  instructions: string;
  rawRequestText: string;
  copyBlocks: Array<{ copyIndex: number; text: string; role: string; script: string }>;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBrief(brief: Brief) {
  console.log(`\n======================================================`);
  console.log(`Starting Brief: ${brief.id} (${brief.name})`);
  console.log(`Dimensions: ${brief.width}x${brief.height} | Language: ${brief.language}`);
  const startTime = Date.now();

  // 1. Create Task
  const taskPayload = {
    title: brief.name,
    description: brief.rawRequestText,
    clientId: brief.clientId,
    priority: 3,
    copyBlocks: brief.copyBlocks,
    rawRequestText: brief.rawRequestText,
    designInstructions: brief.instructions,
  };

  const taskRes = await fetch(`${BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'Idempotency-Key': `task-${brief.id}-${Date.now()}`,
    },
    body: JSON.stringify(taskPayload),
  });

  if (!taskRes.ok) {
    const errText = await taskRes.text();
    throw new Error(`Failed to create task for ${brief.id}: ${taskRes.status} ${errText}`);
  }

  const taskData = (await taskRes.json()) as any;
  const taskId = taskData.id;
  console.log(`[${brief.id}] Task created: ${taskId}`);

  // 2. Call Canva Generate
  const genKey = `gen-${brief.id}-${Date.now()}`;
  const genRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva/generate`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'Idempotency-Key': genKey,
    },
    body: JSON.stringify({ width: brief.width, height: brief.height }),
  });

  if (!genRes.ok) {
    const errText = await genRes.text();
    throw new Error(`Failed to call canva/generate for ${brief.id}: ${genRes.status} ${errText}`);
  }

  let genData = (await genRes.json()) as any;
  console.log(`[${brief.id}] Generate response:`, JSON.stringify(genData));

  // 3. Wait/Resume until design is imported into Canva
  let designId = genData.designId;
  const planId = genData.planId;
  const operationId = genData.operationId;

  if (!designId) {
    console.log(`[${brief.id}] Waiting for Canva import (operationId: ${operationId || planId})...`);
    let attempts = 0;
    while (!designId && attempts < 30) {
      attempts++;
      await sleep(3000);
      const resumeUrl = operationId
        ? `${BASE_URL}/v1/tasks/${taskId}/canva/imports/${operationId}/resume`
        : `${BASE_URL}/v1/tasks/${taskId}/canva/plans/${planId}/resume`;
      const resumeRes = await fetch(resumeUrl, {
        method: 'POST',
        headers: AUTH_HEADERS,
      });
      if (resumeRes.ok) {
        const resumeData = (await resumeRes.json()) as any;
        console.log(`[${brief.id}] Resume attempt ${attempts}: status=${resumeData.status}`);
        if (resumeData.status === 'retrieved' && resumeData.designId) {
          designId = resumeData.designId;
          break;
        }
        if (resumeData.status === 'failed') {
          throw new Error(`Import failed for ${brief.id}: ${JSON.stringify(resumeData)}`);
        }
      } else {
        console.warn(`[${brief.id}] Resume returned ${resumeRes.status}`);
      }
    }
  }

  if (!designId) {
    throw new Error(`Timeout waiting for Canva designId for ${brief.id}`);
  }
  console.log(`[${brief.id}] Canva Design Bound: ${designId}`);

  // Wait a few seconds for Canva import to settle before export
  console.log(`[${brief.id}] Waiting 4s for Canva import to settle...`);
  await sleep(4000);

  // 4. Fetch task Canva binding state to get expectedVersion
  const stateRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva`, {
    headers: AUTH_HEADERS,
  });
  if (!stateRes.ok) {
    throw new Error(`Failed to get Canva state for ${brief.id}: ${stateRes.status}`);
  }
  const stateData = (await stateRes.json()) as any;
  const binding = stateData.binding;
  if (!binding || binding.status !== 'bound') {
    throw new Error(`Task binding not bound for ${brief.id}: ${JSON.stringify(binding)}`);
  }
  let currentBindingVersion = binding.version;
  console.log(`[${brief.id}] Initial binding version: ${currentBindingVersion}`);

  // 5. Export with recovery for Canva settling (up to 3 attempts)
  let artifact: any = null;
  for (let attempt = 1; attempt <= 3 && !artifact; attempt++) {
    const exportKey = `exp-${brief.id}-att${attempt}-${Date.now()}`;
    console.log(`[${brief.id}] Starting export attempt ${attempt} (version ${currentBindingVersion})...`);
    const exportRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva/exports`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'Idempotency-Key': exportKey,
      },
      body: JSON.stringify({ format: 'png', expectedVersion: currentBindingVersion }),
    });

    if (!exportRes.ok) {
      const errText = await exportRes.text();
      console.warn(`[${brief.id}] Export attempt ${attempt} start failed: ${exportRes.status} ${errText}`);
      await sleep(2000);
      continue;
    }

    const exportData = (await exportRes.json()) as any;
    const exportOpId = exportData.operationId;
    console.log(`[${brief.id}] Export attempt ${attempt} submitted: ${exportOpId}`);

    // Poll export status
    let pollAttempts = 0;
    while (pollAttempts < 25) {
      pollAttempts++;
      await sleep(2000);
      const pollRes = await fetch(
        `${BASE_URL}/v1/tasks/${taskId}/canva/exports/${exportOpId}/resume`,
        {
          method: 'POST',
          headers: AUTH_HEADERS,
        }
      );
      if (!pollRes.ok) {
        console.warn(`[${brief.id}] Poll ${pollAttempts} returned HTTP ${pollRes.status}`);
        continue;
      }
      const pollData = (await pollRes.json()) as any;
      console.log(`[${brief.id}] Export poll ${pollAttempts}: status=${pollData.status}`);
      if (pollData.status === 'retrieved' && pollData.artifact) {
        artifact = pollData.artifact;
        break;
      }
      if (pollData.status === 'stale') {
        console.log(`[${brief.id}] Export marked stale. Refreshing binding and retrying with fresh snapshot...`);
        await sleep(2000);
        const freshStateRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva`, { headers: AUTH_HEADERS });
        if (freshStateRes.ok) {
          const freshData = (await freshStateRes.json()) as any;
          if (freshData.binding?.version) {
            currentBindingVersion = freshData.binding.version;
          }
        }
        break; // break poll loop to advance to next export attempt
      }
      if (pollData.status === 'failed') {
        throw new Error(`Export failed for ${brief.id}: ${JSON.stringify(pollData)}`);
      }
    }
  }

  if (!artifact) {
    throw new Error(`Timeout waiting for Canva export artifact for ${brief.id}`);
  }
  console.log(`[${brief.id}] Artifact ready: ${artifact.id} (sha256: ${artifact.sha256})`);

  // 7. Download Artifact PNG
  const artRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva/artifacts/${artifact.id}`, {
    headers: AUTH_HEADERS,
  });
  if (!artRes.ok) {
    throw new Error(`Failed to download artifact for ${brief.id}: ${artRes.status}`);
  }
  const pngBytes = Buffer.from(await artRes.arrayBuffer());
  const pngPath = path.join(PROOFS_DIR, `v1-${brief.id}.png`);
  fs.writeFileSync(pngPath, pngBytes);
  console.log(`[${brief.id}] Saved PNG (${pngBytes.length} bytes) to ${pngPath}`);

  // 8. Fetch Plan Receipt
  const plansRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}/canva/plans`, {
    headers: AUTH_HEADERS,
  });
  let receipt: any = null;
  if (plansRes.ok) {
    const plansData = (await plansRes.json()) as any;
    const planRow = plansData.plans?.[0];
    receipt = planRow?.receipt || null;
  }

  const receiptPath = path.join(PROOFS_DIR, `v1-${brief.id}.receipt.json`);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        briefId: brief.id,
        taskId,
        canvaDesignId: designId,
        bindingVersion: currentBindingVersion,
        artifactSha256: artifact.sha256,
        elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(1),
        receipt,
      },
      null,
      2
    )
  );
  console.log(`[${brief.id}] Saved receipt to ${receiptPath}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  return {
    briefId: brief.id,
    taskId,
    canvaDesignId: designId,
    artifactSha256: artifact.sha256,
    inputTokens: receipt?.inputTokens ?? 0,
    outputTokens: receipt?.outputTokens ?? 0,
    elapsedSeconds: parseFloat(elapsed),
    receipt,
  };
}

async function main() {
  console.log(`=== DESIGN STUDIO V2: RUNNING V1 BASELINE COMPARISONS ===`);
  const briefsDir = path.resolve('packages/evals/src/design-studio/briefs');
  const files = fs
    .readdirSync(briefsDir)
    .filter((f) => f.startsWith('compare-') && f.endsWith('.json'))
    .sort();

  const results: any[] = [];
  for (const file of files) {
    const brief = JSON.parse(fs.readFileSync(path.join(briefsDir, file), 'utf8')) as Brief;
    try {
      const res = await runBrief(brief);
      results.push(res);
    } catch (err: any) {
      console.error(`ERROR running brief ${brief.id}:`, err.message);
      results.push({
        briefId: brief.id,
        error: err.message,
      });
    }
  }

  console.log(`\n================ SUMMARY ================`);
  console.table(
    results.map((r) => ({
      Brief: r.briefId,
      Task: r.taskId?.slice(0, 8),
      Design: r.canvaDesignId?.slice(0, 12),
      SHA256: r.artifactSha256?.slice(0, 10),
      InputTok: r.inputTokens,
      OutputTok: r.outputTokens,
      Elapsed: r.elapsedSeconds ? `${r.elapsedSeconds}s` : 'FAILED',
    }))
  );

  // Compute total tokens and estimated cost
  // Pricing for Opus 5: $5 / MTok input, $15 / MTok output
  let totalInput = 0;
  let totalOutput = 0;
  for (const r of results) {
    totalInput += r.inputTokens || 0;
    totalOutput += r.outputTokens || 0;
  }
  const costUSD = (totalInput * 5) / 1_000_000 + (totalOutput * 15) / 1_000_000;
  console.log(`Total Input Tokens: ${totalInput}`);
  console.log(`Total Output Tokens: ${totalOutput}`);
  console.log(`Estimated Total Cost (Opus 5): $${costUSD.toFixed(4)} USD`);

  fs.writeFileSync(
    path.join(PROOFS_DIR, 'summary.json'),
    JSON.stringify({ results, totalInput, totalOutput, costUSD, timestamp: new Date().toISOString() }, null, 2)
  );
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
