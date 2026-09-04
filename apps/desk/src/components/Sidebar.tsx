import React from 'react';
import { useI18n } from '../services/i18n.js';

export type ScreenId = 'inbox' | 'review' | 'dna' | 'library' | 'settings' | 'ops' | 'eval';

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentScreen, onNavigate }) => {
  const { t } = useI18n();

  return (
    <aside className="side">
      <div className="brand">
        <strong>Hawa Desk</strong>
        <small>{t.sidebar.brandSubtitle}</small>
      </div>

      <nav className="nav">
        <button
          className={currentScreen === 'inbox' ? 'active' : ''}
          onClick={() => onNavigate('inbox')}
        >
          {t.screens.inbox.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'review' ? 'active' : ''}
          onClick={() => onNavigate('review')}
        >
          {t.screens.review.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'dna' ? 'active' : ''}
          onClick={() => onNavigate('dna')}
        >
          {t.screens.dna.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'library' ? 'active' : ''}
          onClick={() => onNavigate('library')}
        >
          {t.screens.library.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'settings' ? 'active' : ''}
          onClick={() => onNavigate('settings')}
        >
          {t.screens.settings.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'ops' ? 'active' : ''}
          onClick={() => onNavigate('ops')}
        >
          {t.screens.ops.split('&')[0].trim()}
        </button>
        <button
          className={currentScreen === 'eval' ? 'active' : ''}
          onClick={() => onNavigate('eval')}
        >
          {t.screens.eval.split('&')[0].trim()}
        </button>
      </nav>

      <div className="health">
        <div>
          <span className="dot"></span>
          <b>{t.sidebar.coreHealthy}</b>
        </div>
        <small style={{ display: 'block', marginTop: 4 }}>
          {t.sidebar.healthDetails}
        </small>
      </div>
    </aside>
  );
};

