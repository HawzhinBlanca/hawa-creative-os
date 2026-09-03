import React, { useState } from 'react';
import { Sidebar, type ScreenId } from './components/Sidebar.js';
import { Header } from './components/Header.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { ReviewScreen } from './screens/ReviewScreen.js';
import { DnaScreen } from './screens/DnaScreen.js';
import { LibraryScreen } from './screens/LibraryScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { OpsScreen } from './screens/OpsScreen.js';
import { EvalScreen } from './screens/EvalScreen.js';

export const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<ScreenId>('inbox');
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskCopy, setTaskCopy] = useState('');

  const handleCreateTask = () => {
    if (!taskTitle) return;
    setShowNewTaskModal(false);
    setTaskTitle('');
    setTaskCopy('');
    setCurrentScreen('inbox');
  };

  return (
    <div className="shell">
      <Sidebar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      <main className="main">
        <Header currentScreen={currentScreen} onNewTask={() => setShowNewTaskModal(true)} />
        <div className="content">
          {currentScreen === 'inbox' && <InboxScreen onSelectReview={() => setCurrentScreen('review')} />}
          {currentScreen === 'review' && <ReviewScreen />}
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
            <h2 style={{ marginTop: 0 }}>Create Task in Hawa Desk</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -4 }}>
              Canonical office intake with client scope lock and exact copy preservation.
            </p>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                Task Title
              </label>
              <input
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                placeholder="e.g. Summer Campaign Poster"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
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
                onChange={(e) => setTaskCopy(e.target.value)}
              />
              <small style={{ color: 'var(--muted)', display: 'block', marginTop: 4 }}>
                Exact copy blocks will be locked and cannot be rewritten by creative models.
              </small>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" onClick={() => setShowNewTaskModal(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={handleCreateTask}>
                Submit to Ingress
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
