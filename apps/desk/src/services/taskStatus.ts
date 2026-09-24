/**
 * What the Work screen shows for each status Core reports, and which queue filter it falls under.
 *
 * Found on 2026-09-24: the screen knew five statuses. Every other one (a draft being made, a failed
 * draft waiting for a designer, a question waiting for the requester's answer, a cancelled or
 * rejected task) was shown as RECEIVED with "Use the Canva controls below to design"; a task sent
 * back for changes showed APPROVED because an older approval was checked before its status; "Needs
 * Action" left out the failed drafts; and "In Design" matched only IN_PROGRESS, which the
 * database-backed list never returns. Each status now has its own label and next step, the status
 * decides (never an old approval), and the filters are built from the same groups as the labels.
 *
 * The statuses, their labels and which of them can be approved are the one vocabulary in
 * packages/contracts/src/task-status.ts (architecture programme 1.2), which Core and the database use
 * too. The Desk's build is `tsc -b`, which builds @hawa/contracts first through the tsconfig
 * reference, so the Desk image (no package dist in it) and a checkout with an old dist both bundle
 * today's list. The views below are keyed by that list, so a status added there does not compile
 * here until it has a view.
 */
import {
  TASK_STATUS_LABELS,
  isApprovableTaskStatus,
  isTaskApiStatus,
  type TaskApiStatus,
} from '@hawa/contracts/task-status';

/** Who has the next move: the office, the approver, Core, the requester, or nobody. */
export type StatusGroup = 'needs_action' | 'review' | 'in_design' | 'delivering' | 'waiting' | 'complete' | 'closed';

export interface TaskStatusView {
  pill: string;
  pillClass: string;
  message: string;
  primaryButton: 'edit' | 'capture' | 'approve' | 'deliver' | 'deliver_again' | 'none';
  group: StatusGroup;
  /** Only a status the shared vocabulary lets a person approve (AWAITING_APPROVAL); never an unknown one. */
  canApprove: boolean;
  /** False for a word the shared vocabulary does not have. */
  known: boolean;
}

type View = Omit<TaskStatusView, 'pill' | 'canApprove' | 'known'>;

const WORKING = 'Nothing to do yet: the task moves on by itself, and this screen updates when it does.';

/** The next step and filter group of each status. The pill label is the shared vocabulary's. */
export const STATUS_VIEWS: Readonly<Record<TaskApiStatus, View>> = {
  RECEIVED: {
    pillClass: 'pill-received',
    message: 'Your request is saved. Use the Canva controls below to design, edit and check it.',
    primaryButton: 'edit',
    group: 'needs_action',
  },
  PROMOTION_PENDING: {
    pillClass: 'pill-progress',
    message: `Core is turning the message into a design task. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ROUTING: {
    pillClass: 'pill-progress',
    message: `Core is working out which client this request is for. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ROUTING_REVIEW: {
    pillClass: 'pill-action',
    message: 'Core could not tell which client this request is for. A person must confirm the client before design starts.',
    primaryButton: 'none',
    group: 'needs_action',
  },
  BRIEFING: {
    pillClass: 'pill-progress',
    message: `Core is writing the design brief. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  BRIEF_REVIEW: {
    pillClass: 'pill-action',
    message: 'The design brief waits for a person to check it before design starts.',
    primaryButton: 'none',
    group: 'needs_action',
  },
  PLANNING: {
    pillClass: 'pill-progress',
    message: `The design is being planned. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ASSET_GENERATION: {
    pillClass: 'pill-progress',
    message: `Images for the design are being made. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  COMPOSING: {
    pillClass: 'pill-progress',
    message: `The design is being made right now. Wait for the draft before starting another. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  QA: {
    pillClass: 'pill-progress',
    message: `The draft is being checked before it comes to review. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  REPAIRING: {
    pillClass: 'pill-progress',
    message: `The check found problems and the draft is being corrected. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  AWAITING_APPROVAL: {
    pillClass: 'pill-action',
    message: 'Review requested. Inspect the captured files and current QA result before approving.',
    primaryButton: 'approve',
    group: 'review',
  },
  REVISION_REQUESTED: {
    pillClass: 'pill-action',
    message: 'Changes were requested on this revision, so it can no longer be approved. It can be approved again only after a new revision with the changes is recorded.',
    primaryButton: 'edit',
    group: 'needs_action',
  },
  APPROVED: {
    pillClass: 'pill-approved',
    message: 'Approved. Deliver Approved Files sends the pinned exports; Core checks the approval against the current revision first.',
    primaryButton: 'deliver',
    group: 'needs_action',
  },
  PUBLISHING: {
    pillClass: 'pill-progress',
    message: 'Delivery to Google Drive and Sheets is running. Wait for its result before delivering again.',
    primaryButton: 'none',
    group: 'delivering',
  },
  PUBLISH_RECONCILIATION: {
    pillClass: 'pill-action',
    message: 'The approved files are in Google Drive, but the Sheets row is not confirmed. Deliver again to retry only the row.',
    primaryButton: 'deliver',
    group: 'needs_action',
  },
  COMPLETE: {
    pillClass: 'pill-complete',
    message: 'Task is marked complete. Check its delivery receipt and audit history for destination evidence.',
    primaryButton: 'deliver_again',
    group: 'complete',
  },
  PAUSED: {
    pillClass: 'pill-waiting',
    message: 'Waiting for the requester to answer a question about their request. Nothing is designed until they answer.',
    primaryButton: 'none',
    group: 'waiting',
  },
  OPERATOR_REQUIRED: {
    pillClass: 'pill-failed',
    message: 'The automatic draft failed or stopped, so a designer must take this over. The panels below show what exists and why it stopped.',
    primaryButton: 'edit',
    group: 'needs_action',
  },
  REJECTED: {
    pillClass: 'pill-complete',
    message: 'Rejected. Nothing more happens on this task.',
    primaryButton: 'none',
    group: 'closed',
  },
  CANCELLED: {
    pillClass: 'pill-complete',
    message: 'Cancelled. Nothing more happens on this task.',
    primaryButton: 'none',
    group: 'closed',
  },
};

/** The label, next step and filter group of a status Core reports. */
export function taskStatusView(status: string | undefined | null): TaskStatusView {
  // Core's words are exact (upper case); a word in another case is not one of them.
  if (isTaskApiStatus(status)) {
    return { ...STATUS_VIEWS[status], pill: TASK_STATUS_LABELS[status], canApprove: isApprovableTaskStatus(status), known: true };
  }
  // A status this Desk does not know is shown as unknown and kept in "Needs Action": never guessed,
  // never RECEIVED, and never approvable (the Desk used to offer approval for it).
  return {
    pill: `UNKNOWN: ${status ? String(status).replace(/_/g, ' ').toUpperCase() : 'NO STATUS'}`,
    pillClass: 'pill-failed',
    message: `Core reports status "${status || 'none'}", which this Desk does not know. Nothing is assumed about it and it cannot be approved here: check the task's history.`,
    primaryButton: 'none',
    group: 'needs_action',
    canApprove: false,
    known: false,
  };
}

/**
 * The Work screen's Approve button: hidden for a status the Desk does not know; enabled only for an
 * approvable status whose current revision passed QA; disabled otherwise.
 */
export function approveButtonState(
  status: string | undefined | null,
  task: { hasRevision: boolean; qaPassed: boolean; busy?: boolean }
): 'hidden' | 'disabled' | 'enabled' {
  const view = taskStatusView(status);
  if (!view.known) return 'hidden';
  return view.canApprove && task.hasRevision && task.qaPassed && !task.busy ? 'enabled' : 'disabled';
}

export type QueueFilter = 'all' | 'needs_action' | 'in_progress' | 'review' | 'complete';

/** The groups each queue filter shows: the same groups the labels come from. */
export const FILTER_GROUPS: Record<Exclude<QueueFilter, 'all'>, readonly StatusGroup[]> = {
  needs_action: ['needs_action', 'review'],
  review: ['review'],
  in_progress: ['in_design'],
  complete: ['complete'],
};

export function inQueueFilter(status: string | undefined | null, filter: QueueFilter): boolean {
  if (filter === 'all') return true;
  return FILTER_GROUPS[filter].includes(taskStatusView(status).group);
}

/**
 * The statuses a queue filter shows, for Core to filter by (GET /tasks?statuses=…): the queue reads
 * one page at a time, so filtering only the page on screen would hide every older match
 * (architecture programme 0.3). Undefined for "all".
 */
export function queueFilterStatuses(filter: QueueFilter): string[] | undefined {
  if (filter === 'all') return undefined;
  return (Object.keys(STATUS_VIEWS) as TaskApiStatus[]).filter((status) => inQueueFilter(status, filter));
}

/**
 * Text as the queue search compares it. Kurdish typed on an Arabic keyboard gives ي and ك where
 * Sorani text has ی and ک (2026-09-24): "كوردی" did not find "کوردی".
 */
export function searchFold(text: string | undefined | null): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک');
}
