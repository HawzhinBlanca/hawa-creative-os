import React, { useState, useEffect } from 'react';
import { Sidebar, type ScreenId } from './components/Sidebar.js';
import { Header } from './components/Header.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { ReviewScreen } from './screens/ReviewScreen.js';
import { DnaScreen } from './screens/DnaScreen.js';
import { LibraryScreen } from './screens/LibraryScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { OpsScreen } from './screens/OpsScreen.js';
import { EvalScreen } from './screens/EvalScreen.js';
import { GuidedTour } from './components/GuidedTour.js';
import { draftStore } from './services/draftStore.js';
import { useI18n } from './services/i18n.js';

export const App: React.FC = () => {
  const { t, isRtl } = useI18n();

  const getInitialScreen = (): ScreenId => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
      if (hash === 'adapters') return 'settings';
      const validScreens: ScreenId[] = ['inbox', 'review', 'dna', 'library', 'settings', 'ops', 'eval'];
      if (validScreens.includes(hash as ScreenId)) return hash as ScreenId;
      const path = window.location.pathname.replace(/^\//, '').split('/')[0];
      if (path === 'adapters') return 'settings';
      if (validScreens.includes(path as ScreenId)) return path as ScreenId;
    }
    return 'inbox';
  };

  const [currentScreen, setCurrentScreen] = useState<ScreenId>(getInitialScreen);
  const [appToast, setAppToast] = useState<string | null>(null);
  const [showTour, setShowTour] = useState<boolean>(false);

  // Global Keyboard Shortcuts (1 - 7 screen navigation)
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
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
        '1': 'inbox',
        '2': 'review',
        '3': 'dna',
        '4': 'library',
        '5': 'settings',
        '6': 'ops',
        '7': 'eval',
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
      const validScreens: ScreenId[] = ['inbox', 'review', 'dna', 'library', 'settings', 'ops', 'eval'];
      if (validScreens.includes(hash as ScreenId)) {
        setCurrentScreen(hash as ScreenId);
      }
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Restore draft when opening modal
  const handleOpenModal = () => {
    const existingDraft = draftStore.getActiveDraft();
    if (existingDraft && !taskTitle && !taskCopyEn) {
      setTaskTitle(existingDraft.title || '');
      setTaskCopyEn(existingDraft.copy || '');
    }
    setShowNewTaskModal(true);
  };

  // Autosave active draft
  const handleTitleChange = (val: string) => {
    setTaskTitle(val);
    draftStore.saveActiveDraft({ title: val, copy: taskCopyEn });
  };

  const handleCopyEnChange = (val: string) => {
    setTaskCopyEn(val);
    draftStore.saveActiveDraft({ title: taskTitle, copy: val });
  };

  // Auto-flush queued offline tasks upon reconnection
  useEffect(() => {
    const handleOnlineFlush = async () => {
      const result = await draftStore.flushQueuedTasks();
      if (result.success > 0) {
        setRefreshTrigger((k) => k + 1);
      }
    };

    window.addEventListener('online', handleOnlineFlush);
    return () => window.removeEventListener('online', handleOnlineFlush);
  }, []);

  const handleCreateTask = async () => {
    if (!taskTitle) return;
    setIsSubmitting(true);

    const fullDescription = [taskCopyEn, taskCopyCkb].filter(Boolean).join(' | ');

    // Check if offline: queue locally in IndexedDB
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      draftStore.enqueueTask({ title: taskTitle, copy: fullDescription });
      draftStore.clearActiveDraft();
      setShowNewTaskModal(false);
      setTaskTitle('');
      setTaskCopyEn('');
      setTaskCopyCkb('');
      setIsSubmitting(false);
      setAppToast('✓ Offline Mode: Task brief queued in local IndexedDB. It will submit automatically upon reconnecting.');
      setTimeout(() => setAppToast(null), 5000);
      return;
    }

    try {
      const idempotencyKey = `task-desk-${Date.now()}`;
      const res = await fetch('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          clientId: 'client-office-1',
          title: taskTitle,
          priority: 'routine',
          description: fullDescription || 'Summer Campaign Poster',
          source: { platform: 'hawa_desk', externalId: 'operator-desk' },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const taskId = data.id;

        // Auto-route and create brief (English primary, Kurdish secondary)
        await fetch(`/v1/tasks/${taskId}/route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskRoute: 'standard_generation' }),
        }).catch(() => {});

        const exactCopyBlocks: any[] = [];
        if (taskCopyEn) {
          exactCopyBlocks.push({
            role: 'headline',
            text: taskCopyEn,
            language: 'en',
            direction: 'ltr',
            approved: true,
          });
        }
        if (taskCopyCkb) {
          exactCopyBlocks.push({
            role: taskCopyEn ? 'subheadline' : 'headline',
            text: taskCopyCkb,
            language: 'ckb',
            direction: 'rtl',
            approved: true,
          });
        }

        await fetch(`/v1/tasks/${taskId}/briefs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objective: taskTitle,
            taskRoute: 'standard_generation',
            primaryLanguage: taskCopyEn ? 'en' : 'ckb',
            direction: taskCopyEn ? 'ltr' : 'rtl',
            variants: [{ width: 1080, height: 1350, role: 'feed_post' }],
            exactCopy: exactCopyBlocks,
            requiredAssetRoles: ['logo_primary'],
          }),
        }).catch(() => {});

        // Trigger creative generation
        await fetch(`/v1/tasks/${taskId}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});

        draftStore.clearActiveDraft();
        setSelectedTask(data);
        setRefreshTrigger((k) => k + 1);
        setShowNewTaskModal(false);
        setTaskTitle('');
        setTaskCopyEn('');
        setTaskCopyCkb('');
        handleNavigate('review');
      } else {
        setShowNewTaskModal(false);
        handleNavigate('inbox');
      }
    } catch {
      // Network failure: queue offline
      draftStore.enqueueTask({ title: taskTitle, copy: fullDescription });
      draftStore.clearActiveDraft();
      setShowNewTaskModal(false);
      setTaskTitle('');
      setTaskCopyEn('');
      setTaskCopyCkb('');
      handleNavigate('inbox');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={`shell ${isRtl ? 'rtl' : 'ltr'}`}>
      <Sidebar currentScreen={currentScreen} onNavigate={handleNavigate} />
      <main className="main">
        <Header currentScreen={currentScreen} onNewTask={handleOpenModal} onStartTour={() => setShowTour(true)} />
        <div className="content">
          {currentScreen === 'inbox' && (
            <InboxScreen
              refreshTrigger={refreshTrigger}
              onSelectReview={(task) => {
                if (task) setSelectedTask(task);
                handleNavigate('review');
              }}
            />
          )}
          {currentScreen === 'review' && <ReviewScreen task={selectedTask} />}
          {currentScreen === 'dna' && <DnaScreen />}
          {currentScreen === 'library' && <LibraryScreen />}
          {currentScreen === 'settings' && <SettingsScreen />}
          {currentScreen === 'ops' && <OpsScreen />}
          {currentScreen === 'eval' && <EvalScreen />}
        </div>
      </main>

      {/* New Task Modal */}
      {showNewTaskModal && (
        <div
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
            className="panel"
            style={{
              width: 540,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginTop: 0, marginBottom: 4 }}>{t.modal.title}</h2>
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
                {t.modal.autosaved}
              </span>
            </div>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                {t.modal.taskTitleLabel}
              </label>
              <input
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskTitlePlaceholder}
                value={taskTitle}
                onChange={(e) => handleTitleChange(e.target.value)}
              />
            </div>

            {/* Primary Copy (English) */}
            <div style={{ margin: '16px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontWeight: 650, fontSize: 13 }}>
                  {t.modal.taskCopyEnLabel}
                </label>
                <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 600 }}>Primary · LTR</span>
              </div>
              <textarea
                dir="ltr"
                lang="en"
                style={{ width: '100%', height: 75, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskCopyEnPlaceholder}
                value={taskCopyEn}
                onChange={(e) => handleCopyEnChange(e.target.value)}
              />
            </div>

            {/* Secondary Copy (Kurdish Sorani) */}
            <div style={{ margin: '16px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontWeight: 650, fontSize: 13 }}>
                  {t.modal.taskCopyCkbLabel}
                </label>
                <span style={{ fontSize: 11, color: '#eab308', fontWeight: 600 }}>Secondary · RTL</span>
              </div>
              <textarea
                dir="rtl"
                lang="ckb"
                style={{ width: '100%', height: 75, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder={t.modal.taskCopyCkbPlaceholder}
                value={taskCopyCkb}
                onChange={(e) => setTaskCopyCkb(e.target.value)}
              />
              <small style={{ color: 'var(--muted)', display: 'block', marginTop: 4 }}>
                {t.modal.copyLockNotice}
              </small>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" disabled={isSubmitting} onClick={() => setShowNewTaskModal(false)}>
                {t.modal.cancel}
              </button>
              <button className="btn primary" disabled={isSubmitting} onClick={handleCreateTask}>
                {isSubmitting ? t.modal.submitting : t.modal.submit}
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
    </div>
  );
};

