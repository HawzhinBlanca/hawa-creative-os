import React, { useState, useEffect, useMemo, useRef } from 'react';
import { eventStream, readTaskTransitioned, TASK_EVENTS } from '../services/eventStream.js';
import { CanvaTaskPanel } from '../components/CanvaTaskPanel.js';
import { StudioPanel } from '../components/StudioPanel.js';
import { AskLedgerPanel } from '../components/AskLedger.js';
import { VectorInspector } from '../components/VectorInspector.js';
import { SubmittedCopy } from '../components/SubmittedCopy.js';
import { apiClient, ApiError, type ApiSessionUser, type TaskTimelineEvent } from '../api/client.js';
import { captureForReview } from '../services/canvaCapture.js';
import { read, reasonOf, type Reading } from '../services/statusReport.js';
import { approvalBlocker, defaultPins, describeExport, togglePin, type StoredExport } from '../services/approvalPins.js';
import { keepLoadedDetail, loadTaskDetail, mergeTaskDetail, queueEntryChanged } from '../services/taskDetail.js';
import { approvalRoleBlocker, describeApproval, describeDelivery, roleLabel } from '../services/actionOutcome.js';
import { approveButtonState, inQueueFilter, queueFilterStatuses, taskStatusView, type QueueFilter } from '../services/taskStatus.js';
import { startQueueRefresh } from '../services/queueRefresh.js';

/** Tasks per queue page (Core's default page). */
const QUEUE_PAGE_SIZE = 50;
/** How long typing in the search box pauses before Core is asked. */
const SEARCH_PAUSE_MS = 300;

export interface LiveTask {
  id: string;
  clientId?: string;
  clientName?: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  designInstructions?: string;
  referenceAssets?: string;
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
    bidiIsolation: boolean;
    /** null = not measured by the check that produced this report; rendered as pending, never as a pass. */
    safeMargins: boolean | null;
    contrastCompliant: boolean | null;
    fontCoverage: boolean;
    errors?: string[];
  };
}

interface WorkScreenProps {
  initialTaskId?: string;
  onNavigateToClients?: (clientId?: string) => void;
  onNavigateToSettings?: () => void;
  onNewTask?: () => void;
}

export const WorkScreen: React.FC<WorkScreenProps> = ({
  initialTaskId,
  onNavigateToClients: _onNavigateToClients,
  onNavigateToSettings: _onNavigateToSettings,
  onNewTask,
}) => {
  const [tasks, setTasks] = useState<LiveTask[]>([]);
  const [queueLoads, setQueueLoads] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string>(initialTaskId || '');
  useEffect(() => { if (initialTaskId) setSelectedTaskId(initialTaskId); }, [initialTaskId]);
  const [queueState, setQueueState] = useState<'loading' | 'signed_out' | 'unauthorized' | 'error' | 'ready' | 'empty'>('loading');
  const [queueError, setQueueError] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<ApiSessionUser | null>(null);
  const [authKeyInput, setAuthKeyInput] = useState('');
  const [canvaLinkInput, setCanvaLinkInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [filter, setFilter] = useState<QueueFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'brief' | 'brand' | 'qa' | 'history'>('brief');
  const [mobilePane, setMobilePane] = useState<'queue' | 'detail'>('queue');
  const [previewZoom, setPreviewZoom] = useState(false);

  // Modals & In-Flight State
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [revisionNotes, setRevisionNotes] = useState('');
  const [isApprovalModalOpen, setIsApprovalModalOpen] = useState(false);
  // The stored exports the reviewer can pin to the approval; delivery sends exactly the pinned files.
  const [approvalExports, setApprovalExports] = useState<Reading<StoredExport[]>>({ state: 'loading' });
  const [pinnedExportIds, setPinnedExportIds] = useState<string[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Show temporary toast. Each toast owns the timer: an older toast's timer cleared a newer one
  // after a fraction of its time, so a failure shown right after a success vanished unread.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'info', durationMs = 3500) => {
    setToastMessage({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), durationMs);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Current values for the timer and the live-event handlers, which are registered once.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const queueStateRef = useRef(queueState);
  queueStateRef.current = queueState;
  const initialTaskIdRef = useRef(initialTaskId);
  initialTaskIdRef.current = initialTaskId;

  // The page on screen: the cursor that started it (null: the newest page), the filter and the search
  // Core applied. Refreshes read this same page again.
  const queueViewRef = useRef<{ cursor: string | null; filter: QueueFilter; search: string }>({ cursor: null, filter: 'all', search: '' });
  const queueReadSeq = useRef(0);
  const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [queueTotal, setQueueTotal] = useState(0);

  // Signing out, and a session Core no longer accepts, end the same way (2026-09-24): the queue and
  // the open task are cleared (their panels stop polling), the live stream is closed, and the
  // sign-in prompt says why.
  const showSignedOut = (message: string | null) => {
    eventStream.disconnect();
    setSessionUser(null);
    setTasks([]);
    setQueueState('signed_out');
    setQueueError(message);
  };

  // Fetch one page of the canonical task list (H01). Core pages, filters and searches (architecture
  // programme 0.3): the screen used to read every page every 30 s, and 1 s after each task event, so
  // its own filters and search could see every task; now the filter and the search go to Core, which
  // returns the page asked for and the total that matches, and older matches are a page away instead
  // of missing. `quiet` is a background refresh: the queue stays on screen while it reads, and a
  // failure is reported above it instead of replacing it. This reads no state directly (only
  // setters and refs), so the event and visibility handlers may call the first render's copy.
  const fetchTasks = async (quiet = false) => {
    const view = queueViewRef.current;
    const seq = ++queueReadSeq.current;
    if (!quiet) {
      setQueueState('loading');
      setQueueError(null);
    }
    try {
      if (!quiet) {
        try {
          const session = await apiClient.auth.getSession();
          if (session.authenticated && session.user) {
            setSessionUser(session.user);
          }
        } catch {}
      }

      const res = await apiClient.tasks.list({
        limit: QUEUE_PAGE_SIZE,
        cursor: view.cursor,
        statuses: queueFilterStatuses(view.filter),
        q: view.search || undefined,
      });
      // A newer read (another page, filter or search) was asked for while this one ran.
      if (seq !== queueReadSeq.current) return;
      const page: LiveTask[] = Array.isArray(res) ? res : (res.items || []);
      setQueueTotal(Array.isArray(res) ? page.length : Number(res.total ?? page.length));
      setNextCursor(Array.isArray(res) ? null : (res.nextCursor ?? null));
      // The task opened from a link or a notification stays in view even when it is not on this page.
      const selectedId = selectedTaskIdRef.current;
      const selectedElsewhere = selectedId && !page.some((t) => t.id === selectedId) ? tasksRef.current.find((t) => t.id === selectedId) : undefined;
      const items = selectedElsewhere ? [...page, selectedElsewhere] : page;
      setQueueError(null);
      if (quiet) {
        // A background refresh keeps the preview already loaded and reads the selected task's detail
        // again only when the list shows it changed, rather than downloading its preview every 30 s.
        const changed = queueEntryChanged(tasksRef.current.find((t) => t.id === selectedId), items.find((t) => t.id === selectedId));
        setTasks((prev) => keepLoadedDetail(prev, items));
        if (changed) setQueueLoads((n) => n + 1);
      } else {
        setTasks(items);
        // The list carries no preview: the selected task's detail is read again after every reload.
        setQueueLoads((n) => n + 1);
      }
      if (items.length === 0 && view.filter === 'all' && !view.search && !view.cursor) {
        setQueueState('empty');
      } else {
        setQueueState('ready');
        setSelectedTaskId((prev) => {
          if (prev && (items.some((i) => i.id === prev) || prev === initialTaskIdRef.current)) return prev;
          return items[0]?.id || '';
        });
      }
    } catch (err: any) {
      if (seq !== queueReadSeq.current) return;
      if (err instanceof ApiError && err.status === 401) {
        // The API client has already shown the sign-in prompt with Core's reason.
        setQueueState('signed_out');
        setQueueError((prev) => prev || 'Authentication required: Sign in to access the active work queue.');
      } else if (quiet) {
        setQueueError(`The queue could not be refreshed (${err?.message || 'network error'}). It shows the last list read.`);
      } else if (err instanceof ApiError) {
        if (err.status === 403) {
          setQueueState('unauthorized');
          setQueueError(err.message || 'Access Denied: Legitimate reviewer or operator role required.');
        } else {
          setQueueState('error');
          setQueueError(err.message || `Server error (HTTP ${err.status})`);
        }
      } else {
        setQueueState('error');
        setQueueError(err.message || 'Network error: Failed to connect to Core API');
      }
    }
  };

  // Every 401, from any panel, ends in the same sign-in prompt (2026-09-24). Only the queue used to
  // notice; after the 24-hour session expired, the rest of the screen went on showing stale data.
  useEffect(
    () =>
      apiClient.auth.onSessionEnded((reason, hadSession) => {
        if (queueStateRef.current === 'signed_out') return;
        showSignedOut(
          hadSession
            ? `Your session has ended (Core answered: ${reason}). Sign in again to continue.`
            : 'Authentication required: Sign in to access the active work queue.'
        );
      }),
    []
  );

  useEffect(() => {
    fetchTasks();
  }, []);

  // A new filter or search starts again at the newest page. The search waits until typing pauses.
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchQuery.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    queueViewRef.current = { cursor: null, filter, search };
    setPageCursors([null]);
    if (queueStateRef.current === 'ready' || queueStateRef.current === 'empty') void fetchTasks(true);
  }, [filter, search]);

  // Older and newer pages. Each page read is remembered by the cursor that started it, so Newer goes
  // back exactly; a refresh reads the page on screen again, never every page.
  const showPage = (cursors: (string | null)[]) => {
    queueViewRef.current = { ...queueViewRef.current, cursor: cursors[cursors.length - 1] };
    setPageCursors(cursors);
    void fetchTasks(true);
  };
  const showOlderPage = () => {
    if (nextCursor) showPage([...pageCursors, nextCursor]);
  };
  const showNewerPage = () => {
    if (pageCursors.length > 1) showPage(pageCursors.slice(0, -1));
  };

  // Background refresh (architecture programme 0.3). Task events ask for one read of the page on
  // screen, coalesced; the 30 s poll runs only while the tab is visible and the event stream is down;
  // a hidden tab reads nothing (services/queueRefresh.ts). A refresh needs a queue on screen.
  const refreshQueueQuietly = async () => {
    if (queueStateRef.current !== 'ready' && queueStateRef.current !== 'empty') return;
    await fetchTasks(true);
  };
  useEffect(() => {
    const refresher = startQueueRefresh({ refresh: refreshQueueQuietly, stream: eventStream, events: TASK_EVENTS, doc: document });
    return () => refresher.stop();
  }, []);

  // `GET /tasks` has no captured preview; `GET /tasks/:id` does. Read the selected task's detail when
  // it is selected (and after each queue reload), so an existing design is shown without an action.
  useEffect(() => {
    if (!selectedTaskId) return;
    let current = true;
    void loadTaskDetail<LiveTask>(apiClient.tasks, selectedTaskId).then((detail) => {
      // A task opened from a link may be on no page read yet: it is shown after the page.
      if (current && detail) setTasks((prev) => (prev.some((t) => t.id === detail.id) ? mergeTaskDetail(prev, detail) : [...prev, detail]));
    });
    return () => {
      current = false;
    };
  }, [selectedTaskId, queueLoads]);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!authKeyInput.trim()) return;
    setAuthError(null);
    try {
      setActionLoading(true);
      const session = await apiClient.auth.login({ key: authKeyInput.trim() });
      if (session.user) setSessionUser(session.user);
      setAuthKeyInput('');
      // The live stream carries the token it was opened with: open it again with the new session.
      eventStream.disconnect();
      eventStream.connect();
      await fetchTasks();
      showToast(`Signed in as ${session.user?.displayName || session.user?.role || 'user'}`, 'success');
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
      showToast(`Sign in failed: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Ends the session on the server too; the tab is signed out whether or not Core answers.
  const handleSignOut = () => {
    void apiClient.auth.logout();
    showSignedOut(null);
    showToast('Signed out', 'info');
  };

  // Live updates via EventStream (2026-09-24). Every task event re-reads what it names: the open
  // task's detail and history at once; the queue is read by the refresher above, once for a burst.
  // The screen used to apply only task:transitioned's own status (Telegram's says IN_PROGRESS where
  // Core records REVISION_REQUESTED), ignored approvals, and never re-read the task open on screen.
  const [timelineReads, setTimelineReads] = useState(0);
  useEffect(() => {
    const onTaskEvent = (data: any) => {
      const taskId = data?.taskId || data?.task?.id || data?.id;
      if (taskId && taskId === selectedTaskIdRef.current) {
        void loadTaskDetail<LiveTask>(apiClient.tasks, taskId).then((detail) => {
          if (detail) setTasks((prev) => mergeTaskDetail(prev, detail));
        });
        setTimelineReads((n) => n + 1);
      }
    };

    const unsubscribers = TASK_EVENTS.filter((name) => name !== 'task:created' && name !== 'task:transitioned').map((name) => eventStream.on(name, onTaskEvent));
    // A move names its task in the one shape (readTaskTransitioned); the task is read again from Core.
    unsubscribers.push(eventStream.on('task:transitioned', (data: unknown) => onTaskEvent({ taskId: readTaskTransitioned(data).taskId })));
    unsubscribers.push(
      eventStream.on('task:created', (data: any) => {
        const taskObj = data?.task || (data?.id ? data : null);
        if (taskObj) {
          // A database row carries `state`, not the Desk's status; the queue read brings it. Only the
          // newest page of the unfiltered queue shows a new task at the top.
          const view = queueViewRef.current;
          if (typeof taskObj.status === 'string' && !view.cursor && view.filter === 'all' && !view.search) {
            setTasks((prev) => [taskObj, ...prev.filter((t) => t.id !== taskObj.id)]);
            // The first task on an empty queue was added to a list the screen did not show.
            setQueueState((state) => (state === 'empty' ? 'ready' : state));
            setSelectedTaskId((prev) => prev || taskObj.id);
          }
          showToast(`New task received: ${taskObj.title || taskObj.headlineEn || taskObj.id}`, 'info');
        }
        onTaskEvent(data);
      })
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  // Filtered tasks. Core filters and searches the page (folding the Arabic-keyboard ي and ك into
  // Sorani ی and ک, as the screen did); the status groups (taskStatus.ts) are applied here again only
  // for a task a live event changed since the page was read.
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => inQueueFilter(task.status, filter));
  }, [tasks, filter]);

  // Selected Task
  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.id === selectedTaskId) || filteredTasks[0] || tasks[0];
  }, [tasks, selectedTaskId, filteredTasks]);

  // History & Audit reads the task's recorded events (GET /tasks/:id/timeline). It read `history`
  // from the task, which no task route returns, so it always showed none (2026-09-24).
  const [timeline, setTimeline] = useState<{ taskId: string; reading: Reading<TaskTimelineEvent[]> } | null>(null);
  const selectedId = selectedTask?.id;
  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    void read(async () => (await apiClient.tasks.timeline(selectedId))?.events ?? []).then((reading) => {
      if (current) setTimeline({ taskId: selectedId, reading });
    });
    return () => {
      current = false;
    };
  }, [selectedId, queueLoads, timelineReads]);
  const timelineReading: Reading<TaskTimelineEvent[]> = timeline && timeline.taskId === selectedId ? timeline.reading : { state: 'loading' };

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

  // Primary Action 2: Capture for review (FR-078). Core exports the linked Canva design as PNG, then
  // validates, hashes and stores it. No QA runs and no revision is created, so the task's status and
  // QA result are whatever Core reports afterwards; nothing is set locally.
  const handleCaptureForReview = async () => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    setActionLoading(true);
    try {
      const outcome = await captureForReview(apiClient.canva, taskId, { key: crypto.randomUUID() });
      showToast(outcome.text, outcome.tone);
      const refreshed = await apiClient.tasks.get<LiveTask>(taskId).catch(() => null);
      if (refreshed) setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...refreshed } : t)));
    } catch (err) {
      showToast(`Nothing captured: ${reasonOf(err)}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Primary Action 3: Request revision (FR-078, CV-15, H02, H03). A request is recorded on a design
  // revision. With none, the call used to be skipped while the Desk still reported "Task transitioned
  // to REVISION_REQUESTED" and cleared the notes (2026-09-24). Nothing is claimed now that Core did
  // not record, and the notes stay until Core has them.
  const handleSendRevisionRequest = async () => {
    if (!selectedTask || !revisionNotes.trim()) return;
    const taskId = selectedTask.id;
    const revisionId = selectedTask.latestRevisionId;
    if (!revisionId) {
      showToast('Nothing sent: this task has no design revision to request changes on. Your notes are kept.', 'error');
      return;
    }
    setActionLoading(true);
    let decisionRes: { decisionId?: string } | null;
    try {
      decisionRes = await apiClient.tasks.recordDecision<{ decisionId?: string } | null>(taskId, revisionId, {
        action: 'revision_requested',
        revisionRequest: {
          comment: revisionNotes.trim(),
        },
      });
    } catch (err: any) {
      showToast(`Revision request failed: ${err.message || 'Server error'}. Your notes are kept.`, 'error');
      setActionLoading(false);
      return;
    }
    setIsRevisionModalOpen(false);
    setRevisionNotes('');
    // Core recorded the request; a failed refresh after it is not a failed request.
    const refreshedTask = await apiClient.tasks.get<LiveTask>(taskId).catch(() => null);
    if (refreshedTask) setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...refreshedTask } : t)));
    showToast(
      refreshedTask
        ? `Revision request recorded. Core now reports this task as ${taskStatusView(refreshedTask.status).pill}.`
        : `Revision request recorded (decision ${decisionRes?.decisionId || 'id not returned'}). Refresh the page to see the task's status.`,
      'success'
    );
    setActionLoading(false);
  };

  // Primary Action 4: Approve captured files (FR-078, CV-15, H02, H03). The modal lists the exports
  // Core has stored for the task; the ones the reviewer keeps selected are pinned to the approval.
  const openApprovalModal = async () => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    setIsApprovalModalOpen(true);
    setApprovalExports({ state: 'loading' });
    setPinnedExportIds([]);
    const reading = await read(async () => {
      const state = await apiClient.canva.taskState(taskId);
      return Array.isArray(state?.artifacts) ? (state.artifacts as StoredExport[]) : [];
    });
    setApprovalExports(reading);
    if (reading.state === 'known') setPinnedExportIds(defaultPins(reading.value));
  };

  const handleApprove = async () => {
    if (!selectedTask || !selectedTask.latestRevisionId) {
      showToast('No active design revision to approve.', 'error');
      return;
    }
    const exportsForApproval = approvalExports.state === 'known' ? approvalExports.value : [];
    const blocker = approvalRoleBlocker(sessionUser?.role) || approvalBlocker(approvalExports.state, exportsForApproval, pinnedExportIds);
    if (blocker) {
      showToast(blocker, 'error');
      return;
    }
    const taskId = selectedTask.id;
    const revisionId = selectedTask.latestRevisionId;
    setActionLoading(true);
    let decisionRes: any;
    try {
      decisionRes = await apiClient.tasks.recordDecision(taskId, revisionId, {
        action: 'approve',
        reason: 'Brand, hierarchy, and exact-copy verified',
        pinnedExportIds,
      });
    } catch (err: any) {
      showToast(`Approval failed: ${err.message || 'Server error'}`, 'error');
      setActionLoading(false);
      return;
    }
    // Core recorded the approval; a failed refresh after it is not a failed approval.
    const refreshedTask = await apiClient.tasks.get(taskId).catch(() => null);
    if (refreshedTask) setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...refreshedTask } : t)));
    setIsApprovalModalOpen(false);
    const notice = describeApproval(revisionId, decisionRes?.decisionId, Boolean(refreshedTask));
    showToast(notice.text, notice.tone, notice.durationMs);
    setActionLoading(false);
  };

  // Primary Action 5: Deliver approved files (FR-078, CV-16, H02)
  const handleDeliver = async () => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    setActionLoading(true);
    let delivery: unknown;
    try {
      delivery = await apiClient.tasks.publish(taskId, {
        destination: 'google_drive',
      });
    } catch (err: any) {
      showToast(`Delivery failed: ${err.message || 'Server error'}`, 'error');
      setActionLoading(false);
      return;
    }
    // Core accepted the delivery (202 DELIVERED_TO_CHAT_ONLY included: the requester has the file);
    // a failed refresh after it is not a failed delivery.
    const refreshedTask = await apiClient.tasks.get<LiveTask>(taskId).catch(() => null);
    if (refreshedTask) setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...refreshedTask } : t)));
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
    ? approveButtonState(selectedTask.status, { hasRevision: Boolean(selectedTask.latestRevisionId), qaPassed: selectedTask.qaReport?.passed === true, busy: actionLoading })
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
                    👤 {sessionUser.role}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {sessionUser && (
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
                      await fetchTasks();
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

            {queueState === 'signed_out' && (
              <div className="auth-prompt-card" role="region" aria-label="Sign In Required">
                <span style={{ fontSize: 24 }}>🔒</span>
                <h4>Authentication Required</h4>
                <p>{queueError || 'Sign in with a valid reviewer or operator key to access the live task queue.'}</p>
                <form onSubmit={handleLogin} className="auth-inline-form">
                  <input
                    type="password"
                    placeholder="Enter your office access key"
                    aria-label="Office access key"
                    autoComplete="off"
                    value={authKeyInput}
                    onChange={(e) => setAuthKeyInput(e.target.value)}
                    className="input-field"
                    style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
                  />
                  <div className="auth-form-actions">
                    <button type="submit" className="btn primary btn-sm" disabled={!authKeyInput.trim() || actionLoading}>
                      Sign In
                    </button>

                  </div>
                  {authError && <div className="auth-error-msg">{authError}</div>}
                </form>
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
                <button className="btn primary btn-sm" onClick={() => void fetchTasks()}>
                  🔄 Retry Connection
                </button>
              </div>
            )}

            {queueState === 'empty' && (
              <div className="queue-empty-state">
                <p>No tasks currently pending in the work queue.</p>
                <button className="btn btn-sm" onClick={() => void fetchTasks()}>
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

            {queueState === 'ready' && (pageCursors.length > 1 || nextCursor) && (
              <nav className="queue-pager" aria-label="Queue pages" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 4px' }}>
                <button className="btn btn-sm" onClick={showNewerPage} disabled={pageCursors.length <= 1} aria-label="Newer tasks">
                  ← Newer
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {`${(pageCursors.length - 1) * QUEUE_PAGE_SIZE + 1}–${(pageCursors.length - 1) * QUEUE_PAGE_SIZE + filteredTasks.length} of ${queueTotal}`}
                </span>
                <button className="btn btn-sm" onClick={showOlderPage} disabled={!nextCursor} aria-label="Older tasks">
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

              {/* Task Header Summary */}
              <div className="detail-header-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span className="client-badge-large">{selectedTask.clientName || 'Client'}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace' }}>
                        {selectedTask.id}
                      </span>
                    </div>
                    <h1 className="detail-title" dir="auto">{selectedTask.title}</h1>
                  </div>

                  {nextAction && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`status-pill-large ${nextAction.pillClass}`}>
                        {nextAction.pill}
                      </span>
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

                <details className="canva-binding-form">
                  <summary>Link this task’s Canva design</summary>
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
                </details>
                <AskLedgerPanel key={`asks-${selectedTask.id}`} taskId={selectedTask.id} />
                <StudioPanel key={`studio-${selectedTask.id}`} taskId={selectedTask.id} />
                <CanvaTaskPanel key={selectedTask.id} taskId={selectedTask.id} />
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
                    disabled={actionLoading}
                    title="Export the linked Canva design as PNG and store it, hashed, as review evidence. QA and approval are separate (FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">📸</span>
                    <span>Capture for Review</span>
                  </button>

                  {/* Action 3: Request revision. A request is recorded on a design revision; without one there is nothing to send it to. */}
                  <button
                    id="btn-request-revision"
                    className="action-btn revision-btn"
                    onClick={() => setIsRevisionModalOpen(true)}
                    disabled={actionLoading || !selectedTask.latestRevisionId}
                    title={
                      selectedTask.latestRevisionId
                        ? 'Request revision and log structured operator instructions (FR-078)'
                        : 'Not available: this task has no design revision to request changes on yet'
                    }
                  >
                    <span className="btn-icon" aria-hidden="true">✏️</span>
                    <span>Request Revision</span>
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
                      <span>Approve Captured Files</span>
                    </button>
                  )}

                  {/* Action 5: Deliver approved files */}
                  <button
                    id="btn-deliver-approved"
                    className="action-btn deliver-btn"
                    onClick={handleDeliver}
                    disabled={actionLoading || !selectedTask.latestApproval || nextAction?.primaryButton !== 'deliver'}
                    title="Publish approved files to Google Drive and Google Sheets (FR-046, FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">🚀</span>
                    <span>Deliver Approved Files</span>
                  </button>
                </div>
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
                  {selectedTask.referenceAssets && <div className="rule"><h4>Reference notes</h4><p style={{whiteSpace:'pre-wrap'}}>{selectedTask.referenceAssets}</p></div>}
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
                          const fontPass = qa ? qa.fontCoverage : null;

                          return (
                            <>
                              <div className={`qa-item ${bidiPass === true ? 'passed' : bidiPass === false ? 'failed' : 'pending'}`}>
                                <span className="qa-status-icon">{bidiPass === true ? '✓' : bidiPass === false ? '✗' : '○'}</span>
                                <div style={{ flex: 1 }}>
                                  <strong>Kurdish Sorani Bidi Isolation (UAX #9)</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {bidiPass === true
                                      ? 'Unicode directional isolates present around mixed LTR numbers and Kurdish text.'
                                      : bidiPass === false
                                      ? 'Bidi directional isolation missing or corrupted for RTL Arabic script segments.'
                                      : 'Automated check pending review of vector layout.'}
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
                                  <strong>Font License & Glyph Coverage</strong>
                                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                                    {fontPass === true
                                      ? 'All glyphs covered by OFL fonts (Vazirmatn/Cairo/Rabar). Zero placeholder tofu boxes.'
                                      : fontPass === false
                                      ? 'Missing Kurdish Sorani glyph shapes or unsupported font weights detected.'
                                      : 'Font coverage inspection pending.'}
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
              <p>Select a task from the queue to inspect details and perform creative actions.</p>
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

            <textarea
              className="hawa-textarea"
              rows={4}
              placeholder="e.g. Increase Kurdish headline size by 4px and verify the logo top-right RTL clearance..."
              value={revisionNotes}
              onChange={(e) => setRevisionNotes(e.target.value)}
              autoFocus
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => setIsRevisionModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={handleSendRevisionRequest}
                disabled={!revisionNotes.trim() || actionLoading}
              >
                Submit Revision Request
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
            <h3 id="modal-app-title" style={{ marginTop: 0 }}>Authorize Release & Approve</h3>
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
                Delivery sends exactly the selected exports, byte for byte, and nothing else.
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
              {approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds) && (
                <p role="status" style={{ fontSize: 12, color: '#b91c1c', margin: '4px 0 0' }}>
                  {approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds)}
                  {approvalExports.state === 'unknown' ? ` (${approvalExports.reason})` : ''}
                </p>
              )}
            </fieldset>

            {/* Core records the approval under the signed-in session's role; nothing chosen here is sent. */}
            <div style={{ marginBottom: 16, fontSize: 12 }}>
              <span style={{ fontWeight: 600 }}>Signing off as: </span>
              <span>{sessionUser ? `${sessionUser.displayName || 'Signed-in user'} (${roleLabel(sessionUser.role || 'unknown role')})` : 'the signed-in session'}</span>
              {approvalRoleBlocker(sessionUser?.role) && (
                <p role="status" style={{ color: '#b91c1c', margin: '4px 0 0' }}>
                  {approvalRoleBlocker(sessionUser?.role)}
                </p>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setIsApprovalModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                style={{ background: '#166534', borderColor: '#166534' }}
                onClick={handleApprove}
                disabled={
                  actionLoading ||
                  Boolean(approvalRoleBlocker(sessionUser?.role)) ||
                  Boolean(approvalBlocker(approvalExports.state, approvalExports.state === 'known' ? approvalExports.value : [], pinnedExportIds))
                }
              >
                Confirm Approval & Release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
