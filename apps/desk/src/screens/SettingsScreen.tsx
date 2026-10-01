import { CanvaConnectionPanel } from '../components/CanvaConnectionPanel.js';
import { ReviewerAssignmentsPanel } from '../components/ReviewerAssignmentsPanel.js';
import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/client.js';
import {
  read,
  reasonOf,
  describeTelegramBridge,
  describeWebhookMode,
  describeWebhookDelivery,
  describeProvider,
  type Reading,
  type TelegramAdapterStatus,
  type ProviderStatusMap,
  type CheckResult,
} from '../services/statusReport.js';

const PILL_CLASS = { ok: 'pill ok', warn: 'pill warn', unknown: 'pill' } as const;
const CHECK_COLORS = {
  ok: { border: '#1d733c', background: '#ecfdf5', title: '#065f46', text: '#047857' },
  warn: { border: '#d97706', background: '#fffbeb', title: '#92400e', text: '#b45309' },
  error: { border: '#dc2626', background: '#fef2f2', title: '#991b1b', text: '#b91c1c' },
} as const;

export const SettingsScreen: React.FC = () => {
  const [checkingWebhook, setCheckingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<CheckResult | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<Reading<TelegramAdapterStatus>>({ state: 'loading' });
  const [activeModal, setActiveModal] = useState<'admission' | 'proof' | 'credentials' | null>(null);
  const [providerStatus, setProviderStatus] = useState<Reading<ProviderStatusMap>>({ state: 'loading' });
  const [registeringWebhook, setRegisteringWebhook] = useState(false);
  const [registerWebhookResult, setRegisterWebhookResult] = useState<string | null>(null);

  // A status that cannot be read is shown as unknown, with the reason. It is never guessed.
  const fetchTelegramStatus = async () => {
    setTelegramStatus(await read(() => apiClient.telegram.status()));
  };

  const fetchProviderStatus = async () => {
    setProviderStatus(
      await read(async () => {
        const data = await apiClient.system.providers();
        if (!data?.providers) throw new Error('the server returned no provider status');
        return data.providers as ProviderStatusMap;
      })
    );
  };

  useEffect(() => {
    fetchProviderStatus();
    fetchTelegramStatus();
  }, []);

  // The webhook secret stays on the server. Core asks Telegram how delivery to our webhook is going
  // (getWebhookInfo) and relays the answer; the Desk never posts to the webhook itself.
  const handleCheckWebhook = async () => {
    setCheckingWebhook(true);
    setWebhookResult(null);
    setWebhookResult(describeWebhookDelivery(await read(() => apiClient.telegram.webhookInfo())));
    setCheckingWebhook(false);
  };

  const handleDeleteWebhook = async () => {
    setRegisteringWebhook(true);
    setRegisterWebhookResult(null);
    try {
      await apiClient.telegram.deleteWebhook();
      setRegisterWebhookResult('✓ Webhook removed. Telegram reverted to on-demand polling mode.');
      await fetchTelegramStatus();
    } catch (err) {
      setRegisterWebhookResult(`✗ Failed: ${reasonOf(err)}`);
    } finally {
      setRegisteringWebhook(false);
    }
  };

  const bridgeView = describeTelegramBridge(telegramStatus);
  const webhookModeView = describeWebhookMode(telegramStatus);
  const providerTile = (key: string, name: string) => {
    const view = describeProvider(providerStatus, key);
    return (
      <div style={{ padding: '6px 8px', background: view.configured ? 'rgba(29,115,60,0.08)' : 'rgba(0,0,0,0.04)', borderRadius: 6, border: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 600 }}>{name}</span>: {view.text}
      </div>
    );
  };


  return (
    <section id="settings" className="screen active">
      <div className="ops">
        <h1 className="sr-only">Settings & Platform Adapters</h1>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Adapters and capabilities</h2>
          <div className="settings-adapters-table" role="region" aria-label="Adapters and capabilities table" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>Adapter</th>
                <th>Authority</th>
                <th>State</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>Hawa Desk</b></td>
                <td>canonical</td>
                <td><span className="pill ok">healthy</span></td>
                <td>—</td>
              </tr>
              <tr>
                <td>
                  <b>Telegram Bridge</b>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {bridgeView.detail}
                  </div>
                </td>
                <td>capture & card dispatch</td>
                <td>
                  <span className={PILL_CLASS[bridgeView.tone]}>
                    {bridgeView.label}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn"
                      style={{ fontSize: 11 }}
                      disabled={checkingWebhook}
                      onClick={handleCheckWebhook}
                      title="Ask Telegram, through Core, how delivery to the registered webhook is going"
                    >
                      {checkingWebhook ? 'Checking…' : 'Check webhook'}
                    </button>
                  </div>
                </td>
              </tr>
              <tr>
                <td><b>WAHA WhatsApp</b></td>
                <td>capture only</td>
                <td><span className="pill warn">quarantined</span></td>
                <td>
                  <button
                    className="btn"
                    style={{ fontSize: 11 }}
                    onClick={() => setActiveModal('admission')}
                  >
                    View admission
                  </button>
                </td>
              </tr>
              <tr>
                <td><b>Canva Native Studio</b></td>
                <td>Native editor; connection and exports checked separately</td>
                <td><span className="pill">See connection below</span></td>
                <td>
                  <button
                    className="btn"
                    style={{ fontSize: 11 }}
                    onClick={() => setActiveModal('proof')}
                  >
                    Studio status
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          </div>

          {webhookResult && (
            <div className="finding" style={{ borderColor: CHECK_COLORS[webhookResult.tone].border, background: CHECK_COLORS[webhookResult.tone].background, marginTop: 14 }}>
              <b style={{ color: CHECK_COLORS[webhookResult.tone].title }}>Telegram webhook delivery (as reported by Telegram)</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: CHECK_COLORS[webhookResult.tone].text }}>{webhookResult.text}</p>
            </div>
          )}

          {/* Horizon 17 (Option 2): the webhook's state; since ADR-135 the worker polls and none is registered */}
          <h3 style={{ marginTop: 24 }}>Telegram Webhook & Public Tunnel (Horizon 17)</h3>
          <div className="rule" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <b>Instant Push Ingress (&lt;50ms)</b>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
                  Current Mode: <b>{webhookModeView.detail}</b>
                </p>
              </div>
              <span className={PILL_CLASS[webhookModeView.tone]}>
                {webhookModeView.label}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>
                The worker polls Telegram and hands every update to RequestLifecycle (ADR-135), so no
                webhook is registered from here. Delete clears one set outside Hawa, which would stop
                the worker's poller.
              </span>
              <button
                className="btn secondary"
                style={{ fontSize: 11, padding: '7px 12px' }}
                disabled={registeringWebhook}
                onClick={handleDeleteWebhook}
              >
                Delete Webhook
              </button>
            </div>
            {registerWebhookResult && (
              <div style={{ fontSize: 11, color: registerWebhookResult.startsWith('✓') ? '#047857' : '#b91c1c', marginTop: 4 }}>
                {registerWebhookResult}
              </div>
            )}
          </div>

          <CanvaConnectionPanel />

          <h3 style={{ marginTop: 24 }}>Network policy</h3>
          <div className="rule">
            <b>Private office / VPN only</b>
            <p>No public administration endpoints. Outbound provider egress is capability-scoped, token-budgeted, and audited in OpenTelemetry.</p>
          </div>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Model registry</h2>
          <div className="rule">
            <b>Reasoning, layout, critique & judge</b>
            <p>Each design records the models used for its run. Visual review is advisory; it cannot waive deterministic QA or human approval.</p>
          </div>
          <div className="rule">
            <b>Artwork</b>
            <p>gpt-image-2.5-sunburst by default, or a Google Gemini image model when HAWA_IMAGE_PROVIDER=google · only when a concept asks for generated imagery; zero image calls otherwise · live settings in core /v1/health → models</p>
          </div>
          <div className="rule">
            <b>Voice notes</b>
            <p>whisper-1 · transcription of Telegram voice messages</p>
          </div>
          <div className="rule">
            <b>Other providers</b>
            <p>Anthropic and Google models are disabled in production and fail closed before any network call · deterministic hard QA cannot be waived by a model</p>
          </div>

          <h3 style={{ marginTop: 24 }}>Upstream locks</h3>
          <div className="finding">
            <b>No automatic upgrades</b>
            <p>Studio, workflow engine, Comfy nodes, models, and containers require offline evidence before admission.</p>
          </div>

          <h3 style={{ marginTop: 24 }}>Live API Credentials & Secret Store</h3>
          <div className="rule" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <b>Local & Cloud Provider Keys</b>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Deploy-time configuration; a key pasted here lasts until the next restart</p>
              </div>
              <button
                className="btn primary"
                style={{ fontSize: 12, padding: '6px 14px' }}
                onClick={() => {
                  fetchProviderStatus();
                  setActiveModal('credentials');
                }}
              >
                🔑 Manage / Paste API Keys
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, fontSize: 11, marginTop: 4 }}>
              {providerTile('gemini', 'Google Gemini')}
              {providerTile('openai', 'OpenAI')}
              {providerTile('anthropic', 'Anthropic')}
              {providerTile('telegram', 'Telegram')}
            </div>
            {providerStatus.state === 'unknown' && (
              <p style={{ margin: 0, fontSize: 11, color: '#b91c1c' }}>Provider status unknown: {providerStatus.reason}</p>
            )}
          </div>
        </div>
      </div>

      <ReviewerAssignmentsPanel />

      {/* Admission Inspector Modal */}
      {activeModal === 'admission' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div className="panel" style={{ width: 500, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
            <h2 style={{ marginTop: 0 }}>WAHA WhatsApp Admission</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Status: <code>QUARANTINED</code> · Invariant #1 Compliance Check</p>
            <div className="finding" style={{ borderColor: '#d97706', background: '#fffbeb' }}>
              <b style={{ color: '#92400e' }}>Non-Authoritative Ingress Only</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#b45309' }}>
                WAHA WhatsApp messages cannot trigger autonomous side effects or approvals. All messages are ingested as unconfirmed events requiring Desk operator triage and client scope locking.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn" onClick={() => setActiveModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Proof Report Modal */}
      {activeModal === 'proof' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div className="panel" style={{ width: 540, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
            <h2 style={{ marginTop: 0 }}>Canva integration</h2>
            <p>Connect your own Canva account below. A selected editor does not prove native composition, semantic capture, print quality or delivery.</p>
            <CanvaConnectionPanel />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn" onClick={() => setActiveModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Live API Credentials Modal */}
      {activeModal === 'credentials' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 110,
            backdropFilter: 'blur(4px)',
          }}
        >
          <div className="panel" style={{ width: 560, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 24, boxShadow: '0 24px 48px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Provider configuration</h2>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => setActiveModal(null)}>✕</button>
            </div>
            <p>Provider credentials are managed on the production host. A verified deployment activates matching settings for the app and design worker and keeps them across restarts.</p>
            <p>The host operator can update credentials with <code>bash ~/.hawa/current/infra/docker/rotate_external_secrets.sh</code>. The update is verified and recorded without storing keys in the browser.</p>
            <button className="btn" onClick={() => setActiveModal(null)}>Close</button>
          </div>
        </div>
      )}
    </section>
  );
};
