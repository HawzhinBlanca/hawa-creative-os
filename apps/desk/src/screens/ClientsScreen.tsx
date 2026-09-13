import React, { useState } from 'react';
import { DnaScreen } from './DnaScreen.js';
import { LibraryScreen } from './LibraryScreen.js';

interface ClientsScreenProps {
  initialView?: 'dna' | 'library';
}

export const ClientsScreen: React.FC<ClientsScreenProps> = ({ initialView = 'dna' }) => {
  const [subView, setSubView] = useState<'dna' | 'library'>(initialView);

  return (
    <div className="clients-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-navigation bar between Brand DNA and Asset Library */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          background: 'var(--panel)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', gap: 6 }} role="tablist" aria-label="Clients Sub Navigation">
          <button
            role="tab"
            aria-selected={subView === 'dna'}
            className={`btn btn-sm ${subView === 'dna' ? 'primary' : ''}`}
            onClick={() => setSubView('dna')}
          >
            🧬 Client DNA & Brand Tokens
          </button>
          <button
            role="tab"
            aria-selected={subView === 'library'}
            className={`btn btn-sm ${subView === 'library' ? 'primary' : ''}`}
            onClick={() => setSubView('library')}
          >
            📁 Canva Design Library
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {subView === 'dna'
            ? 'Client brand rules and references'
            : 'Templates, uploads and editing in Canva'}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {subView === 'dna' ? <DnaScreen /> : <LibraryScreen />}
      </div>
    </div>
  );
};
