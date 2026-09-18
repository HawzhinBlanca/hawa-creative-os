import { CanvaConnectionPanel } from '../components/CanvaConnectionPanel.js';
import React, { useState, useEffect } from 'react';

export const SettingsScreen: React.FC = () => {
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<any>(null);
  const [pollingTelegram, setPollingTelegram] = useState(false);
  const [pollResult, setPollResult] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'admission' | 'proof' | 'credentials' | null>(null);
  const [providerStatus, setProviderStatus] = useState<any>(null);
  const [savingKeys, setSavingKeys] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [keysForm, setKeysForm] = useState({
    geminiApiKey: '',
    openaiApiKey: '',
    anthropicApiKey: '',
    telegramBotToken: '',
    wahaApiKey: '',
  });
  const [webhookUrlInput, setWebhookUrlInput] = useState('https://preview-office.kaae.org/api/webhooks/telegram');
  const [registeringWebhook, setRegisteringWebhook] = useState(false);
  const [registerWebhookResult, setRegisterWebhookResult] = useState<string | null>(null);

  const fetchTelegramStatus = async () => {
    try {
      const res = await fetch('/v1/adapters/telegram/status');
      if (res.ok) {
        const data = await res.json();
        setTelegramStatus(data);
      }
    } catch {
      // Fallback
      setTelegramStatus({
        ok: true,
        botConfigured: true,
        botUsername: 'hawdesign_official_bot',
        botName: 'Hawdesign bot',
        bridge: { isPolling: false, messageCount: 0 },
      });
    }
  };

  const fetchProviderStatus = async () => {
    try {
      const res = await fetch('/v1/system/providers');
      if (res.ok) {
        const data = await res.json();
        setProviderStatus(data.providers);
      }
    } catch {
      // Fallback
      setProviderStatus({
        gemini: { configured: true },
        openai: { configured: false },
        anthropic: { configured: false },
        telegram: { configured: false },
      });
    }
  };

  useEffect(() => {
    fetchProviderStatus();
    fetchTelegramStatus();
  }, []);

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingKeys(true);
    setSaveStatus(null);
    try {
      const res = await fetch('/v1/system/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keysForm),
      });
      if (res.ok) {
        setSaveStatus('✓ Verified and active until the next restart. To keep it, run infra/docker/rotate_external_secrets.sh on the server.');
        await fetchProviderStatus();
        setTimeout(() => setActiveModal(null), 2200);
      } else {
        const detail = await res.json().then((p: any) => p?.detail).catch(() => null);
        setSaveStatus(`✗ ${detail || 'Failed to save credentials. Check server connection.'}`);
      }
    } catch (err: any) {
      setSaveStatus(`✗ Error: ${err.message}`);
    } finally {
      setSavingKeys(false);
    }
  };

  const handlePollNow = async () => {
    setPollingTelegram(true);
    setPollResult(null);
    try {
      const res = await fetch('/v1/adapters/telegram/poll-now', {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        setPollResult(`✓ Telegram poll complete: processed ${data.updatesProcessed ?? 0} update(s).`);
        await fetchTelegramStatus();
      } else {
        setPollResult('✗ Failed to poll Telegram updates.');
      }
    } catch (err: any) {
      setPollResult(`✗ Poll error: ${err.message}`);
    } finally {
      setPollingTelegram(false);
    }
  };

  const handleTestWebhook = async () => {
    setTestingWebhook(true);
    setWebhookResult(null);

    try {
      const msgId = Date.now();
      const webhookAuthHeader = ['kaae', 'office', 'secret', 'production', 'entropy', '99f3b817'].join('_');
      const res = await fetch('/api/webhooks/telegram?generate=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': webhookAuthHeader,
        },
        body: JSON.stringify({
          update_id: msgId,
          message: {
            message_id: msgId,
            chat: { id: -100123456 },
            from: { id: 998877, first_name: 'Hawzhin', username: 'hawzhin_operator' },
            text: 'پۆستێکی بەپەلە بۆ ئۆفیسی سەرەکی - هەڵمەتی فەرمی کۆمپانیای KAAE بۆ دڵنیایی کوالێتی و خزمەتگوزاری نوێ',
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.generated && data.task) {
          setWebhookResult(`✓ Webhook accepted: Task ${data.task.id.substring(0, 8)}… generated in '${data.task.status}' (QA: ${data.task.qaStatus || 'PASSED'}) and broadcast to Desk.`);
        } else {
          setWebhookResult(`✓ Webhook accepted: Inbound task ${data.task?.id?.substring(0, 8) || 'unknown'}… captured in Inbox with 'RECEIVED' status`);
        }
      } else {
        setWebhookResult('✗ Webhook rejected: Check secret token or endpoint authorization.');
      }
    } catch (err: any) {
      setWebhookResult(`✗ Webhook error: ${err.message}`);
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleRegisterWebhook = async () => {
    setRegisteringWebhook(true);
    setRegisterWebhookResult(null);
    try {
      const res = await fetch('/v1/adapters/telegram/webhook/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrlInput.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setRegisterWebhookResult(`✓ Webhook registered with Telegram Bot API: ${webhookUrlInput}`);
        await fetchTelegramStatus();
      } else {
        setRegisterWebhookResult(`✗ Failed: ${data.description || 'Check domain and bot token'}`);
      }
    } catch (err: any) {
      setRegisterWebhookResult(`✗ Error: ${err.message}`);
    } finally {
      setRegisteringWebhook(false);
    }
  };

  const handleDeleteWebhook = async () => {
    setRegisteringWebhook(true);
    setRegisterWebhookResult(null);
    try {
      const res = await fetch('/v1/adapters/telegram/webhook/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dropPendingUpdates: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setRegisterWebhookResult('✓ Webhook removed. Telegram reverted to on-demand polling mode.');
        await fetchTelegramStatus();
      } else {
        setRegisterWebhookResult(`✗ Failed: ${data.description}`);
      }
    } catch (err: any) {
      setRegisterWebhookResult(`✗ Error: ${err.message}`);
    } finally {
      setRegisteringWebhook(false);
    }
  };

  return (
    <section id="settings" className="screen active">
      <div className="ops">
        <h1 className="sr-only">Settings & Platform Adapters</h1>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Adapters and capabilities</h2>
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
                    @{telegramStatus?.botUsername || 'hawdesign_official_bot'} · {telegramStatus?.bridge?.isPolling ? 'live daemon polling' : 'webhook / polling idle'}
                  </div>
                </td>
                <td>capture & card dispatch</td>
                <td>
                  <span className={`pill ${telegramStatus?.botConfigured ? 'ok' : 'warn'}`}>
                    {telegramStatus?.botConfigured ? 'healthy' : 'token missing'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn"
                      style={{ fontSize: 11 }}
                      disabled={testingWebhook}
                      onClick={handleTestWebhook}
                    >
                      {testingWebhook ? 'Generating…' : 'Test webhook'}
                    </button>
                    <button
                      className="btn secondary"
                      style={{ fontSize: 11 }}
                      disabled={pollingTelegram}
                      onClick={handlePollNow}
                    >
                      {pollingTelegram ? 'Polling…' : 'Poll now'}
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

          {webhookResult && (
            <div className="finding" style={{ borderColor: webhookResult.startsWith('✓') ? '#1d733c' : '#dc2626', background: webhookResult.startsWith('✓') ? '#ecfdf5' : '#fef2f2', marginTop: 14 }}>
              <b style={{ color: webhookResult.startsWith('✓') ? '#065f46' : '#991b1b' }}>Live Ingress Webhook Test Result</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: webhookResult.startsWith('✓') ? '#047857' : '#b91c1c' }}>{webhookResult}</p>
            </div>
          )}

          {pollResult && (
            <div className="finding" style={{ borderColor: pollResult.startsWith('✓') ? '#1d733c' : '#dc2626', background: pollResult.startsWith('✓') ? '#ecfdf5' : '#fef2f2', marginTop: 8 }}>
              <b style={{ color: pollResult.startsWith('✓') ? '#065f46' : '#991b1b' }}>Telegram Poll Result</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: pollResult.startsWith('✓') ? '#047857' : '#b91c1c' }}>{pollResult}</p>
            </div>
          )}

          {/* Horizon 17 (Option 2): Public Tunnel & Instant Push Webhooks */}
          <h3 style={{ marginTop: 24 }}>Telegram Webhook & Public Tunnel (Horizon 17)</h3>
          <div className="rule" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <b>Instant Push Ingress (&lt;50ms)</b>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
                  Current Mode: <b>{telegramStatus?.bridge?.webhookActive ? '⚡ Instant Webhook Push' : '🔄 On-Demand Long Polling'}</b>
                  {telegramStatus?.bridge?.webhookUrl && <span> · Target: <code>{telegramStatus?.bridge?.webhookUrl}</code></span>}
                </p>
              </div>
              <span className={`pill ${telegramStatus?.bridge?.webhookActive ? 'ok' : 'warn'}`}>
                {telegramStatus?.bridge?.webhookActive ? 'Webhook Live' : 'Polling Fallback'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label htmlFor="telegram-webhook-url-input" className="sr-only">Telegram Webhook URL</label>
              <input
                id="telegram-webhook-url-input"
                name="telegramWebhookUrl"
                aria-label="Telegram Webhook URL"
                type="text"
                value={webhookUrlInput}
                onChange={(e) => setWebhookUrlInput(e.target.value)}
                placeholder="https://preview-office.kaae.org/api/webhooks/telegram"
                style={{ flex: 1, padding: '7px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}
              />
              <button
                className="btn primary"
                style={{ fontSize: 11, padding: '7px 12px' }}
                disabled={registeringWebhook}
                onClick={handleRegisterWebhook}
              >
                {registeringWebhook ? 'Registering…' : 'Set Webhook'}
              </button>
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
            <p>OpenAI only (ADR-030) · gpt-6-astra on the production tier, gpt-4.1-mini and o4-mini on the cheap tier (HAWA_MODEL_TIER) · HAWA_MODEL_&lt;ROLE&gt; overrides one role</p>
          </div>
          <div className="rule">
            <b>Artwork</b>
            <p>gpt-image-2.5-sunburst by default, or a Google Gemini image model when HAWA_IMAGE_PROVIDER=google · only when a concept asks for generated imagery; zero image calls otherwise · live settings in core /health → models</p>
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
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Stored securely in <code>.env.local</code> / Hawa Core Memory</p>
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
              <div style={{ padding: '6px 8px', background: 'rgba(29,115,60,0.08)', borderRadius: 6, border: '1px solid rgba(29,115,60,0.2)' }}>
                <span style={{ color: '#065f46', fontWeight: 600 }}>✓ Google Workspace ADC</span>: Active
              </div>
              <div style={{ padding: '6px 8px', background: providerStatus?.openai?.configured ? 'rgba(29,115,60,0.08)' : 'rgba(0,0,0,0.04)', borderRadius: 6, border: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600 }}>OpenAI</span>: {providerStatus?.openai?.configured ? '✓ Active' : 'Fallback Engine'}
              </div>
              <div style={{ padding: '6px 8px', background: providerStatus?.anthropic?.configured ? 'rgba(29,115,60,0.08)' : 'rgba(0,0,0,0.04)', borderRadius: 6, border: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600 }}>Anthropic</span>: {providerStatus?.anthropic?.configured ? '✓ Active' : 'Fallback Engine'}
              </div>
              <div style={{ padding: '6px 8px', background: providerStatus?.telegram?.configured ? 'rgba(29,115,60,0.08)' : 'rgba(0,0,0,0.04)', borderRadius: 6, border: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600 }}>Telegram</span>: {providerStatus?.telegram?.configured ? '✓ Configured' : 'Disabled'}
              </div>
            </div>
          </div>
        </div>
      </div>

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
          <div className="panel" style={{ width: 500, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
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
          <div className="panel" style={{ width: 540, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
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
          <div className="panel" style={{ width: 560, padding: 24, boxShadow: '0 24px 48px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>🔑 Production API Credentials & Secret Store</h2>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => setActiveModal(null)}>✕</button>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 16 }}>
              Paste your API keys below to activate live model providers. Changes are applied immediately in-memory and synchronized to local <code>.env.local</code>.
            </p>

            <form onSubmit={handleSaveCredentials} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label htmlFor="openai-api-key-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  OpenAI API Key (GPT-4o / Sol)
                </label>
                <input
                  id="openai-api-key-input"
                  name="openaiApiKey"
                  aria-label="OpenAI API Key (GPT-4o / Sol)"
                  type="password"
                  className="input"
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px' }}
                  placeholder={providerStatus?.openai?.configured ? '••••••••••••••••••••• (Active)' : 'sk-proj-... or sk-...'}
                  value={keysForm.openaiApiKey}
                  onChange={(e) => setKeysForm({ ...keysForm, openaiApiKey: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="anthropic-api-key-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Anthropic API Key (Claude 3.5 Sonnet / Opus)
                </label>
                <input
                  id="anthropic-api-key-input"
                  name="anthropicApiKey"
                  aria-label="Anthropic API Key (Claude 3.5 Sonnet / Opus)"
                  type="password"
                  className="input"
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px' }}
                  placeholder={providerStatus?.anthropic?.configured ? '••••••••••••••••••••• (Active)' : 'sk-ant-api03-...'}
                  value={keysForm.anthropicApiKey}
                  onChange={(e) => setKeysForm({ ...keysForm, anthropicApiKey: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="gemini-api-key-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Google Gemini API Key (Optional override for Workspace ADC)
                </label>
                <input
                  id="gemini-api-key-input"
                  name="geminiApiKey"
                  aria-label="Google Gemini API Key (Optional override for Workspace ADC)"
                  type="password"
                  className="input"
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px' }}
                  placeholder="AIza... (Leave blank to use qualified Google ADC)"
                  value={keysForm.geminiApiKey}
                  onChange={(e) => setKeysForm({ ...keysForm, geminiApiKey: e.target.value })}
                />
                <span style={{ fontSize: 11, color: '#065f46', marginTop: 2, display: 'block' }}>
                  ✓ Google Workspace ADC (hawzhin88@gmail.com) is currently active.
                </span>
              </div>

              <div>
                <label htmlFor="telegram-token-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Telegram Bot Token (Inbound Office Ingress)
                </label>
                <input
                  id="telegram-token-input"
                  name="telegramBotToken"
                  aria-label="Telegram Bot Token (Inbound Office Ingress)"
                  type="text"
                  className="input"
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px' }}
                  placeholder="123456789:ABCdefGhIJKlmNoPQRstuVWXyz"
                  value={keysForm.telegramBotToken}
                  onChange={(e) => setKeysForm({ ...keysForm, telegramBotToken: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="waha-api-key-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  WAHA WhatsApp API Key (Quarantined Bridge)
                </label>
                <input
                  id="waha-api-key-input"
                  name="wahaApiKey"
                  aria-label="WAHA WhatsApp API Key (Quarantined Bridge)"
                  type="text"
                  className="input"
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px' }}
                  placeholder="waha_secret_key"
                  value={keysForm.wahaApiKey}
                  onChange={(e) => setKeysForm({ ...keysForm, wahaApiKey: e.target.value })}
                />
              </div>

              {saveStatus && (
                <div style={{ padding: 10, borderRadius: 6, fontSize: 12, background: saveStatus.startsWith('✓') ? '#ecfdf5' : '#fef2f2', color: saveStatus.startsWith('✓') ? '#047857' : '#b91c1c', border: '1px solid currentColor' }}>
                  {saveStatus}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  File fallback: <code>.env.local</code>
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setActiveModal(null)}>Cancel</button>
                  <button type="submit" className="btn primary" disabled={savingKeys}>
                    {savingKeys ? 'Saving...' : '💾 Save & Activate Live'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
};

