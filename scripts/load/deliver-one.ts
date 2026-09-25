#!/usr/bin/env tsx
/**
 * One request on the chaos stack, brief to delivery, and who delivered it: for rehearsing the
 * Phase 2 flags (runbooks/20_architecture_operations.md). Chaos stack only (its driver refuses
 * anything else).
 *
 *   npx tsx scripts/load/deliver-one.ts <chat id>
 *
 * Sends a brief in the chat through the fake Telegram, waits for the draft, approves it in the Desk
 * API as the art director (the PNG pinned), presses Deliver once, waits until the file reached the
 * chat, and prints the publication's executor: `restate` when Core handed the delivery to the Delivery
 * workflow (the chat was on HAWA_LIFECYCLE_CHATS when Deliver was pressed), `core` otherwise.
 */
import { closeDb, query, sql } from '../../packages/testkit/chaos/driver/stack.js';
import { approve, briefToDraft, deliver, waitDelivered } from '../../packages/testkit/chaos/driver/scenario.js';

async function main(): Promise<void> {
  const chat = process.argv[2];
  if (!chat || !/^\d+$/.test(chat)) throw new Error('usage: deliver-one.ts <chat id>');
  try {
    const taskId = await briefToDraft(chat, `DELIVER-ONE-${chat}`);
    console.log(`task ${taskId}: draft shown in chat ${chat}`);
    const approved = await approve(taskId);
    if (approved.status >= 300) throw new Error(`approval refused: HTTP ${approved.status}`);
    const delivered = await deliver(taskId);
    console.log(`Deliver: HTTP ${delivered.status}${delivered.body?.executor ? `, executor ${delivered.body.executor}` : ''}`);
    if (delivered.status >= 300) throw new Error(`delivery refused: HTTP ${delivered.status}`);
    await waitDelivered(chat, taskId);
    const pubs = await query<{ executor: string; state: string }>(sql`SELECT executor, state::text AS state FROM hawa.publications WHERE task_id = ${taskId}::uuid`);
    console.log(`delivered: publications ${JSON.stringify(pubs)}`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
