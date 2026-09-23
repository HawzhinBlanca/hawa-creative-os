/**
 * What the Work screen says after Approve and Deliver, and who may approve.
 *
 * Found on 2026-09-23: a delivery that reached the requester in Telegram while Drive refused was
 * shown as "Delivery failed"; an approval or delivery that succeeded was reported as failed when
 * only the refresh after it failed; and the approval dialog offered a "Sign-off Role" that was
 * never sent, while Core refuses every approval from an operator session.
 */

export interface ActionNotice {
  tone: 'success' | 'info' | 'error';
  text: string;
  /** How long the notice stays, when longer than the default. */
  durationMs?: number;
}

/** Why the signed-in session cannot approve, or null when it can (or its role is not known). */
export function approvalRoleBlocker(role: string | undefined | null): string | null {
  if (!role) return null;
  return role.toLowerCase().trim() === 'operator'
    ? 'Approval needs an art director or administrator sign-in. You are signed in as an operator; sign out and sign in with an approver key to approve.'
    : null;
}

/** The signed-in role as the office reads it: "art_director" as "Art Director". */
export function roleLabel(role: string): string {
  return role
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

const REFRESH_NOTE = ' Refresh the page to see the latest status.';

/**
 * The notice after Core accepted a delivery. `refreshedStatus` is the task's status read after it,
 * undefined when that read failed: the delivery still happened, so the notice says so and asks
 * for a refresh instead of reporting a failure.
 */
export function describeDelivery(delivery: unknown, refreshedStatus: string | undefined): ActionNotice {
  const d = (delivery && typeof delivery === 'object' ? delivery : {}) as { status?: unknown; message?: unknown; sheetProblem?: unknown };
  const refreshNote = refreshedStatus === undefined ? REFRESH_NOTE : '';
  if (d.status === 'DELIVERED_TO_CHAT_ONLY') {
    // Core's message ends by restating that the file went to Telegram; the notice already says it.
    const reason = String(d.message || 'no reason reported')
      .replace(/\s*The approved file (?:was sent|is queued) (?:to|for) the requester in Telegram[^.]*\.?\s*$/i, '')
      .replace(/[.\s]+$/, '');
    return {
      tone: 'info',
      text: `Sent to the requester in Telegram. The Drive copy was not saved: ${reason || 'no reason reported'}.${refreshNote}`,
      durationMs: 12000,
    };
  }
  if (refreshedStatus === 'COMPLETE' || (refreshedStatus === undefined && d.status === 'COMPLETE')) {
    return { tone: 'success', text: `Delivery complete.${refreshNote}` };
  }
  if (d.status === 'PUBLISH_RECONCILIATION') {
    // The files are in Drive but the Sheets row was not confirmed; delivering again retries only the row.
    return {
      tone: 'info',
      text: `Files delivered to Drive, but the Sheets row is not confirmed: ${String(d.sheetProblem || 'no reason reported')}. Deliver again to retry the row.${refreshNote}`,
    };
  }
  return { tone: 'info', text: `Publication requested. Check the task for verified delivery status.${refreshNote}` };
}

/** The notice after Core recorded an approval; `refreshed` is false when the read after it failed. */
export function describeApproval(revisionId: string, decisionId: string | undefined, refreshed: boolean): ActionNotice {
  return {
    tone: 'success',
    text: `Approved Revision ${revisionId}. Decision ID: ${decisionId || 'recorded'}.${refreshed ? '' : REFRESH_NOTE}`,
  };
}
