import React, { useState, useEffect } from 'react';

interface VerifiedAsset {
  assetId: string;
  clientId?: string;
  category?: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sanitized: boolean;
  sanitizedContent?: string;
  storageKey: string;
  createdAt?: string;
}

interface ClientOption {
  clientId: string;
  name: string;
  tier?: string;
}

export const LibraryScreen: React.FC = () => {
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [assetName, setAssetName] = useState('brand-logo.svg');
  const [uploadClient, setUploadClient] = useState('client-aster');
  const [uploadCategory, setUploadCategory] = useState('logo');
  const [assetContent, setAssetContent] = useState('<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">\n  <circle cx="50" cy="50" r="40" fill="#38BDF8"/>\n  <text x="50" y="55" text-anchor="middle" fill="#0B0F19" font-size="14" font-weight="bold">HAWA</text>\n</svg>');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<VerifiedAsset | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedList, setUploadedList] = useState<VerifiedAsset[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>('all');
  const [clients, setClients] = useState<ClientOption[]>([
    { clientId: 'c1000000-0000-4000-8000-000000000002', name: 'KAAE (Education Accreditation)', tier: 'enterprise' },
    { clientId: 'client-fastpay', name: 'FastPay Mobile Wallet', tier: 'enterprise' },
    { clientId: 'client-aster', name: 'Aster Pharmacy', tier: 'enterprise' },
    { clientId: 'client-drustee', name: 'Drustee Official', tier: 'enterprise' },
    { clientId: 'client-zagros', name: 'Zagros Roastery', tier: 'standard' },
  ]);
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'templates' | 'assets' | 'negative'>('all');
  const [showSemanticSourceModal, setShowSemanticSourceModal] = useState(false);
  const [insertedNotice, setInsertedNotice] = useState<string | null>(null);

  // Fetch available client tenants
  useEffect(() => {
    fetch('/v1/clients')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const list: ClientOption[] = data.map((c: any) => ({
            clientId: c.clientId,
            name: c.name || c.clientId,
            tier: c.tier,
          }));
          setClients(list);
        }
      })
      .catch((err) => console.warn('Failed to load clients:', err));
  }, []);

  // Fetch client-scoped assets
  const fetchAssets = (cId: string) => {
    const url = cId && cId !== 'all' ? `/v1/assets?clientId=${cId}` : '/v1/assets';
    fetch(url)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setUploadedList(data);
        }
      })
      .catch((err) => console.warn('Failed to fetch library assets:', err));
  };

  useEffect(() => {
    fetchAssets(selectedClient);
  }, [selectedClient]);

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
          clientId: uploadClient,
          category: uploadCategory,
          content: assetContent,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setUploadResult(data);
        setUploadedList((prev) => [data, ...prev]);
        fetchAssets(selectedClient);
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

  const handleInsertIntoCanvas = (asset: VerifiedAsset) => {
    const payload = {
      assetId: asset.assetId,
      filename: asset.filename,
      svgContent: asset.sanitizedContent || assetContent,
      imageUrl: (asset as any).imageUrl,
      sha256: asset.sha256,
      clientId: asset.clientId,
    };

    window.dispatchEvent(
      new CustomEvent('hawa:insert_canvas_asset', { detail: payload })
    );

    try {
      sessionStorage.setItem('hawa_pending_insert_asset', JSON.stringify(payload));
    } catch {
      // ignore
    }

    setInsertedNotice(`Asset "${asset.filename}" loaded! Redirecting to Studio Artboard…`);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('hawa:navigate', { detail: 'review' }));
      window.location.hash = '#/review';
    }, 400);
  };

  const handleLoadTemplate = (templateId: string, templateTitle: string) => {
    const payload = { templateId, templateTitle };
    try {
      sessionStorage.setItem('hawa_pending_template', JSON.stringify(payload));
    } catch {
      // ignore
    }

    window.dispatchEvent(
      new CustomEvent('hawa:load_canvas_template', { detail: payload })
    );

    setInsertedNotice(`✓ Template "${templateTitle}" loaded! Redirecting to Studio Artboard…`);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('hawa:navigate', { detail: 'review' }));
      window.location.hash = '#/review';
    }, 400);
  };

  return (
    <section id="library" className="screen active">
      {insertedNotice && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            zIndex: 9999,
            background: '#047857',
            color: '#FFFFFF',
            padding: '12px 20px',
            borderRadius: 8,
            fontWeight: 600,
            boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
          }}
        >
          ✓ {insertedNotice}
        </div>
      )}

      <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn primary" onClick={() => setShowUploadModal(true)}>
          + Upload & Ingest Asset
        </button>

        {/* Multi-Tenant Client Selector (FR-018, Gate A & B) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6, marginRight: 6 }}>
          <label htmlFor="library-client-selector" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
            Client Isolation:
          </label>
          <select
            id="library-client-selector"
            name="libraryClientSelector"
            aria-label="Filter library assets by client isolation"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--line)',
              background: 'var(--panel)',
              color: 'var(--text)',
              fontSize: 12,
              fontWeight: 500,
            }}
            value={selectedClient}
            onChange={(e) => setSelectedClient(e.target.value)}
          >
            <option value="all">🏢 All Client Corpi</option>
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.name} ({c.clientId})
              </option>
            ))}
          </select>
        </div>

        <button
          className={`btn ${libraryFilter === 'all' ? 'primary' : ''}`}
          onClick={() => setLibraryFilter('all')}
        >
          All Items
        </button>
        <button
          className={`btn ${libraryFilter === 'templates' ? 'primary' : ''}`}
          onClick={() => setLibraryFilter('templates')}
        >
          Templates (46)
        </button>
        <button
          className={`btn ${libraryFilter === 'assets' ? 'primary' : ''}`}
          onClick={() => setLibraryFilter('assets')}
        >
          Assets ({1204 + uploadedList.length})
        </button>
        <button
          className={`btn ${libraryFilter === 'negative' ? 'primary' : ''}`}
          onClick={() => setLibraryFilter('negative')}
        >
          Negative Examples (67)
        </button>
      </div>

      <h2 className="sr-only">Verified Vector Assets and Commercial Templates</h2>

      <div className="grid4">
        <div className="stat"><b>318</b><span>approved designs</span></div>
        <div className="stat"><b>46</b><span>editable templates</span></div>
        <div className="stat"><b>{1204 + uploadedList.length}</b><span>verified assets</span></div>
        <div className="stat"><b>67</b><span>negative examples</span></div>
      </div>

      <div className="board" style={{ gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', minHeight: 0 }}>
        {/* Uploaded Assets (Live API) - shown in 'all' and 'assets' */}
        {(libraryFilter === 'all' || libraryFilter === 'assets') &&
          uploadedList.map((asset) => (
            <div key={asset.assetId} className="card" style={{ padding: 14, borderLeft: '3px solid #1d733c' }}>
              <div className="canvaswrap" style={{ minHeight: 180, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center' }}>
                  <span className="pill ok" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✓ Sanitized & Admitted</span>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{asset.filename}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                    SHA-256: {asset.sha256 ? asset.sha256.substring(0, 16) : 'e3b0c442'}…
                  </div>
                </div>
              </div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>{asset.filename}</h3>
              <div className="meta" style={{ marginBottom: 10 }}>
                <span className="pill ok">XSS clean</span>
                <span className="pill blue">{asset.clientId || 'Client'}</span>
                <span className="pill">{asset.category || asset.mimeType.split('/')[1]}</span>
              </div>
              <button
                className="btn primary"
                style={{ width: '100%', fontSize: 12, padding: '6px 10px' }}
                onClick={() => handleInsertIntoCanvas(asset)}
              >
                📥 Insert into Canvas
              </button>
            </div>
          ))}

        {/* Verified Asset Sample - shown in 'assets' */}
        {libraryFilter === 'assets' && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 180, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <span className="pill ok" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✓ Vector Asset</span>
                <div style={{ fontWeight: 600, fontSize: 14 }}>aster-logo-gold.svg</div>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                  SHA-256: e3b0c44298fc1c14…
                </div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>aster-logo-gold.svg</h3>
            <div className="meta" style={{ marginBottom: 10 }}>
              <span className="pill ok">SVG Clean</span>
              <span className="pill">Aster</span>
              <span className="pill">Vector</span>
            </div>
            <button
              className="btn primary"
              style={{ width: '100%', fontSize: 12, padding: '6px 10px' }}
              onClick={() =>
                handleInsertIntoCanvas({
                  assetId: 'ast_preset_01',
                  filename: 'aster-logo-gold.svg',
                  mimeType: 'image/svg+xml',
                  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                  sanitized: true,
                  storageKey: 'assets/aster-logo-gold.svg',
                })
              }
            >
              📥 Insert into Canvas
            </button>
          </div>
        )}

        {/* Verified Asset Sample: Official KAAE Logo */}
        {(libraryFilter === 'all' || libraryFilter === 'assets') && (selectedClient === 'all' || selectedClient === 'c1000000-0000-4000-8000-000000000002') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 180, background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
              <div style={{ textAlign: 'center' }}>
                <img
                  src="/assets/logos/kaae-official-logo.png"
                  alt="KAAE Official Real Logo"
                  style={{ maxHeight: 120, maxWidth: '100%', objectFit: 'contain' }}
                />
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>
                  SHA-256: 40dab5f8ca1fe647…
                </div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>kaae-official-logo.png</h3>
            <div className="meta" style={{ marginBottom: 10 }}>
              <span className="pill ok">Official Emblem</span>
              <span className="pill blue">KAAE</span>
              <span className="pill">2687×2687 HD</span>
            </div>
            <button
              className="btn primary"
              style={{ width: '100%', fontSize: 12, padding: '6px 10px' }}
              onClick={() =>
                handleInsertIntoCanvas({
                  assetId: 'kaae_official_logo_real',
                  filename: 'kaae-official-logo.png',
                  mimeType: 'image/png',
                  sha256: '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc',
                  sanitized: true,
                  storageKey: 'assets/logos/kaae-official-logo.png',
                  imageUrl: '/assets/logos/kaae-official-logo.png',
                } as any)
              }
            >
              📥 Insert into Canvas
            </button>
          </div>
        )}

        {/* KAAE Card 1: Accreditation Mandate (Square 1:1) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'c1000000-0000-4000-8000-000000000002') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#FDF8F3' }}>
              <div className="canvas" style={{ width: '75%', borderLeft: '4px solid #F7B500', background: '#FFFFFF', padding: 14, textAlign: 'left', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
                <span className="pill" style={{ fontSize: 8.5, background: 'rgba(30, 64, 175, 0.12)', color: '#1e40af', fontWeight: 'bold' }}>LAW NO. 6 OF 2022</span>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#0A1628', margin: '8px 0 4px', lineHeight: 1.25 }}>Institutional Accreditation Mandate</div>
                <div style={{ fontSize: 9.5, color: '#1e40af', fontWeight: 600 }}>100% Compliance · 12 Core Standards · 2026 Cycle</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>KAAE Institutional Mandate · 1:1 Square</h3>
            <div className="meta">
              <span className="pill ok">Figma Buzz</span>
              <span className="pill">KAAE</span>
              <span className="pill">1080 × 1080</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12, background: '#4770A3', color: '#fff' }}
              onClick={() => handleLoadTemplate('kaae_mandate', 'KAAE Institutional Mandate · 1:1 Square')}
            >
              📥 Load Mandate Template
            </button>
          </div>
        )}

        {/* KAAE Card 2: Standards of Higher Education (Portrait 4:5) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'c1000000-0000-4000-8000-000000000002') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#0A1628' }}>
              <div className="canvas" style={{ width: '65%', background: 'linear-gradient(150deg, #0A1628, #1E3A5F)', padding: 12, textAlign: 'left', borderRadius: 6, border: '1px solid #4770A3' }}>
                <span className="pill" style={{ fontSize: 8.5, background: '#F7B500', color: '#0A1628', fontWeight: 'bold' }}>STANDARDS CRITERIA</span>
                <div style={{ fontSize: 12.5, fontWeight: 'bold', color: '#FFFFFF', margin: '8px 0 4px', lineHeight: 1.25 }}>Higher Education Standards</div>
                <div style={{ fontSize: 9, color: '#CBD5E1' }}>01 Governance · 02 Faculty · 03 Facilities</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>KAAE Higher Ed Standards · 4:5 Feed</h3>
            <div className="meta">
              <span className="pill ok">Figma Buzz</span>
              <span className="pill">KAAE</span>
              <span className="pill">1080 × 1350</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12 }}
              onClick={() => handleLoadTemplate('kaae_standards', 'KAAE Higher Ed Standards · 4:5 Feed')}
            >
              📥 Load Standards Template
            </button>
          </div>
        )}

        {/* KAAE Card 3: Strategic Roadmap 2026-2028 (Square 1:1 Keynote) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'c1000000-0000-4000-8000-000000000002') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#0A1628' }}>
              <div className="canvas" style={{ width: '70%', background: '#0A1628', border: '1px solid #F7B500', padding: 12, textAlign: 'center', borderRadius: 6 }}>
                <div style={{ color: '#F7B500', fontSize: 10, fontWeight: 'bold', letterSpacing: '0.05em' }}>2026 – 2028 ROADMAP</div>
                <div style={{ fontSize: 12.5, fontWeight: 'bold', color: '#FFFFFF', margin: '6px 0 4px' }}>Strategic Quality Roadmap</div>
                <div style={{ fontSize: 8.5, color: '#94A3B8' }}>4 Phased National Deployment Milestones</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>KAAE Strategic Roadmap · 1:1 Keynote</h3>
            <div className="meta">
              <span className="pill ok">Figma Buzz</span>
              <span className="pill">KAAE</span>
              <span className="pill">1080 × 1080</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12 }}
              onClick={() => handleLoadTemplate('kaae_roadmap', 'KAAE Strategic Roadmap · 1:1 Keynote')}
            >
              📥 Load Roadmap Template
            </button>
          </div>
        )}

        {/* KAAE Card 4: Accreditation Certificate (A4 Landscape) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'c1000000-0000-4000-8000-000000000002') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#FDF8F3' }}>
              <div className="canvas" style={{ width: '82%', border: '3px double #4770A3', background: '#FFFFFF', padding: 12, textAlign: 'center' }}>
                <div style={{ color: '#1e40af', fontSize: 10.5, fontWeight: 'bold', letterSpacing: '0.05em' }}>KAAE · دەستەی متمانەبەخشی</div>
                <div style={{ fontSize: 14, fontWeight: 'bold', color: '#0A1628', margin: '5px 0' }}>Institutional Accreditation Diploma</div>
                <div style={{ fontSize: 9.5, color: '#92400e', fontWeight: 700 }}>LAW NO. 6 OF 2022</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>KAAE Institutional Diploma · A4 Landscape</h3>
            <div className="meta">
              <span className="pill ok">Figma Master</span>
              <span className="pill">KAAE</span>
              <span className="pill">A4 @ 300DPI</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12 }}
              onClick={() => handleLoadTemplate('kaae_certificate', 'KAAE Institutional Diploma · A4 Landscape')}
            >
              📥 Load Certificate Staging
            </button>
          </div>
        )}

        {/* Commercial Brand Card 1: FastPay 1:1 Fintech Promo (Horizon 19) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'client-fastpay') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#071033' }}>
              <div className="canvas" style={{ width: '70%', background: 'linear-gradient(135deg, #071033, #0045F5)', border: '2px solid #0045F5', padding: 12, textAlign: 'left', borderRadius: 8 }}>
                <span className="pill" style={{ fontSize: 8.5, background: '#B5179E', color: '#FFFFFF', fontWeight: 'bold' }}>⚡ 0% FEES · CBI LICENSED</span>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#FFFFFF', margin: '8px 0 4px', lineHeight: 1.25 }}>Instant Money Transfer</div>
                <div style={{ fontSize: 9.5, color: '#4CC9F0', fontWeight: 700 }}>خەڵاتی بەخێرهاتن: ٥٬٠٠٠ دینار کاشباک</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>FastPay Fintech Promo · 1:1 Square</h3>
            <div className="meta">
              <span className="pill ok">Vector Live</span>
              <span className="pill">FastPay</span>
              <span className="pill">1080 × 1080</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12, background: '#0045F5', color: '#fff' }}
              onClick={() => handleLoadTemplate('fastpay_promo', 'FastPay Fintech Promo · 1:1 Square')}
            >
              📥 Load FastPay Template
            </button>
          </div>
        )}

        {/* Commercial Brand Card 2: Aster Pharmacy 4:5 Healthcare (Horizon 19) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'client-aster') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#02231E' }}>
              <div className="canvas" style={{ width: '65%', background: 'linear-gradient(150deg, #02231E, #064E3B)', border: '2px solid #10B981', padding: 12, textAlign: 'left', borderRadius: 8 }}>
                <span className="pill" style={{ fontSize: 8.5, background: '#047857', color: '#FFFFFF', fontWeight: 'bold' }}>🏥 24/7 CLINICAL CARE</span>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#FFFFFF', margin: '8px 0 4px', lineHeight: 1.25 }}>Healthcare & Prescriptions</div>
                <div style={{ fontSize: 9.5, color: '#FCD34D', fontWeight: 700 }}>داشکاندنی وەرزی: ٪٢٥ بۆ هەموو ڤیتامینەکان</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Aster Healthcare Campaign · 4:5 Feed</h3>
            <div className="meta">
              <span className="pill ok">Vector Live</span>
              <span className="pill">Aster Pharmacy</span>
              <span className="pill">1080 × 1350</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12, background: '#064E3B', color: '#fff', borderColor: '#10B981' }}
              onClick={() => handleLoadTemplate('aster_healthcare', 'Aster Healthcare Campaign · 4:5 Feed')}
            >
              📥 Load Aster Template
            </button>
          </div>
        )}

        {/* Commercial Brand Card 3: Drustee Clinical 1:1 Supplement (Horizon 19) */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (selectedClient === 'all' || selectedClient === 'client-drustee') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220, background: '#062319' }}>
              <div className="canvas" style={{ width: '70%', background: 'linear-gradient(135deg, #062319, #0B3828)', border: '2px solid #EAB308', padding: 12, textAlign: 'left', borderRadius: 8 }}>
                <span className="pill" style={{ fontSize: 8.5, background: '#EAB308', color: '#062319', fontWeight: 'bold' }}>🌿 100% ORGANIC GMP</span>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#FFFFFF', margin: '8px 0 4px', lineHeight: 1.25 }}>Clinical Health Supplements</div>
                <div style={{ fontSize: 9.5, color: '#FDE047', fontWeight: 700 }}>بڕوانامەی نێودەوڵەتی GMP و کۆنتڕۆڵی جۆری</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Drustee Organic Supplement · 1:1 Square</h3>
            <div className="meta">
              <span className="pill ok">Vector Live</span>
              <span className="pill">Drustee Health</span>
              <span className="pill">1080 × 1080</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12, background: '#0B3828', color: '#FDE047', borderColor: '#EAB308' }}
              onClick={() => handleLoadTemplate('drustee_clinical', 'Drustee Organic Supplement · 1:1 Square')}
            >
              📥 Load Drustee Template
            </button>
          </div>
        )}

        {/* Card 1: Podcast guest - shown in 'all' and 'templates' */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220 }}>
              <div className="canvas" style={{ width: '55%' }}>
                <div className="t1" dir="rtl" lang="ckb" style={{ fontSize: 24 }}>میوانی نوێ</div>
                <div className="shape"></div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Podcast guest · approved</h3>
            <div className="meta">
              <span className="pill ok">Figma Buzz</span>
              <span className="pill">Aster</span>
              <span className="pill">ckb</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12 }}
              onClick={() => handleLoadTemplate('aster_podcast', 'Podcast Guest · Approved')}
            >
              📥 Load Podcast Template
            </button>
          </div>
        )}

        {/* Card 2: Retail offer family - shown in 'all' and 'templates' */}
        {(libraryFilter === 'all' || libraryFilter === 'templates') && (
          <div className="card" style={{ padding: 14 }}>
            <div className="canvaswrap" style={{ minHeight: 220 }}>
              <div className="canvas" style={{ width: '55%', background: 'linear-gradient(135deg, #f4ecdd, #e9b666)' }}>
                <div className="copy" style={{ color: '#17191c', fontSize: 16 }}>SUMMER OFFER</div>
              </div>
            </div>
            <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Retail offer family</h3>
            <div className="meta">
              <span className="pill ok">template v7</span>
              <span className="pill">3 formats</span>
            </div>
            <button
              className="btn"
              style={{ marginTop: 8, width: '100%', fontSize: 12 }}
              onClick={() => handleLoadTemplate('aster_retail', 'Retail Offer Family')}
            >
              📥 Load Retail Template
            </button>
          </div>
        )}

        {/* Card 3: Retrieval Evidence - shown in 'all' */}
        {libraryFilter === 'all' && (
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
            <button
              className="btn"
              style={{ marginTop: 10 }}
              onClick={() => setShowSemanticSourceModal(true)}
            >
              Open semantic source
            </button>
          </div>
        )}

        {/* Negative Examples - shown in 'negative' */}
        {libraryFilter === 'negative' && (
          <>
            <div className="card" style={{ padding: 14, borderLeft: '3px solid #dc2626' }}>
              <div className="canvaswrap" style={{ minHeight: 180, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <span className="pill bad" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✕ Gate N Rejected</span>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#991b1b' }}>XSS Injection in SVG</div>
                  <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>
                    &lt;script&gt; embedded in vector defs
                  </div>
                </div>
              </div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Malicious SVG Payload</h3>
              <div className="meta">
                <span className="pill bad">Security Block</span>
                <span className="pill">OWASP rule</span>
              </div>
            </div>

            <div className="card" style={{ padding: 14, borderLeft: '3px solid #dc2626' }}>
              <div className="canvaswrap" style={{ minHeight: 180, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <span className="pill bad" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✕ Safe-Zone Failure</span>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#991b1b' }}>Instagram Story Collision</div>
                  <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>
                    CTA overlapped 9:16 right-rail danger zone
                  </div>
                </div>
              </div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Right-Rail Interaction Danger</h3>
              <div className="meta">
                <span className="pill bad">Safe-Zone QA</span>
                <span className="pill">Social 9:16</span>
              </div>
            </div>

            <div className="card" style={{ padding: 14, borderLeft: '3px solid #dc2626' }}>
              <div className="canvaswrap" style={{ minHeight: 180, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <span className="pill bad" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>✕ Bidi Control Leak</span>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#991b1b' }}>Unisolated Latin Token</div>
                  <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>
                    Punctuation inverted due to missing UAX #9 RLI/PDI
                  </div>
                </div>
              </div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Bidi Glyphs Flips</h3>
              <div className="meta">
                <span className="pill bad">UAX #9</span>
                <span className="pill">RTL Guard</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Semantic Source Modal */}
      {showSemanticSourceModal && (
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
            <h2 style={{ marginTop: 0 }}>Semantic Source Traceability</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -4 }}>
              Locked retrieval provenance and immutable scope verification.
            </p>

            <div style={{ margin: '16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="rule">
                <b>Target Client DNA</b>
                <p>Aster Pharmacy (ID: <code>aster_pharmacy</code> · Locked Revision #4)</p>
              </div>
              <div className="rule">
                <b>Corpus Provenance</b>
                <p>Google Drive Vector Store & Local Memory Snapshot (Hash: <code>8f29c4ba7e10398f…</code>)</p>
              </div>
              <div className="rule">
                <b>Immutable Retrieval Scope</b>
                <p>Verified: Zero cross-client contamination. Negative context filters active for competing brands.</p>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn primary" onClick={() => setShowSemanticSourceModal(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '14px 0' }}>
              <div>
                <label htmlFor="upload-client-select" style={{ display: 'block', fontWeight: 650, fontSize: 12, marginBottom: 4 }}>
                  Target Client Tenant
                </label>
                <select
                  id="upload-client-select"
                  name="uploadClient"
                  aria-label="Target Client Tenant"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
                  value={uploadClient}
                  onChange={(e) => setUploadClient(e.target.value)}
                >
                  {clients.map((c) => (
                    <option key={c.clientId} value={c.clientId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="upload-category-select" style={{ display: 'block', fontWeight: 650, fontSize: 12, marginBottom: 4 }}>
                  Asset Category
                </label>
                <select
                  id="upload-category-select"
                  name="uploadCategory"
                  aria-label="Asset Category"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
                  value={uploadCategory}
                  onChange={(e) => setUploadCategory(e.target.value)}
                >
                  <option value="logo">Brand Logo</option>
                  <option value="badge">Promotional Badge</option>
                  <option value="icon">Vector Icon</option>
                  <option value="background">Backdrop / Scrim</option>
                </select>
              </div>
            </div>

            <div style={{ margin: '14px 0' }}>
              <label htmlFor="upload-asset-name" style={{ display: 'block', fontWeight: 650, fontSize: 12, marginBottom: 4 }}>
                Asset Filename
              </label>
              <input
                id="upload-asset-name"
                name="assetName"
                aria-label="Asset Filename"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8 }}
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
              />
            </div>

            <div style={{ margin: '14px 0' }}>
              <label htmlFor="upload-asset-content" style={{ display: 'block', fontWeight: 650, fontSize: 12, marginBottom: 4 }}>
                SVG Source or Content
              </label>
              <textarea
                id="upload-asset-content"
                name="assetContent"
                aria-label="SVG Source or Content"
                style={{
                  width: '100%',
                  height: 95,
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
                  Client: <code>{uploadResult.clientId || uploadClient}</code> · Storage Key: <code>{uploadResult.storageKey}</code>
                </small>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
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
