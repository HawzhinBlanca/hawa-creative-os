import React, { useState, useEffect } from 'react';
import { useI18n } from '../services/i18n.js';

export type ScreenId = 'work' | 'clients' | 'settings' | 'inbox' | 'review' | 'dna' | 'library' | 'ops' | 'eval' | 'comparison';

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentScreen, onNavigate }) => {
  const { t } = useI18n();

  // Honest Live Health State (FR-064: No fake health)
  const [healthStatus, setHealthStatus] = useState<{
    status: 'ok' | 'degraded' | 'checking';
    label: string;
    details: string;
  }>({
    status: 'checking',
    label: 'Checking Core...',
    details: 'Checking API availability...',
  });

  useEffect(() => {
    let mounted = true;
    const probeHealth = async () => {
      try {
        const res = await fetch('/v1/health', { signal: AbortSignal.timeout(3000) });
        if (!mounted) return;
        if (res.ok) {
          await res.json();
          setHealthStatus({
            status: 'ok',
            label: 'Core Reachable',
            details: 'API responded · Canva and delivery require separate verification',
          });
        } else {
          setHealthStatus({
            status: 'degraded',
            label: 'Core Warning',
            details: `HTTP ${res.status} response from server`,
          });
        }
      } catch {
        if (!mounted) return;
        setHealthStatus({
          status: 'degraded',
          label: 'Core Disconnected',
          details: 'API unreachable · check connection',
        });
      }
    };

    probeHealth();
    const interval = setInterval(probeHealth, 30000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

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

