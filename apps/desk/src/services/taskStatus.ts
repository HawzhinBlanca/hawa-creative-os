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
 * The statuses are Core's: toApiTaskStatus (packages/db task.repository.ts) for every database
 * state, the domain state machine's TaskStatus, and the ones Core sets on its in-memory tasks and
 * broadcasts (IN_PROGRESS, PAUSED, CHANGES_REQUESTED, COMPLETED).
 */

/** Who has the next move: the office, the approver, Core, the requester, or nobody. */
export type StatusGroup = 'needs_action' | 'review' | 'in_design' | 'delivering' | 'waiting' | 'complete' | 'closed';

export interface TaskStatusView {
  pill: string;
  pillClass: string;
  message: string;
  primaryButton: 'edit' | 'capture' | 'approve' | 'deliver' | 'deliver_again' | 'none';
  group: StatusGroup;
  /** False where Core refuses an approval (revision_requested, publishing, complete, cancelled, rejected, approved). */
  canApprove: boolean;
}

type View = Omit<TaskStatusView, 'canApprove'> & { canApprove?: boolean };

const WORKING = 'Nothing to do yet: the task moves on by itself, and this screen updates when it does.';

const VIEWS: Record<string, View> = {
  RECEIVED: {
    pill: 'RECEIVED',
    pillClass: 'pill-received',
    message: 'Your request is saved. Use the Canva controls below to design, edit and check it.',
    primaryButton: 'edit',
    group: 'needs_action',
  },
  PROMOTION_PENDING: {
    pill: 'STARTING',
    pillClass: 'pill-progress',
    message: `Core is turning the message into a design task. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ROUTING: {
    pill: 'ROUTING',
    pillClass: 'pill-progress',
    message: `Core is working out which client this request is for. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ROUTING_REVIEW: {
    pill: 'CHECK CLIENT',
    pillClass: 'pill-action',
    message: 'Core could not tell which client this request is for. A person must confirm the client before design starts.',
    primaryButton: 'none',
    group: 'needs_action',
  },
  NEEDS_INFORMATION: {
    pill: 'NEEDS INFORMATION',
    pillClass: 'pill-waiting',
    message: 'Waiting for the requester to send what is missing. Design starts when they answer.',
    primaryButton: 'none',
    group: 'waiting',
  },
  BRIEFING: {
    pill: 'BRIEFING',
    pillClass: 'pill-progress',
    message: `Core is writing the design brief. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  BRIEF_REVIEW: {
    pill: 'CHECK BRIEF',
    pillClass: 'pill-action',
    message: 'The design brief waits for a person to check it before design starts.',
    primaryButton: 'none',
    group: 'needs_action',
  },
  PLANNING: {
    pill: 'PLANNING',
    pillClass: 'pill-progress',
    message: `The design is being planned. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  ASSET_GENERATION: {
    pill: 'MAKING IMAGES',
    pillClass: 'pill-progress',
    message: `Images for the design are being made. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  COMPOSING: {
    pill: 'BEING MADE',
    pillClass: 'pill-progress',
    message: `The design is being made right now. Wait for the draft before starting another. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  QA: {
    pill: 'CHECKING',
    pillClass: 'pill-progress',
    message: `The draft is being checked before it comes to review. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  REPAIRING: {
    pill: 'CORRECTING',
    pillClass: 'pill-progress',
    message: `The check found problems and the draft is being corrected. ${WORKING}`,
    primaryButton: 'none',
    group: 'in_design',
  },
  IN_PROGRESS: {
    pill: 'IN DESIGN',
    pillClass: 'pill-progress',
    message: 'Design work is in progress. Capture for Review stores a PNG export of the linked Canva design; it runs no QA and approves nothing.',
    primaryButton: 'capture',
    group: 'in_design',
  },
  AWAITING_APPROVAL: {
    pill: 'NEEDS APPROVAL',
    pillClass: 'pill-action',
    message: 'Review requested. Inspect the captured files and current QA result before approving.',
    primaryButton: 'approve',
    group: 'review',
  },
  REVISION_REQUESTED: {
    pill: 'CHANGES REQUESTED',
    pillClass: 'pill-action',
    message: 'Changes were requested on this revision, so it can no longer be approved. It can be approved again only after a new revision with the changes is recorded.',
    primaryButton: 'edit',
    group: 'needs_action',
    canApprove: false,
  },
  APPROVED: {
    pill: 'APPROVED',
    pillClass: 'pill-approved',
    message: 'Approved. Deliver Approved Files sends the pinned exports; Core checks the approval against the current revision first.',
    primaryButton: 'deliver',
    group: 'needs_action',
    canApprove: false,
  },
  PUBLISHING: {
    pill: 'DELIVERING',
    pillClass: 'pill-progress',
    message: 'Delivery to Google Drive and Sheets is running. Wait for its result before delivering again.',
    primaryButton: 'none',
    group: 'delivering',
    canApprove: false,
  },
  PUBLISH_RECONCILIATION: {
    pill: 'SHEETS ROW PENDING',
    pillClass: 'pill-action',
    message: 'The approved files are in Google Drive, but the Sheets row is not confirmed. Deliver again to retry only the row.',
    primaryButton: 'deliver',
    group: 'needs_action',
    canApprove: false,
  },
  COMPLETE: {
    pill: 'COMPLETE',
    pillClass: 'pill-complete',
    message: 'Task is marked complete. Check its delivery receipt and audit history for destination evidence.',
    primaryButton: 'deliver_again',
    group: 'complete',
    canApprove: false,
  },
  PAUSED: {
    pill: 'WAITING FOR ANSWER',
    pillClass: 'pill-waiting',
    message: 'Waiting for the requester to answer a question about their change. Nothing is designed until they answer.',
    primaryButton: 'none',
    group: 'waiting',
  },
  OPERATOR_REQUIRED: {
    pill: 'NEEDS A DESIGNER',
    pillClass: 'pill-failed',
    message: 'The automatic draft failed or stopped, so a designer must take this over. The panels below show what exists and why it stopped.',
    primaryButton: 'edit',
    group: 'needs_action',
  },
  REJECTED: {
    pill: 'REJECTED',
    pillClass: 'pill-complete',
    message: 'Rejected. Nothing more happens on this task.',
    primaryButton: 'none',
    group: 'closed',
    canApprove: false,
  },
  CANCELLED: {
    pill: 'CANCELLED',
    pillClass: 'pill-complete',
    message: 'Cancelled. Nothing more happens on this task.',
    primaryButton: 'none',
    group: 'closed',
    canApprove: false,
  },
};
// Names Core uses for the same state on its in-memory tasks.
VIEWS.CHANGES_REQUESTED = VIEWS.REVISION_REQUESTED;
VIEWS.COMPLETED = VIEWS.COMPLETE;

/** The label, next step and filter group of a status Core reports. */
export function taskStatusView(status: string | undefined | null): TaskStatusView {
  const known = VIEWS[String(status || '').toUpperCase()];
  if (known) return { ...known, canApprove: known.canApprove ?? true };
  // A status this Desk does not know is shown as itself and kept in "Needs Action", never guessed.
  return {
    pill: status ? String(status).replace(/_/g, ' ').toUpperCase() : 'NO STATUS',
    pillClass: 'pill-action',
    message: `Core reports status "${status || 'none'}", which this Desk does not know. Nothing is assumed about it: check the task's history.`,
    primaryButton: 'none',
    group: 'needs_action',
    canApprove: true,
  };
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
  return Object.keys(VIEWS).filter((status) => inQueueFilter(status, filter));
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
