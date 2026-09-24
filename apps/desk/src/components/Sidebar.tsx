import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../services/i18n.js';
import { queryKeys } from '../services/queryClient.js';

/** How often the health line is read while the tab is visible. */
const HEALTH_POLL_MS = 30_000;

interface HealthLine {
  status: 'ok' | 'degraded' | 'checking';
  label: string;
  details: string;
}

const CHECKING: HealthLine = { status: 'checking', label: 'Checking Core...', details: 'Checking API availability...' };

/** Reads Core's public health route; the answer is the line the sidebar shows. */
export async function probeHealth(): Promise<HealthLine> {
  try {
    const res = await fetch('/v1/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      await res.json();
      return { status: 'ok', label: 'Core Reachable', details: 'API responded · Canva and delivery require separate verification' };
    }
    return { status: 'degraded', label: 'Core Warning', details: `HTTP ${res.status} response from server` };
  } catch {
    return { status: 'degraded', label: 'Core Disconnected', details: 'API unreachable · check connection' };
  }
}

export type ScreenId = 'work' | 'clients' | 'settings' | 'inbox' | 'review' | 'dna' | 'library' | 'ops' | 'eval' | 'comparison';

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentScreen, onNavigate }) => {
  const { t } = useI18n();

  // Honest Live Health State (FR-064: No fake health). A query polled every 30 s, only while the tab
  // is visible (TanStack pauses refetchInterval in a hidden tab), and read at once when it is shown
  // again after that: a Desk left open in a background tab read Core's health all day (programme 0.3,
  // then ADR-037). A probe never throws: an unreachable Core is an answer the line shows.
  const { data: healthStatus = CHECKING } = useQuery({
    queryKey: queryKeys.health,
    queryFn: probeHealth,
    refetchInterval: HEALTH_POLL_MS,
    staleTime: HEALTH_POLL_MS,
    retry: false,
  });

  const isWorkActive = currentScreen === 'work' || currentScreen === 'inbox' || currentScreen === 'review';
  const isClientsActive = currentScreen === 'clients' || currentScreen === 'dna' || currentScreen === 'library';
  const isSettingsActive = currentScreen === 'settings' || currentScreen === 'ops' || currentScreen === 'eval';

  return (
    <aside className="side" role="navigation" aria-label="Main Navigation">
      <div className="brand">
        <strong>Hawa Desk</strong>
        <small>{t.sidebar.brandSubtitle}</small>
      </div>

      <nav className="nav" aria-label="Primary Navigation">
        {/* 1. Work Desk (Unified Queue & Detail) */}
        <button
          id="nav-work"
          className={isWorkActive ? 'active' : ''}
          onClick={() => onNavigate('work')}
          aria-current={isWorkActive ? 'page' : undefined}
          title="Actionable task queue and Canva design review detail"
        >
          <span>💼</span> {t.screens.work}
        </button>

        {/* 2. Clients (Client DNA & Brand Assets) */}
        <button
          id="nav-clients"
          className={isClientsActive ? 'active' : ''}
          onClick={() => onNavigate('clients')}
          aria-current={isClientsActive ? 'page' : undefined}
          title="Client DNA profiles, guidelines, tokens, and verified asset library"
        >
          <span>🧬</span> {t.screens.clients}
        </button>

        {/* 3. Settings (Integrations, Honest Health, Audit) */}
        <button
          id="nav-settings"
          className={isSettingsActive ? 'active' : ''}
          onClick={() => onNavigate('settings')}
          aria-current={isSettingsActive ? 'page' : undefined}
          title="Channel bridges, honest health probes, and audit logs"
        >
          <span>⚙️</span> {t.screens.settings}
        </button>

        {/* 4. Blinded comparison with the office designer */}
        <button
          id="nav-comparison"
          className={currentScreen === 'comparison' ? 'active' : ''}
          onClick={() => onNavigate('comparison')}
          aria-current={currentScreen === 'comparison' ? 'page' : undefined}
          title="Hawa and the office designer, judged blind by requesters and outside designers"
        >
          <span>⚖️</span> {t.screens.comparison}
        </button>
      </nav>

      {/* Honest Health Indicator (FR-064) */}
      <div className="health" role="status" aria-live="polite">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className="dot"
            style={{
              background: healthStatus.status === 'ok' ? '#16a34a' : '#d97706',
            }}
          />
          <b>{healthStatus.label}</b>
        </div>
        <small style={{ display: 'block', marginTop: 4, color: 'var(--muted)' }}>
          {healthStatus.details}
        </small>
      </div>
    </aside>
  );
};

