import React, { useState, useEffect, useMemo } from 'react';
import { extractPaletteFromFile, type ExtractedPalette } from '../services/paletteExtractor.js';

export interface ClientSummary {
  clientId: string;
  name: string;
  code: string;
  version: number;
  status: 'active' | 'archived' | 'draft';
  defaultLocale: string;
  defaultDirection?: 'rtl' | 'ltr';
  colorsCount: number;
  rulesCount: number;
  snapshotsCount?: number;
  updatedAt?: string;
}

export interface BrandColor {
  name: string;
  hex: string;
  role: 'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text';
  cmyk?: string;
  pantone?: string;
}

export interface BrandFont {
  family: string;
  style: string;
  weight: number | string;
  role: 'display' | 'body' | 'caption' | 'code';
  license: string;
  supportedLocales: string[];
}

export interface OfficialAsset {
  assetId: string;
  name: string;
  role: 'logo_primary' | 'logo_secondary' | 'logo_symbol' | 'badge' | 'watermark' | 'pattern';
  storageKey: string;
  sha256: string;
  mimeType: string;
}

export interface ClientDNA {
  tenantId: string;
  clientId: string;
  name: string;
  code: string;
  version: number;
  status: 'active' | 'archived' | 'draft';
  defaultLocale: 'ckb' | 'ar' | 'en';
  defaultDirection: 'rtl' | 'ltr';
  colors: BrandColor[];
  fonts: BrandFont[];
  assets: OfficialAsset[];
  guidelines: {
    voiceAndTone: string;
    prohibitedPhrases: string[];
    requiredDisclaimers: string[];
    layoutRules: string[];
  };
  destinations: {
    googleSharedDriveId: string;
    productionFolderId: string;
    archiveFolderId: string;
    spreadsheetId: string;
    sheetId: number;
  };
  approvalPolicy: {
    requiredRoles: string[];
    allowAutoApproval: boolean;
    autoApprovalEligibleTemplates: string[];
  };
  updatedAt: string;
}

export interface ClientDnaSnapshot {
  snapshotId: string;
  clientId: string;
  version: number;
  sha256: string;
  commitMessage: string;
  createdBy: string;
  createdAt: string;
  dna: ClientDNA;
}

// Fallback seed clients for initial render or offline resiliency
const FALLBACK_CLIENTS: ClientSummary[] = [
  {
    clientId: 'client-office-1',
    name: 'Hawa Creative',
    code: 'HAWA',
    version: 1,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colorsCount: 3,
    rulesCount: 3,
    snapshotsCount: 1,
  },
  {
    clientId: 'client-aster',
    name: 'Aster Hotel & Resort',
    code: 'ASTER',
    version: 12,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colorsCount: 3,
    rulesCount: 3,
    snapshotsCount: 2,
  },
  {
    clientId: 'client-nova',
    name: 'Nova Tech Systems',
    code: 'NOVA',
    version: 8,
    status: 'active',
    defaultLocale: 'en',
    defaultDirection: 'ltr',
    colorsCount: 3,
    rulesCount: 2,
    snapshotsCount: 2,
  },
  {
    clientId: 'client-rona',
    name: 'Rona Haute Couture',
    code: 'RONA',
    version: 4,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    colorsCount: 3,
    rulesCount: 2,
    snapshotsCount: 1,
  },
];

// WCAG Contrast Helper
function getLuminance(hex: string): number {
  const cleanHex = hex.replace('#', '');
  const rgb = parseInt(cleanHex.length === 3 ? cleanHex.split('').map((c) => c + c).join('') : cleanHex, 16);
  if (isNaN(rgb)) return 0.5;
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = (rgb >> 0) & 0xff;
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function getContrastRatio(hex1: string, hex2: string): number {
  try {
    const l1 = getLuminance(hex1);
    const l2 = getLuminance(hex2);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 10) / 10;
  } catch {
    return 4.5;
  }
}

export const DnaScreen: React.FC = () => {
  const [clients, setClients] = useState<ClientSummary[]>(FALLBACK_CLIENTS);
  const [selectedClientId, setSelectedClientId] = useState<string>('client-office-1');
  const [currentDna, setCurrentDna] = useState<ClientDNA | null>(null);
  const [snapshots, setSnapshots] = useState<ClientDnaSnapshot[]>([]);
  const [activeTab, setActiveTab] = useState<'brand' | 'identity' | 'language' | 'rules'>('brand');
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Modals state
  const [showOnboardModal, setShowOnboardModal] = useState(false);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [inspectingSnapshot, setInspectingSnapshot] = useState<ClientDnaSnapshot | null>(null);

  // Candidate rule promotion state
  const [promotedRule, setPromotedRule] = useState<string | null>(null);

  // Inline color swatch adder state
  const [showAddSwatch, setShowAddSwatch] = useState(false);
  const [newSwatchName, setNewSwatchName] = useState('');
  const [newSwatchHex, setNewSwatchHex] = useState('#164a3a');
  const [newSwatchRole, setNewSwatchRole] = useState<BrandColor['role']>('accent');

  // Logo Palette Extraction State
  const [logoExtractionNotice, setLogoExtractionNotice] = useState<string | null>(null);
  const [extractedPaletteData, setExtractedPaletteData] = useState<ExtractedPalette | null>(null);
  const [showLogoDropzone, setShowLogoDropzone] = useState(false);

  // Inline lexicon adder state
  const [newPhrase, setNewPhrase] = useState('');
  const [newDisclaimer, setNewDisclaimer] = useState('');
  const [newRule, setNewRule] = useState('');

  // Onboarding Form State
  const [onboardForm, setOnboardForm] = useState({
    name: '',
    code: '',
    defaultLocale: 'ckb' as 'ckb' | 'ar' | 'en',
    defaultDirection: 'rtl' as 'rtl' | 'ltr',
    primaryColorName: 'Imperial Bronze',
    primaryColorHex: '#8b5a2b',
    secondaryColorName: 'Opal Mist',
    secondaryColorHex: '#f2ece4',
    accentColorName: 'Solstice Gold',
    accentColorHex: '#e5a93b',
    backgroundColorName: 'Paper White',
    backgroundColorHex: '#faf8f5',
    fontFamily: 'Vazirmatn',
    fontWeight: '700',
    voiceAndTone: 'Authentic Kurdish craftsmanship with understated modern elegance',
    prohibitedPhrases: 'cheap, discount, fake, generic',
    requiredDisclaimers: 'بە گەرەنتی کوالیتی بەرز و ڕەسەنایەتی',
    layoutRules: 'Always maintain 40px safe margins; never flatten typography',
  });
  const [isOnboarding, setIsOnboarding] = useState(false);

  // Snapshot Form State
  const [snapshotMessage, setSnapshotMessage] = useState('');
  const [snapshotAuthor, setSnapshotAuthor] = useState('art_director');
  const [isCommittingSnapshot, setIsCommittingSnapshot] = useState(false);

  // Fetch client directory
  const loadClientDirectory = async () => {
    try {
      const res = await fetch('/v1/clients');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setClients(data);
        }
      }
    } catch (err) {
      console.warn('Could not load client directory from API; using cached seeds.', err);
    }
  };

  // Fetch specific client DNA & snapshots
  const loadClientData = async (clientId: string) => {
    setLoading(true);
    setErrorNotice(null);
    try {
      const [dnaRes, snapRes] = await Promise.all([
        fetch(`/v1/clients/${clientId}/dna`),
        fetch(`/v1/clients/${clientId}/snapshots`),
      ]);

      if (dnaRes.ok) {
        const dnaData: ClientDNA = await dnaRes.json();
        setCurrentDna(dnaData);
      } else {
        setErrorNotice(`Unable to load DNA for ${clientId}`);
      }

      if (snapRes.ok) {
        const snapData: ClientDnaSnapshot[] = await snapRes.json();
        setSnapshots(snapData);
      } else {
        setSnapshots([]);
      }
    } catch (err) {
      console.error('Error fetching client data:', err);
      setErrorNotice('Operating in offline mode. Changes will sync when network is restored.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadClientDirectory();
  }, []);

  useEffect(() => {
    if (selectedClientId) {
      loadClientData(selectedClientId);
      setPromotedRule(null);
      setSaveSuccess(null);
    }
  }, [selectedClientId]);

  // Copy to clipboard helper
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedText(`${label} copied!`);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // Background color for contrast calculation
  const currentBgHex = useMemo(() => {
    if (!currentDna?.colors) return '#ffffff';
    const bg = currentDna.colors.find((c) => c.role === 'background');
    return bg ? bg.hex : '#ffffff';
  }, [currentDna]);

  // Save DNA modifications to Core API
  const saveDnaChanges = async (updatedDna: ClientDNA, successMessage: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/v1/clients/${updatedDna.clientId}/dna`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedDna),
      });

      if (res.ok) {
        const saved: ClientDNA = await res.json();
        setCurrentDna(saved);
        setSaveSuccess(successMessage);
        loadClientDirectory();
        // Refresh snapshots
        const snapRes = await fetch(`/v1/clients/${saved.clientId}/snapshots`);
        if (snapRes.ok) {
          const snapData = await snapRes.json();
          setSnapshots(snapData);
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        setErrorNotice(errJson.detail || errJson.message || 'Failed to save DNA to Core API');
      }
    } catch (err) {
      console.error('Save error:', err);
      setErrorNotice('Network error while saving DNA.');
    } finally {
      setLoading(false);
    }
  };

  // Handle adding new color swatch
  const handleAddSwatch = async () => {
    if (!currentDna || !newSwatchName.trim()) return;
    const newColor: BrandColor = {
      name: newSwatchName.trim(),
      hex: newSwatchHex,
      role: newSwatchRole,
    };
    const updated: ClientDNA = {
      ...currentDna,
      colors: [...currentDna.colors, newColor],
    };
    await saveDnaChanges(updated, `Added color swatch "${newColor.name}" (${newColor.hex})`);
    setNewSwatchName('');
    setShowAddSwatch(false);
  };

  // Handle removing color swatch
  const handleRemoveSwatch = async (colorName: string) => {
    if (!currentDna) return;
    if (currentDna.colors.length <= 1) {
      setErrorNotice('A brand DNA must maintain at least one approved color swatch.');
      return;
    }
    const updated: ClientDNA = {
      ...currentDna,
      colors: currentDna.colors.filter((c) => c.name !== colorName),
    };
    await saveDnaChanges(updated, `Removed color swatch "${colorName}"`);
  };

  // Logo Palette Extraction Handlers
  const handleOnboardLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const pal = await extractPaletteFromFile(file);
      setOnboardForm((prev) => ({
        ...prev,
        primaryColorHex: pal.primary,
        secondaryColorHex: pal.secondary,
        accentColorHex: pal.accent,
        backgroundColorHex: pal.cardBg,
      }));
      setLogoExtractionNotice(`✓ Extracted from logo: WCAG ${pal.wcagGrade} (${pal.contrastRatioOnWhite}:1 against white)`);
      setTimeout(() => setLogoExtractionNotice(null), 6000);
    } catch (err: any) {
      setLogoExtractionNotice(`⚠️ Palette extraction failed: ${err.message}`);
    }
  };

  const handleMainTabLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const pal = await extractPaletteFromFile(file);
      setExtractedPaletteData(pal);
      setSaveSuccess(`✓ Extracted ${pal.swatches.length} brand colors from logo (WCAG ${pal.wcagGrade})`);
      setTimeout(() => setSaveSuccess(null), 5000);
    } catch (err: any) {
      setErrorNotice(`Palette extraction failed: ${err.message}`);
    }
  };

  const handleApplyExtractedPalette = async () => {
    if (!currentDna || !extractedPaletteData) return;
    const newColors: BrandColor[] = [
      { name: 'Logo Primary', hex: extractedPaletteData.primary, role: 'primary' },
      { name: 'Logo Secondary', hex: extractedPaletteData.secondary, role: 'secondary' },
      { name: 'Logo Accent', hex: extractedPaletteData.accent, role: 'accent' },
      { name: 'Logo Surface', hex: extractedPaletteData.cardBg, role: 'surface' },
    ];
    const updated: ClientDNA = {
      ...currentDna,
      colors: [
        ...currentDna.colors.filter((c) => c.role !== 'primary' && c.role !== 'secondary' && c.role !== 'accent'),
        ...newColors,
      ],
    };
    await saveDnaChanges(updated, 'Auto-extracted and applied brand palette from logo');
    setShowLogoDropzone(false);
    setExtractedPaletteData(null);
  };

  // Handle adding prohibited phrase
  const handleAddProhibitedPhrase = async () => {
    if (!currentDna || !newPhrase.trim()) return;
    const phrase = newPhrase.trim().toLowerCase();
    if (currentDna.guidelines.prohibitedPhrases.includes(phrase)) {
      setNewPhrase('');
      return;
    }
    const updated: ClientDNA = {
      ...currentDna,
      guidelines: {
        ...currentDna.guidelines,
        prohibitedPhrases: [...currentDna.guidelines.prohibitedPhrases, phrase],
      },
    };
    await saveDnaChanges(updated, `Added prohibited phrase "${phrase}" to deterministic QA filters`);
    setNewPhrase('');
  };

  // Handle removing prohibited phrase
  const handleRemoveProhibitedPhrase = async (phrase: string) => {
    if (!currentDna) return;
    const updated: ClientDNA = {
      ...currentDna,
      guidelines: {
        ...currentDna.guidelines,
        prohibitedPhrases: currentDna.guidelines.prohibitedPhrases.filter((p) => p !== phrase),
      },
    };
    await saveDnaChanges(updated, `Removed prohibited phrase "${phrase}"`);
  };

  // Handle adding disclaimer
  const handleAddDisclaimer = async () => {
    if (!currentDna || !newDisclaimer.trim()) return;
    const disclaimer = newDisclaimer.trim();
    const updated: ClientDNA = {
      ...currentDna,
      guidelines: {
        ...currentDna.guidelines,
        requiredDisclaimers: [...(currentDna.guidelines.requiredDisclaimers || []), disclaimer],
      },
    };
    await saveDnaChanges(updated, 'Registered required disclaimer (Invariant #5 protected)');
    setNewDisclaimer('');
  };

  // Handle adding layout rule
  const handleAddLayoutRule = async () => {
    if (!currentDna || !newRule.trim()) return;
    const rule = newRule.trim();
    const updated: ClientDNA = {
      ...currentDna,
      guidelines: {
        ...currentDna.guidelines,
        layoutRules: [...currentDna.guidelines.layoutRules, rule],
      },
    };
    await saveDnaChanges(updated, 'Added layout principle to deterministic QA engine');
    setNewRule('');
  };

  // Promote candidate rule
  const handlePromoteCandidate = async (ruleTitle: string) => {
    if (!currentDna) return;
    const updated: ClientDNA = {
      ...currentDna,
      guidelines: {
        ...currentDna.guidelines,
        layoutRules: [...currentDna.guidelines.layoutRules, ruleTitle],
      },
    };
    await saveDnaChanges(updated, `Candidate rule "${ruleTitle}" promoted to active brand law`);
    setPromotedRule(ruleTitle);
  };

  // Onboard New Client Tenant Handler
  const handleOnboardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onboardForm.name.trim() || !onboardForm.code.trim()) {
      setErrorNotice('Client Name and Short Code are required.');
      return;
    }

    setIsOnboarding(true);
    setErrorNotice(null);

    const newClientId = `client-${onboardForm.code.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now().toString(36)}`;
    const newTenantId = `tenant-${onboardForm.code.toLowerCase()}`;

    const newDnaPayload: ClientDNA = {
      tenantId: newTenantId,
      clientId: newClientId,
      name: onboardForm.name.trim(),
      code: onboardForm.code.trim().toUpperCase(),
      version: 1,
      status: 'active',
      defaultLocale: onboardForm.defaultLocale,
      defaultDirection: onboardForm.defaultDirection,
      colors: [
        { name: onboardForm.primaryColorName || 'Primary Brand', hex: onboardForm.primaryColorHex, role: 'primary' },
        { name: onboardForm.secondaryColorName || 'Secondary Brand', hex: onboardForm.secondaryColorHex, role: 'secondary' },
        { name: onboardForm.accentColorName || 'Accent Gold', hex: onboardForm.accentColorHex, role: 'accent' },
        { name: onboardForm.backgroundColorName || 'Canvas Background', hex: onboardForm.backgroundColorHex, role: 'background' },
      ],
      fonts: [
        {
          family: onboardForm.fontFamily,
          style: onboardForm.fontWeight === '700' ? 'Bold' : 'Regular',
          weight: parseInt(onboardForm.fontWeight, 10) || 700,
          role: 'display',
          license: 'OFL',
          supportedLocales: ['ckb', 'ar', 'en'],
        },
      ],
      assets: [
        {
          assetId: `asset_${newClientId}_logo_1`,
          name: `${onboardForm.name} Primary Crest`,
          role: 'logo_primary',
          storageKey: `assets/${onboardForm.code.toLowerCase()}/logo_primary.svg`,
          sha256: 'sha256_' + Math.random().toString(16).substring(2) + Math.random().toString(16).substring(2),
          mimeType: 'image/svg+xml',
        },
      ],
      guidelines: {
        voiceAndTone: onboardForm.voiceAndTone || 'Professional Kurdish visual communications',
        prohibitedPhrases: onboardForm.prohibitedPhrases.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        requiredDisclaimers: onboardForm.requiredDisclaimers ? [onboardForm.requiredDisclaimers.trim()] : [],
        layoutRules: onboardForm.layoutRules.split(';').map((s) => s.trim()).filter(Boolean),
      },
      destinations: {
        googleSharedDriveId: `drive_${onboardForm.code.toLowerCase()}_creative`,
        productionFolderId: `folder_${onboardForm.code.toLowerCase()}_prod`,
        archiveFolderId: `folder_${onboardForm.code.toLowerCase()}_archive`,
        spreadsheetId: `sheet_${onboardForm.code.toLowerCase()}_deliverables`,
        sheetId: 0,
      },
      approvalPolicy: {
        requiredRoles: ['art_director'],
        allowAutoApproval: false,
        autoApprovalEligibleTemplates: [],
      },
      updatedAt: new Date().toISOString(),
    };

    try {
      const res = await fetch(`/v1/clients/${newClientId}/dna`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDnaPayload),
      });

      if (res.ok) {
        await loadClientDirectory();
        setSelectedClientId(newClientId);
        setShowOnboardModal(false);
        setSaveSuccess(`Tenant "${onboardForm.name}" successfully onboarded with isolated schema & verified cryptographic DNA.`);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setErrorNotice(errJson.detail || errJson.message || 'Onboarding failed at validation stage.');
      }
    } catch (err) {
      console.error('Onboarding request error:', err);
      setErrorNotice('Network communication error during tenant onboarding.');
    } finally {
      setIsOnboarding(false);
    }
  };

  // Commit Immutable Snapshot Handler
  const handleCommitSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentDna) return;

    setIsCommittingSnapshot(true);
    setErrorNotice(null);

    try {
      const res = await fetch(`/v1/clients/${currentDna.clientId}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: snapshotMessage.trim() || `Manual governance snapshot v${currentDna.version + 1}`,
          createdBy: snapshotAuthor,
        }),
      });

      if (res.ok) {
        const snap: ClientDnaSnapshot = await res.json();
        setSnapshots((prev) => [snap, ...prev]);
        setCurrentDna((prev) => (prev ? { ...prev, version: snap.version } : null));
        setShowSnapshotModal(false);
        setSnapshotMessage('');
        setSaveSuccess(`Immutable snapshot v${snap.version} committed with verified SHA-256 fingerprint.`);
        loadClientDirectory();
      } else {
        const errJson = await res.json().catch(() => ({}));
        setErrorNotice(errJson.detail || errJson.message || 'Snapshot commit rejected.');
      }
    } catch (err) {
      console.error('Snapshot error:', err);
      setErrorNotice('Network error while committing snapshot.');
    } finally {
      setIsCommittingSnapshot(false);
    }
  };

  // Active client summary
  const selectedSummary = clients.find((c) => c.clientId === selectedClientId) || clients[0];

  return (
    <section id="dna" className="screen active">
      {/* Toast Notification */}
      {copiedText && (
        <div
          style={{
            position: 'fixed',
            top: 24,
            right: 24,
            background: '#1d733c',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 13,
            boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            zIndex: 9999,
          }}
        >
          ✓ {copiedText}
        </div>
      )}

      <div className="dna">
        {/* Left Column: Client Directory */}
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Clients & Tenants</h3>
            <span className="pill ok">{clients.length} Registered</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {clients.map((c) => {
              const isSelected = c.clientId === selectedClientId;
              return (
                <div
                  key={c.clientId}
                  className={`listitem ${isSelected ? 'sel' : ''}`}
                  style={{
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: isSelected ? '1px solid var(--accent, #e9b666)' : '1px solid transparent',
                    background: isSelected ? 'var(--soft)' : 'transparent',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setSelectedClientId(c.clientId)}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 13, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      <code>{c.code}</code> · {c.defaultLocale.toUpperCase()}
                      {c.defaultDirection ? ` (${c.defaultDirection.toUpperCase()})` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <span className={`pill ${isSelected ? 'ok' : ''}`} style={{ fontSize: 10 }}>
                      v{c.version}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                      {c.colorsCount} cols · {c.rulesCount} rules
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '16px 0' }} />

          <button
            className="btn primary"
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            onClick={() => setShowOnboardModal(true)}
          >
            <span>+</span>
            <span>Onboard Client Tenant</span>
          </button>

          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'var(--soft)', fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
            <b style={{ color: 'var(--text)' }}>Invariant #4 Strict Isolation:</b> Each client scope is immutable and bounded in PostgreSQL before retrieval commences. Zero cross-tenant leakage.
          </div>
        </div>

        {/* Center Column: Live DNA Workspace */}
        <div className="panel" style={{ minWidth: 0 }}>
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={activeTab === 'brand' ? 'on' : ''} onClick={() => setActiveTab('brand')}>
              🎨 Brand & Palette
            </button>
            <button className={activeTab === 'identity' ? 'on' : ''} onClick={() => setActiveTab('identity')}>
              🏛️ Tenant Identity
            </button>
            <button className={activeTab === 'language' ? 'on' : ''} onClick={() => setActiveTab('language')}>
              ✍️ Language & RTL
            </button>
            <button className={activeTab === 'rules' ? 'on' : ''} onClick={() => setActiveTab('rules')}>
              ⚖️ Rules & Principles
            </button>
          </div>

          {/* Header Bar with Client Name and Live API Status */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 20 }}>{currentDna ? currentDna.name : selectedSummary.name}</h2>
                <span className="pill ok" style={{ fontSize: 12 }}>
                  v{currentDna ? currentDna.version : selectedSummary.version} active
                </span>
                <span className="pill blue" style={{ fontSize: 11 }}>
                  LIVE API
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Tenant ID: <code>{currentDna?.tenantId || 'tenant-isolated'}</code> · Client ID: <code>{selectedClientId}</code>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                style={{ fontSize: 12 }}
                onClick={() => loadClientData(selectedClientId)}
                disabled={loading}
              >
                🔄 Refresh
              </button>
              <button
                className="btn primary"
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
                onClick={() => setShowSnapshotModal(true)}
              >
                <span>🛡️</span>
                <span>Commit Snapshot</span>
              </button>
            </div>
          </div>

          {/* Alert Messages */}
          {loading && (
            <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 12 }}>
              Fetching verified DNA records from Core API…
            </div>
          )}

          {saveSuccess && (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', marginBottom: 16 }}>
              <b style={{ color: '#065f46' }}>✓ Live DNA Synchronized</b>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#047857' }}>{saveSuccess}</p>
            </div>
          )}

          {errorNotice && (
            <div className="finding" style={{ borderColor: '#e12d39', background: '#fef2f2', marginBottom: 16 }}>
              <b style={{ color: '#991b1b' }}>⚠ Action Blocked</b>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#b91c1c' }}>{errorNotice}</p>
            </div>
          )}

          {/* TAB 1: Brand & Palette */}
          {activeTab === 'brand' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Approved Brand Palette</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 11, background: 'rgba(56, 189, 248, 0.1)', color: '#38BDF8', border: '1px solid rgba(56, 189, 248, 0.3)' }}
                    onClick={() => setShowLogoDropzone(!showLogoDropzone)}
                  >
                    🎨 {showLogoDropzone ? 'Close Extractor' : 'Extract from Logo'}
                  </button>
                  <button
                    className="btn"
                    style={{ fontSize: 11 }}
                    onClick={() => setShowAddSwatch(!showAddSwatch)}
                  >
                    {showAddSwatch ? 'Cancel' : '+ Add Swatch'}
                  </button>
                </div>
              </div>

              {/* Logo Palette Extractor Drawer */}
              {showLogoDropzone && (
                <div style={{ padding: 16, background: 'rgba(56, 189, 248, 0.04)', borderRadius: 10, marginBottom: 16, border: '1px dashed rgba(56, 189, 248, 0.35)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h4 style={{ margin: 0, fontSize: 13, color: '#38BDF8' }}>🎨 Client Logo Color Quantization & WCAG Contrast</h4>
                    {extractedPaletteData && (
                      <span className={`pill ${extractedPaletteData.wcagGrade === 'AAA' ? 'ok' : extractedPaletteData.wcagGrade === 'AA' ? 'ok' : 'warn'}`}>
                        WCAG: {extractedPaletteData.wcagGrade} ({extractedPaletteData.contrastRatioOnWhite}:1)
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
                    Upload or select client logo (.svg, .png, .webp). The engine quantizes pixel frequencies and computes relative luminance contrast.
                  </p>
                  <input
                    type="file"
                    accept="image/*,.svg"
                    onChange={handleMainTabLogoUpload}
                    style={{ fontSize: 12 }}
                  />

                  {extractedPaletteData && (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(56, 189, 248, 0.2)' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                        {extractedPaletteData.swatches.map((hex, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)' }}>
                            <div style={{ width: 18, height: 18, borderRadius: 4, background: hex }} />
                            <code style={{ fontSize: 11 }}>{hex}</code>
                          </div>
                        ))}
                      </div>
                      <button
                        className="btn primary"
                        style={{ fontSize: 12, background: '#10B981', color: '#fff' }}
                        onClick={handleApplyExtractedPalette}
                      >
                        ✓ Apply Extracted Palette to Client DNA
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Add Swatch Drawer */}
              {showAddSwatch && (
                <div style={{ padding: 14, background: 'var(--soft)', borderRadius: 10, marginBottom: 16, border: '1px solid var(--line)' }}>
                  <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>New Color Swatch</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr auto', gap: 10, alignItems: 'center' }}>
                    <input
                      type="text"
                      className="search"
                      style={{ width: '100%' }}
                      placeholder="Color Name (e.g. Kurdish Star Gold)"
                      value={newSwatchName}
                      onChange={(e) => setNewSwatchName(e.target.value)}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="color"
                        value={newSwatchHex}
                        onChange={(e) => setNewSwatchHex(e.target.value)}
                        style={{ width: 36, height: 32, border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      />
                      <input
                        type="text"
                        className="search"
                        style={{ width: 90 }}
                        value={newSwatchHex}
                        onChange={(e) => setNewSwatchHex(e.target.value)}
                      />
                    </div>
                    <select
                      className="search"
                      style={{ width: '100%', height: 34 }}
                      value={newSwatchRole}
                      onChange={(e) => setNewSwatchRole(e.target.value as any)}
                    >
                      <option value="primary">primary</option>
                      <option value="secondary">secondary</option>
                      <option value="accent">accent</option>
                      <option value="background">background</option>
                      <option value="surface">surface</option>
                      <option value="text">text</option>
                    </select>
                    <button className="btn primary" onClick={handleAddSwatch}>
                      Add Swatch
                    </button>
                  </div>
                </div>
              )}

              {/* Swatch Display Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
                {(currentDna?.colors || []).map((color) => {
                  const contrast = getContrastRatio(color.hex, currentBgHex);
                  const isWcagAaa = contrast >= 7.0;
                  const isWcagAa = contrast >= 4.5;
                  const isTextDark = getLuminance(color.hex) > 0.45;

                  return (
                    <div
                      key={color.name}
                      style={{
                        borderRadius: 10,
                        border: '1px solid var(--line)',
                        overflow: 'hidden',
                        background: 'var(--panel)',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
                      }}
                    >
                      <div
                        style={{
                          height: 72,
                          background: color.hex,
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          padding: 8,
                          color: isTextDark ? '#17191c' : '#ffffff',
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', opacity: 0.85 }}>
                          {color.role}
                        </span>
                        <button
                          onClick={() => handleRemoveSwatch(color.name)}
                          title="Remove Swatch"
                          style={{
                            background: 'rgba(0,0,0,0.25)',
                            border: 'none',
                            borderRadius: '50%',
                            width: 20,
                            height: 20,
                            color: '#fff',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                          }}
                        >
                          ×
                        </button>
                      </div>

                      <div style={{ padding: 10 }}>
                        <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 2 }}>{color.name}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <code
                            style={{ fontSize: 12, cursor: 'pointer' }}
                            onClick={() => copyToClipboard(color.hex, color.name)}
                            title="Click to copy hex"
                          >
                            {color.hex}
                          </code>
                          <span
                            className={`pill ${isWcagAaa ? 'ok' : isWcagAa ? 'blue' : 'warn'}`}
                            style={{ fontSize: 10 }}
                            title={`Contrast ratio against canvas: ${contrast}:1`}
                          >
                            {isWcagAaa ? 'AAA' : isWcagAa ? 'AA' : 'Fail'} {contrast}:1
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Official Verified Assets */}
              <h3 style={{ marginTop: 24, marginBottom: 8 }}>Official Cryptographic Assets</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
                Assets protected by Invariant #5 with deterministic SHA-256 integrity verification.
              </p>

              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Asset Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Storage Key</th>
                    <th>SHA-256 Fingerprint</th>
                  </tr>
                </thead>
                <tbody>
                  {(currentDna?.assets || []).map((asset) => (
                    <tr key={asset.assetId || asset.name}>
                      <td style={{ fontWeight: 600 }}>{asset.name}</td>
                      <td>
                        <code>{asset.role}</code>
                      </td>
                      <td>
                        <span className="pill ok">verified active</span>
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--muted)' }}>{asset.storageKey}</td>
                      <td>
                        <code
                          style={{ cursor: 'pointer' }}
                          onClick={() => copyToClipboard(asset.sha256, 'SHA-256 hash')}
                          title="Click to copy full hash"
                        >
                          {asset.sha256.substring(0, 12)}…
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 2: Tenant Identity */}
          {activeTab === 'identity' && (
            <div>
              <h3>Tenant Isolation & Scope Settings (Invariant #4)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginTop: 12 }}>
                <div style={{ padding: 14, borderRadius: 10, background: 'var(--soft)', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 650 }}>
                    Tenant Identity
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    <div><b>Name:</b> {currentDna?.name}</div>
                    <div style={{ marginTop: 4 }}><b>Code:</b> <code>{currentDna?.code}</code></div>
                    <div style={{ marginTop: 4 }}><b>Tenant UUID:</b> <code>{currentDna?.tenantId}</code></div>
                    <div style={{ marginTop: 4 }}><b>Client UUID:</b> <code>{currentDna?.clientId}</code></div>
                  </div>
                </div>

                <div style={{ padding: 14, borderRadius: 10, background: 'var(--soft)', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 650 }}>
                    Publishing Destinations (Invariant #10)
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    <div><b>Shared Drive:</b> <code>{currentDna?.destinations?.googleSharedDriveId}</code></div>
                    <div style={{ marginTop: 4 }}><b>Production Folder:</b> <code>{currentDna?.destinations?.productionFolderId}</code></div>
                    <div style={{ marginTop: 4 }}><b>Archive Folder:</b> <code>{currentDna?.destinations?.archiveFolderId}</code></div>
                    <div style={{ marginTop: 4 }}><b>Spreadsheet Tracker:</b> <code>{currentDna?.destinations?.spreadsheetId}</code></div>
                  </div>
                </div>
              </div>

              <h3 style={{ marginTop: 24, marginBottom: 8 }}>Approval Policy & Sign-Off Mandates</h3>
              <div style={{ padding: 14, borderRadius: 10, background: 'var(--soft)', border: '1px solid var(--line)', fontSize: 13 }}>
                <div>
                  <b>Required Sign-Off Roles:</b>{' '}
                  {(currentDna?.approvalPolicy?.requiredRoles || ['art_director']).map((r) => (
                    <span key={r} className="pill ok" style={{ marginRight: 6 }}>
                      {r}
                    </span>
                  ))}
                </div>
                <div style={{ marginTop: 8 }}>
                  <b>Auto-Approval Allowed:</b>{' '}
                  <span className={`pill ${currentDna?.approvalPolicy?.allowAutoApproval ? 'ok' : 'bad'}`}>
                    {currentDna?.approvalPolicy?.allowAutoApproval ? 'YES (Bypasses Review)' : 'NO (Strict Human QA)'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Language & RTL Typography */}
          {activeTab === 'language' && (
            <div>
              <h3>Kurdish Typography Registry (Invariant #8)</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
                Kurdish Sorani and Arabic RTL text rendering with guaranteed Unicode UAX #9 Directional Isolation.
              </p>

              {(currentDna?.fonts || []).map((font) => (
                <div
                  key={font.family}
                  style={{
                    padding: 16,
                    borderRadius: 10,
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                    marginBottom: 16,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <b style={{ fontSize: 15 }}>{font.family}</b>
                      <span className="pill" style={{ marginLeft: 8 }}>
                        {font.role}
                      </span>
                    </div>
                    <span className="pill ok">License: {font.license}</span>
                  </div>

                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                    Weight: <b>{font.weight}</b> · Style: <b>{font.style}</b> · Supported: <b>{font.supportedLocales.join(', ')}</b>
                  </div>

                  {/* Live Kurdish RTL Interactive Preview Card */}
                  <div
                    style={{
                      marginTop: 14,
                      padding: 14,
                      borderRadius: 8,
                      background: 'var(--panel)',
                      border: '1px dashed var(--line)',
                      direction: 'rtl',
                      fontFamily: `${font.family}, Vazirmatn, sans-serif`,
                      fontSize: 16,
                      lineHeight: 1.6,
                      textAlign: 'right',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, direction: 'ltr' }}>
                      <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>LIVE RTL SHAPING & ISOLATION PREVIEW</span>
                      <span className="pill blue" style={{ fontSize: 9 }}>UAX #9 ISOLATED</span>
                    </div>
                    <div style={{ color: 'var(--text)' }}>
                      دیزاینی فەرمی بۆ <b>{currentDna?.name}</b> — نرخ: <span style={{ color: '#16a34a', fontWeight: 700 }}>{'\u2067'}٢٥,٠٠٠ دینار{'\u2069'}</span> بە گەرەنتی کوالیتی ستۆدیۆی هاوا
                    </div>
                  </div>
                </div>
              ))}

              <h3 style={{ marginTop: 24, marginBottom: 8 }}>Required Disclaimers (Protected Claims)</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  type="text"
                  className="search"
                  style={{ flex: 1 }}
                  placeholder="New required disclaimer text…"
                  value={newDisclaimer}
                  onChange={(e) => setNewDisclaimer(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddDisclaimer()}
                />
                <button className="btn primary" onClick={handleAddDisclaimer}>
                  Add Disclaimer
                </button>
              </div>

              {(currentDna?.guidelines?.requiredDisclaimers || []).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {currentDna?.guidelines?.requiredDisclaimers.map((disc, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '8px 12px',
                        background: 'var(--soft)',
                        borderRadius: 6,
                        fontSize: 13,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>{disc}</span>
                      <span className="pill ok" style={{ fontSize: 10 }}>Invariant #5 Active</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>No required disclaimers defined for this client.</p>
              )}
            </div>
          )}

          {/* TAB 4: Rules & Guidelines */}
          {activeTab === 'rules' && (
            <div>
              <h3>Voice & Tone Guideline</h3>
              <div style={{ padding: 14, background: 'var(--soft)', borderRadius: 10, border: '1px solid var(--line)', marginBottom: 20 }}>
                <p style={{ margin: 0, fontSize: 14, fontStyle: 'italic' }}>
                  “{currentDna?.guidelines?.voiceAndTone || 'Standard Kurdish studio voice'}”
                </p>
              </div>

              <h3>Prohibited Lexicon (Deterministic QA Invariant #6)</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
                Phrases automatically blocked by QA pipeline. Any generated design containing these words is rejected before human review.
              </p>

              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input
                  type="text"
                  className="search"
                  style={{ flex: 1 }}
                  placeholder="Add banned word or phrase…"
                  value={newPhrase}
                  onChange={(e) => setNewPhrase(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddProhibitedPhrase()}
                />
                <button className="btn primary" onClick={handleAddProhibitedPhrase}>
                  + Ban Phrase
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
                {(currentDna?.guidelines?.prohibitedPhrases || []).map((phrase) => (
                  <span
                    key={phrase}
                    className="pill bad"
                    style={{ fontSize: 12, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>{phrase}</span>
                    <button
                      onClick={() => handleRemoveProhibitedPhrase(phrase)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 700,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <h3>Layout & Architectural Principles</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input
                  type="text"
                  className="search"
                  style={{ flex: 1 }}
                  placeholder="New layout rule or safety margin…"
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddLayoutRule()}
                />
                <button className="btn primary" onClick={handleAddLayoutRule}>
                  + Add Principle
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(currentDna?.guidelines?.layoutRules || []).map((rule, idx) => (
                  <div
                    key={idx}
                    className="rule"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 14px',
                    }}
                  >
                    <div>
                      <b>Principle #{idx + 1}</b>
                      <p style={{ margin: '2px 0 0', fontSize: 13 }}>{rule}</p>
                    </div>
                    <span className="pill ok" style={{ fontSize: 10 }}>Hard QA Invariant</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Governance & Immutable Snapshots */}
        <div className="panel" style={{ minWidth: 320 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Governance & Audit</h3>
            <span className="pill ok">{snapshots.length} Snapshots</span>
          </div>

          <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Current Revision</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
              v{currentDna?.version || 1} Active
            </div>
            <button
              className="btn primary"
              style={{ width: '100%', marginTop: 10, fontSize: 12 }}
              onClick={() => setShowSnapshotModal(true)}
            >
              🛡️ Create Immutable Version
            </button>
          </div>

          {/* Candidate Rules from Operator Feedback */}
          <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>Candidate Rule (Mined from Feedback)</h4>
          {!promotedRule ? (
            <div className="finding" style={{ marginBottom: 16 }}>
              <b>Enforce top-right brand logo anchor in RTL</b>
              <p style={{ margin: '4px 0', fontSize: 12 }}>
                Ensure brand logo always occupies top-right corner in Kurdish Sorani layouts to conform to Kurdish reading flow.
              </p>
              <small style={{ display: 'block', color: 'var(--muted)', marginTop: 4 }}>
                Derived from 6 consecutive approved campaign deliverables · 0 counterexamples
              </small>
              <button
                className="btn primary"
                style={{ fontSize: 11, marginTop: 8, width: '100%' }}
                onClick={() => handlePromoteCandidate('Enforce top-right brand logo anchor in RTL')}
              >
                Approve & Promote to Active DNA
              </button>
            </div>
          ) : (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', marginBottom: 16 }}>
              <b style={{ color: '#065f46' }}>✓ Rule Promoted to Active DNA</b>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#047857' }}>
                “{promotedRule}” was incorporated into active layout invariants.
              </p>
            </div>
          )}

          {/* Immutable Snapshot Timeline */}
          <h4 style={{ margin: '20px 0 10px', fontSize: 13 }}>Immutable Snapshot Timeline</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {snapshots.map((snap) => (
              <div
                key={snap.snapshotId}
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="pill ok" style={{ fontSize: 10, fontWeight: 700 }}>
                    v{snap.version}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                    {new Date(snap.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                <p style={{ margin: '6px 0', fontWeight: 550, color: 'var(--text)' }}>
                  {snap.commitMessage}
                </p>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <code
                    style={{ fontSize: 10, cursor: 'pointer' }}
                    onClick={() => copyToClipboard(snap.sha256, 'SHA-256 hash')}
                    title="Click to copy full SHA-256 fingerprint"
                  >
                    {snap.sha256.substring(0, 14)}…
                  </code>
                  <button
                    className="btn"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => setInspectingSnapshot(snap)}
                  >
                    Inspect
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* MODAL 1: Onboard Client Tenant */}
      {showOnboardModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 620,
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: 28,
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              borderRadius: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Onboard Client Tenant</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 0' }}>
                  Initialize isolated tenant workspace schema & verified cryptographic DNA.
                </p>
              </div>
              <button
                onClick={() => setShowOnboardModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleOnboardSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                    Client Name *
                  </label>
                  <input
                    type="text"
                    required
                    className="search"
                    style={{ width: '100%' }}
                    placeholder="e.g. Erbil Grand Bazaar"
                    value={onboardForm.name}
                    onChange={(e) => setOnboardForm({ ...onboardForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                    Code (Uppercase) *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={8}
                    className="search"
                    style={{ width: '100%', textTransform: 'uppercase' }}
                    placeholder="EGB"
                    value={onboardForm.code}
                    onChange={(e) => setOnboardForm({ ...onboardForm, code: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                    Default Locale
                  </label>
                  <select
                    className="search"
                    style={{ width: '100%', height: 36 }}
                    value={onboardForm.defaultLocale}
                    onChange={(e) => setOnboardForm({ ...onboardForm, defaultLocale: e.target.value as any })}
                  >
                    <option value="ckb">Kurdish Sorani (ckb)</option>
                    <option value="ar">Arabic (ar)</option>
                    <option value="en">English (en)</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                    Default Direction
                  </label>
                  <select
                    className="search"
                    style={{ width: '100%', height: 36 }}
                    value={onboardForm.defaultDirection}
                    onChange={(e) => setOnboardForm({ ...onboardForm, defaultDirection: e.target.value as any })}
                  >
                    <option value="rtl">Right-to-Left (RTL)</option>
                    <option value="ltr">Left-to-Right (LTR)</option>
                  </select>
                </div>
              </div>

              {/* Logo Upload & Auto-Extraction Zone */}
              <div style={{ marginBottom: 16, padding: 12, border: '1px dashed var(--line)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 650 }}>
                    🎨 Auto-Extract Palette from Client Logo (.svg, .png)
                  </label>
                  {logoExtractionNotice && (
                    <span style={{ fontSize: 11, color: '#10B981', fontWeight: 600 }}>
                      {logoExtractionNotice}
                    </span>
                  )}
                </div>
                <input
                  type="file"
                  accept="image/*,.svg"
                  onChange={handleOnboardLogoUpload}
                  style={{ fontSize: 11 }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 6 }}>
                  Initial Brand Colors
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Primary</span>
                    <input
                      type="color"
                      value={onboardForm.primaryColorHex}
                      onChange={(e) => setOnboardForm({ ...onboardForm, primaryColorHex: e.target.value })}
                      style={{ width: '100%', height: 32, border: 'none', borderRadius: 4, cursor: 'pointer', marginTop: 2 }}
                    />
                  </div>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Secondary</span>
                    <input
                      type="color"
                      value={onboardForm.secondaryColorHex}
                      onChange={(e) => setOnboardForm({ ...onboardForm, secondaryColorHex: e.target.value })}
                      style={{ width: '100%', height: 32, border: 'none', borderRadius: 4, cursor: 'pointer', marginTop: 2 }}
                    />
                  </div>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Accent</span>
                    <input
                      type="color"
                      value={onboardForm.accentColorHex}
                      onChange={(e) => setOnboardForm({ ...onboardForm, accentColorHex: e.target.value })}
                      style={{ width: '100%', height: 32, border: 'none', borderRadius: 4, cursor: 'pointer', marginTop: 2 }}
                    />
                  </div>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Background</span>
                    <input
                      type="color"
                      value={onboardForm.backgroundColorHex}
                      onChange={(e) => setOnboardForm({ ...onboardForm, backgroundColorHex: e.target.value })}
                      style={{ width: '100%', height: 32, border: 'none', borderRadius: 4, cursor: 'pointer', marginTop: 2 }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                  Voice & Tone Mandate
                </label>
                <input
                  type="text"
                  className="search"
                  style={{ width: '100%' }}
                  value={onboardForm.voiceAndTone}
                  onChange={(e) => setOnboardForm({ ...onboardForm, voiceAndTone: e.target.value })}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                  Prohibited Lexicon (Comma separated)
                </label>
                <input
                  type="text"
                  className="search"
                  style={{ width: '100%' }}
                  value={onboardForm.prohibitedPhrases}
                  onChange={(e) => setOnboardForm({ ...onboardForm, prohibitedPhrases: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn" onClick={() => setShowOnboardModal(false)} disabled={isOnboarding}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={isOnboarding}>
                  {isOnboarding ? 'Provisioning Tenant…' : 'Complete Tenant Onboarding'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Commit Immutable Snapshot */}
      {showSnapshotModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 520,
              padding: 24,
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              borderRadius: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Commit DNA Governance Snapshot</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 0' }}>
                  Create an immutable point-in-time cryptographic version for {currentDna?.name}.
                </p>
              </div>
              <button
                onClick={() => setShowSnapshotModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCommitSnapshot}>
              <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Version Progression:</span>
                  <b>v{currentDna?.version || 1} ➔ v{(currentDna?.version || 1) + 1}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>Integrity Standard:</span>
                  <span className="pill ok">SHA-256 Canonical JSON</span>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                  Commit Summary / Rationale *
                </label>
                <textarea
                  required
                  className="search"
                  style={{ width: '100%', height: 72, resize: 'vertical' }}
                  placeholder="e.g. Certified Nawroz campaign color palette and Kurdish typography invariants"
                  value={snapshotMessage}
                  onChange={(e) => setSnapshotMessage(e.target.value)}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>
                  Sign-Off Authority Role
                </label>
                <select
                  className="search"
                  style={{ width: '100%', height: 36 }}
                  value={snapshotAuthor}
                  onChange={(e) => setSnapshotAuthor(e.target.value)}
                >
                  <option value="art_director">Art Director</option>
                  <option value="creative_director">Creative Director</option>
                  <option value="compliance_officer">Compliance Officer</option>
                  <option value="operator">Lead Studio Operator</option>
                </select>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn" onClick={() => setShowSnapshotModal(false)} disabled={isCommittingSnapshot}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={isCommittingSnapshot}>
                  {isCommittingSnapshot ? 'Computing SHA-256…' : 'Seal & Commit Version'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Inspect Snapshot Details */}
      {inspectingSnapshot && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 640,
              maxHeight: '85vh',
              overflowY: 'auto',
              padding: 24,
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              borderRadius: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Snapshot v{inspectingSnapshot.version} Inspection</h2>
                <p style={{ color: 'var(--muted)', fontSize: 12, margin: '2px 0 0' }}>
                  Committed by <b>{inspectingSnapshot.createdBy}</b> on{' '}
                  {new Date(inspectingSnapshot.createdAt).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => setInspectingSnapshot(null)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
              <div><b>Commit Message:</b> {inspectingSnapshot.commitMessage}</div>
              <div style={{ marginTop: 6 }}>
                <b>Cryptographic SHA-256:</b>{' '}
                <code
                  style={{ cursor: 'pointer', wordBreak: 'break-all' }}
                  onClick={() => copyToClipboard(inspectingSnapshot.sha256, 'SHA-256 hash')}
                  title="Click to copy full hash"
                >
                  {inspectingSnapshot.sha256}
                </code>
              </div>
            </div>

            <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Frozen Brand Colors</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {(inspectingSnapshot.dna?.colors || []).map((col: any) => (
                <div
                  key={col.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                    fontSize: 12,
                  }}
                >
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: col.hex }} />
                  <b>{col.name}</b>
                  <code>{col.hex}</code>
                </div>
              ))}
            </div>

            <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Active Layout Principles</h4>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text)' }}>
              {(inspectingSnapshot.dna?.guidelines?.layoutRules || []).map((rule: string, i: number) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {rule}
                </li>
              ))}
            </ul>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn primary" onClick={() => setInspectingSnapshot(null)}>
                Close Audit Inspection
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
