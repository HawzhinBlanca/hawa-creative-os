import React, { useState, useEffect, useRef } from 'react';
import type { ScreenId } from './Sidebar.js';
import { getAuthHeaders } from '../services/auth.js';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (screen: ScreenId) => void;
  activeClientId?: string;
  onAction?: (actionId: string) => void;
}

interface SearchItem {
  id: string;
  category: 'Actions' | 'Navigation' | 'Tasks' | 'Clients' | 'Templates';
  title: string;
  subtitle: string;
  url?: string;
  badge?: string;
  actionId?: string;
  screen?: ScreenId;
  /** Found, but shown on no Desk page (Core answers url: null): listed, and selecting it opens nothing. */
  unlinked?: boolean;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigate,
  activeClientId,
  onAction,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Static Local Items for instant sub-millisecond response
  const baseItems: SearchItem[] = [
    // Quick Actions. "Export 4-in-1 Campaign" and "Synthesize Sandboxed Vector Backdrop" were
    // removed (2026-09-24): no handler existed for either, so choosing one only switched screens.
    {
      id: 'act-tour',
      category: 'Actions',
      title: 'Start Interactive Guided Tour',
      subtitle: 'Walk through 7 key features of Hawa Creative OS',
      badge: 'Help',
      actionId: 'start_tour',
    },
    {
      id: 'act-kurdish',
      category: 'Actions',
      title: 'Toggle Kurdish Sorani (کوردی سۆرانی)',
      subtitle: 'Switch between English (LTR) and Kurdish Sorani (RTL) localization',
      badge: 'Language',
      actionId: 'toggle_language',
    },

    // Primary Navigation (CV-17)
    {
      id: 'nav-work',
      category: 'Navigation',
      title: 'Work Desk (Creative Queue & Canva Detail)',
      subtitle: 'Actionable queue, Canva Studio handoff, captured preview, and verified delivery',
      badge: 'Work',
      screen: 'work',
    },
    {
      id: 'nav-clients',
      category: 'Navigation',
      title: 'Clients & Brand DNA',
      subtitle: 'Client DNA profiles, guidelines, tokens, and verified asset library',
      badge: 'Clients',
      screen: 'clients',
    },
    {
      id: 'nav-settings',
      category: 'Navigation',
      title: 'Settings & Adapters',
      subtitle: 'Channel bridges (Telegram, WhatsApp), honest health probes, and audit logs',
      badge: 'Settings',
      screen: 'settings',
    },
    {
      id: 'nav-review',
      category: 'Navigation',
      title: 'Work Detail & Canva Review',
      subtitle: 'Task detail view, Canva design link, and release authorization',
      badge: 'Detail',
      screen: 'work',
    },
    {
      id: 'nav-inbox',
      category: 'Navigation',
      title: 'Work Queue & Intake',
      subtitle: 'Multi-channel message intake, Telegram/WhatsApp bridge, and task promotion',
      badge: 'Queue',
      screen: 'work',
    },
    {
      id: 'nav-dna',
      category: 'Navigation',
      title: 'Client DNA & Brand Governance',
      subtitle: 'Brand kits, Kurdish font inspector, and governed rule proposals',
      badge: 'Screen 3',
      screen: 'dna',
    },
    {
      id: 'nav-ops',
      category: 'Navigation',
      title: 'Operations & AI Cost Budgets',
      subtitle: 'Token/GPU expenditure tracking, system health, and reconciliation',
      badge: 'Screen 6',
      screen: 'ops',
    },
    {
      id: 'nav-eval',
      category: 'Navigation',
      title: 'AI Model Gateway & Tournaments',
      subtitle: 'Canary evaluations, provider circuit-breakers, and prompt safety',
      badge: 'Screen 7',
      screen: 'eval',
    },
    {
      id: 'nav-library',
      category: 'Navigation',
      title: 'Certified Brand Asset Library',
      subtitle: 'Gold trust seals, Kurdish star motifs, and client wordmarks',
      badge: 'Screen 4',
      screen: 'library',
    },

  ];

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Search logic: combines instant local filtering with API search
  useEffect(() => {
    setIsLoading(false);
    setSearchError(null);
    setSearchNotice(null);
    if (!isOpen) return;

    const trimmed = query.trim().toLowerCase();

    // 1. Filter local base items
    const localMatches = baseItems.filter((item) => {
      if (!trimmed) return true;
      return (
        item.title.toLowerCase().includes(trimmed) ||
        item.subtitle.toLowerCase().includes(trimmed) ||
        item.category.toLowerCase().includes(trimmed) ||
        item.badge?.toLowerCase().includes(trimmed)
      );
    });

    setResults(localMatches);
    setSelectedIndex(0);

    // No guessed scope: remote results require an actual selected client.
    if (!activeClientId || !trimmed) return;
    const controller = new AbortController();
    let current = true;

    // 2. Fetch server items if query provided (tasks, client DNA)
    const timer = setTimeout(async () => {
      try {
        setIsLoading(true);
        const url = `/v1/search?q=${encodeURIComponent(trimmed)}&clientId=${encodeURIComponent(activeClientId)}`;
        const res = await fetch(url, { headers: getAuthHeaders(), signal: controller.signal });
        if (!res.ok) throw new Error('Search failed');
        {
          const data = await res.json();
          if (!current) return;
          if (!Array.isArray(data.results)) throw new Error('Invalid search response');
          {
            // Merge remote items, deduplicating IDs
            const seenIds = new Set(localMatches.map((i) => i.id));
            const merged: SearchItem[] = [...localMatches];

            for (const r of data.results) {
              if (!seenIds.has(r.id)) {
                const unlinked = r.url === null;
                merged.push({
                  id: r.id,
                  category: r.category as any,
                  title: r.title,
                  subtitle: unlinked ? `${r.subtitle ?? ''} · Not shown on a Desk page` : r.subtitle,
                  url: typeof r.url === 'string' ? r.url : undefined,
                  badge: r.badge,
                  ...(unlinked ? { unlinked } : {}),
                });
                seenIds.add(r.id);
              }
            }
            setResults(merged);
            // Core read the newest tasks only (its ceiling); older matches may be missing.
            if (data.truncated === true) setSearchNotice('Only the newest tasks were searched; an older task may be missing. Search for more specific words.');
          }
        }
      } catch {
        if (current) setSearchError('Client search could not load. Check your connection and search again.');
      } finally {
        if (current) setIsLoading(false);
      }
    }, 150);

    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [query, isOpen, activeClientId]);

  // Keyboard navigation inside palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (results.length > 0 ? (prev - 1 + results.length) % results.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[selectedIndex]) {
          executeItem(results[selectedIndex]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, results, selectedIndex]);

  // Ensure selected item is scrolled into view
  useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  const executeItem = (item: SearchItem) => {
    if (item.unlinked) return;
    onClose();

    if (item.actionId && onAction) {
      onAction(item.actionId);
    }

    if (item.screen) {
      onNavigate(item.screen);
    } else if (item.url) {
      window.location.hash = item.url;
    }
  };

  if (!isOpen) return null;

  return (
    <div
      id="command-palette-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(3, 7, 18, 0.75)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        id="command-palette-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 640,
          background: 'rgba(17, 24, 39, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 14,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          color: '#f3f4f6',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        {/* Search Header Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '14px 18px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            gap: 12,
            background: 'rgba(31, 41, 55, 0.4)',
          }}
        >
          <span style={{ fontSize: 18, opacity: 0.6 }}>🔍</span>
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search commands and selected client"
            placeholder="Search commands or this client… (⌘K)"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#ffffff',
              fontSize: 16,
              fontWeight: 500,
            }}
          />

          {/* Scope Indicator Badge (Invariant #4) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {isLoading && (
              <span style={{ fontSize: 11, color: '#38bdf8', opacity: 0.8 }}>Searching…</span>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                fontWeight: 600,
                padding: '4px 8px',
                borderRadius: 6,
                background: 'rgba(56, 189, 248, 0.12)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                letterSpacing: '0.02em',
              }}
              title="Client search is limited to the selected task’s client"
            >
              <span>🔒</span>
              <span>{activeClientId ? 'Selected client' : 'Commands'}</span>
            </div>
          </div>
        </div>

        {!activeClientId && <p style={{ padding: '0 18px', color: '#9ca3af', fontSize: 12 }}>Select a task in Work to search its client.</p>}
        {searchError && <p role="alert" style={{ padding: '0 18px', color: '#fca5a5' }}>{searchError}</p>}
        {searchNotice && <p role="status" style={{ padding: '0 18px', color: '#fcd34d' }}>{searchNotice}</p>}
        {/* Results List */}
        <div
          ref={listRef}
          id="command-palette-results"
          style={{
            maxHeight: 380,
            overflowY: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {results.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
              No matching commands or client entities found.
            </div>
          ) : (
            results.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  id={`cmd-item-${item.id}`}
                  onClick={() => executeItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderRadius: 8,
                    cursor: item.unlinked ? 'default' : 'pointer',
                    background: isSelected ? 'rgba(56, 189, 248, 0.14)' : 'transparent',
                    border: isSelected ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                    transition: 'background 0.1s ease',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color:
                            item.category === 'Actions'
                              ? '#ec4899'
                              : item.category === 'Navigation'
                              ? '#3b82f6'
                              : item.category === 'Templates'
                              ? '#f59e0b'
                              : '#10b981',
                        }}
                      >
                        {item.category}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#f9fafb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.title}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.subtitle}
                    </span>
                  </div>

                  {item.badge && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 7px',
                        borderRadius: 4,
                        background: 'rgba(255, 255, 255, 0.08)',
                        color: '#d1d5db',
                        fontWeight: 500,
                        marginLeft: 12,
                        flexShrink: 0,
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer Shortcut Bar */}
        <div
          style={{
            padding: '8px 16px',
            background: 'rgba(15, 23, 42, 0.7)',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: '#6b7280',
          }}
        >
          <div style={{ display: 'flex', gap: 14 }}>
            <span>
              <kbd style={{ background: 'rgba(255, 255, 255, 0.1)', padding: '1px 5px', borderRadius: 4, color: '#d1d5db' }}>↑↓</kbd> Navigate
            </span>
            <span>
              <kbd style={{ background: 'rgba(255, 255, 255, 0.1)', padding: '1px 5px', borderRadius: 4, color: '#d1d5db' }}>↵</kbd> Select
            </span>
            <span>
              <kbd style={{ background: 'rgba(255, 255, 255, 0.1)', padding: '1px 5px', borderRadius: 4, color: '#d1d5db' }}>ESC</kbd> Close
            </span>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#22c55e' }}>●</span> Raycast Engine • Invariant #4 Scope Locked
          </span>
        </div>
      </div>
    </div>
  );
};
