import React, { useState } from 'react';

interface VerifiedAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sanitized: boolean;
  storageKey: string;
}

export const LibraryScreen: React.FC = () => {
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [assetName, setAssetName] = useState('brand-logo.svg');
  const [assetContent, setAssetContent] = useState('<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">\n  <circle cx="50" cy="50" r="40" fill="#38BDF8"/>\n  <text x="50" y="55" text-anchor="middle" fill="#0B0F19" font-size="14" font-weight="bold">HAWA</text>\n</svg>');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<VerifiedAsset | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedList, setUploadedList] = useState<VerifiedAsset[]>([]);

  const handleUploadAsset = async () => {
    setIsUploading(true);
    setUploadError(null);
    setUploadResult(null);

    try {
      const res = await fetch('/v1/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: assetName,
          mimeType: assetName.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          content: assetContent,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setUploadResult(data);
        setUploadedList((prev) => [data, ...prev]);
      } else {
        const err = await res.json().catch(() => ({}));
        setUploadError(err.detail || 'Security policy rejected asset');
      }
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <section id="library" className="screen active">
      <div className="toolbar">
        <button className="btn primary" onClick={() => setShowUploadModal(true)}>
          + Upload & Ingest Asset
        </button>
        <button className="btn">Templates</button>
        <button className="btn">Assets</button>
        <button className="btn">Negative examples</button>
      </div>

      <div className="grid4">
        <div className="stat"><b>318</b><span>approved designs</span></div>
        <div className="stat"><b>46</b><span>editable templates</span></div>
        <div className="stat"><b>{1204 + uploadedList.length}</b><span>verified assets</span></div>
        <div className="stat"><b>67</b><span>negative examples</span></div>
      </div>

      <div className="board" style={{ gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', minHeight: 0 }}>
        {/* Uploaded Assets (Live API) */}
        {uploadedList.map((asset) => (
          <div key={asset.assetId} className="card" style={{ padding: 14, borderLeft: '3px solid #1d733c' }}>
            <div className="canvaswrap" style={{ minHeight: 200, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <span className="pill ok" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✓ Sanitized & Admitted</span>
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{asset.filename}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                  SHA-256: {asset.sha256.substring(0, 16)}…
                </div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>{asset.filename}</h3>
            <div className="meta">
              <span className="pill ok">XSS clean</span>
              <span className="pill blue">LIVE API</span>
              <span className="pill">{asset.mimeType.split('/')[1]}</span>
            </div>
          </div>
        ))}

        {/* Card 1 */}
        <div className="card" style={{ padding: 14 }}>
          <div className="canvaswrap" style={{ minHeight: 240 }}>
            <div className="canvas" style={{ width: '55%' }}>
              <div className="t1" dir="rtl" lang="ckb" style={{ fontSize: 24 }}>میوانی نوێ</div>
              <div className="shape"></div>
            </div>
          </div>
          <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Podcast guest · approved</h3>
          <div className="meta">
            <span className="pill ok">editable .hyc</span>
            <span className="pill">Aster</span>
            <span className="pill">ckb</span>
          </div>
        </div>

        {/* Card 2 */}
        <div className="card" style={{ padding: 14 }}>
          <div className="canvaswrap" style={{ minHeight: 240 }}>
            <div className="canvas" style={{ width: '55%', background: 'linear-gradient(135deg, #f4ecdd, #e9b666)' }}>
              <div className="copy" style={{ color: '#17191c', fontSize: 16 }}>SUMMER OFFER</div>
            </div>
          </div>
          <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Retail offer family</h3>
          <div className="meta">
            <span className="pill ok">template v7</span>
            <span className="pill">3 formats</span>
          </div>
        </div>

        {/* Card 3: Retrieval Evidence */}
        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Retrieval evidence</h3>
          <div className="rule">
            <b>Why this appears</b>
            <p>Same client (Aster), campaign type (retail_offer), language (ckb), and active template family. Approved after one revision.</p>
          </div>
          <div className="rule">
            <b>Source integrity</b>
            <p>Design hash, manifest, Drive ID and Client DNA version are available and locked.</p>
          </div>
          <button className="btn" style={{ marginTop: 10 }}>Open semantic source</button>
        </div>
      </div>

      {/* Asset Ingestion & Security Modal */}
      {showUploadModal && (
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
          <div
            className="panel"
            style={{
              width: 540,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <h2 style={{ marginTop: 0 }}>Asset Security & Ingestion</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -4 }}>
              OWASP-compliant SVG sanitization, MIME sniff, and SHA-256 fingerprint verification (Gate N).
            </p>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                Asset Filename
              </label>
              <input
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
              />
            </div>

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 }}>
                SVG Source or Content
              </label>
              <textarea
                style={{
                  width: '100%',
                  height: 100,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  padding: '8px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                }}
                value={assetContent}
                onChange={(e) => setAssetContent(e.target.value)}
              />
            </div>

            {uploadError && (
              <div className="finding" style={{ borderColor: '#dc2626', background: '#fef2f2', margin: '12px 0' }}>
                <b style={{ color: '#991b1b' }}>⚠ Security Policy Violation</b>
                <p style={{ margin: '2px 0', fontSize: 12, color: '#b91c1c' }}>{uploadError}</p>
              </div>
            )}

            {uploadResult && (
              <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', margin: '12px 0' }}>
                <b style={{ color: '#065f46' }}>✓ Asset Admitted & Fingerprinted</b>
                <p style={{ margin: '2px 0', fontSize: 11, color: '#047857' }}>
                  SHA-256: <code>{uploadResult.sha256}</code>
                </p>
                <small style={{ color: '#047857', display: 'block' }}>
                  Storage Key: <code>{uploadResult.storageKey}</code>
                </small>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" onClick={() => setShowUploadModal(false)}>
                {uploadResult ? 'Done' : 'Cancel'}
              </button>
              <button className="btn primary" disabled={isUploading} onClick={handleUploadAsset}>
                {isUploading ? 'Validating & Sanitizing…' : 'Upload & Verify'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

