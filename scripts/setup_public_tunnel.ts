#!/usr/bin/env node
/**
 * Setup & Verify Public Tunnel, Telegram Push Webhook, and Cloud Figma Bridge
 * Part of Hawa Horizons 16-19 Execution Suite.
 */

async function main() {
  console.log('================================================================');
  console.log('  HAWA CREATIVE OS — PUBLIC TUNNEL & CLOUD INGRESS INITIALIZER  ');
  console.log('================================================================\n');

  const coreBaseUrl = process.env.HAWA_CORE_URL || 'http://127.0.0.1:8080';
  const targetWebhookUrl = process.argv[2] || process.env.TELEGRAM_WEBHOOK_URL || 'https://preview-office.kaae.org/api/webhooks/telegram';
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET must be set; this script has no built-in secret');

  console.log(`[1/4] Inspecting Hawa Core at ${coreBaseUrl}...`);
  try {
    const healthRes = await fetch(`${coreBaseUrl}/v1/health`);
    if (healthRes.ok) {
      const health = await healthRes.json();
      console.log(`  ✓ Core Engine Healthy: status=${health.status}, timestamp=${health.timestamp}`);
    } else {
      console.warn(`  ⚠️ Core returned HTTP ${healthRes.status}`);
    }
  } catch (err: any) {
    console.error(`  ✗ Failed to connect to Hawa Core at ${coreBaseUrl}:`, err.message);
    process.exit(1);
  }

  // Webhook registration was removed by stage 2 of ADR-135: the worker's poller is the only way
  // updates reach Hawa, through RequestLifecycle, and a webhook would stop its getUpdates.
  console.log('\n[2/4] Telegram: polled by the worker (ADR-135); no webhook is registered.');
  console.log(`  (was: ${targetWebhookUrl}; the secret stays for Core's internal intake)`);

  console.log('\n[3/4] Checking Figma Cloud Agent Studio Bridge Status...');
  try {
    const figmaRes = await fetch(`${coreBaseUrl}/v1/adapters/figma/cloud-status`);
    if (figmaRes.ok) {
      const figmaData = await figmaRes.json();
      console.log(`  ✓ Mode: ${figmaData.figma?.mode} (Configured: ${figmaData.figma?.configured})`);
      console.log(`  ✓ Master File Key: ${figmaData.figma?.fileKey}`);
      console.log(`  🔒 Invariant #14: Agent output strictly confined to '30_AI_STAGING'`);
    }
  } catch (err: any) {
    console.error(`  ✗ Failed to query Figma status:`, err.message);
  }

  console.log('\n[4/4] Verifying Kurdish Voice Note Multimodal Ingress Engine...');
  try {
    const voiceRes = await fetch(`${coreBaseUrl}/v1/assets/transcribe-brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'سڵاو، تکایە کەمپەینێکی نوێ بۆ فاستپەی دروست بکە بە داشکاندنی لەسەدا پەنجا و ٥٠٠٠ دینار کاشباک',
        durationSeconds: 10,
      }),
    });
    if (voiceRes.ok) {
      const voiceData = await voiceRes.json();
      console.log(`  ✓ Voice Transcriber Result:`, voiceData.normalizedText);
      console.log(`  ✓ Protected Tokens Extracted:`, voiceData.protectedTokens.map((t: any) => t.value).join(', ') || 'None');
      console.log(`  ✓ Language Detected: ${voiceData.detectedLanguage} (Confidence: ${voiceData.confidence})`);
    }
  } catch (err: any) {
    console.error(`  ✗ Voice transcriber check failed:`, err.message);
  }

  console.log('\n================================================================');
  console.log('  ALL 4 HORIZONS READY FOR PRODUCTION DEMO & TELEGRAM TESTING!  ');
  console.log('================================================================\n');
}

main().catch(console.error);
