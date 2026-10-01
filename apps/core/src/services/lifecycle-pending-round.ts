/**
 * ADR-230 addendum (live test 2026-10-01, L8): a change the requester sent while their design was being
 * made is applied.
 *
 * Request ab48fb97: at 13:59 "also please add that seats are limited" arrived while the request was
 * `designing`. Intake kept it on the request for the office (ADR-144's pending change) and told the
 * requester "I've added that". The draft finished at 14:00 without it, went to office review as if
 * nothing had been said, and the office's draft alert did not mention it.
 *
 * When a design run finishes with a draft and changes are kept from that very round (a late change of
 * kind `change`, kept while the request was `designing` at the revision the run finished at, and not
 * yet read by an office member), the design outcome starts the next round with them as its directive,
 * in the same transaction: the finished draft is recorded (its task `revision_requested`) and never sent
 * to review; a child task carries the changes; the request stays `designing` on it. The changes were the
 * requester's own instruction, so the paid round is theirs; it counts against the daily automatic-design
 * allowance as any change does, and no other model call is made.
 *
 * When the round cannot start (the allowance is used up, the brief cannot be found, or this request
 * already had `MAX_PENDING_ROUNDS` such rounds), the draft goes to review as before, the office's alert
 * lists the changes word for word and says they are not in it, the changes stay unread (Deliver waits
 * for them), and the requester is told the office has them.
 */
import { CHANNEL_INGRESS_USER_ID } from '@hawa/contracts';
import { TaskRepository, sql, type Database, type Kysely } from '@hawa/db';
import { PENDING_ROUND_MESSAGES, escapeTelegramHtml, say, type RequesterLang } from '@hawa/integrations';
import { persistChatIntake, type ChatIntake } from './chat-intake.js';
import { acknowledgeLateChange } from './lifecycle-chat-target.js';
import { LifecycleProjectionConflict } from './lifecycle-projection.js';
import { designName } from './requester-turn.js';
import { freshDirectionLine, planPendingCopyChanges, type CopyFields } from './fresh-round-copy.js';

/** Automatic rounds for changes sent while designing, per request: a person takes over after these. */
export const MAX_PENDING_ROUNDS = 3;

export interface PendingDesignChange { updateId: string; text: string }

/** Changes kept on the request while it was being designed at `rev`, that no office member has read. */
export async function pendingDesigningChanges(trx: Kysely<Database>, tenantId: string, requestId: string,
  rev: number): Promise<PendingDesignChange[]> {
  return (await sql<{ source_event_id: string; text: string }>`SELECT l.source_event_id, l.payload->>'text' AS text
    FROM hawa.inbox_events l
    WHERE l.tenant_id = ${tenantId}::uuid AND l.source_account_id = 'lifecycle_chat_routing'
      AND l.event_kind = 'lifecycle_late_requester_change' AND l.payload->>'requestId' = ${requestId}
      AND coalesce(l.payload->>'kind', 'change') = 'change' AND l.payload->>'requestStage' = 'designing'
      AND l.payload->>'requestRev' = ${String(rev)} AND coalesce(l.payload->>'text', '') <> ''
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events a WHERE a.tenant_id = l.tenant_id
        AND a.source_account_id = 'lifecycle_late_change_ack' AND a.source_event_id = l.source_event_id)
    ORDER BY l.received_at, l.id`.execute(trx)).rows.map((row) => ({ updateId: row.source_event_id, text: row.text }));
}

/** The requester's words as they will see them quoted (HTML), each in full up to 300 characters. */
export function quotedChanges(changes: PendingDesignChange[]): string {
  return changes.map((c) => {
    const words = Array.from(c.text.trim().replace(/\s+/g, ' '));
    return `“${escapeTelegramHtml(words.length > 300 ? `${words.slice(0, 299).join('')}…` : words.join(''))}”`;
  }).join('; ');
}

export interface PendingRound { newTaskId: string; runId: string; round: number; directive: string; updateIds: string[] }

export type PendingRoundAttempt =
  | { started: true; round: PendingRound; requesterText: string }
  | { started: false; why: PendingRoundRefusal; changes: PendingDesignChange[];
      requesterText: string; officeNote: string };

type PendingRoundRefusal = 'DAILY_CAP_REACHED' | 'PARENT_BRIEF_MISSING' | 'ROUND_LIMIT' | 'COPY_CHANGE_UNSAFE';
const WHY: Record<Exclude<PendingRoundRefusal, 'COPY_CHANGE_UNSAFE'>, string> = {
  DAILY_CAP_REACHED: 'the automatic design allowance for today is used up',
  PARENT_BRIEF_MISSING: 'the brief of this design could not be found',
  ROUND_LIMIT: `this request already had ${MAX_PENDING_ROUNDS} automatic rounds for changes sent while it was being made`,
};

/**
 * Inside the design outcome's transaction, after its draft was recorded and the request moved to
 * `in_review` at `rev`: start the round for the pending changes, or say why not. Null when there are
 * none. A failed start leaves nothing behind (a savepoint is rolled back).
 */
export async function startPendingChangeRound(trx: Kysely<Database>, input: {
  tenantId: string; requestId: string; taskId: string; chatId: string | null; clientId: string | null;
  expectedRev: number; rev: number; title: string; lang: RequesterLang; officeTold: boolean; actionKey: string;
}): Promise<PendingRoundAttempt | null> {
  const { tenantId, requestId, taskId, expectedRev, rev } = input;
  const changes = await pendingDesigningChanges(trx, tenantId, requestId, expectedRev);
  if (!changes.length) return null;
  const named = { title: designName(input.title, input.lang), changes: quotedChanges(changes) };
  await sql`SAVEPOINT pending_change_round`.execute(trx);
  try {
    const earlier = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.lifecycle_projections
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid AND result ? 'pendingRound'`.execute(trx)).rows[0]?.n ?? 0);
    if (earlier >= MAX_PENDING_ROUNDS) throw new LifecycleProjectionConflict('WRONG_STAGE', 'ROUND_LIMIT');
    const parent = await trx.selectFrom('outbox_commands').select('payload')
      .where('tenant_id', '=', tenantId).where('aggregate_id', '=', taskId)
      .where('command_type', '=', 'task.created').executeTakeFirst();
    const p = parent?.payload as Record<string, unknown> | undefined;
    if (!p || !Array.isArray(p.exactCopy) || typeof p.designInstructions !== 'string' || !input.chatId) {
      throw new LifecycleProjectionConflict('PARENT_BRIEF_MISSING', 'PARENT_BRIEF_MISSING');
    }
    const options = p.studioOptions && typeof p.studioOptions === 'object' ? p.studioOptions as Record<string, unknown> : {};
    const round = (Number.isInteger(options.revisionRound) ? Number(options.revisionRound) : 0) + 1;
    const directive = changes.map((c) => c.text.trim()).join('\n').slice(0, 2000);
    const inherited = Object.fromEntries(['tier', 'imagery', 'previews', 'holdForSelection']
      .filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
    // ADR-233: words to add or alter go into the copy, rebuilt from the requester's own message; a
    // change to the words that cannot be applied that way stops the round, and the office has them.
    const copy = planPendingCopyChanges(p.exactCopy, p as CopyFields, changes.map((c) => c.text));
    if (!copy.ok) throw new LifecycleProjectionConflict('WRONG_STAGE', `COPY_CHANGE_UNSAFE:${copy.why}`);
    const fields = Object.fromEntries((['headlineEn', 'headlineCkb', 'copyEn', 'copyCkb'] as const)
      .filter((k) => typeof copy.fields[k] === 'string').map((k) => [k, copy.fields[k]]));
    const draft: ChatIntake = {
      platform: 'telegram', sourceEventId: `lc-${requestId}-r${round}-pending-${expectedRev}`, sourceChannelId: input.chatId,
      rawText: directive, rawJson: { pendingChanges: changes.map((c) => c.updateId), fromTask: taskId, requestRev: expectedRev,
        copyChanges: copy.applied },
      title: directive.slice(0, 200),
      designInstructions: `${p.designInstructions}\n${freshDirectionLine('pending_changes', directive)}`,
      exactCopy: copy.exactCopy, clientId: input.clientId, autoGenerate: true,
      ...fields,
      ...(p.variant && typeof p.variant === 'object' ? { variant: p.variant as { width: number; height: number } } : {}),
      ...(typeof p.designStudio === 'boolean' ? { designStudio: p.designStudio } : {}),
      // A new design of the request, never an edit of the draft that just finished (ADR-233): nobody has
      // reviewed or touched that draft, and its Canva design is left as it is.
      studioOptions: { ...inherited, revisionRound: round,
        freshFrom: { parentTaskId: taskId, kind: 'pending_changes', directive } } as ChatIntake['studioOptions'],
    };
    const persisted = await persistChatIntake(trx, { ...draft, tenantId }, { outboxState: 'recorded' });
    if (persisted.autoGenerateDeclined) throw new LifecycleProjectionConflict('DAILY_CAP_REACHED', 'DAILY_CAP_REACHED');
    const newTaskId = String(persisted.task.id);
    const claimed = await trx.updateTable('tasks').set({ request_id: requestId })
      .where('tenant_id', '=', tenantId).where('id', '=', newTaskId).where('request_id', 'is', null)
      .returning('id').executeTakeFirst();
    if (!claimed) throw new LifecycleProjectionConflict('TASK_ALREADY_OWNED', 'The pending-change round task acquired another owner');
    // The finished draft is not reviewed: it is superseded by the round that carries the changes.
    const finished = await trx.selectFrom('tasks').select(['state', 'version'])
      .where('tenant_id', '=', tenantId).where('id', '=', taskId).executeTakeFirstOrThrow();
    if (finished.state === 'human_review') {
      await new TaskRepository(trx).transitionState({ taskId, tenantId, expectedVersion: Number(finished.version),
        fromState: 'human_review', toState: 'revision_requested', actorType: 'workflow', actorId: CHANNEL_INGRESS_USER_ID,
        reason: 'The requester sent changes while this draft was being made; a new round carries them.',
        data: { pendingChanges: changes.map((c) => c.updateId), revisionTaskId: newTaskId } }, trx);
    }
    const moved = await trx.updateTable('requests').set({ stage: 'designing', current_task_id: newTaskId, updated_at: new Date() })
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', rev)
      .returning('request_id').executeTakeFirst();
    if (!moved) throw new LifecycleProjectionConflict('STALE_REVISION', 'Request changed while its pending changes were applied');
    // Read by this round: the Deliver gate does not wait for them, and they are never applied twice.
    for (const change of changes) {
      await acknowledgeLateChange(trx, tenantId, { requestId, updateId: change.updateId, actorUserId: CHANNEL_INGRESS_USER_ID,
        actorRole: 'lifecycle_pending_round', actionId: input.actionKey });
    }
    await sql`RELEASE SAVEPOINT pending_change_round`.execute(trx);
    return { started: true, round: { newTaskId, runId: `dr-${newTaskId}`, round, directive, updateIds: changes.map((c) => c.updateId) },
      requesterText: say(PENDING_ROUND_MESSAGES.addingChanges, input.lang, named) };
  } catch (error) {
    const unsafeCopy = error instanceof LifecycleProjectionConflict && error.message.startsWith('COPY_CHANGE_UNSAFE:')
      ? error.message.slice('COPY_CHANGE_UNSAFE:'.length) : null;
    const why: PendingRoundRefusal | null = error instanceof LifecycleProjectionConflict
      ? (unsafeCopy !== null ? 'COPY_CHANGE_UNSAFE' : error.message === 'ROUND_LIMIT' ? 'ROUND_LIMIT' : error.code === 'DAILY_CAP_REACHED' ? 'DAILY_CAP_REACHED'
        : error.code === 'PARENT_BRIEF_MISSING' ? 'PARENT_BRIEF_MISSING' : null) : null;
    await sql`ROLLBACK TO SAVEPOINT pending_change_round`.execute(trx);
    if (!why) throw error;
    const words = changes.map((c) => `“${c.text.trim().length > 1500 ? `${c.text.trim().slice(0, 1500)}…` : c.text.trim()}”`).join('\n');
    const reason = why === 'COPY_CHANGE_UNSAFE' ? `a change to the design's words could not be applied safely: ${unsafeCopy}` : WHY[why];
    return { started: false, why, changes,
      requesterText: say(input.officeTold ? PENDING_ROUND_MESSAGES.changesWithOffice : PENDING_ROUND_MESSAGES.changesKept, input.lang, named),
      officeNote: `NOT IN THIS DRAFT: while it was being made the requester asked for the changes below, and a new round could not start (${reason}). Please make them before it is approved:\n${words}` };
  }
}
