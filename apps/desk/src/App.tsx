import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sidebar, type ScreenId } from './components/Sidebar.js';
import { Header } from './components/Header.js';
import { WorkScreen } from './screens/WorkScreen.js';

// The Work queue is where the Desk opens, so it ships in the main chunk. The other screens load on
// first visit: with TanStack Query added (ADR-037) one chunk would pass the 500 KiB budget CV-17 sets.
const ClientsScreen = lazy(() => import('./screens/ClientsScreen.js').then((m) => ({ default: m.ClientsScreen })));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen.js').then((m) => ({ default: m.SettingsScreen })));
const OpsScreen = lazy(() => import('./screens/OpsScreen.js').then((m) => ({ default: m.OpsScreen })));
const EvalScreen = lazy(() => import('./screens/EvalScreen.js').then((m) => ({ default: m.EvalScreen })));
const ComparisonScreen = lazy(() => import('./screens/ComparisonScreen.js').then((m) => ({ default: m.ComparisonScreen })));
import { GuidedTour } from './components/GuidedTour.js';
import { CommandPalette } from './components/CommandPalette.js';
import { draftStore } from './services/draftStore.js';
import { submitManualTask, getPendingManualDraft } from './services/manualTaskIntake.js';
import { useI18n } from './services/i18n.js';
import { SignIn } from './components/SignIn.js';
import { useSessionState, useSessionUser } from './DeskProviders.js';
import { queryKeys } from './services/queryClient.js';

export const App: React.FC = () => {
  const { t, isRtl } = useI18n();
  const queryClient = useQueryClient();
  // Signed out (never signed in, signed out, or a session Core ended), the App shows sign-in in place
  // of any screen. The session read stays mounted while signed in, so an ended session is noticed on
  // every screen, not only the Work queue (ADR-037).
  const sessionState = useSessionState();
  useSessionUser();

  const getInitialScreen = (): ScreenId => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
      if (hash === 'adapters') return 'settings';
      const validScreens: ScreenId[] = ['work', 'clients', 'settings', 'inbox', 'review', 'dna', 'library', 'ops', 'eval', 'comparison'];
      if (validScreens.includes(hash as ScreenId)) return hash as ScreenId;
      const path = window.location.pathname.replace(/^\//, '').split('/')[0];
      if (path === 'adapters') return 'settings';
      if (validScreens.includes(path as ScreenId)) return path as ScreenId;
    }
    return 'work';
  };

  const [currentScreen, setCurrentScreen] = useState<ScreenId>(getInitialScreen);
  const [appToast, setAppToast] = useState<string | null>(null);
  const [showTour, setShowTour] = useState<boolean>(false);
  const [showCommandPalette, setShowCommandPalette] = useState<boolean>(false);

  // Global Keyboard Shortcuts (Cmd+K omnisearch & 1 - 7 screen navigation)
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      // Raycast-grade Cmd+K / Ctrl+K Palette Toggle
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.getAttribute('role') === 'textbox')
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const screenMap: Record<string, ScreenId> = {
        '1': 'work',
        '2': 'clients',
        '3': 'settings',
        '4': 'work',
        '5': 'settings',
        '6': 'settings',
        '7': 'settings',
      };

      if (screenMap[e.key]) {
        handleNavigate(screenMap[e.key]);
      }
    };

    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, []);

  useEffect(() => {
    const handleLocationChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
      if (hash === 'adapters') {
        setCurrentScreen('settings');
        return;
      }
      const validScreens: ScreenId[] = ['inbox', 'review', 'dna', 'library', 'settings', 'ops', 'eval', 'comparison'];
      if (validScreens.includes(hash as ScreenId)) {
        setCurrentScreen(hash as ScreenId);
      }
    };

    const handleCustomNav = (e: any) => {
      const targetScreen = e.detail;
      const validScreens: ScreenId[] = ['inbox', 'review', 'dna', 'library', 'settings', 'ops', 'eval', 'comparison'];
      if (targetScreen && validScreens.includes(targetScreen as ScreenId)) {
        window.location.hash = `#/${targetScreen}`;
        setCurrentScreen(targetScreen as ScreenId);
      }
    };

    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hawa:navigate', handleCustomNav);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hawa:navigate', handleCustomNav);
    };
  }, []);

  const handleNavigate = (screen: ScreenId) => {
    window.location.hash = `#/${screen}`;
    setCurrentScreen(screen);
  };

  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskCopyEn, setTaskCopyEn] = useState('');
  const [taskCopyCkb, setTaskCopyCkb] = useState('');
  const [taskSubmissionError, setTaskSubmissionError] = useState<string | null>(null);
  const [taskDesignInstructions, setTaskDesignInstructions] = useState('');
  const [taskReferenceAssets, setTaskReferenceAssets] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [selectedClientId, setSelectedClientId] = useState('c1000000-0000-4000-8000-000000000002');
  const taskTitleInputRef = useRef<HTMLInputElement>(null);

  const availableClients = [
    { id: 'c1000000-0000-4000-8000-000000000002', name: 'KAAE (Kurdistan Accrediting Association for Education)' },
    { id: 'c1000000-0000-4000-8000-000000000003', name: 'Drustee Evidence-First Health' },
    { id: 'c1000000-0000-4000-8000-000000000004', name: 'FastPay Mobile Wallet' },
  ];

  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  // Auto-focus title input when modal opens, trap Tab focus, and register Escape key listener
  useEffect(() => {
    if (showNewTaskModal) {
      previouslyFocusedElementRef.current = document.activeElement as HTMLElement;

      const timer = setTimeout(() => {
        taskTitleInputRef.current?.focus();
      }, 50);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowNewTaskModal(false);
          return;
        }

        if (e.key === 'Tab' && modalRef.current) {
          const focusable = modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];

          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('keydown', handleKeyDown);
        if (previouslyFocusedElementRef.current) {
          previouslyFocusedElementRef.current.focus();
        }
      };
    }
  }, [showNewTaskModal]);

  // Restore draft when opening modal
  const handleOpenModal = () => {
    const pendingDraft = getPendingManualDraft();
    const existingDraft = pendingDraft || draftStore.getActiveDraft();
    if (existingDraft && (pendingDraft || (!taskTitle && !taskCopyEn))) {
      setTaskTitle(existingDraft.title || '');
      setTaskCopyEn(existingDraft.copy || '');
      setTaskDesignInstructions(existingDraft.designInstructions || '');
      setTaskReferenceAssets(existingDraft.referenceAssets || '');
      if (existingDraft.copyCkb) setTaskCopyCkb(existingDraft.copyCkb);
      if (existingDraft.clientId) setSelectedClientId(existingDraft.clientId);
    }
    setShowNewTaskModal(true);
  };

  // Save every field; an unavailable browser store must be visible before submission.
  useEffect(() => {
    if (!showNewTaskModal) return;
    try {
      draftStore.saveActiveDraft({ title: taskTitle, copy: taskCopyEn, copyCkb: taskCopyCkb,
        clientId: selectedClientId, designInstructions: taskDesignInstructions, referenceAssets: taskReferenceAssets });
    } catch {
      setTaskSubmissionError('Your browser could not save this draft. Keep this window open and free browser storage before submitting.');
    }
  }, [showNewTaskModal, taskTitle, taskCopyEn, taskCopyCkb, selectedClientId, taskDesignInstructions, taskReferenceAssets]);

  const handleTitleChange = setTaskTitle;
  const handleCopyEnChange = setTaskCopyEn;

  const handleCreateTask = async () => {
    if (!taskTitle.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setTaskSubmissionError(null);
    try {
      const data = await submitManualTask({ title: taskTitle, copy: taskCopyEn, copyCkb: taskCopyCkb,
        clientId: selectedClientId, designInstructions: taskDesignInstructions, referenceAssets: taskReferenceAssets });
      draftStore.clearActiveDraft();
      setSelectedTask(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      setShowNewTaskModal(false);
      setTaskTitle('');
      setTaskCopyEn('');
      setTaskCopyCkb('');
      setTaskDesignInstructions('');
      setTaskReferenceAssets('');
      setAppToast('Request saved. Create or link a Canva design to edit it. Automatic design composition is not connected.');
      handleNavigate('review');
    } catch (error) {
      setTaskSubmissionError(error instanceof Error ? error.message : 'Request could not be confirmed. Your draft is retained; retry without changing it.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={`shell ${isRtl ? 'rtl' : 'ltr'}`}>
      <Sidebar currentScreen={currentScreen} onNavigate={handleNavigate} />
      <main className="main">
        <Header
          currentScreen={currentScreen}
          onNewTask={handleOpenModal}
          onStartTour={() => setShowTour(true)}
          onOpenCommandPalette={() => setShowCommandPalette(true)}
        />
        <div className="content">
          <Suspense fallback={<p role="status" style={{ color: 'var(--muted)' }}>Loading…</p>}>
          {sessionState.status === 'signed_out' && <SignIn reason={sessionState.reason} />}
          {sessionState.status === 'signed_in' && (currentScreen === 'work' || currentScreen === 'inbox' || currentScreen === 'review') && (
            <WorkScreen
              initialTaskId={selectedTask?.id}
              onNavigateToClients={() => handleNavigate('clients')}
              onNavigateToSettings={() => handleNavigate('settings')}
              onNewTask={handleOpenModal}
            />
          )}
          {sessionState.status === 'signed_in' && (currentScreen === 'clients' || currentScreen === 'dna' || currentScreen === 'library') && (
            <ClientsScreen initialView={currentScreen === 'library' ? 'library' : 'dna'} />
          )}
          {sessionState.status === 'signed_in' && currentScreen === 'settings' && <SettingsScreen />}
          {sessionState.status === 'signed_in' && currentScreen === 'ops' && <OpsScreen />}
          {sessionState.status === 'signed_in' && currentScreen === 'eval' && <EvalScreen />}
          {sessionState.status === 'signed_in' && currentScreen === 'comparison' && <ComparisonScreen />}
          </Suspense>
        </div>
      </main>

      {/* New Task Modal */}
      {showNewTaskModal && (
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewTaskModal(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            ref={modalRef}
            className="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-task-title"
            style={{
              width: 540,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 id="new-task-title" style={{ marginTop: 0, marginBottom: 4 }}>{t.modal.title}</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0 }}>
                  {t.modal.subtitle}
                </p>
              </div>
              <span
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 12,
                  background: 'rgba(56, 189, 248, 0.1)',
                  color: '#38BDF8',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                }}
                title="Draft autosaves continuously to IndexedDB / local storage"
              >
                Local browser draft
              </span>
            </div>

            {/* Client / Workspace Selector */}
            <div style={{ margin: '14px 0' }}>
              <label htmlFor="modal-client-select" style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                {t.modal.clientLabel}
              </label>
              <select
                id="modal-client-select"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--text)' }}
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
              >
                {availableClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ margin: '14px 0' }}>
              <label htmlFor="modal-task-title" style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                {t.modal.taskTitleLabel}
              </label>
              <input
                id="modal-task-title"
                ref={taskTitleInputRef}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskTitlePlaceholder}
                value={taskTitle}
                onChange={(e) => handleTitleChange(e.target.value)}
              />
            </div>

            {/* Design Instructions / Direction */}
            <div style={{ margin: '14px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label htmlFor="modal-design-instructions" style={{ fontWeight: 650, fontSize: 13 }}>
                  Design Instructions &amp; Creative Direction
                </label>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Style &amp; Layout Constraints</span>
              </div>
              <textarea
                id="modal-design-instructions"
                style={{ width: '100%', height: 60, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder="e.g. Minimalist layout, emerald botanical palette, elegant Kurdish typography, formal institutional tone..."
                value={taskDesignInstructions}
                onChange={(e) => setTaskDesignInstructions(e.target.value)}
              />
            </div>

            {/* Reference Brand Assets */}
            <div style={{ margin: '14px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label htmlFor="modal-reference-assets" style={{ fontWeight: 650, fontSize: 13 }}>
                  Reference Brand Assets
                </label>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Authorized Assets</span>
              </div>
              <input
                id="modal-reference-assets"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder="e.g. logo_primary, product_packshot, certification_seal"
                value={taskReferenceAssets}
                onChange={(e) => setTaskReferenceAssets(e.target.value)}
              />
            </div>

            {/* Primary Copy (English) */}
            <div style={{ margin: '14px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontWeight: 650, fontSize: 13 }}>
                  {t.modal.taskCopyEnLabel}
                </label>
                <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 600 }}>Primary · LTR</span>
              </div>
              <textarea
                dir="ltr"
                lang="en"
                style={{ width: '100%', height: 65, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskCopyEnPlaceholder}
                value={taskCopyEn}
                onChange={(e) => handleCopyEnChange(e.target.value)}
              />
            </div>

            {/* Secondary Copy (Kurdish Sorani) */}
            <div style={{ margin: '14px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontWeight: 650, fontSize: 13 }}>
                  {t.modal.taskCopyCkbLabel}
                </label>
                <span style={{ fontSize: 11, color: '#eab308', fontWeight: 600 }}>Secondary · RTL</span>
              </div>
              <textarea
                dir="rtl"
                lang="ckb"
                style={{ width: '100%', height: 65, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskCopyCkbPlaceholder}
                value={taskCopyCkb}
                onChange={(e) => setTaskCopyCkb(e.target.value)}
              />
              <small style={{ color: 'var(--muted)', display: 'block', marginTop: 4 }}>
                Your submitted copy is saved unchanged. Compare it with the Canva export before approving any design.
              </small>
            </div>

            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Save your instructions and exact copy, then create or link a Canva design for manual editing. Automatic composition is not connected.</p>
            {taskSubmissionError && <p role="alert" style={{ color: '#f87171' }}>{taskSubmissionError}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" disabled={isSubmitting} onClick={() => setShowNewTaskModal(false)}>
                {t.modal.cancel}
              </button>
              <button className="btn primary" disabled={isSubmitting} onClick={handleCreateTask}>
                {isSubmitting ? 'Saving request…' : 'Save request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Application Toast */}
      {appToast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            background: '#0f172a',
            color: '#ffffff',
            padding: '12px 20px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>{appToast}</span>
        </div>
      )}

      {/* Guided 60-Second Operator Onboarding Tour */}
      <GuidedTour
        isOpen={showTour}
        onClose={() => setShowTour(false)}
        onNavigateScreen={(s) => handleNavigate(s as ScreenId)}
      />

      {/* Raycast-Grade Global Command Palette (Cmd+K) */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onNavigate={(screen) => handleNavigate(screen)}
        activeClientId={selectedTask?.clientId || 'client-drustee'}
        onAction={(actionId) => {
          if (actionId === 'tour') {
            setShowTour(true);
          } else if (actionId === 'new_task') {
            handleOpenModal();
          }
        }}
      />
    </div>
  );
};
