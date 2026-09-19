import React, { useState, useEffect, useMemo } from 'react';
import { eventStream } from '../services/eventStream.js';
import { CanvaTaskPanel } from '../components/CanvaTaskPanel.js';
import { StudioPanel } from '../components/StudioPanel.js';
import { VectorInspector } from '../components/VectorInspector.js';
import { SubmittedCopy } from '../components/SubmittedCopy.js';
import { apiClient, ApiError, type ApiSessionUser } from '../api/client.js';
import { captureForReview } from '../services/canvaCapture.js';
import { read, reasonOf, type Reading } from '../services/statusReport.js';
import { approvalBlocker, defaultPins, describeExport, togglePin, type StoredExport } from '../services/approvalPins.js';

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
    safeMargins: boolean;
    contrastCompliant: boolean;
    fontCoverage: boolean;
    errors?: string[];
  };
  history?: Array<{
    id: string;
    type: string;
    actor: string;
    summary: string;
    timestamp: string;
  }>;
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
  const [selectedTaskId, setSelectedTaskId] = useState<string>(initialTaskId || '');
  useEffect(() => { if (initialTaskId) setSelectedTaskId(initialTaskId); }, [initialTaskId]);
  const [queueState, setQueueState] = useState<'loading' | 'signed_out' | 'unauthorized' | 'error' | 'ready' | 'empty'>('loading');
  const [queueError, setQueueError] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<ApiSessionUser | null>(null);
  const [authKeyInput, setAuthKeyInput] = useState('');
  const [canvaLinkInput, setCanvaLinkInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [filter, setFilter] = useState<'all' | 'needs_action' | 'in_progress' | 'review' | 'complete'>('all');
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
  const [approverRole, setApproverRole] = useState<'art_director' | 'brand_lead' | 'compliance_reviewer'>('art_director');
  const [actionLoading, setActionLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Show temporary toast
  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Fetch canonical task list from server using typed API client (H01)
  const fetchTasks = async () => {
    setQueueState('loading');
    setQueueError(null);
    try {
      try {
        const session = await apiClient.auth.getSession();
        if (session.authenticated && session.user) {
          setSessionUser(session.user);
        }
      } catch {}

      const res = await apiClient.tasks.list({ limit: 50, offset: 0 });
      const items: LiveTask[] = Array.isArray(res) ? res : (res.items || []);
      setTasks(items);
      if (items.length === 0) {
        setQueueState('empty');
      } else {
        setQueueState('ready');
        setSelectedTaskId((prev) => {
          if (prev && items.some((i) => i.id === prev)) return prev;
          return items[0].id;
        });
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setQueueState('signed_out');
          setQueueError('Authentication required: Sign in to access the active work queue.');
        } else if (err.status === 403) {
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

  useEffect(() => {
    fetchTasks();
  }, []);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!authKeyInput.trim()) return;
    setAuthError(null);
    try {
      setActionLoading(true);
      const session = await apiClient.auth.login({ key: authKeyInput.trim() });
      if (session.user) setSessionUser(session.user);
      setAuthKeyInput('');
      await fetchTasks();
      showToast(`Signed in as ${session.user?.displayName || session.user?.role || 'user'}`, 'success');
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
      showToast(`Sign in failed: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSignOut = () => {
    apiClient.auth.logout();
    setSessionUser(null);
    setTasks([]);
    setQueueState('signed_out');
    showToast('Signed out', 'info');
  };

  // Live real-time updates via EventStream
  useEffect(() => {
    const unsubCreated = eventStream.on('task:created', (data: any) => {
      const taskObj = data?.task || (data?.id ? data : null);
      if (taskObj) {
        setTasks((prev) => [taskObj, ...prev.filter((t) => t.id !== taskObj.id)]);
        showToast(`New task received: ${taskObj.title || taskObj.headlineEn || taskObj.id}`, 'info');
      }
    });

    const unsubTransitioned = eventStream.on('task:transitioned', (data: any) => {
      const targetId = data?.taskId || data?.task?.id || data?.id;
      const targetStatus = data?.toStatus || data?.status || data?.state;
      if (targetId && targetStatus) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === targetId ? { ...t, status: targetStatus, updatedAt: new Date().toISOString() } : t
          )
        );
      }
    });

    const unsubPublished = eventStream.on('task:published', () => {
      // A notification is not a delivery receipt. Reload authoritative task evidence.
      void fetchTasks();
    });

    return () => {
      unsubCreated();
      unsubTransitioned();
      unsubPublished();
    };
  }, []);

  // Filtered tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Status Filter
      if (filter === 'needs_action') {
        if (task.status !== 'AWAITING_APPROVAL' && task.status !== 'IN_PROGRESS' && task.status !== 'RECEIVED') return false;
      } else if (filter === 'in_progress') {
        if (task.status !== 'IN_PROGRESS') return false;
      } else if (filter === 'review') {
        if (task.status !== 'AWAITING_APPROVAL') return false;
      } else if (filter === 'complete') {
        if (task.status !== 'COMPLETE') return false;
      }

      // Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = task.title.toLowerCase().includes(q);
        const matchClient = (task.clientName || '').toLowerCase().includes(q);
        const matchId = task.id.toLowerCase().includes(q);
        const matchCopy = (task.copyEn || '').toLowerCase().includes(q) || (task.copyCkb || '').includes(q);
        return matchTitle || matchClient || matchId || matchCopy;
      }

      return true;
    });
  }, [tasks, filter, searchQuery]);

  // Selected Task
  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.id === selectedTaskId) || filteredTasks[0] || tasks[0];
  }, [tasks, selectedTaskId, filteredTasks]);

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

  // Primary Action 3: Request revision (FR-078, CV-15, H02, H03)
  const handleSendRevisionRequest = async () => {
    if (!selectedTask || !revisionNotes.trim()) return;
    setActionLoading(true);
    try {
      if (selectedTask.latestRevisionId) {
        await apiClient.tasks.recordDecision(
          selectedTask.id,
          selectedTask.latestRevisionId,
          {
            action: 'revision_requested',
            revisionRequest: {
              comment: revisionNotes.trim(),
            },
          }
        );
      }
      const refreshedTask = await apiClient.tasks.get(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === selectedTask.id ? { ...t, ...refreshedTask } : t)));
      setIsRevisionModalOpen(false);
      setRevisionNotes('');
      showToast(`Revision request logged. Task transitioned to REVISION_REQUESTED.`, 'info');
    } catch (err: any) {
      showToast(`Revision request failed: ${err.message || 'Server error'}`, 'error');
    } finally {
      setActionLoading(false);
    }
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
    const blocker = approvalBlocker(approvalExports.state, exportsForApproval, pinnedExportIds);
    if (blocker) {
      showToast(blocker, 'error');
      return;
    }
    setActionLoading(true);
    try {
      const decisionRes: any = await apiClient.tasks.recordDecision(
        selectedTask.id,
        selectedTask.latestRevisionId,
        {
          action: 'approve',
          reason: 'Brand, hierarchy, and exact-copy verified',
          pinnedExportIds,
        }
      );

      // Await genuine 201 server receipt and refresh authoritative task state
      const refreshedTask = await apiClient.tasks.get(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === selectedTask.id ? { ...t, ...refreshedTask } : t)));
      setIsApprovalModalOpen(false);
      showToast(`Approved Revision ${selectedTask.latestRevisionId}. Decision ID: ${decisionRes.decisionId || 'recorded'}.`, 'success');
    } catch (err: any) {
      showToast(`Approval failed: ${err.message || 'Server error'}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Primary Action 5: Deliver approved files (FR-078, CV-16, H02)
  const handleDeliver = async () => {
    if (!selectedTask) return;
    setActionLoading(true);
    try {
      await apiClient.tasks.publish(selectedTask.id, {
        destination: 'google_drive',
      });

      // Await genuine server receipt and refresh task
      const refreshedTask = await apiClient.tasks.get(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === selectedTask.id ? { ...t, ...refreshedTask } : t)));
      showToast(refreshedTask.status === 'COMPLETE' ? 'Delivery complete.' : 'Publication requested. Check the task for verified delivery status.', refreshedTask.status === 'COMPLETE' ? 'success' : 'info');
    } catch (err: any) {
      showToast(`Delivery failed: ${err.message || 'Server error'}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Helper: Next action prompt
  const getNextActionPrompt = (task: LiveTask) => {
    if (task.status === 'COMPLETE') {
      return {
        pill: 'COMPLETE',
        pillClass: 'pill-complete',
        message: 'Task is marked complete. Check its delivery receipt and audit history for destination evidence.',
        primaryButton: 'deliver_again',
      };
    }
    if (task.latestApproval) {
      return {
        pill: 'APPROVED',
        pillClass: 'pill-approved',
        message: 'An approval is recorded. Delivery still requires the server’s current revision and publication checks.',
        primaryButton: 'deliver',
      };
    }
    if (task.status === 'AWAITING_APPROVAL') {
      return {
        pill: 'NEEDS APPROVAL',
        pillClass: 'pill-action',
        message: 'Review requested. Inspect the captured files and current QA result before approving.',
        primaryButton: 'approve',
      };
    }
    if (task.status === 'IN_PROGRESS') {
      return {
        pill: 'IN DESIGN',
        pillClass: 'pill-progress',
        message: 'Design work is in progress. Capture for Review stores a PNG export of the linked Canva design; it runs no QA and approves nothing.',
        primaryButton: 'capture',
      };
    }
    return {
      pill: 'RECEIVED',
      pillClass: 'pill-received',
      message: 'Your request is saved. Use the Canva controls below to design, edit and check it.',
      primaryButton: 'edit',
    };
  };

  const nextAction = selectedTask ? getNextActionPrompt(selectedTask) : null;

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
          <span>{toastMessage.text}</span>
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
          📋 Queue ({filteredTasks.length})
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
                <span className="queue-count-badge">{filteredTasks.length}</span>
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
                <p>Sign in with a valid reviewer or operator key to access the live task queue.</p>
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
                <button className="btn primary btn-sm" onClick={fetchTasks}>
                  🔄 Retry Connection
                </button>
              </div>
            )}

            {queueState === 'empty' && (
              <div className="queue-empty-state">
                <p>No tasks currently pending in the work queue.</p>
                <button className="btn btn-sm" onClick={fetchTasks}>
                  🔄 Refresh Queue
                </button>
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

                    <div className="card-title" title={task.title}>
                      {task.title}
                    </div>

                    <div className="card-snippet">
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
                    <h1 className="detail-title">{selectedTask.title}</h1>
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

                  {/* Action 3: Request revision */}
                  <button
                    id="btn-request-revision"
                    className="action-btn revision-btn"
                    onClick={() => setIsRevisionModalOpen(true)}
                    disabled={actionLoading}
                    title="Request revision and log structured operator instructions (FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">✏️</span>
                    <span>Request Revision</span>
                  </button>

                  {/* Action 4: Approve captured files */}
                  <button
                    id="btn-approve-captured"
                    className="action-btn approve-btn"
                    onClick={openApprovalModal}
                    disabled={actionLoading || !selectedTask.latestRevisionId || selectedTask.qaReport?.passed !== true || selectedTask.status === 'COMPLETE'}
                    title="Record human approval bound to captured revision (FR-041, FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">✅</span>
                    <span>Approve Captured Files</span>
                  </button>

                  {/* Action 5: Deliver approved files */}
                  <button
                    id="btn-deliver-approved"
                    className="action-btn deliver-btn"
                    onClick={handleDeliver}
                    disabled={actionLoading || !selectedTask.latestApproval || selectedTask.status === 'COMPLETE'}
                    title="Publish approved files to Google Drive and Google Sheets (FR-046, FR-078)"
                  >
                    <span className="btn-icon" aria-hidden="true">🚀</span>
                    <span>Deliver Approved Files</span>
                  </button>
                </div>
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
                    📜 History & Audit ({selectedTask.history?.length || 0})
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

                  {/* TAB 4: HISTORY & AUDIT TRAIL */}
                  {activeTab === 'history' && (
                    <div className="tab-pane-content" role="tabpanel" aria-label="Task History">
                      <div className="history-timeline">
                        {(selectedTask.history || []).map((h, i) => (
                          <div key={h.id || i} className="timeline-item">
                            <div className="timeline-marker" />
                            <div className="timeline-content">
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <strong style={{ fontSize: 13 }}>{h.actor}</strong>
                                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                  {new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--ink)' }}>{h.summary}</p>
                            </div>
                          </div>
                        ))}
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
              Provide clear, structured feedback notes. The task will transition back to IN_PROGRESS.
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

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Sign-off Role
              </label>
              <select
                className="hawa-select"
                value={approverRole}
                onChange={(e) => setApproverRole(e.target.value as any)}
              >
                <option value="art_director">Art Director (Creative & Layout Sign-off)</option>
                <option value="brand_lead">Brand Lead (Client Identity Sign-off)</option>
                <option value="compliance_reviewer">Compliance Reviewer (Institutional Legal Sign-off)</option>
              </select>
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
