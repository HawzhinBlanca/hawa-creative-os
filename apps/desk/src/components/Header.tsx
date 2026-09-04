import React, { useState, useEffect } from 'react';
import type { ScreenId } from './Sidebar.js';
import { eventStream, type StreamConnectionStatus } from '../services/eventStream.js';

interface HeaderProps {
  currentScreen: ScreenId;
  onNewTask: () => void;
}

const titles: Record<ScreenId, string> = {
  inbox: 'Inbox & Production Board',
  review: 'Task Review & Approval',
  dna: 'Client DNA & Brand Governance',
  library: 'Creative Library & Retrieval Evidence',
  settings: 'Adapters & Model Registry',
  ops: 'Actionable Operations & Health',
  eval: 'Model Evaluations & Canary Tournaments',
};

export const Header: React.FC<HeaderProps> = ({ currentScreen, onNewTask }) => {
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
  const badgeText = !isOnline ? 'Offline (PWA Cache)' : streamStatus === 'connected' ? 'Live Stream' : 'Connecting…';

  return (
    <header className="top">
      <h1>{titles[currentScreen]}</h1>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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

        <input
          className="search"
          aria-label="Search"
          placeholder="Search tasks, clients, copy, hashes…"
        />
        <button className="btn primary" onClick={onNewTask}>
          + New task
        </button>
      </div>
    </header>
  );
};
