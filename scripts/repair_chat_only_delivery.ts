/**
 * scripts/repair_chat_only_delivery.ts (ADR-230)
 *
 * Closes requests whose delivery finished chat-only before such a delivery closed its request: the
 * requester has every file and the final notice, the Drive archive was not written (the office Google
 * account was not connected), and the request still says "being delivered" (production request
 * 95eeb08d-c085-5f7d-b3d8-61049b1fc1fd, 2026-10-01).
 *
 * For each request id it sends one signed repair to the office gateway on Restate, which hands it to the
 * request's own object (RequestLifecycle.reconcileDelivery). Core reads the delivery report it stored and
 * its own Telegram send marks again, and delivers the request only when every file and the notice were
 * sent; anything else is refused and changes nothing. Running it twice is safe: a repaired request
 * answers `replayed`.
 *
 *   RESTATE_INGRESS_URL=http://127.0.0.1:8080 HAWA_WORKER_TOKEN=... \
 *     pnpm exec tsx scripts/repair_chat_only_delivery.ts <requestId> [<requestId> ...]
 *
 * Run it after the release that carries ADR-230 is deployed (an older worker has no such handler).
 */
import { pathToFileURL } from 'node:url';
import { signLifecycleOfficeEvent } from '../packages/integrations/src/lifecycle-office-auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RepairAnswer { requestId: string; status: number; body: unknown }

/** One signed repair through the office gateway; the gateway's answer as it came. */
export async function repairChatOnlyDelivery(requestId: string, options: { ingress: string; secret: string; fetcher?: typeof fetch }): Promise<RepairAnswer> {
  if (!UUID.test(requestId)) throw new Error(`Not a request id: ${requestId}`);
  const event = { v: 1 as const, kind: 'reconcile-delivery' as const, requestId: requestId.toLowerCase() };
  const signature = signLifecycleOfficeEvent(options.secret, event);
  const response = await (options.fetcher ?? fetch)(`${options.ingress.replace(/\/+$/, '')}/OfficeDecisionGateway/reconcileDelivery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text().catch(() => '');
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* the gateway's words as they are */ }
  return { requestId: event.requestId, status: response.status, body };
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const ingress = (process.env.RESTATE_INGRESS_URL || '').trim();
  const secret = (process.env.HAWA_WORKER_TOKEN || '').trim();
  if (!ids.length) throw new Error('Name at least one request id');
  if (!ingress || !secret) throw new Error('RESTATE_INGRESS_URL and HAWA_WORKER_TOKEN are required');
  let failed = 0;
  for (const id of ids) {
    const answer = await repairChatOnlyDelivery(id, { ingress, secret });
    const accepted = answer.status === 200 && (answer.body as { accepted?: unknown })?.accepted === true;
    if (!accepted) failed++;
    console.log(`${answer.requestId}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
