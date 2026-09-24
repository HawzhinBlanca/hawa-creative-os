import React, { useState, useEffect } from 'react';
import type { ScreenId } from './Sidebar.js';
import { useI18n } from '../services/i18n.js';
import { useDesk } from '../DeskProviders.js';
import { useStreamStatus } from '../services/liveUpdates.js';

interface HeaderProps {
  currentScreen: ScreenId;
  onNewTask: () => void;
  onStartTour?: () => void;
  onOpenCommandPalette?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ currentScreen, onNewTask, onStartTour, onOpenCommandPalette }) => {
  const { locale, t, toggleLocale } = useI18n();
  // The tab's one event stream (ADR-037).
  const streamStatus = useStreamStatus(useDesk().stream);
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const badgeColor = !isOnline ? '#9a3412' : streamStatus === 'connected' ? '#166534' : '#854d0e';
  const badgeBg = !isOnline ? 'rgba(154, 52, 18, 0.08)' : streamStatus === 'connected' ? 'rgba(22, 101, 52, 0.08)' : 'rgba(133, 77, 14, 0.08)';
  const badgeBorder = !isOnline ? 'rgba(154, 52, 18, 0.3)' : streamStatus === 'connected' ? 'rgba(22, 101, 52, 0.3)' : 'rgba(133, 77, 14, 0.3)';
  const badgeText = !isOnline ? t.header.offlineCache : streamStatus === 'connected' ? t.header.liveStream : t.header.connecting;

  return (
    <header className="top">
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t.screens[currentScreen]}</h1>
        <small style={{ color: 'var(--muted)', fontSize: 12 }}>{t.screenSubtitles[currentScreen]}</small>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {/* Language Selector Toggle */}
        <button
          id="lang-toggle-btn"
          onClick={toggleLocale}
          className="btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            padding: '5px 11px',
            background: locale === 'en' ? 'rgba(2, 132, 199, 0.1)' : 'rgba(180, 83, 9, 0.12)',
            color: locale === 'en' ? '#0369a1' : '#b45309',
            border: `1px solid ${locale === 'en' ? 'rgba(2, 132, 199, 0.35)' : 'rgba(180, 83, 9, 0.35)'}`,
            borderRadius: 8,
            cursor: 'pointer',
          }}
          title={locale === 'en' ? 'Primary: English. Click to switch to Secondary: کوردی سۆرانی' : 'Secondary: کوردی. کلیک بکە بۆ گۆڕین بۆ سەرەکی: English'}
        >
          <span>{locale === 'en' ? '🇬🇧 English (Primary)' : '☀️ کوردی (Secondary)'}</span>
          <span style={{ opacity: 0.8, fontSize: 11, fontWeight: 700 }}>⇄</span>
          <span style={{ fontSize: 11, fontWeight: 700 }}>{locale === 'en' ? 'کوردی' : 'EN'}</span>
        </button>

        {onStartTour && (
          <button
            id="tour-btn"
            onClick={onStartTour}
            className="btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              fontWeight: 600,
              padding: '5px 11px',
              background: 'rgba(4, 120, 87, 0.1)',
              color: '#047857',
              border: '1px solid rgba(4, 120, 87, 0.35)',
              borderRadius: 8,
              cursor: 'pointer',
            }}
            title="Start 60-Second Operator Onboarding Tour"
          >
            <span>🚀</span>
            <span>Tour</span>
          </button>
        )}

        <div
          id="sse-stream-indicator"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 20,
            background: badgeBg,
            border: `1px solid ${badgeBorder}`,
            color: badgeColor,
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
          title={!isOnline ? 'Offline PWA active: fonts and shell cached' : `Real-time SSE event stream: ${streamStatus}`}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: badgeColor,
              boxShadow: streamStatus === 'connected' && isOnline ? '0 0 6px #22c55e' : 'none',
              display: 'inline-block',
            }}
          />
          <span>{badgeText}</span>
        </div>

        <button
          id="omnisearch-btn"
          onClick={onOpenCommandPalette}
          className="btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            padding: '5px 12px',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            color: 'var(--muted)',
            cursor: 'pointer',
          }}
          title="Global Omnisearch (⌘K / Ctrl+K)"
        >
          <span>🔍</span>
          <span>{t.header.searchPlaceholder || 'Omnisearch...'}</span>
          <kbd
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: 4,
              padding: '1px 5px',
              fontSize: 10,
              fontFamily: 'monospace',
              color: 'var(--text)',
            }}
          >
            ⌘K
          </kbd>
        </button>
        <button className="btn primary" onClick={onNewTask}>
          {t.header.newTask}
        </button>
      </div>
    </header>
  );
};

