import React, { useState } from 'react';

export const SettingsScreen: React.FC = () => {
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'admission' | 'proof' | null>(null);

  const handleTestWebhook = async () => {
    setTestingWebhook(true);
    setWebhookResult(null);

    try {
      const msgId = Date.now();
      const res = await fetch('/api/webhooks/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': 'expected_office_secret',
        },
        body: JSON.stringify({
          message: {
            message_id: msgId,
            chat: { id: -100123456 },
            text: 'پۆستێکی بەپەلە بۆ ئۆفیسی سەرەکی (تێستی تیلیگرام)',
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setWebhookResult(`✓ Webhook accepted: Inbound task ${data.task?.id.substring(0, 8)}… captured in Inbox with 'RECEIVED' status`);
      } else {
        setWebhookResult('✗ Webhook rejected: Check secret token');
      }
    } catch (err: any) {
      setWebhookResult(`✗ Webhook error: ${err.message}`);
    } finally {
      setTestingWebhook(false);
    }
  };

  return (
    <section id="settings" className="screen active">
      <div className="ops">
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
                <td><b>Telegram</b></td>
                <td>capture only</td>
                <td><span className="pill ok">healthy</span></td>
                <td>
                  <button
                    className="btn"
                    style={{ fontSize: 11 }}
                    disabled={testingWebhook}
                    onClick={handleTestWebhook}
                  >
                    {testingWebhook ? 'Sending…' : 'Test webhook'}
                  </button>
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
                <td><b>HyCanvas</b></td>
                <td>creative source</td>
                <td><span className="pill ok">v0.3.9 admitted</span></td>
                <td>
                  <button
                    className="btn"
                    style={{ fontSize: 11 }}
                    onClick={() => setActiveModal('proof')}
                  >
                    Proof report
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          {webhookResult && (
            <div className="finding" style={{ borderColor: webhookResult.startsWith('✓') ? '#1d733c' : '#dc2626', background: webhookResult.startsWith('✓') ? '#ecfdf5' : '#fef2f2', marginTop: 14 }}>
              <b style={{ color: webhookResult.startsWith('✓') ? '#065f46' : '#991b1b' }}>Live Webhook Test Result</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: webhookResult.startsWith('✓') ? '#047857' : '#b91c1c' }}>{webhookResult}</p>
            </div>
          )}

          <h3 style={{ marginTop: 24 }}>Network policy</h3>
          <div className="rule">
            <b>Private office / VPN only</b>
            <p>No public administration endpoints. Outbound provider egress is capability-scoped, token-budgeted, and audited in OpenTelemetry.</p>
          </div>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Model registry</h2>
          <div className="rule">
            <b>fast_router & brief_builder</b>
            <p>Gemini 3.8 Flash · exact snapshot 2026-09-03 · 100% token preservation</p>
          </div>
          <div className="rule">
            <b>creative_director</b>
            <p>GPT-5.6 Sol · creator/judge separation active · discrete editable nodes</p>
          </div>
          <div className="rule">
            <b>visual_judge (advisory)</b>
            <p>Claude Opus 5 · independent model family · cannot waive hard QA</p>
          </div>

          <h3 style={{ marginTop: 24 }}>Upstream locks</h3>
          <div className="finding">
            <b>No automatic upgrades</b>
            <p>Studio, workflow engine, Comfy nodes, models, and containers require offline evidence before admission.</p>
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
          <div className="panel" style={{ width: 520, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
            <h2 style={{ marginTop: 0 }}>HyCanvas Studio v0.3.9 Admission Certificate</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>ADR-0002 Compliance · Verified 2026-09-04</p>
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5' }}>
              <b style={{ color: '#065f46' }}>✓ Deterministic Serialization Passed</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#047857' }}>
                Round-trip hash match: 1,000 randomized operation batches yielded 100% byte-for-byte idempotent <code>.hyc</code> source packages without layout drift or font degradation.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn" onClick={() => setActiveModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

