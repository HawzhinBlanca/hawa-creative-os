import { TaskControls } from '../components/TaskControls.js';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CanvaTaskPanel } from '../components/CanvaTaskPanel.js';
import { StudioPanel } from '../components/StudioPanel.js';
import { AskLedgerPanel } from '../components/AskLedger.js';
import { RequesterSendEvidencePanel } from '../components/RequesterSendEvidencePanel.js';
import { VectorInspector } from '../components/VectorInspector.js';
import { AuthorizedImage } from '../components/AuthorizedImage.js';
import { OriginalDocument } from '../components/DocumentRequestForm.js';
import { SubmittedCopy } from '../components/SubmittedCopy.js';
import { apiClient, ApiError, type DecisionPayload, type LateRequesterChangeView, type TaskListParams, type TaskListResponse, type TaskTimelineEvent } from '../api/client.js';
import { captureForReview } from '../services/canvaCapture.js';
import { read, reasonOf, type Reading } from '../services/statusReport.js';
import { approvalBlocker, defaultPins, describeExport, togglePin, type StoredExport } from '../services/approvalPins.js';
import { reserveDecisionAction, completeDecisionAction, type ReservedDecisionAction } from '../services/decisionActionId.js';
import { queueEntryChanged, readTaskDetail } from '../services/taskDetail.js';
import { approvalRoleBlocker, describeApproval, describeDelivery, roleLabel } from '../services/actionOutcome.js';
import { approveButtonState, inQueueFilter, queueFilterStatuses, taskStatusView, type QueueFilter } from '../services/taskStatus.js';
import { queryKeys, readingOf, type TaskPageView } from '../services/queryClient.js';
import { useDesk, usePollInterval, useSessionUser } from '../DeskProviders.js';

/** Tasks per queue page (Core's default page). */
const QUEUE_PAGE_SIZE = 50;
/** How long typing in the search box pauses before Core is asked. */
const SEARCH_PAUSE_MS = 300;

export interface LiveTask {
  sourceDocument?: { id: string; clientId: string; sourceSha256: string } | null;
  id: string;
  requestId?: string | null;
  clientId?: string;
  clientName?: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  designInstructions?: string;
  referenceAssets?: string;
  /** The task's stored reference photos (GET /tasks/:id only), each served by its authorised `url`. */
  referenceImages?: Array<{ sha256: string; mediaType: string; size: number; url: string }>;
  referenceImageCount?: number;
  source?: { platform?: string; externalId?: string; channelId?: string };
  sourcePlatform?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  latestRevisionId?: string;
  latestRevision?: {
    id: string;
    version: number;
    previewUrl?: string;
    svgContent?: string;
    sha256?: string;
    byteSize?: number;
    dimensions?: { width: number; height: number };
    format?: string;
    createdAt?: string;
  };
  canvaBinding?: {
    designId?: string;
    designUrl?: string;
    title?: string;
    lastSyncedAt?: string;
  };
  latestApproval?: {
    decisionId: string;
    role: string;
    actorId?: string;
    decidedAt: string;
  };
  deliveryReceipt?: {
    driveFolderUrl?: string;
    sheetRowUrl?: string;
    deliveredAt: string;
  };
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  qaReport?: {
    passed: boolean;
    bidiIsolation: boolean | null;
    rtlVisualReviewRequired?: boolean;
    /** null = not measured by the check that produced this report; rendered as pending, never as a pass. */
    safeMargins: boolean | null;
    contrastCompliant: boolean | null;
    fontFamilyPass?: boolean | null;
    /** Legacy field: a family-name check cannot establish rendered glyph coverage. */
    fontCoverage?: boolean | null;
    exportArtifactId?: string | null;
    exportSha256?: string | null;
    captureVersion?: string | null;
    errors?: string[];
  };
}

/** The page `view` names, filtered and searched by Core (the one list request the queue makes). */
export function readQueuePage(
  api: { list<T = any>(params?: TaskListParams): Promise<TaskListResponse<T>> },
  view: TaskPageView
): Promise<TaskListResponse<LiveTask>> {
  return api.list<LiveTask>({
    limit: QUEUE_PAGE_SIZE,
    cursor: view.cursor,
    statuses: queueFilterStatuses(view.filter as QueueFilter),
    q: view.search || undefined,
  });
}

interface WorkScreenProps {
  initialTaskId?: string;
  reviewRevisionId?: string;
  onNavigateToClients?: (clientId?: string) => void;
  onNavigateToSettings?: () => void;
  onNewTask?: () => void;
  onSelectedClientChange?: (clientId: string | undefined, clientName?: string) => void;
}

export const WorkScreen: React.FC<WorkScreenProps> = ({
  initialTaskId,
  reviewRevisionId,
  onNavigateToClients: _onNavigateToClients,
  onNavigateToSettings,
  onNewTask,
  onSelectedClientChange,
}) => {
  const queryClient = useQueryClient();
  const { session, stream } = useDesk();
  const sessionUser = useSessionUser().data ?? null;
  // No poll while the tab's event stream is up; every 30 s while it is down (services/liveUpdates.ts).
  const pollInterval = usePollInterval();

  const [selectedTaskId, setSelectedTaskId] = useState<string>(initialTaskId || '');
  const [confirmedReviewRevision, setConfirmedReviewRevision] = useState<string | undefined>();
  useEffect(() => {
    setConfirmedReviewRevision(undefined);
    if (initialTaskId) { setSelectedTaskId(initialTaskId); setMobilePane('detail'); }
  }, [initialTaskId, reviewRevisionId]);
  const [canvaLinkInput, setCanvaLinkInput] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'brief' | 'brand' | 'qa' | 'history'>('brief');
  const [mobilePane, setMobilePane] = useState<'queue' | 'detail'>(initialTaskId ? 'detail' : 'queue');
  const [previewZoom, setPreviewZoom] = useState(false);

  // Modals & In-Flight State
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [revisionNotes, setRevisionNotes] = useState('');
  const [revisionScope, setRevisionScope] = useState<NonNullable<DecisionPayload['revisionRequest']>['scope'] | ''>('');
  const [revisionCategory, setRevisionCategory] = useState<NonNullable<DecisionPayload['revisionRequest']>['category'] | ''>('');
  const [revisionTargets, setRevisionTargets] = useState('');
  const [revisionPriority, setRevisionPriority] = useState<NonNullable<DecisionPayload['revisionRequest']>['priority'] | ''>('');
  const [revisionReusable, setRevisionReusable] = useState(false);
  const [isApprovalModalOpen, setIsApprovalModalOpen] = useState(false);
  const [isRejectionModalOpen, setIsRejectionModalOpen] = useState(false);
  const [rejectionCategory, setRejectionCategory] = useState<DecisionPayload['rejectionCategory']>();
  const [rejectionReason, setRejectionReason] = useState('');
  // The stored exports the reviewer can pin to the approval; delivery sends exactly the pinned files.
  const [approvalExports, setApprovalExports] = useState<Reading<StoredExport[]>>({ state: 'loading' });
  const [pinnedExportIds, setPinnedExportIds] = useState<string[]>([]);
  const [rtlReviewed, setRtlReviewed] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Show temporary toast. Each toast owns the timer: an older toast's timer cleared a newer one
  // after a fraction of its time, so a failure shown right after a success vanished unread.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const decisionStarting = useRef(false);
  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'info', durationMs = 3500) => {
    setToastMessage({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), durationMs);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // What the queue shows (ADR-037): the filter and search Core applies, and the numbered pages read so
  // far, each by the cursor that starts it (page N is cursors[N - 1]; null is the newest page). A new
  // filter or search starts again at page 1, in the same update, so no request is made for the old
  // page under the new filter. The search waits until typing pauses.
  const [queueView, setQueueView] = useState<{ filter: QueueFilter; search: string; cursors: (string | null)[] }>({
    filter: 'needs_action',
    search: '',
    cursors: [null],
  });
  const { filter, search } = queueView;
  const setFilter = (next: QueueFilter) => setQueueView((v) => (v.filter === next ? v : { ...v, filter: next, cursors: [null] }));
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchQuery.trim();
      setQueueView((v) => (v.search === next ? v : { ...v, search: next, cursors: [null] }));
    }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const cursor = queueView.cursors[queueView.cursors.length - 1];
  const pageNumber = queueView.cursors.length;

  // The page on screen: one request, never every page (programme 0.3). The previous page stays on
  // screen while the next one is read. Task events refresh it through the cache (liveUpdates.ts);
  // the screen has no timer or event handler of its own for the list.
  const listQuery = useQuery({
    queryKey: queryKeys.taskPage({ filter, search, cursor }),
    queryFn: () => readQueuePage(apiClient.tasks, { filter, search, cursor }),
    placeholderData: keepPreviousData,
    refetchInterval: pollInterval,
  });
  const page = listQuery.data;
  const queueTotal = page?.total ?? 0;
  const nextCursor = page?.nextCursor ?? null;
  const pageCount = Math.max(1, Math.ceil(queueTotal / QUEUE_PAGE_SIZE));

  // `GET /tasks` has no captured preview; `GET /tasks/:id` does. The selected task's detail is its own
  // query, so an existing design is shown without an action, and a live event naming the task reads it
  // again.
  const detailQuery = useQuery({
    queryKey: queryKeys.taskDetail(selectedTaskId),
    queryFn: () => readTaskDetail<LiveTask>(apiClient.tasks, selectedTaskId),
    enabled: Boolean(selectedTaskId),
  });
  const detail = detailQuery.data?.id === selectedTaskId ? detailQuery.data : undefined;

  useEffect(() => {
    setIsApprovalModalOpen(false);
    setIsRevisionModalOpen(false);
    setIsRejectionModalOpen(false);
  }, [selectedTaskId, reviewRevisionId]);
  const reviewBlocked = Boolean(initialTaskId && reviewRevisionId && selectedTaskId === initialTaskId &&
    (!detail?.latestRevisionId || (detail.latestRevisionId !== reviewRevisionId && confirmedReviewRevision !== detail.latestRevisionId)));

  // The page, and the task opened from a link or a notification when it is not on this page.
  const tasks = useMemo<LiveTask[]>(() => {
    const items = page?.items ?? [];
    return detail && !items.some((t) => t.id === detail.id) ? [...items, detail] : items;
  }, [page, detail]);

  // The selection stays while its task is on the page (or was opened from a link); otherwise the
  // first task of the page is selected. Not while the previous page stands in for one being read.
  const isPlaceholderPage = listQuery.isPlaceholderData;
  useEffect(() => {
    if (!page || isPlaceholderPage) return;
    setSelectedTaskId((prev) => (prev && (page.items.some((t) => t.id === prev) || prev === initialTaskId) ? prev : page.items[0]?.id || ''));
  }, [page, isPlaceholderPage, initialTaskId]);

  // While the stream is down the list is polled, and nothing names the task that changed: its detail
  // is read again when its list entry shows a change (not on every poll: the detail carries the
  // preview). With the stream up, the event that changed it does this.
  const listEntry = page?.items.find((t) => t.id === selectedTaskId);
  const seenEntry = useRef<LiveTask | undefined>(undefined);
  useEffect(() => {
    const before = seenEntry.current;
    seenEntry.current = listEntry;
    if (pollInterval !== false && before && listEntry && before.id === listEntry.id && queueEntryChanged(before, listEntry)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.task(listEntry.id) });
    }
  }, [listEntry, pollInterval, queryClient]);

  // What the queue pane shows. A failed read with a page on screen keeps the page and says so above
  // it; a 401 never gets here (the session ends and the App shows sign-in).
  const listError = listQuery.error;
  const queueState: 'loading' | 'unauthorized' | 'error' | 'ready' | 'empty' = !page
    ? listQuery.isError
      ? listError instanceof ApiError && listError.status === 403
        ? 'unauthorized'
        : 'error'
      : 'loading'
    : page.items.length === 0 && filter === 'all' && !search && !cursor
      ? 'empty'
      : 'ready';
  const queueError: string | null = !listQuery.isError
    ? null
    : page
      ? `The queue could not be refreshed (${reasonOf(listError)}). It shows the last list read.`
      : listError instanceof ApiError && listError.status === 403
        ? listError.message || 'Access Denied: Legitimate reviewer or operator role required.'
        : reasonOf(listError);

  // Older and newer pages. Each page is remembered by the cursor that started it, so Newer goes back
  // exactly. Older waits for the page on screen to be read (while the placeholder shows, its cursor
  // is the one just followed).
  const showOlderPage = () => {
    if (nextCursor && !listQuery.isPlaceholderData) setQueueView((v) => ({ ...v, cursors: [...v.cursors, nextCursor] }));
  };
  const showNewerPage = () => {
    setQueueView((v) => (v.cursors.length > 1 ? { ...v, cursors: v.cursors.slice(0, -1) } : v));
  };

  // A new request tells the office at once; the list itself is read again through the cache.
  useEffect(
    () =>
      stream.on('task:created', (data) => {
        const payload = (data ?? {}) as { id?: string; title?: string; headlineEn?: string; task?: { id?: string; title?: string; headlineEn?: string } };
        const taskObj = payload.task || (payload.id ? payload : null);
        if (taskObj) showToast(`New task received: ${taskObj.title || taskObj.headlineEn || taskObj.id}`, 'info');
      }),
    [stream]
  );

  // A failed revoke cannot be called sign-out: the HttpOnly cookie or bearer session may still work.
  const handleSignOut = async () => {
    try {
      await apiClient.auth.logout();
      session.signOut();
    } catch {
      showToast('Could not sign out. Check the connection and try again.', 'error');
    }
  };

  // Filtered tasks. Core filters and searches the page (folding the Arabic-keyboard letters into
  // Sorani ones); the status groups (taskStatus.ts) are applied here again only for the task opened
  // from a link, which is shown beside the page whatever its status.
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => inQueueFilter(task.status, filter));
  }, [tasks, filter]);

  // Selected Task: its list entry with its detail laid over it.
  const selectedTask = useMemo(() => {
    const entry = tasks.find((t) => t.id === selectedTaskId);
    if (entry && detail) return { ...entry, ...detail };
    return selectedTaskId ? entry : filteredTasks[0] || tasks[0];
  }, [tasks, selectedTaskId, filteredTasks, detail]);

  useEffect(() => {
    onSelectedClientChange?.(selectedTask?.clientId, selectedTask?.clientName);
    return () => onSelectedClientChange?.(undefined);
  }, [selectedTask?.clientId, selectedTask?.clientName, onSelectedClientChange]);

  // History & Audit reads the task's recorded events (GET /tasks/:id/timeline). It read `history`
  // from the task, which no task route returns, so it always showed none (2026-09-24).
  const selectedId = selectedTask?.id;
  const timelineQuery = useQuery({
    queryKey: queryKeys.taskTimeline(selectedId || ''),
    queryFn: async () => (await apiClient.tasks.timeline(selectedId!))?.events ?? [],
    enabled: Boolean(selectedId),
  });
  const timelineReading: Reading<TaskTimelineEvent[]> = readingOf<TaskTimelineEvent[]>(timelineQuery);

  // After Core confirms an action, the task and the list are read again. The cache is never changed
  // before that: an approval has side effects on the server and can be refused. The task as read
  // again, or null when that read failed (the action still happened).
  const readTaskAgain = async (taskId: string): Promise<LiveTask | null> => {
    const askedAt = Date.now();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
    ]);
    const state = queryClient.getQueryState<LiveTask>(queryKeys.taskDetail(taskId));
    return state && state.status === 'success' && state.dataUpdatedAt >= askedAt ? (state.data ?? null) : null;
  };

  // Keyboard navigation (j/k or ArrowUp/ArrowDown for queue navigation, / for search)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Escape') {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById('queue-search-input')?.focus();
        return;
      }

      if (e.key === 'Escape') {
        setIsRevisionModalOpen(false);
        setIsApprovalModalOpen(false);
        setPreviewZoom(false);
        return;
      }

      const currentIndex = filteredTasks.findIndex((t) => t.id === selectedTaskId);
      if (currentIndex === -1) return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const nextIndex = Math.min(filteredTasks.length - 1, currentIndex + 1);
        setSelectedTaskId(filteredTasks[nextIndex].id);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const prevIndex = Math.max(0, currentIndex - 1);
        setSelectedTaskId(filteredTasks[prevIndex].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredTasks, selectedTaskId]);

  // Primary Action 1: Edit in Canva (FR-078)
  const handleEditInCanva = async () => {
    if (!selectedTask) return;
    setActionLoading(true);
    try {
      const result = await apiClient.tasks.getEditorUrl(selectedTask.id);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      showToast(err.message || 'Bind a separate Canva design to this task first.', 'error');
    } finally { setActionLoading(false); }
  };

  // Core records preview, checked source and the review receipt. Keep the action identity after
  // a lost response; the browser never manufactures a revision or successful QA report.
  const handleCaptureForReview = async () => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    setActionLoading(true);
    try {
      const state = await apiClient.canva.taskState(taskId);
      const actionKey = JSON.stringify([sessionUser?.id,taskId,state.binding?.designId,state.binding?.version,'capture']);
      const reservation = await reserveDecisionAction(actionKey);
      const outcome = await captureForReview(apiClient.canva, taskId,
        { key:reservation.actionId,expectedBinding:state.binding || undefined });
      if (outcome.completed) completeDecisionAction(actionKey,reservation);
      showToast(outcome.text, outcome.tone);
      await readTaskAgain(taskId);
    } catch (err) {
      showToast(`Nothing captured: ${reasonOf(err)}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Primary Action 3: Request revision (FR-078, CV-15, H02, H03). A request is recorded on a design
  // revision. With none, the call used to be skipped while the Desk still reported "Task transitioned
  // to REVISION_REQUESTED" and cleared the notes (2026-09-24). Nothing is claimed now that Core did
  // not record, and the notes stay until Core has them. A mutation (ADR-037): the button shows it is
  // pending, and the task's status on screen is Core's, read again after Core answered.
  const requestRevision = useMutation({
    mutationFn: (input: { taskId: string; revisionId: string; feedback: NonNullable<DecisionPayload['revisionRequest']>; actionKey: string; reservation: ReservedDecisionAction }) =>
      apiClient.tasks.recordDecision<{ decisionId?: string } | null>(input.taskId, input.revisionId, {
        action: 'revision_requested',
        revisionRequest: input.feedback,
      }, input.reservation.actionId),
    onSuccess: async (decisionRes, input) => {
      completeDecisionAction(input.actionKey, input.reservation);
      setIsRevisionModalOpen(false);
      setRevisionNotes('');
      setRevisionTargets('');
      setRevisionScope('');
      setRevisionCategory('');
      setRevisionPriority('');
      setRevisionReusable(false);
      // Core recorded the request; a failed read after it is not a failed request.
      const refreshedTask = await readTaskAgain(input.taskId);
      showToast(
        refreshedTask
          ? `Revision request recorded. Core now reports this task as ${taskStatusView(refreshedTask.status).pill}.`
          : `Revision request recorded (decision ${decisionRes?.decisionId || 'id not returned'}). Refresh the page to see the task's status.`,
        'success'
      );
    },
    onError: (err: Error) => showToast(`Revision request failed: ${err.message || 'Server error'}. Your notes are kept.`, 'error'),
  });

  const handleSendRevisionRequest = async () => {
    if (reviewBlocked || !selectedTask || !revisionNotes.trim() || decisionStarting.current) return;
    const revisionId = selectedTask.latestRevisionId;
    if (!revisionId) {
      showToast('Nothing sent: this task has no design revision to request changes on. Your notes are kept.', 'error');
      return;
    }
    if (!revisionScope || !revisionCategory || !revisionPriority) {
      showToast('Choose the scope, category and priority before sending this revision request.', 'error');
      return;
    }
    const targetNodes = revisionTargets.split(',').map((node) => node.trim()).filter(Boolean);
    if ((revisionScope !== 'full_design' && targetNodes.length === 0) || targetNodes.length > 32 ||
        targetNodes.some((node) => node.length > 128) || new Set(targetNodes).size !== targetNodes.length) {
      showToast('Name each target once (up to 32); a focused revision needs at least one target.', 'error');
      return;
    }
    const feedback = { scope: revisionScope, category: revisionCategory, targetNodes,
      priority: revisionPriority, isReusableFeedback: revisionReusable, comment: revisionNotes.trim() };
    const actionKey = JSON.stringify([sessionUser?.id, selectedTask.id, revisionId, 'revision_requested', feedback]);
    decisionStarting.current = true;
    try {
      const reservation = await reserveDecisionAction(actionKey);
      requestRevision.mutate({ taskId: selectedTask.id, revisionId, feedback, actionKey, reservation });
    } catch (err) { showToast(`Revision request could not start: ${reasonOf(err)}`, 'error'); }
    finally { decisionStarting.current = false; }
  };

  const reject = useMutation({
    mutationFn: (input: { taskId: string; revisionId: string; category: NonNullable<DecisionPayload['rejectionCategory']>;
      reason: string; actionKey: string; reservation: ReservedDecisionAction }) =>
      apiClient.tasks.recordDecision(input.taskId, input.revisionId, {
        action: 'reject', rejectionCategory: input.category, reason: input.reason,
      }, input.reservation.actionId),
    onSuccess: async (_result, input) => {
      completeDecisionAction(input.actionKey, input.reservation);
      setIsRejectionModalOpen(false);
      setRejectionCategory(undefined);
      setRejectionReason('');
      const refreshed = await readTaskAgain(input.taskId);
      showToast(refreshed ? `Rejection recorded. Core reports ${taskStatusView(refreshed.status).pill}.`
        : 'Rejection recorded. Refresh the task to see its final state.', 'success');
    },
    onError: (err: Error) => showToast(`Rejection could not be confirmed: ${err.message}. Keep this dialog open and retry.`, 'error'),
  });

  const handleReject = async () => {
    if (reviewBlocked || decisionStarting.current || reject.isPending || !selectedTask?.latestRevisionId || !rejectionCategory || !rejectionReason.trim()) return;
    if (selectedTask.status !== 'AWAITING_APPROVAL' || approvalRoleBlocker(sessionUser?.role)) {
      showToast('This draft is no longer available for this reviewer. Refresh the task.', 'error');
      return;
    }
    const actionKey = JSON.stringify([sessionUser?.id, selectedTask.id, selectedTask.latestRevisionId,
      'reject', rejectionCategory, rejectionReason.trim()]);
    decisionStarting.current = true;
    try {
      const reservation = await reserveDecisionAction(actionKey);
      reject.mutate({ taskId: selectedTask.id, revisionId: selectedTask.latestRevisionId,
        category: rejectionCategory, reason: rejectionReason.trim(), actionKey, reservation });
    } catch (err) { showToast(`Rejection could not start: ${reasonOf(err)}`, 'error'); }
    finally { decisionStarting.current = false; }
  };

  // Primary Action 4: Approve captured files (FR-078, CV-15, H02, H03). The modal lists the exports
  // Core has stored for the task; the ones the reviewer keeps selected are pinned to the approval.
  const openApprovalModal = async () => {
    if (reviewBlocked || !selectedTask) return;
    const taskId = selectedTask.id;
    setIsApprovalModalOpen(true);
    setApprovalExports({ state: 'loading' });
    setPinnedExportIds([]);
    setRtlReviewed(false);
    const reading = await read(async () => {
      const state = await apiClient.canva.taskState(taskId);
      return Array.isArray(state?.artifacts) ? (state.artifacts as StoredExport[]) : [];
    });
    setApprovalExports(reading);
    if (reading.state === 'known') setPinnedExportIds(defaultPins(reading.value, selectedTask.canvaBinding ? selectedTask.qaReport?.exportArtifactId : undefined, selectedTask.canvaBinding ? selectedTask.qaReport?.captureVersion : undefined));
  };

  // A mutation (ADR-037): pending until Core answers and the task is read again. The cached status is
  // never set to approved beforehand: Core can refuse a stale revision, role or selected export.
  const approve = useMutation({
    mutationFn: (input: { taskId: string; revisionId: string; pinnedExportIds: string[]; requestOwned: boolean; rtlVisualReview?: { confirmed: true; exportSha256: string }; actionKey: string; reservation: ReservedDecisionAction }) =>
      apiClient.tasks.recordDecision<{ decisionId?: string } | null>(input.taskId, input.revisionId, {
        action: 'approve',
        reason: 'Approved by art director',
        pinnedExportIds: input.pinnedExportIds,
        ...(input.rtlVisualReview ? { rtlVisualReview: input.rtlVisualReview } : {}),
      }, input.reservation.actionId),
    onSuccess: async (decisionRes, input) => {
      completeDecisionAction(input.actionKey, input.reservation);
      // Core recorded the approval; a failed read after it is not a failed approval.
      const refreshedTask = await readTaskAgain(input.taskId);
      setIsApprovalModalOpen(false);
      const notice = describeApproval(input.revisionId, decisionRes?.decisionId, Boolean(refreshedTask));
      showToast(input.requestOwned ? `${notice.text} Delivery will need a separate workflow action.` : notice.text,
        notice.tone, notice.durationMs);
    },
    onError: (err: Error) => showToast(`Approval failed: ${err.message || 'Server error'}`, 'error'),
  });

  const handleApprove = async () => {
    if (reviewBlocked || decisionStarting.current) return;
    if (!selectedTask || !selectedTask.latestRevisionId) {
      showToast('No active design revision to approve.', 'error');
      return;
    }
    if (!detail || detail.id !== selectedTask.id) {
      showToast('Wait for the current task details before approving.', 'info');
      return;
    }
    const exportsForApproval = approvalExports.state === 'known' ? approvalExports.value : [];
    const blocker = approvalRoleBlocker(sessionUser?.role) || approvalBlocker(approvalExports.state, exportsForApproval, pinnedExportIds, selectedTask.canvaBinding ? selectedTask.qaReport?.exportArtifactId ?? null : undefined, selectedTask.canvaBinding ? selectedTask.qaReport?.captureVersion ?? null : undefined);
    if (blocker) {
      showToast(blocker, 'error');
      return;
    }
    const rtlRequired = selectedTask.qaReport?.rtlVisualReviewRequired === true;
    const checkedHash = selectedTask.qaReport?.exportSha256;
    if (rtlRequired && (!rtlReviewed || !checkedHash || !exportsForApproval.some((item) =>
      item.format === 'png' && pinnedExportIds.includes(item.id)))) {
      showToast('Inspect and select the final PNG, then confirm Kurdish/Arabic visual review.', 'error');
      return;
    }
    const actionKey = JSON.stringify([sessionUser?.id, selectedTask.id, selectedTask.latestRevisionId, 'approve',
      [...pinnedExportIds].sort(), rtlRequired ? checkedHash : null]);
    decisionStarting.current = true;
    try {
      const reservation = await reserveDecisionAction(actionKey);
      approve.mutate({ taskId: selectedTask.id, revisionId: selectedTask.latestRevisionId, pinnedExportIds,
        requestOwned: Boolean(detail.requestId),
        actionKey, reservation,
        ...(rtlRequired ? { rtlVisualReview: { confirmed: true, exportSha256: checkedHash! } } : {}) });
    } catch (err) { showToast(`Approval could not start: ${reasonOf(err)}`, 'error'); }
    finally { decisionStarting.current = false; }
  };

  // Every action button waits while one runs.
  const busy = actionLoading || approve.isPending || reject.isPending || requestRevision.isPending;

  // Words the requester sent after the design reached the office, shown before a delivery (finding 13).
  const confirmLateChanges = (changes: LateRequesterChangeView[]) => window.confirm([
    changes.length === 1
      ? 'The requester sent this after the design reached the office:'
      : `The requester sent ${changes.length} messages after the design reached the office:`,
    ...changes.map((change) => `\n"${change.text}"`),
    '\nThese words were not applied to the design. Deliver the approved design anyway?',
  ].join('\n'));

  // Primary Action 5: Deliver approved files (FR-078, CV-16, H02)
  const handleDeliver = async () => {
    const approval = detail?.latestApproval;
    if (!selectedTask || !detail || !approval) return;
    const taskId = selectedTask.id;
    const requestOwned = Boolean(detail.requestId || selectedTask.requestId);
    setActionLoading(true);
    let delivery: unknown;
    let acknowledged: string[] = [];
    for (;;) {
      let reservation: ReservedDecisionAction | null = null;
      let actionKey = '';
      try {
        if (requestOwned) {
          // The task version is part of the key: a press whose answer was lost is retried with the same
          // id, but once that delivery moved the task on (started, then failed back to APPROVED) the next
          // press is a new action. A kept id would be answered from the spent press (finding 19).
          actionKey = JSON.stringify([sessionUser?.id, taskId, approval.decisionId, selectedTask.version ?? null, 'deliver',
            ...(acknowledged.length ? [[...acknowledged].sort()] : [])]);
          reservation = await reserveDecisionAction(actionKey);
        }
        delivery = await apiClient.tasks.publish(taskId,
          { destination: 'google_drive', ...(requestOwned ? { approvalId: approval.decisionId } : {}),
            ...(acknowledged.length ? { acknowledgeLateChanges: acknowledged } : {}) },
          reservation?.actionId);
        if (reservation) completeDecisionAction(actionKey, reservation);
        break;
      } catch (err: any) {
        const late: LateRequesterChangeView[] | null = err?.problem?.code === 'LATE_REQUESTER_CHANGE' &&
          Array.isArray(err.problem.lateChanges) ? err.problem.lateChanges : null;
        if (late && reservation) {
          // Core refused before asking for any delivery, so this action id was never used.
          completeDecisionAction(actionKey, reservation);
          const unseen = late.filter((change) => !acknowledged.includes(change.updateId));
          if (unseen.length && confirmLateChanges(late)) {
            acknowledged = [...new Set([...acknowledged, ...late.map((change) => change.updateId)])];
            continue;
          }
          showToast('Not delivered. The requester sent words after this design reached the office; read them before delivering.', 'error');
          setActionLoading(false);
          return;
        }
        showToast(`Delivery failed: ${err.message || 'Server error'}`, 'error');
        setActionLoading(false);
        return;
      }
    }
    // Core accepted the delivery (202 DELIVERED_TO_CHAT_ONLY included: the requester has the file);
    // a failed refresh after it is not a failed delivery.
    const refreshedTask = await readTaskAgain(taskId);
    const notice = describeDelivery(delivery, refreshedTask ? String(refreshedTask.status || '') : undefined);
    showToast(notice.text, notice.tone, notice.durationMs);
    setActionLoading(false);
  };

  // Helper: Next action prompt. The status decides, never an older approval: a task sent back for
  // changes after an approval was labelled APPROVED (2026-09-24). Every status has its own label.
  const getNextActionPrompt = (task: LiveTask) => taskStatusView(task.status);

  const nextAction = selectedTask ? getNextActionPrompt(selectedTask) : null;
  // Hidden for a status the Desk does not know, which could be approved until 2026-09-24.
  const approveState = selectedTask
    ? approveButtonState(selectedTask.status, { hasRevision: Boolean(selectedTask.latestRevisionId), qaPassed: selectedTask.qaReport?.passed === true, busy: busy || !detail || reviewBlocked })
    : 'hidden';

  return (
    <div className="work-desk-container" role="main" aria-label="Hawa Work Desk">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`hawa-toast hawa-toast-${toastMessage.type}`}
          role="status"
          aria-live="polite"
        >
          <span>{toastMessage.type === 'success' ? '✓' : toastMessage.type === 'error' ? '⚠' : 'ℹ'}</span>
          <span dir="auto">{toastMessage.text}</span>
        </div>
      )}

      {/* Mobile Top View Switcher (Visible only at <= 768px) */}
      <div className="work-mobile-toggle" role="tablist" aria-label="Mobile View Switcher">
        <button
          role="tab"
          aria-selected={mobilePane === 'queue'}
          className={`btn ${mobilePane === 'queue' ? 'primary' : ''}`}
          onClick={() => setMobilePane('queue')}
        >
          📋 Queue ({queueTotal})
        </button>
        <button
          role="tab"
          aria-selected={mobilePane === 'detail'}
          className={`btn ${mobilePane === 'detail' ? 'primary' : ''}`}
          onClick={() => setMobilePane('detail')}
          disabled={!selectedTask}
        >
          🔍 Task Detail
        </button>
      </div>

      {/* Work Desk Split Layout: Left Pane = Actionable Queue; Right Pane = Task Detail */}
      <div className="work-desk-split">
        {/* ========================================================================= */}
        {/* LEFT PANE: ACTIONABLE TASK QUEUE                                          */}
        {/* ========================================================================= */}
        <section
          className={`work-queue-pane ${mobilePane === 'detail' ? 'mobile-hidden' : ''}`}
          aria-label="Actionable Task Queue"
        >
          {/* Queue Header & Filters */}
          <div className="work-queue-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>Work Queue</h2>
                <span
                  className="queue-count-badge"
                  title={filter === 'all' && !search ? `${queueTotal} tasks` : `${queueTotal} tasks match the filter and search`}
                >
                  {queueTotal}
                </span>
                {sessionUser && (
                  <span
                    style={{ fontSize: 11, padding: '2px 6px', background: 'var(--blue)', color: 'var(--blue-text)', borderRadius: 4, fontWeight: 500 }}
                    title={`Signed in as ${sessionUser.displayName || sessionUser.role}`}
                  >
                    {sessionUser.authMethod === 'trusted_office' ? 'Office team' : `👤 ${sessionUser.role}`}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {sessionUser && sessionUser.authMethod !== 'trusted_office' && (
                  <button className="btn btn-sm" onClick={handleSignOut} title="Sign Out of Session">
                    Sign Out
                  </button>
                )}
                <button
                  className="btn primary btn-sm work-queue-new-btn"
                  onClick={async () => {
                    if (onNewTask) {
                      onNewTask();
                      return;
                    }
                    try {
                      setActionLoading(true);
                      const res: any = await apiClient.tasks.create({
                        title: `Campaign Brief ${new Date().toLocaleDateString()}`,
                        description: 'Intake campaign instructions for client brand review',
                        priority: 'high',
                      });
                      const createdTask = res.task || res;
                      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
                      if (createdTask?.id) setSelectedTaskId(createdTask.id);
                      showToast(`Created server task: ${createdTask?.id || 'new'}`, 'success');
                    } catch (err: any) {
                      showToast(`Task creation failed: ${err.message}`, 'error');
                    } finally {
                      setActionLoading(false);
                    }
                  }}
                  disabled={actionLoading}
                  aria-label="Create New Task"
                >
                  + New Task
                </button>
              </div>
            </div>

            {/* Fast Search Input */}
            <div className="queue-search-box">
              <span className="search-icon" aria-hidden="true">🔍</span>
              <input
                id="queue-search-input"
                type="text"
                className="queue-search-field"
                placeholder="Search tasks, clients, copy (Press '/' to focus)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search work queue"
              />
              {searchQuery && (
                <button
                  className="search-clear-btn"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Filter Pills */}
            <div className="queue-filter-pills" role="radiogroup" aria-label="Task Status Filter">
              <button
                className={`queue-pill ${filter === 'all' ? 'active' : ''}`}
                onClick={() => setFilter('all')}
                role="radio"
                aria-checked={filter === 'all'}
              >
                All
              </button>
              <button
                className={`queue-pill ${filter === 'needs_action' ? 'active' : ''}`}
                onClick={() => setFilter('needs_action')}
                role="radio"
                aria-checked={filter === 'needs_action'}
              >
                Needs Action
              </button>
              <button
                className={`queue-pill ${filter === 'review' ? 'active' : ''}`}
                onClick={() => setFilter('review')}
                role="radio"
                aria-checked={filter === 'review'}
              >
                Review
              </button>
              <button
                className={`queue-pill ${filter === 'in_progress' ? 'active' : ''}`}
                onClick={() => setFilter('in_progress')}
                role="radio"
                aria-checked={filter === 'in_progress'}
              >
                In Design
              </button>
              <button
                className={`queue-pill ${filter === 'complete' ? 'active' : ''}`}
                onClick={() => setFilter('complete')}
                role="radio"
                aria-checked={filter === 'complete'}
              >
                Complete
              </button>
            </div>
          </div>

          {/* Task Cards List */}
          <div className="work-queue-list" role="list" aria-label="Tasks List">
            {queueState === 'loading' && (
              <div className="queue-loading-state" role="status" aria-live="polite">
                <div className="spinner" />
                <p>Loading canonical task queue from server...</p>
              </div>
            )}

            {queueState === 'unauthorized' && (
              <div className="queue-forbidden-state" role="alert">
                <span style={{ fontSize: 24 }}>⛔</span>
                <h4>Access Denied (HTTP 403)</h4>
                <p>{queueError || 'Your role is not authorized to access this work queue.'}</p>
                <button className="btn btn-sm" onClick={handleSignOut}>Switch Account</button>
              </div>
            )}

            {queueState === 'error' && (
              <div className="queue-error-state" role="alert">
                <span style={{ fontSize: 24 }}>⚠️</span>
                <h4>Failed to Load Queue</h4>
                <p>{queueError || 'Could not connect to the canonical task API.'}</p>
                <button className="btn primary btn-sm" onClick={() => void listQuery.refetch()}>
                  🔄 Retry Connection
                </button>
              </div>
            )}

            {queueState === 'empty' && (
              <div className="queue-empty-state">
                <p>No tasks currently pending in the work queue.</p>
                <button className="btn btn-sm" onClick={() => void listQuery.refetch()}>
                  🔄 Refresh Queue
                </button>
              </div>
            )}

            {(queueState === 'ready' || queueState === 'empty') && queueError && (
              <div className="queue-error-state" role="status" style={{ padding: '8px 12px' }}>
                <p style={{ margin: 0 }}>{queueError}</p>
              </div>
            )}

            {queueState === 'ready' && filteredTasks.length === 0 && (
              <div className="queue-empty-state">
                <p>No tasks match the active filter ({filter}).</p>
                <button className="btn btn-sm" onClick={() => { setFilter('all'); setSearchQuery(''); }}>
                  Reset Filters
                </button>
              </div>
            )}

            {queueState === 'ready' && filteredTasks.length > 0 &&
              filteredTasks.map((task) => {
                const isSelected = task.id === selectedTaskId;
                const statusMeta = getNextActionPrompt(task);
                return (
                  <div
                    key={task.id}
                    role="listitem"
                    tabIndex={0}
                    className={`queue-task-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      setMobilePane('detail');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedTaskId(task.id);
                        setMobilePane('detail');
                      }
                    }}
                    aria-selected={isSelected}
                    aria-label={`${task.title} for ${task.clientName || 'Client'}. Status: ${statusMeta.pill}`}
                  >
                    <div className="card-top-row">
                      <span className="client-badge">{task.clientName || 'General Client'}</span>
                      <span className={`status-pill ${statusMeta.pillClass}`}>
                        {statusMeta.pill}
                      </span>
                    </div>

                    <div className="card-title" dir="auto" title={task.title}>
                      {task.title}
                    </div>

                    <div className="card-snippet" dir="auto">
                      {task.headlineCkb || task.headlineEn || task.copyEn || 'No copy snippet'}
                    </div>

                    <div className="card-meta-row">
                      <span className="source-tag">
                        {task.sourcePlatform === 'telegram' ? '✈️ Telegram' : task.sourcePlatform === 'whatsapp' ? '💬 WhatsApp' : '🖥️ Desk'}
                      </span>
                      <span className="time-tag">
                        {task.latestRevision ? `Rev v${task.latestRevision.version}` : 'Draft'}
                      </span>
                    </div>
                  </div>
                );
              })}

            {queueState === 'ready' && (pageNumber > 1 || nextCursor) && (
              <nav className="queue-pager" aria-label="Queue pages" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 4px' }}>
                <button className="btn btn-sm" onClick={showNewerPage} disabled={pageNumber <= 1} aria-label="Newer tasks">
                  ← Newer
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }} aria-live="polite">
                  {`Page ${pageNumber} of ${pageCount} · ${(pageNumber - 1) * QUEUE_PAGE_SIZE + 1}–${(pageNumber - 1) * QUEUE_PAGE_SIZE + filteredTasks.length} of ${queueTotal}`}
                </span>
                <button className="btn btn-sm" onClick={showOlderPage} disabled={!nextCursor || listQuery.isPlaceholderData} aria-label="Older tasks">
                  Older →
                </button>
              </nav>
            )}
          </div>
        </section>

        {/* ========================================================================= */}
        {/* RIGHT PANE: TASK DETAIL & CANVA ACTIONS                                   */}
        {/* ========================================================================= */}
        <section
          className={`work-detail-pane ${mobilePane === 'queue' ? 'mobile-hidden' : ''}`}
          aria-label="Task Detail View"
        >
          {selectedTask ? (
            <div className="detail-scroll-container">
              {/* Mobile Back to Queue Button */}
              <div className="detail-mobile-header">
                <button
                  className="btn btn-sm"
                  onClick={() => setMobilePane('queue')}
                  aria-label="Back to Task Queue"
                >
                  ← Back to Queue
                </button>
              </div>

              {reviewBlocked && detail && (
                <div role="alert" className="next-action-banner">
                  <div>
                    <strong>This notification names an older revision.</strong>
                    <p>Decisions are paused. Inspect the current design and its evidence before continuing.</p>
                    {detail.latestRevisionId && <button className="btn primary" onClick={() => {
                      setIsApprovalModalOpen(false);
                      setIsRevisionModalOpen(false);
                      setIsRejectionModalOpen(false);
                      setConfirmedReviewRevision(detail.latestRevisionId);
                    }}>Review current revision</button>}
                  </div>
                </div>
              )}

              {/* Task Header Summary */}
              <div className="detail-header-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span className="client-badge-large">{selectedTask.clientName || 'Client'}</span>
                      <details style={{ fontSize: 12, color: 'var(--muted)' }}><summary>Task details</summary><code>{selectedTask.id}</code></details>
                    </div>
                    <h1 className="detail-title" dir="auto">{selectedTask.title}</h1>
                  </div>

                  {nextAction && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`status-pill-large ${nextAction.pillClass}`} data-testid="task-status">
                        {nextAction.pill}
                      </span>
                      {(approve.isPending || requestRevision.isPending) && (
                        <span className="decision-pending" role="status" style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {approve.isPending ? 'Approval sent; waiting for Core…' : 'Revision request sent; waiting for Core…'}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Next Action Banner */}
                {nextAction && (
                  <div className="next-action-banner" role="region" aria-label="Next Recommended Action">
                    <span className="action-icon" aria-hidden="true">⚡</span>
                    <div style={{ flex: 1 }}>
                      <strong>Next Action: </strong>
                      <span>{nextAction.message}</span>
                    </div>
                  </div>
                )}

                {!detail?.requestId && !selectedTask.requestId && <details className="canva-binding-form">
                  <summary>{selectedTask.canvaBinding ? 'Linked Canva design' : 'Link this task’s Canva design'}</summary>
                  {selectedTask.canvaBinding && <p>Design {selectedTask.canvaBinding.designId}</p>}
                  {!selectedTask.canvaBinding && <>
                  <p>Use a separate Canva copy for this task. Linking does not capture or approve its contents.</p>
                  <form onSubmit={async event => {
                    event.preventDefault();
                    setActionLoading(true);
                    try {
                      await apiClient.tasks.bindCanva(selectedTask.id, canvaLinkInput.trim());
                      setCanvaLinkInput('');
                      showToast('Canva handoff saved for this task.', 'success');
                    } catch (err: any) { showToast(err.message || 'Could not save the Canva link.', 'error'); }
                    finally { setActionLoading(false); }
                  }}>
                    <label htmlFor="task-canva-link">Canva edit link</label>
                    <input id="task-canva-link" type="url" value={canvaLinkInput} required
                      onChange={event => setCanvaLinkInput(event.target.value)} placeholder="https://www.canva.com/design/…/edit" />
                    <button className="btn" type="submit" disabled={actionLoading || !canvaLinkInput.trim()}>Save Canva link</button>
                  </form>
                  </>}
                </details>}
                <AskLedgerPanel key={`asks-${selectedTask.id}`} taskId={selectedTask.id} />
                {!detail?.requestId && !selectedTask.requestId && <TaskControls key={`controls-${selectedTask.id}`}
                  taskId={selectedTask.id} status={selectedTask.status} version={selectedTask.version} role={sessionUser?.role}
                  refresh={() => readTaskAgain(selectedTask.id)} />}

                <p className="capture-availability" role="status">Retrieved exports require QA and human approval before delivery.</p>
                {/* =================================================================== */}
                {/* PRIMARY ACTION BAR (FR-078)                                         */}
                {/* =================================================================== */}
                <div className="primary-actions-bar" role="toolbar" aria-label="Primary Task Actions">
                  {/* Action 1: Edit in Canva */}
                  <button
                    id="btn-edit-in-canva"
                    className="action-btn canva-btn"
                    onClick={handleEditInCanva}
                    title="Open live document in native Canva Studio (FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">🎨</span>
                    <span>Edit in Canva</span>
                    <span className="btn-external-icon" aria-hidden="true">↗</span>
                  </button>

                  {/* Action 2: Capture for review */}
                  <button
                    id="btn-capture-for-review"
                    className="action-btn capture-btn"
                    onClick={handleCaptureForReview}
                    disabled={busy || ['COMPLETE','CANCELLED','REJECTED'].includes(selectedTask.status)}
                    title="Capture the PNG preview and checked source for a server-recorded review. Human approval is still required."
                  >
                    <span className="btn-icon" aria-hidden="true">📸</span>
                    <span>Capture for Review</span>
                  </button>

                  {/* Action 3: Request revision. A request is recorded on a design revision; without one there is nothing to send it to. */}
                  <button
                    id="btn-request-revision"
                    className="action-btn revision-btn"
                    onClick={() => setIsRevisionModalOpen(true)}
                    disabled={busy || !detail || reviewBlocked || !selectedTask.latestRevisionId}
                    title={
                      selectedTask.latestRevisionId
                        ? 'Request revision and log structured operator instructions (FR-078)'
                        : 'Not available: this task has no design revision to request changes on yet'
                    }
                  >
                    <span className="btn-icon" aria-hidden="true">✏️</span>
                    <span>{requestRevision.isPending ? 'Sending request…' : 'Request Revision'}</span>
                  </button>

                  {/* Action 4: Approve captured files */}
                  {approveState !== 'hidden' && (
                    <button
                      id="btn-approve-captured"
                      className="action-btn approve-btn"
                      onClick={openApprovalModal}
                      disabled={approveState !== 'enabled'}
                      title="Record human approval bound to captured revision (FR-041, FR-078)"
                    >
                      <span className="btn-icon" aria-hidden="true">✅</span>
                      <span>{approve.isPending ? 'Approving…' : 'Approve Captured Files'}</span>
                    </button>
                  )}

                  {selectedTask.status === 'AWAITING_APPROVAL' && selectedTask.latestRevisionId && (
                    <button id="btn-reject-design" className="action-btn revision-btn"
                      onClick={() => setIsRejectionModalOpen(true)} disabled={busy || !detail || reviewBlocked || Boolean(approvalRoleBlocker(sessionUser?.role))}
                      title="Stop this request and record why the current design is rejected">
                      <span className="btn-icon" aria-hidden="true">⛔</span>
                      <span>{reject.isPending ? 'Rejecting…' : 'Reject Design'}</span>
                    </button>
                  )}

                  {/* Action 5: Deliver approved files */}
                  <button
                    id="btn-deliver-approved"
                    className="action-btn deliver-btn"
                    onClick={handleDeliver}
                    disabled={busy || !detail?.latestApproval || nextAction?.primaryButton !== 'deliver'}
                    title={selectedTask.status === 'REQUESTER_SEND_RECONCILIATION'
                      ? 'Requester send is uncertain. An operator must check Telegram and delivery records before any retry.'
                      : selectedTask.status === 'PUBLISH_RECONCILIATION'
                      ? 'Retry the unconfirmed Sheets row using the recorded publication'
                      : selectedTask.status === 'ARCHIVE_RECONCILIATION'
                        ? 'Recheck the recorded Drive file identity before requester delivery'
                        : 'Start the approved delivery to Drive, Sheets and the requester (FR-046, FR-078)'}
                  >
                    <span className="btn-icon" aria-hidden="true">🚀</span>
                    <span>{selectedTask.status === 'REQUESTER_SEND_RECONCILIATION' ? 'Check Telegram Delivery'
                      : selectedTask.status === 'PUBLISH_RECONCILIATION' ? 'Retry Sheet Sync'
                      : selectedTask.status === 'ARCHIVE_RECONCILIATION' ? 'Recheck Drive Archive' : 'Deliver Approved Files'}</span>
                  </button>
                  {(detail?.requestId || selectedTask.requestId) && selectedTask.status === 'APPROVED' && (
                    <p className="capture-availability" role="note">
                      Approval is recorded. Delivery starts separately and remains pending until the archive and requester send are confirmed.
                    </p>
                  )}
                </div>
                {selectedTask.status === 'REQUESTER_SEND_RECONCILIATION' &&
                  <RequesterSendEvidencePanel key={`requester-send-${selectedTask.id}`} taskId={selectedTask.id}
                    canConfirm={sessionUser?.role === 'office_admin' || sessionUser?.role === 'administrator'} />}
                {!selectedTask.latestRevisionId && (
                  <p className="capture-availability" role="note">
                    Request Revision and approval need a recorded design revision; this task has none yet.
                  </p>
                )}
              </div>

              {/* =================================================================== */}
              {/* LARGE CAPTURED PREVIEW STAGE (FR-077)                               */}
              {/* =================================================================== */}
              {selectedTask.latestRevision && <div className="preview-stage-container" aria-label="Captured Design Preview">
                <div className="stage-header-bar">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>Design Evidence</span>
                    {selectedTask.latestRevision && (
                      <span className="revision-badge">
                        Revision v{selectedTask.latestRevision.version}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn btn-xs"
                      onClick={() => setPreviewZoom(!previewZoom)}
                      aria-label="Toggle Fullscreen Zoom"
                    >
                      {previewZoom ? 'Collapse' : '⛶ Fullscreen'}
                    </button>
                  </div>
                </div>

                {/* Preview Stage Visual Box - Real High-Fidelity Vector & Canvas Inspector */}
                <div className={`preview-viewport ${previewZoom ? 'fullscreen-zoom' : ''}`} style={{ minHeight: 480, display: 'flex', flexDirection: 'column' }}>
                  <VectorInspector
                    previewUrl={selectedTask.latestRevision?.previewUrl}
                    svgContent={selectedTask.latestRevision?.svgContent}
                    title={selectedTask.title || 'Creative Vector Canvas'}
                    clientName={selectedTask.clientName || 'Institutional Client'}
                    dimensions={selectedTask.latestRevision?.dimensions}
                    exactCopy={{
                      headlineEn: selectedTask.headlineEn,
                      headlineCkb: selectedTask.headlineCkb,
                      copyEn: selectedTask.copyEn,
                      copyCkb: selectedTask.copyCkb,
                    }}
                    sha256={selectedTask.latestRevision?.sha256}
                    status={selectedTask.status}
                  />
                </div>

                <section className="rule" aria-label="Saved request">
                  <h3>Saved request</h3>
                  <p dir="auto" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selectedTask.description || selectedTask.title}</p>
                  {selectedTask.referenceImages?.length ? <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{selectedTask.referenceImages.map((photo,i) => <AuthorizedImage key={photo.sha256} src={photo.url} alt={`Request photo ${i+1}`} style={{width:96,height:96,objectFit:'contain'}} />)}</div> : null}
                </section>
                <StudioPanel key={`studio-${selectedTask.id}`} taskId={selectedTask.id} taskStatus={selectedTask.status} hasCanvaBinding={Boolean(selectedTask.canvaBinding)} onOpenCanva={() => void handleEditInCanva()} />
                <CanvaTaskPanel key={selectedTask.id} taskId={selectedTask.id} taskStatus={selectedTask.status} revision={detailQuery.dataUpdatedAt} onOpenSettings={onNavigateToSettings} />
                {/* Technical Package Metadata Badges (FR-032, FR-048) */}
                <div className="preview-meta-strip">
                  <div className="meta-badge-item">
                    <span className="meta-label">Aspect Ratio</span>
                    <span className="meta-val">{selectedTask.latestRevision?.dimensions ? `${selectedTask.latestRevision.dimensions.width} × ${selectedTask.latestRevision.dimensions.height}` : 'Not captured'}</span>
                  </div>
                  <div className="meta-badge-item">
                    <span className="meta-label">Formats</span>
                    <span className="meta-val">{selectedTask.latestRevision?.format || 'Not captured'}</span>
                  </div>
                  <div className="meta-badge-item">
                    <span className="meta-label">Package Size</span>
                    <span className="meta-val">
                      {selectedTask.latestRevision?.byteSize
                        ? `${(selectedTask.latestRevision.byteSize / 1024 / 1024).toFixed(2)} MB`
                        : 'Not captured'}
                    </span>
                  </div>
                  <div className="meta-badge-item meta-hash-item" style={{ flex: 1 }}>
                    <span className="meta-label">SHA-256 Checksum</span>
                    <span className="meta-val font-mono" title={selectedTask.latestRevision?.sha256}>
                      {selectedTask.latestRevision?.sha256 || 'Not captured'}
                    </span>
                    <button
                      className="btn-copy-hash"
                      disabled={!selectedTask.latestRevision?.sha256}
                      onClick={() => {
                        const h = selectedTask.latestRevision?.sha256 || 'Not captured';
                        navigator.clipboard?.writeText(h);
                        showToast('SHA-256 copied to clipboard', 'info');
                      }}
                      title="Copy SHA-256 to clipboard"
                    >
                      📋 Copy
                    </button>
                  </div>
                </div>
              </div>}

              {/* =================================================================== */}
              {/* BRIEF, BRAND GUIDANCE, QA PREFLIGHT, AND HISTORY TABS               */}
              {/* =================================================================== */}
              <div className="detail-tabs-container">
                <div className="tabs-header" role="tablist" aria-label="Task Detail Sections">
                  <button
                    role="tab"
                    aria-selected={activeTab === 'brief'}
                    className={`tab-btn ${activeTab === 'brief' ? 'active' : ''}`}
                    onClick={() => setActiveTab('brief')}
                  >
                    📝 Brief & Exact Copy
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'brand'}
                    className={`tab-btn ${activeTab === 'brand' ? 'active' : ''}`}
                    onClick={() => setActiveTab('brand')}
                  >
                    🧬 Brand DNA
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'qa'}
                    className={`tab-btn ${activeTab === 'qa' ? 'active' : ''}`}
                    onClick={() => setActiveTab('qa')}
                  >
                    🛡️ QA Preflight ({selectedTask.qaReport?.passed ? 'Pass' : 'Review'})
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'history'}
                    className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
                    onClick={() => setActiveTab('history')}
                  >
                    📜 History & Audit ({timelineReading.state === 'known' ? timelineReading.value.length : timelineReading.state === 'loading' ? '…' : '?'})
                  </button>
                </div>

                <div className="tab-body">
                  {/* TAB 1: BRIEF & EXACT COPY */}
                  {activeTab === 'brief' && (
                    <div className="tab-pane-content" role="tabpanel" aria-label="Brief and Copy">
                  {selectedTask.designInstructions && <div className="rule"><h4>Design instructions</h4><p style={{whiteSpace:'pre-wrap'}}>{selectedTask.designInstructions}</p></div>}
                  {selectedTask.sourceDocument && <div className="rule"><h4>Original request PDF</h4><OriginalDocument receipt={selectedTask.sourceDocument} /></div>}
                  {selectedTask.referenceAssets && <div className="rule"><h4>Reference notes</h4><p style={{whiteSpace:'pre-wrap'}}>{selectedTask.referenceAssets}</p></div>}
                  {typeof selectedTask.referenceImageCount === 'number' && (
                    <div className="rule" data-testid="reference-photos">
                      <h4>Reference photos: {selectedTask.referenceImageCount}</h4>
                      {(selectedTask.referenceImages?.length ?? 0) > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {selectedTask.referenceImages!.map((photo, i) => (
                            <AuthorizedImage
                              key={photo.sha256}
                              src={photo.url}
                              alt={`Reference photo ${i + 1} of ${selectedTask.referenceImageCount}`}
                              title={`sha256 ${photo.sha256.slice(0, 12)}`}
                              style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }}
                              fallback={<span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace' }}>{photo.sha256.slice(0, 12)}</span>}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                      <div className="exact-copy-notice">
                        <b>Exact Copy Invariant (#1):</b> Compare this content with the captured design. The server must validate exact copy before approval.
                      </div>

                      {selectedTask.description ? (
                        <div className="copy-block-card">
                          <div className="copy-label">Original submitted request</div>
                          <div className="copy-value-en" style={{whiteSpace:'pre-wrap'}}>{selectedTask.description}</div>
                        </div>
                      ) : (
                        <SubmittedCopy
                          headlineEn={selectedTask.headlineEn}
                          copyEn={selectedTask.copyEn}
                          headlineCkb={selectedTask.headlineCkb}
                          copyCkb={selectedTask.copyCkb}
                        />
                      )}
                    </div>
                  )}

                  {/* TAB 2: BRAND DNA GUIDELINES */}
                  {activeTab === 'brand' && (
                    <div className="tab-pane-content" role="tabpanel" aria-label="Brand DNA Guidelines">
                      <p>Review the selected client’s approved, versioned brand profile in Client DNA & Library. This task does not yet expose a verified brand snapshot here.</p>
                      <button className="btn" onClick={() => _onNavigateToClients?.(selectedTask.clientId)}>Open client library</button>
                    </div>
                  )}

                  {/* TAB 3: QA PREFLIGHT CHECKS (CV-14, FR-030) */}
                  {activeTab === 'qa' && (
                    <div className="tab-pane-content" role="tabpanel" aria-label="Automated QA Preflight">
                      <div className="qa-checklist">
                        {(() => {
                          const qa = selectedTask.qaReport || (selectedTask as any).latestQAReport;
                          const bidiPass = qa ? qa.bidiIsolation : null;
                          const marginPass = qa ? qa.safeMargins : null;
                          const contrastPass = qa ? qa.contrastCompliant : null;
                          const fontPass = qa?.fontFamilyPass ?? null;

                          return (
                            <>
                              <div className={`qa-item ${bidiPass === true ? 'passed' : bidiPass === false ? 'failed' : 'pending'}`}>
                                <span className="qa-status-icon">{bidiPass === true ? '✓' : bidiPass === false ? '✗' : '○'}</span>
                                <div style={{ flex: 1 }}>
                                  <strong>Arabic/Sorani reading direction</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {bidiPass === true
                                      ? 'No Arabic/Sorani direction issue was identified in the checked source.'
                                      : bidiPass === false
                                      ? 'The checked source conflicts with the required text direction.'
                                      : qa?.rtlVisualReviewRequired
                                      ? 'Paragraph flags cannot prove rendered reading order. Inspect the final PNG before approval.'
                                      : 'Automated direction check has not been measured.'}
                                  </p>
                                </div>
                              </div>

                              <div className={`qa-item ${marginPass === true ? 'passed' : marginPass === false ? 'failed' : 'pending'}`}>
                                <span className="qa-status-icon">{marginPass === true ? '✓' : marginPass === false ? '✗' : '○'}</span>
                                <div style={{ flex: 1 }}>
                                  <strong>Safe Margins & Bleed Clearance</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {marginPass === true
                                      ? 'All text nodes maintain minimum 32px safe margins away from artboard edges.'
                                      : marginPass === false
                                      ? 'Text or logo element violates outer margin boundary clearance.'
                                      : 'Margin safety audit pending.'}
                                  </p>
                                </div>
                              </div>

                              <div className={`qa-item ${contrastPass === true ? 'passed' : contrastPass === false ? 'failed' : 'pending'}`}>
                                <span className="qa-status-icon">{contrastPass === true ? '✓' : contrastPass === false ? '✗' : '○'}</span>
                                <div style={{ flex: 1 }}>
                                  <strong>High Contrast Compliance (WCAG AA 4.5:1+)</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {contrastPass === true
                                      ? 'Observed contrast ratio meets institutional accessibility standards.'
                                      : contrastPass === false
                                      ? 'Contrast ratio falls below 4.5:1 threshold against backdrop.'
                                      : 'Contrast ratio calculation pending backdrop rasterization.'}
                                  </p>
                                </div>
                              </div>

                              <div className={`qa-item ${fontPass === true ? 'passed' : fontPass === false ? 'failed' : 'pending'}`}>
                                <span className="qa-status-icon">{fontPass === true ? '✓' : fontPass === false ? '✗' : '○'}</span>
                                <div style={{ flex: 1 }}>
                                  <strong>Declared font families</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {fontPass === true
                                      ? 'Text runs declare font families allowed by the saved policy.'
                                      : fontPass === false
                                      ? 'Declared font families do not match the saved policy.'
                                      : 'Font-family inspection has not been measured.'}
                                  </p>
                                </div>
                              </div>

                              <div className="qa-item pending">
                                <span className="qa-status-icon">○</span>
                                <div style={{ flex: 1 }}>
                                  <strong>Rendered glyph coverage</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    Not verified by this check. Inspect the final export for missing glyphs and unexpected font changes; verify licenses against approved font records.
                                  </p>
                                </div>
                              </div>

                              {qa && Array.isArray(qa.errors) && qa.errors.length > 0 && (
                                <div style={{ marginTop: 12, padding: 10, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8 }}>
                                  <strong style={{ color: '#ef4444', fontSize: 12 }}>Preflight Violations:</strong>
                                  <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 12, color: '#f87171' }}>
                                    {qa.errors.map((err: string, idx: number) => (
                                      <li key={idx}>{err}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: HISTORY & AUDIT TRAIL (GET /tasks/:id/timeline) */}
                  {activeTab === 'history' && (
                    <div className="tab-pane-content" role="tabpanel" aria-label="Task History">
                      {timelineReading.state === 'loading' && <p style={{ fontSize: 12, color: 'var(--muted)' }}>Reading the task's history…</p>}
                      {timelineReading.state === 'unknown' && (
                        <p role="alert" style={{ fontSize: 12 }}>The task's history could not be read: {timelineReading.reason}</p>
                      )}
                      {timelineReading.state === 'known' && timelineReading.value.length === 0 && (
                        <p style={{ fontSize: 12, color: 'var(--muted)' }}>Core has no recorded events for this task.</p>
                      )}
                      <div className="history-timeline">
                        {(timelineReading.state === 'known' ? timelineReading.value : []).map((h, i) => {
                          const what = h.eventType
                            ? h.eventType.replace(/[._]/g, ' ')
                            : h.toStatus
                            ? `${h.fromStatus || '—'} → ${h.toStatus}`
                            : 'event';
                          const data = (h.data && typeof h.data === 'object' ? h.data : {}) as Record<string, unknown>;
                          const why = h.reason || (typeof data.reason === 'string' ? data.reason : '') || (typeof data.comment === 'string' ? data.comment : '');
                          const who = h.actor ? h.actor.displayName || [h.actor.type, h.actor.id].filter(Boolean).join(' ') : '';
                          return (
                            <div key={h.eventId || i} className="timeline-item">
                              <div className="timeline-marker" />
                              <div className="timeline-content">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                  <strong style={{ fontSize: 13 }}>{what}</strong>
                                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                    {h.occurredAt ? new Date(h.occurredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'time not recorded'}
                                  </span>
                                </div>
                                {who && <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)' }}>{who}</p>}
                                {why && (
                                  <p dir="auto" style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--ink)' }}>
                                    {why}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="detail-empty-state">
              <h3>No Task Selected</h3>
              {selectedTaskId && selectedTaskId === initialTaskId
                ? <p role={detailQuery.isError ? 'alert' : 'status'}>{detailQuery.isError
                  ? 'Linked task unavailable. It may have been removed or your account may not have access. Select a task from the queue or contact your office administrator.'
                  : 'Loading the linked task…'}</p>
                : <p>Select a task from the queue to inspect details and perform creative actions.</p>}
            </div>
          )}
        </section>
      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: REQUEST REVISION (FR-078)                                       */}
      {/* ========================================================================= */}
      {isRevisionModalOpen && (
        <div className="hawa-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-rev-title">
          <div className="hawa-modal-box">
            <h3 id="modal-rev-title" style={{ marginTop: 0 }}>Request Revision</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
              {/* The task never went back to IN_PROGRESS, as this used to say (2026-09-24): Core marks it REVISION_REQUESTED. */}
              Provide clear, structured feedback notes. Core records them on revision v{selectedTask?.latestRevision?.version ?? '?'} and
              marks the task Changes requested (after repeated requests it may hand the task to a designer instead). Nothing is
              redesigned automatically, and this revision can no longer be approved: approval opens again once a new revision with
              the changes is recorded.
            </p>

            <label className="hawa-revision-label" htmlFor="revision-scope">Scope</label>
            <select id="revision-scope" className="hawa-select" value={revisionScope} onChange={(e) => setRevisionScope(e.target.value as typeof revisionScope)} autoFocus>
              <option value="">Choose scope</option>
              <option value="full_design">Full design</option><option value="typography">Typography</option>
              <option value="layout">Layout</option><option value="color">Color</option>
              <option value="assets">Assets</option><option value="copy">Copy</option>
            </select>
            <label className="hawa-revision-label" htmlFor="revision-category">Category</label>
            <select id="revision-category" className="hawa-select" value={revisionCategory} onChange={(e) => setRevisionCategory(e.target.value as typeof revisionCategory)}>
              <option value="">Choose category</option>
              <option value="aesthetic_preference">Aesthetic preference</option>
              <option value="factual_error">Factual error</option><option value="brand_violation">Brand violation</option>
              <option value="legal_compliance">Legal or compliance</option><option value="technical_defect">Technical defect</option>
            </select>
            <label className="hawa-revision-label" htmlFor="revision-targets">Target node IDs (comma separated; leave empty for full design)</label>
            <input id="revision-targets" className="hawa-select" value={revisionTargets} maxLength={4096}
              onChange={(e) => setRevisionTargets(e.target.value)} placeholder="headline, logo" />
            <label className="hawa-revision-label" htmlFor="revision-priority">Priority</label>
            <select id="revision-priority" className="hawa-select" value={revisionPriority} onChange={(e) => setRevisionPriority(e.target.value as typeof revisionPriority)}>
              <option value="">Choose priority</option>
              <option value="low">Low</option><option value="medium">Medium</option>
              <option value="high">High</option><option value="critical">Critical</option>
            </select>
            <label className="hawa-revision-reuse" htmlFor="revision-reusable">
              <input id="revision-reusable" type="checkbox" checked={revisionReusable}
                onChange={(e) => setRevisionReusable(e.target.checked)} />
              Suggest this feedback for future work (requires separate human rule approval)
            </label>

            <label className="hawa-revision-label" htmlFor="revision-comment">Requested change</label>
            <textarea
              id="revision-comment"
              className="hawa-textarea"
              rows={4}
              maxLength={2000}
              placeholder="e.g. Increase Kurdish headline size by 4px and verify the logo top-right RTL clearance..."
              value={revisionNotes}
              onChange={(e) => setRevisionNotes(e.target.value)}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => setIsRevisionModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={handleSendRevisionRequest}
                disabled={!revisionNotes.trim() || !revisionScope || !revisionCategory || !revisionPriority || busy}
              >
                {requestRevision.isPending ? 'Sending request…' : 'Submit Revision Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: APPROVE CAPTURED FILES (FR-041, FR-078, CV-15)                   */}
      {/* ========================================================================= */}
      {isApprovalModalOpen && selectedTask && selectedTask.latestRevision && (
        <div className="hawa-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-app-title">
          <div className="hawa-modal-box">
            <h3 id="modal-app-title" style={{ marginTop: 0 }}>Approve Captured Files</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              You are recording binding human approval for <b>Revision v{selectedTask.latestRevision.version}</b>.
            </p>

            <div className="info-box" style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Immutable Checksum (SHA-256):</span>
              <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginTop: 4 }}>
                {selectedTask.latestRevision.sha256}
              </div>
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
              <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Files to deliver</legend>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>
                Delivery sends exactly the selected exports, byte for byte. The PPTX checked by QA must stay selected for a Canva design.
              </p>
              {approvalExports.state === 'known' &&
                approvalExports.value.map((e) => (
                  <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={pinnedExportIds.includes(e.id)}
                      onChange={() => setPinnedExportIds((prev) => togglePin(prev, e.id))}
                    />
                    <span style={{ fontFamily: 'monospace' }}>{describeExport(e)}</span>
                  </label>
                ))}
              {approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds, selectedTask.canvaBinding ? selectedTask.qaReport?.exportArtifactId ?? null : undefined, selectedTask.canvaBinding ? selectedTask.qaReport?.captureVersion ?? null : undefined) && (
                <p role="status" style={{ fontSize: 12, color: '#b91c1c', margin: '4px 0 0' }}>
                  {approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds, selectedTask.canvaBinding ? selectedTask.qaReport?.exportArtifactId ?? null : undefined, selectedTask.canvaBinding ? selectedTask.qaReport?.captureVersion ?? null : undefined)}
                  {approvalExports.state === 'unknown' ? ` (${approvalExports.reason})` : ''}
                </p>
              )}
            </fieldset>

            {selectedTask.qaReport?.rtlVisualReviewRequired === true && (
              <fieldset style={{ margin: '0 0 14px', padding: 12 }}>
                <legend style={{ fontSize: 12, fontWeight: 600 }}>Kurdish/Arabic visual review required</legend>
                <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
                  Inspect the selected final PNG for letter shape,
                  reading order, mixed numbers and clipping. Select that PNG above before approving.
                </p>
                <label style={{ display: 'flex', gap: 8, alignItems: 'start', fontSize: 12 }}>
                  <input type="checkbox" checked={rtlReviewed} onChange={(event) => setRtlReviewed(event.target.checked)} />
                  <span>I inspected the selected final PNG and confirmed the Kurdish/Arabic text reads correctly.</span>
                </label>
              </fieldset>
            )}

            {/* Core records the approval under the signed-in session's role; nothing chosen here is sent. */}
            <div style={{ marginBottom: 16, fontSize: 12 }}>
              <span style={{ fontWeight: 600 }}>Signing off as: </span>
              <span>{sessionUser ? `${sessionUser.displayName || 'Signed-in user'} (${roleLabel(sessionUser.role || 'unknown role')})` : 'the signed-in session'}</span>
              {approvalRoleBlocker(sessionUser?.role) && (
                <p role="status" style={{ color: 'var(--warn-text)', margin: '4px 0 0' }}>
                  {approvalRoleBlocker(sessionUser?.role)}
                </p>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setIsApprovalModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary approval-confirm"
                style={{ background: '#166534', borderColor: '#166534' }}
                onClick={handleApprove}
                disabled={
                  busy ||
                  Boolean(approvalRoleBlocker(sessionUser?.role)) ||
                  (selectedTask.qaReport?.rtlVisualReviewRequired === true &&
                    (!rtlReviewed || !selectedTask.qaReport.exportSha256 ||
                      !(approvalExports.state === 'known' && approvalExports.value.some((item) =>
                        item.format === 'png' && pinnedExportIds.includes(item.id))))) ||
                  Boolean(approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds, selectedTask.canvaBinding ? selectedTask.qaReport?.exportArtifactId ?? null : undefined, selectedTask.canvaBinding ? selectedTask.qaReport?.captureVersion ?? null : undefined))
                }
              >
                {approve.isPending ? 'Approving…' : 'Confirm Approval'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isRejectionModalOpen && selectedTask?.latestRevisionId && (
        <div className="hawa-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-reject-title">
          <div className="hawa-modal-box">
            <h3 id="modal-reject-title">Reject this design</h3>
            <p>This stops production for this request. Record which part is rejected and why.</p>
            <label className="hawa-revision-label" htmlFor="rejection-category">What is rejected?</label>
            <select id="rejection-category" className="hawa-input" value={rejectionCategory || ''}
              onChange={(event) => setRejectionCategory(event.target.value as DecisionPayload['rejectionCategory'])}>
              <option value="">Select a category</option>
              <option value="concept">Concept</option>
              <option value="content">Content</option>
              <option value="brand_direction">Brand direction</option>
              <option value="task">The whole task</option>
            </select>
            <label className="hawa-revision-label" htmlFor="rejection-reason">Reason</label>
            <textarea id="rejection-reason" className="hawa-textarea" rows={4} maxLength={2000}
              value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => setIsRejectionModalOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={handleReject}
                disabled={busy || !rejectionCategory || !rejectionReason.trim()}>
                {reject.isPending ? 'Recording…' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
