import React, { useState, useEffect } from 'react';
import type { ScreenId } from './Sidebar.js';
import { eventStream, type StreamConnectionStatus } from '../services/eventStream.js';
import { useI18n } from '../services/i18n.js';

interface HeaderProps {
  currentScreen: ScreenId;
  onNewTask: () => void;
  onStartTour?: () => void;
  onOpenCommandPalette?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ currentScreen, onNewTask, onStartTour, onOpenCommandPalette }) => {
  const { locale, t, toggleLocale } = useI18n();
  const [streamStatus, setStreamStatus] = useState<StreamConnectionStatus>(eventStream.getStatus());
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const unsub = eventStream.onStatusChange(setStreamStatus);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsub();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const badgeColor = !isOnline ? '#f97316' : streamStatus === 'connected' ? '#22c55e' : '#eab308';
  const badgeBg = !isOnline ? 'rgba(249, 115, 22, 0.12)' : streamStatus === 'connected' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(234, 179, 8, 0.12)';
  const badgeBorder = !isOnline ? 'rgba(249, 115, 22, 0.3)' : streamStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(234, 179, 8, 0.3)';
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
            background: locale === 'en' ? 'rgba(56, 189, 248, 0.1)' : 'rgba(234, 179, 8, 0.12)',
            color: locale === 'en' ? '#38bdf8' : '#eab308',
            border: `1px solid ${locale === 'en' ? 'rgba(56, 189, 248, 0.25)' : 'rgba(234, 179, 8, 0.3)'}`,
            borderRadius: 8,
            cursor: 'pointer',
          }}
          title={locale === 'en' ? 'Primary: English. Click to switch to Secondary: کوردی سۆرانی' : 'Secondary: کوردی. کلیک بکە بۆ گۆڕین بۆ سەرەکی: English'}
        >
          <span>{locale === 'en' ? '🇬🇧 English (Primary)' : '☀️ کوردی (Secondary)'}</span>
          <span style={{ opacity: 0.6, fontSize: 11 }}>⇄</span>
          <span style={{ fontSize: 11, opacity: 0.85 }}>{locale === 'en' ? 'کوردی' : 'EN'}</span>
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
              background: 'rgba(16, 185, 129, 0.1)',
              color: '#10B981',
              border: '1px solid rgba(16, 185, 129, 0.25)',
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

