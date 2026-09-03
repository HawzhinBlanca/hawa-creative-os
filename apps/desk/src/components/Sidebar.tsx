import React from 'react';

export type ScreenId = 'inbox' | 'review' | 'dna' | 'library' | 'settings' | 'ops' | 'eval';

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentScreen, onNavigate }) => {
  return (
    <aside className="side">
      <div className="brand">
        <strong>Hawa Desk</strong>
        <small>Private Creative OS</small>
      </div>

      <nav className="nav">
        <button
          className={currentScreen === 'inbox' ? 'active' : ''}
          onClick={() => onNavigate('inbox')}
        >
          Inbox
        </button>
        <button
          className={currentScreen === 'review' ? 'active' : ''}
          onClick={() => onNavigate('review')}
        >
          Task review
        </button>
        <button
          className={currentScreen === 'dna' ? 'active' : ''}
          onClick={() => onNavigate('dna')}
        >
          Client DNA
        </button>
        <button
          className={currentScreen === 'library' ? 'active' : ''}
          onClick={() => onNavigate('library')}
        >
          Library
        </button>
        <button
          className={currentScreen === 'settings' ? 'active' : ''}
          onClick={() => onNavigate('settings')}
        >
          Settings
        </button>
        <button
          className={currentScreen === 'ops' ? 'active' : ''}
          onClick={() => onNavigate('ops')}
        >
          Operations
        </button>
        <button
          className={currentScreen === 'eval' ? 'active' : ''}
          onClick={() => onNavigate('eval')}
        >
          Evaluations
        </button>
      </nav>

      <div className="health">
        <div>
          <span className="dot"></span>
          <b>Core healthy</b>
        </div>
        <small style={{ display: 'block', marginTop: 4 }}>
          Telegram active · Desk canonical · WAHA quarantined
        </small>
      </div>
    </aside>
  );
};
