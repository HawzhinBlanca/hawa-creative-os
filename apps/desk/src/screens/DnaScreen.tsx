import React, { useState, useEffect } from 'react';

interface ClientDnaData {
  id: string;
  name: string;
  version: string;
  palette: { name: string; hex: string; textDark?: boolean }[];
  logos: { name: string; role: string; status: 'active' | 'deprecated'; hash: string }[];
  fontInfo: { name: string; desc: string };
  rules: { title: string; desc: string; source: string }[];
  candidateRule: { title: string; desc: string; evidence: string } | null;
}

const CLIENT_DATA: Record<string, ClientDnaData> = {
  aster: {
    id: 'aster',
    name: 'Aster Hotel & Resort',
    version: 'v12 active',
    palette: [
      { name: 'forest', hex: '#164a3a' },
      { name: 'cream', hex: '#f4ecdd', textDark: true },
      { name: 'warm gold', hex: '#e9b666', textDark: true },
    ],
    logos: [
      { name: 'Logo · white primary', role: 'logo_primary', status: 'active', hash: 'a81f3…' },
      { name: 'Logo · old seal', role: 'logo_secondary', status: 'deprecated', hash: 'c13b7…' },
    ],
    fontInfo: {
      name: 'Office Sorani Primary (Vazirmatn)',
      desc: 'Weights: Regular (400) / Bold (700) · Languages: ckb, ar · All 40 critical RTL golden cases passed',
    },
    rules: [
      {
        title: 'Dark background logo',
        desc: 'Use the white official logo; minimum clear space equals cap height.',
        source: 'Explicit owner instruction · 5 supporting approvals',
      },
      {
        title: 'Price numerals',
        desc: 'Preserve the source numeral system; never normalize final copy silently.',
        source: 'Contract requirement · Hard QA invariant',
      },
    ],
    candidateRule: {
      title: 'Reduce headline density on stories',
      desc: 'Limit headline to 3 lines maximum on 9:16 vertical formats to prevent overlap with native UI overlays.',
      evidence: 'Mined from 3 repeated operator edits · 1 counterexample',
    },
  },
  nova: {
    id: 'nova',
    name: 'Nova Tech Systems',
    version: 'v8 active',
    palette: [
      { name: 'deep navy', hex: '#0b192c' },
      { name: 'slate blue', hex: '#1e3e62' },
      { name: 'safety orange', hex: '#ff6500' },
    ],
    logos: [
      { name: 'Nova Symbol · Primary', role: 'logo_primary', status: 'active', hash: '7f41d…' },
      { name: 'Wordmark · Monochrome', role: 'logo_secondary', status: 'active', hash: 'd829e…' },
    ],
    fontInfo: {
      name: 'Modern Sans (Noto Sans Arabic)',
      desc: 'Weights: Light (300) / Medium (500) / Bold (700) · Languages: ckb, ar, en · Zero glyph clipping',
    },
    rules: [
      {
        title: 'Tech minimalism',
        desc: 'Maintain generous padding (minimum 64px); max 2 focal elements per artboard.',
        source: 'Brand guidelines v2.1 · Operator consensus',
      },
      {
        title: 'High-contrast action targets',
        desc: 'CTA elements must use safety orange with WCAG AAA contrast against background.',
        source: 'Accessibility invariant · Verified by QA',
      },
    ],
    candidateRule: {
      title: 'Monochrome watermark on white cards',
      desc: 'Automatically downgrade full color emblem to 40% monochrome when placed on clean white content cards.',
      evidence: 'Observed across 4 published campaign deliverables',
    },
  },
  rona: {
    id: 'rona',
    name: 'Rona Haute Couture',
    version: 'v4 active',
    palette: [
      { name: 'royal plum', hex: '#4a154b' },
      { name: 'off-white', hex: '#f8f5fa', textDark: true },
      { name: 'warm amber', hex: '#ecb22e', textDark: true },
    ],
    logos: [
      { name: 'Rona Signature', role: 'logo_primary', status: 'active', hash: 'e39a1…' },
      { name: 'Emblem Crest', role: 'logo_secondary', status: 'active', hash: 'b4912…' },
    ],
    fontInfo: {
      name: 'Editorial Calligraphy (IBM Plex Arabic & Naskh)',
      desc: 'Weights: Regular (400) / SemiBold (600) · Languages: ckb, ar · Elegant ligature support',
    },
    rules: [
      {
        title: 'Editorial elegance',
        desc: 'Headline scale must be at least 2.5x body text with open leading.',
        source: 'Creative Director mandate',
      },
      {
        title: 'Organic framing',
        desc: 'Product photography must use smooth organic masks rather than sharp rectangular borders.',
        source: 'Visual identity manual',
      },
    ],
    candidateRule: null,
  },
};

export const DnaScreen: React.FC = () => {
  const [selectedClientId, setSelectedClientId] = useState<string>('client-office-1');
  const [activeTab, setActiveTab] = useState<'brand' | 'identity' | 'language' | 'rules'>('brand');
  const [promotedRule, setPromotedRule] = useState<string | null>(null);
  const [liveDna, setLiveDna] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Fetch live DNA when client-office-1 is selected
  useEffect(() => {
    if (selectedClientId === 'client-office-1') {
      setLoading(true);
      fetch('/v1/clients/client-office-1/dna')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setLiveDna(data);
        })
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [selectedClientId]);

  // Construct client view data
  const client: ClientDnaData = (selectedClientId === 'client-office-1' && liveDna) ? {
    id: 'client-office-1',
    name: liveDna.name || 'Hawa Creative',
    version: `v${liveDna.version || 1} active (LIVE API)`,
    palette: (liveDna.colors || []).map((c: any) => ({
      name: c.name,
      hex: c.hex,
      textDark: c.hex.toLowerCase() === '#ffffff' || c.hex.toLowerCase() === '#f4ecdd',
    })),
    logos: (liveDna.assets || []).map((a: any) => ({
      name: a.name,
      role: a.role,
      status: 'active' as const,
      hash: a.sha256 ? a.sha256.substring(0, 8) + '…' : 'sha256_verified',
    })),
    fontInfo: {
      name: `${liveDna.fonts?.[0]?.family || 'Noto Sans Arabic'} (Body)`,
      desc: `Style: ${liveDna.fonts?.[0]?.style || 'Regular'} · License: ${liveDna.fonts?.[0]?.license || 'OFL'} · Supported: ${liveDna.fonts?.[0]?.supportedLocales?.join(', ') || 'ckb, ar'}`,
    },
    rules: (liveDna.guidelines?.layoutRules || []).map((r: string) => ({
      title: 'Layout Rule',
      desc: r,
      source: 'Client DNA Master Spec · Invariant #6',
    })).concat([
      {
        title: 'Voice & Tone',
        desc: liveDna.guidelines?.voiceAndTone || 'Sophisticated Kurdish visual studio',
        source: 'Brand guidelines v1.0',
      },
      {
        title: 'Prohibited Words',
        desc: `Blocked by QA: ${(liveDna.guidelines?.prohibitedPhrases || []).join(', ')}`,
        source: 'Automated Lexicon Check',
      },
    ]),
    candidateRule: {
      title: 'Enforce top-right brand logo anchor in RTL',
      desc: 'Ensure brand logo always occupies top-right corner in Kurdish Sorani layouts.',
      evidence: 'Derived from 6 consecutive approved campaign deliverables',
    },
  } : CLIENT_DATA[selectedClientId] || CLIENT_DATA.aster;

  const handlePromoteCandidate = async (title: string) => {
    if (selectedClientId === 'client-office-1' && liveDna) {
      try {
        const updatedRules = [...(liveDna.guidelines?.layoutRules || []), title];
        const updatedDna = {
          ...liveDna,
          guidelines: {
            ...liveDna.guidelines,
            layoutRules: updatedRules,
          },
        };
        const res = await fetch('/v1/clients/client-office-1/dna', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedDna),
        });
        if (res.ok) {
          const saved = await res.json();
          setLiveDna(saved);
          setPromotedRule(title);
          setSaveSuccess(`Rule promoted & DNA bumped to v${saved.version}`);
        }
      } catch (err) {
        console.error('Failed to update DNA:', err);
      }
    } else {
      setPromotedRule(title);
    }
  };

  return (
    <section id="dna" className="screen active">
      <div className="dna">
        {/* Left Column: Client List */}
        <div className="panel">
          <h3>Clients</h3>
          <div
            className={`listitem ${selectedClientId === 'client-office-1' ? 'sel' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedClientId('client-office-1')}
          >
            <span>Hawa Creative</span>
            <span className="pill ok">LIVE API</span>
          </div>
          <div
            className={`listitem ${selectedClientId === 'aster' ? 'sel' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedClientId('aster')}
          >
            <span>Aster Hotel</span>
            <span className="pill">v12 active</span>
          </div>
          <div
            className={`listitem ${selectedClientId === 'nova' ? 'sel' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedClientId('nova')}
          >
            <span>Nova Tech</span>
            <span className="pill">v8 active</span>
          </div>
          <div
            className={`listitem ${selectedClientId === 'rona' ? 'sel' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedClientId('rona')}
          >
            <span>Rona Couture</span>
            <span className="pill">v4 active</span>
          </div>
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />
          <button className="btn" style={{ width: '100%' }} onClick={() => alert('New client onboarding initiates isolated workspace & tenant schema.')}>
            + Add client
          </button>
        </div>

        {/* Center Column: DNA Details */}
        <div className="panel">
          <div className="tabs">
            <button className={activeTab === 'identity' ? 'on' : ''} onClick={() => setActiveTab('identity')}>Identity</button>
            <button className={activeTab === 'brand' ? 'on' : ''} onClick={() => setActiveTab('brand')}>Brand</button>
            <button className={activeTab === 'language' ? 'on' : ''} onClick={() => setActiveTab('language')}>Language</button>
            <button className={activeTab === 'rules' ? 'on' : ''} onClick={() => setActiveTab('rules')}>Rules</button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 }}>
            <h2>{client.name}</h2>
            <span className="pill ok">{client.version}</span>
          </div>

          {loading && <small style={{ color: 'var(--muted)', display: 'block', margin: '4px 0' }}>Fetching live DNA from Core API…</small>}
          {saveSuccess && (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', margin: '8px 0' }}>
              <b style={{ color: '#065f46' }}>✓ Live DNA Synchronized</b>
              <p style={{ margin: '2px 0', fontSize: 12, color: '#047857' }}>{saveSuccess}</p>
            </div>
          )}

          {(activeTab === 'brand' || activeTab === 'identity') && (
            <>
              <h3>Approved palette</h3>
              <div className="swatches">
                {client.palette.map((p) => (
                  <div
                    key={p.name}
                    className="swatch"
                    style={{ background: p.hex, color: p.textDark ? '#17191c' : 'white' }}
                  >
                    {p.name}
                  </div>
                ))}
              </div>

              <h3>Official assets</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {client.logos.map((logo) => (
                    <tr key={logo.name}>
                      <td>{logo.name}</td>
                      <td><code>{logo.role}</code></td>
                      <td>
                        <span className={`pill ${logo.status === 'active' ? 'ok' : 'bad'}`}>
                          {logo.status}
                        </span>
                      </td>
                      <td><code>{logo.hash}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {(activeTab === 'brand' || activeTab === 'language') && (
            <>
              <h3 style={{ marginTop: 20 }}>Fonts & RTL Registry</h3>
              <div className="rule">
                <b>{client.fontInfo.name}</b>
                <p>{client.fontInfo.desc}</p>
              </div>
            </>
          )}

          {(activeTab === 'brand' || activeTab === 'rules') && (
            <>
              <h3 style={{ marginTop: 20 }}>Core Brand Principles</h3>
              {client.rules.map((rule) => (
                <div key={rule.title} className="rule" style={{ marginBottom: 8 }}>
                  <b>{rule.title}</b>
                  <p>{rule.desc}</p>
                  <small style={{ color: 'var(--muted)' }}>{rule.source}</small>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Right Column: Governance & Candidate Rules */}
        <div className="panel">
          <h3>Draft changes</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>No unreviewed changes in client branch.</p>
          <button className="btn" onClick={() => alert('Created immutable snapshot')}>Create DNA version</button>

          <h3 style={{ marginTop: 24 }}>Active rules</h3>
          {client.rules.map((rule) => (
            <div key={rule.title} className="rule">
              <b>{rule.title}</b>
              <p>{rule.desc}</p>
              <small>{rule.source}</small>
            </div>
          ))}

          {promotedRule && (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', marginTop: 12 }}>
              <b style={{ color: '#065f46' }}>✓ Rule Promoted to Active</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#047857' }}>
                “{promotedRule}” was added to active rules for {client.name}.
              </p>
            </div>
          )}

          <h3 style={{ marginTop: 24 }}>Candidate rule (from feedback)</h3>
          {client.candidateRule && !promotedRule ? (
            <div className="finding">
              <b>{client.candidateRule.title}</b>
              <p>{client.candidateRule.desc}</p>
              <small style={{ display: 'block', color: 'var(--muted)', marginTop: 4 }}>
                {client.candidateRule.evidence}
              </small>
              <button
                className="btn primary"
                style={{ fontSize: 11, marginTop: 8 }}
                onClick={() => handlePromoteCandidate(client.candidateRule!.title)}
              >
                Approve promotion
              </button>
            </div>
          ) : (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>No pending candidate rules.</p>
          )}
        </div>
      </div>
    </section>
  );
};

