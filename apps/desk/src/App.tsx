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
import { draftStore } from './services/draftStore.js';

export const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<ScreenId>('inbox');
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskCopy, setTaskCopy] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Restore draft when opening modal
  const handleOpenModal = () => {
    const existingDraft = draftStore.getActiveDraft();
    if (existingDraft && !taskTitle && !taskCopy) {
      setTaskTitle(existingDraft.title || '');
      setTaskCopy(existingDraft.copy || '');
    }
    setShowNewTaskModal(true);
  };

  // Autosave active draft
  const handleTitleChange = (val: string) => {
    setTaskTitle(val);
    draftStore.saveActiveDraft({ title: val, copy: taskCopy });
  };

  const handleCopyChange = (val: string) => {
    setTaskCopy(val);
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

    // Check if offline: queue locally in IndexedDB
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      draftStore.enqueueTask({ title: taskTitle, copy: taskCopy });
      draftStore.clearActiveDraft();
      setShowNewTaskModal(false);
      setTaskTitle('');
      setTaskCopy('');
      setIsSubmitting(false);
      alert('Offline Mode: Task brief queued in local storage. It will submit automatically upon reconnecting.');
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
          description: taskCopy,
          source: { platform: 'hawa_desk', externalId: 'operator-desk' },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const taskId = data.id;

        // Auto-route and create brief
        await fetch(`/v1/tasks/${taskId}/route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskRoute: 'standard_generation' }),
        }).catch(() => {});

        await fetch(`/v1/tasks/${taskId}/briefs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objective: taskTitle,
            taskRoute: 'standard_generation',
            primaryLanguage: 'ckb',
            direction: 'rtl',
            variants: [{ width: 1080, height: 1350, role: 'feed_post' }],
            exactCopy: taskCopy ? [{ role: 'headline', text: taskCopy, language: 'ckb', direction: 'rtl', approved: true }] : [],
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
        setTaskCopy('');
        setCurrentScreen('review');
      } else {
        setShowNewTaskModal(false);
        setCurrentScreen('inbox');
      }
    } catch {
      // Network failure: queue offline
      draftStore.enqueueTask({ title: taskTitle, copy: taskCopy });
      draftStore.clearActiveDraft();
      setShowNewTaskModal(false);
      setTaskTitle('');
      setTaskCopy('');
      setCurrentScreen('inbox');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="shell">
      <Sidebar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      <main className="main">
        <Header currentScreen={currentScreen} onNewTask={handleOpenModal} />
        <div className="content">
          {currentScreen === 'inbox' && (
            <InboxScreen
              refreshTrigger={refreshTrigger}
              onSelectReview={(task) => {
                if (task) setSelectedTask(task);
                setCurrentScreen('review');
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
              width: 520,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginTop: 0, marginBottom: 4 }}>Create Task in Hawa Desk</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0 }}>
                  Canonical office intake with client scope lock and exact copy preservation.
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
                💾 Autosaved
              </span>
            </div>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                Task Title
              </label>
              <input
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder="e.g. Summer Campaign Poster"
                value={taskTitle}
                onChange={(e) => handleTitleChange(e.target.value)}
              />
            </div>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                Approved Copy (Kurdish Sorani or Arabic)
              </label>
              <textarea
                dir="rtl"
                lang="ckb"
                style={{ width: '100%', height: 90, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder="تێکستی پەسەندکراو بنووسە…"
                value={taskCopy}
                onChange={(e) => handleCopyChange(e.target.value)}
              />
              <small style={{ color: 'var(--muted)', display: 'block', marginTop: 4 }}>
                Exact copy blocks will be locked and cannot be rewritten by creative models.
              </small>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" disabled={isSubmitting} onClick={() => setShowNewTaskModal(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={isSubmitting} onClick={handleCreateTask}>
                {isSubmitting ? 'Submitting & Routing…' : 'Submit to Ingress'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
