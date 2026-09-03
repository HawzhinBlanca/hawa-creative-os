import React, { useState } from 'react';

export const DnaScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'brand' | 'identity' | 'language' | 'rules'>('brand');

  return (
    <section id="dna" className="screen active">
      <div className="dna">
        {/* Left Column: Client List */}
        <div className="panel">
          <h3>Clients</h3>
          <div className="listitem sel">
            <span>Aster</span>
            <span className="pill ok">v12 active</span>
          </div>
          <div className="listitem">
            <span>Nova</span>
            <span className="pill">v8</span>
          </div>
          <div className="listitem">
            <span>Rona</span>
            <span className="pill">v4</span>
          </div>
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />
          <button className="btn" style={{ width: '100%' }}>+ Add client</button>
        </div>

        {/* Center Column: DNA Details */}
        <div className="panel">
          <div className="tabs">
            <button className={activeTab === 'identity' ? 'on' : ''} onClick={() => setActiveTab('identity')}>Identity</button>
            <button className={activeTab === 'brand' ? 'on' : ''} onClick={() => setActiveTab('brand')}>Brand</button>
            <button className={activeTab === 'language' ? 'on' : ''} onClick={() => setActiveTab('language')}>Language</button>
            <button className={activeTab === 'rules' ? 'on' : ''} onClick={() => setActiveTab('rules')}>Rules</button>
          </div>

          <h2>Aster brand system</h2>

          <h3>Approved palette</h3>
          <div className="swatches">
            <div className="swatch" style={{ background: '#164a3a', color: 'white' }}>forest</div>
            <div className="swatch" style={{ background: '#f4ecdd', color: '#17191c' }}>cream</div>
            <div className="swatch" style={{ background: '#e9b666', color: '#17191c' }}>warm gold</div>
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
              <tr>
                <td>Logo · white primary</td>
                <td>logo_primary</td>
                <td><span className="pill ok">active</span></td>
                <td><code>a81f3…</code></td>
              </tr>
              <tr>
                <td>Logo · old seal</td>
                <td>logo_secondary</td>
                <td><span className="pill bad">deprecated</span></td>
                <td><code>c13b7…</code></td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Fonts & RTL Registry</h3>
          <div className="rule">
            <b>Office Sorani Primary (Vazirmatn)</b>
            <p>Weights: Regular (400) / Bold (700) · Languages: ckb, ar · All 40 critical RTL golden cases passed</p>
          </div>
        </div>

        {/* Right Column: Governance & Candidate Rules */}
        <div className="panel">
          <h3>Draft changes</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>No unreviewed changes.</p>
          <button className="btn">Create DNA version</button>

          <h3 style={{ marginTop: 24 }}>Active rules</h3>
          <div className="rule">
            <b>Dark background logo</b>
            <p>Use the white official logo; minimum clear space equals cap height.</p>
            <small>Explicit owner instruction · 5 supporting approvals</small>
          </div>
          <div className="rule">
            <b>Price numerals</b>
            <p>Preserve the source numeral system; never normalize final copy silently.</p>
          </div>

          <h3 style={{ marginTop: 24 }}>Candidate rule (from feedback)</h3>
          <div className="finding">
            <b>Reduce headline density on stories</b>
            <p>Mined from 3 repeated operator edits · 1 counterexample</p>
            <button className="btn primary" style={{ fontSize: 11, marginTop: 6 }}>Approve promotion</button>
          </div>
        </div>
      </div>
    </section>
  );
};
