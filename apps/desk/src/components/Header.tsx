import React from 'react';
import type { ScreenId } from './Sidebar.js';

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
  return (
    <header className="top">
      <h1>{titles[currentScreen]}</h1>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
