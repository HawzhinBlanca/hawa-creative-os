import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ResilientModelGateway } from '../packages/integrations/src/model-gateway.js';
import type { RequestContext } from '@hawa/contracts';

// Load .env.production
const envPath = path.resolve('infra/docker/.env.production');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      process.env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
}

const mockCtx: RequestContext = {
  tenantId: 'tenant-studio',
  clientId: 'client-office-1',
  taskId: 'task-test-models-001',
  actor: { type: 'model', id: 'tester' },
  correlationId: crypto.randomUUID(),
  deadline: new Date(Date.now() + 60000).toISOString(),
  idempotencyKey: crypto.randomUUID(),
};

async function run() {
  console.log('🤖 Initializing ModelGateway test for ChatGPT 5.6-Sol and Claude Opus 5...\n');
  const gateway = new ResilientModelGateway();

  // Test 1: Creative Director
  console.log('--- 1. Creative Director Role ---');
  console.log('Cascade order: OpenAI gpt-5.6-sol -> Anthropic claude-3-5-sonnet -> Google gemini-3.8-flash -> Deterministic fallback');
  const dirRes = await gateway.generateStructured(mockCtx, {
    role: 'creative_director',
    inputs: [{ text: 'Design a high-end Silicon Valley dark mode product poster for an autonomous creative engine named Synapse OS.' }],
    schema: { type: 'object' },
  });
  if (dirRes.ok) {
    console.log('✅ Creative Director Call: SUCCESS');
    console.log('  Resolved Provider:', dirRes.value.deployment.provider);
    console.log('  Resolved Model:', dirRes.value.deployment.exactModelId);
    console.log('  Execution Latency:', dirRes.value.latencyMs.toFixed(1), 'ms');
    console.log('  Token Cost USD:', `$${dirRes.value.usage.estimatedCostUsd.toFixed(5)}`);
  } else {
    console.log('❌ Error:', dirRes.error);
  }

  // Test 2: Visual Judge
  console.log('\n--- 2. Visual Judge Role ---');
  console.log('Cascade order: Anthropic claude-opus-5 -> Google gemini-3.8-flash -> OpenAI gpt-5.6-sol -> Heuristic judge');
  const judgeRes = await gateway.generateStructured(mockCtx, {
    role: 'visual_judge',
    inputs: [{ text: 'Inspect rendered canvas: A4 Swiss International Typographic poster.' }],
    schema: { type: 'object' },
  });
  if (judgeRes.ok) {
    console.log('✅ Visual Judge Call: SUCCESS');
    console.log('  Resolved Provider:', judgeRes.value.deployment.provider);
    console.log('  Resolved Model:', judgeRes.value.deployment.exactModelId);
    console.log('  Execution Latency:', judgeRes.value.latencyMs.toFixed(1), 'ms');
    console.log('  Token Cost USD:', `$${judgeRes.value.usage.estimatedCostUsd.toFixed(5)}`);
  } else {
    console.log('❌ Error:', judgeRes.error);
  }
}

run().catch(console.error);
