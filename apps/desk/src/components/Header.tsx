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

  useEffect(() => {
    return eventStream.onStatusChange(setStreamStatus);
  }, []);

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
            background: streamStatus === 'connected' ? 'rgba(34, 197, 94, 0.12)' : streamStatus === 'connecting' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${streamStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' : streamStatus === 'connecting' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            color: streamStatus === 'connected' ? '#22c55e' : streamStatus === 'connecting' ? '#eab308' : '#ef4444',
            fontWeight: 500,
          }}
          title={`Real-time SSE event stream: ${streamStatus}`}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: streamStatus === 'connected' ? '#22c55e' : streamStatus === 'connecting' ? '#eab308' : '#ef4444',
              boxShadow: streamStatus === 'connected' ? '0 0 6px #22c55e' : 'none',
              display: 'inline-block',
            }}
          />
          <span>{streamStatus === 'connected' ? 'Live Stream' : streamStatus === 'connecting' ? 'Connecting…' : 'Offline'}</span>
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
