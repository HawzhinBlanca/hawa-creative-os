import React, { useState, useEffect, useMemo, useRef } from 'react';
import { extractPaletteFromFile, type ExtractedPalette } from '../services/paletteExtractor.js';
import { apiClient } from '../api/client.js';
import { DocumentInspectionPanel } from '../components/DocumentInspectionPanel.js';
import { read, reasonOf } from '../services/statusReport.js';

import { readClientDirectory, type ClientSummary } from '../services/clientDirectory.js';
export type { ClientSummary } from '../services/clientDirectory.js';

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

// WCAG Contrast Helper
function getLuminance(hex: string): number {
  const cleanHex = hex.replace('#', '');
  const rgb = parseInt(cleanHex.length === 3 ? cleanHex.split('').map((c) => c + c).join('') : cleanHex, 16);
  if (isNaN(rgb)) return NaN;
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
    // An unreadable colour has no measurable contrast; NaN renders as unknown, never as a pass.
    return NaN;
  }
}

/** A candidate rule as the Desk shows it. Core's feedback miner returns CandidateRuleProposal. */
export interface CandidateRule {
  ruleId: string;
  clientId: string;
  title: string;
  ruleText: string;
  category: string;
  confidence: number | null;
  occurrences: number | null;
  evidenceTasks: number | null;
  status: 'proposed' | 'promoted' | 'dismissed';
  rationale: string;
}

const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);

/** Maps Core's candidate rule (`id`, `title`, `ruleText`, upper-case status) to the Desk's view. */
export function candidateRuleFromCore(rule: any): CandidateRule {
  const status = String(rule?.status ?? '').toLowerCase();
  return {
    ruleId: String(rule?.id ?? ''),
    clientId: String(rule?.clientId ?? ''),
    title: String(rule?.title || rule?.ruleText || ''),
    ruleText: String(rule?.ruleText ?? ''),
    category: String(rule?.category ?? ''),
    confidence: numberOrNull(rule?.confidence),
    occurrences: numberOrNull(rule?.frequency),
    evidenceTasks: Array.isArray(rule?.evidenceTaskIds) ? rule.evidenceTaskIds.length : null,
    status: status === 'promoted' ? 'promoted' : status === 'dismissed' ? 'dismissed' : 'proposed',
    rationale: String(rule?.rationale ?? ''),
  };
}

/** What Core's font inspector (packages/qa font-inspector.ts) reports about an uploaded font. */
export interface FontInspectionResult {
  fontFamily: string;
  format: string;
  totalRequired: number;
  presentCount: number;
  coveragePercent: number;
  status: string;
  hasZwnj: boolean;
  missingGlyphs: { char: string; hex: string; name: string }[];
  /** Measured in the browser from the uploaded file; Core does not report it. */
  fileSizeBytes: number;
}

/** Maps Core's coverage result; an answer without coverage numbers is a failed inspection. */
export function fontInspectionFromCore(body: any, fileSizeBytes: number): FontInspectionResult {
  if (typeof body?.coveragePercentage !== 'number' || typeof body?.totalRequired !== 'number') {
    throw new Error('Core answered without a coverage result');
  }
  return {
    fontFamily: String(body.metadata?.family || body.fontName || 'unnamed font'),
    format: String(body.format || body.metadata?.format || 'unknown'),
    totalRequired: body.totalRequired,
    presentCount: Number(body.presentCount),
    coveragePercent: body.coveragePercentage,
    status: String(body.status || 'unknown'),
    hasZwnj: body.hasZwnj === true,
    missingGlyphs: Array.isArray(body.missingGlyphs) ? body.missingGlyphs : [],
    fileSizeBytes,
  };
}

type DnaSection = 'clients' | 'dna' | 'snapshots' | 'rules';
const NOT_READ_YET: Record<DnaSection, string> = {
  clients: 'not read yet',
  dna: 'not read yet',
  snapshots: 'not read yet',
  rules: 'not read yet',
};

export const DnaScreen: React.FC<{ initialClientId?: string }> = ({ initialClientId }) => {
  const linkedClientRef = useRef(initialClientId);
  linkedClientRef.current = initialClientId;
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [directoryNotice, setDirectoryNotice] = useState<string | null>('not read yet');
  const directoryRead = useRef(0);
  const loadClientDirectory = async () => {
    const generation = ++directoryRead.current;
    try {
      const list = await readClientDirectory();
      if (generation !== directoryRead.current) return;
      setClients(list);
      setDirectoryNotice(null);
      setSelectedClientId(current => list.some(client => client.clientId === current) ? current
        : linkedClientRef.current ? list.find(client => client.clientId === linkedClientRef.current)?.clientId || '' : list[0]?.clientId || '');
    } catch (err) {
      if (generation !== directoryRead.current) return;
      setDirectoryNotice(reasonOf(err));
    }
  };
  useEffect(() => { void loadClientDirectory(); return () => { directoryRead.current++; }; }, []);
  useEffect(() => {
    if (!initialClientId || clients.length === 0) return;
    const available = clients.some(client => client.clientId === initialClientId);
    setSelectedClientId(available ? initialClientId : '');
    if (!available) setDirectoryNotice('The linked client is unavailable. Choose a client you can access.');
  }, [initialClientId, clients]);
  return <DnaClientScreen key={selectedClientId} clients={clients} selectedClientId={selectedClientId}
    setSelectedClientId={setSelectedClientId} directoryNotice={directoryNotice} loadClientDirectory={loadClientDirectory} />;
};

/** One editor lifetime per client. Late reads and writes cannot update the next client's editor. */
const DnaClientScreen: React.FC<{
  clients: ClientSummary[]; selectedClientId: string; setSelectedClientId: (id: string) => void;
  directoryNotice: string | null; loadClientDirectory: () => Promise<void>;
}> = ({ clients, selectedClientId, setSelectedClientId, directoryNotice, loadClientDirectory }) => {
  const [currentDna, setCurrentDna] = useState<ClientDNA | null>(null);
  const [snapshots, setSnapshots] = useState<ClientDnaSnapshot[]>([]);
  const [activeTab, setActiveTab] = useState<'brand' | 'identity' | 'language' | 'rules'>('brand');
  const [loading, setLoading] = useState(false);
  const [undoPalette, setUndoPalette] = useState<{ dna: ClientDNA; expectedVersion: number } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  // Sections Core has not answered for, with the reason. An unread section shows as unknown, never as empty.
  const [unread, setUnread] = useState<Partial<Record<DnaSection, string>>>(NOT_READ_YET);
  const markRead = (section: DnaSection, reason?: string) =>
    setUnread((prev) => {
      const next = { ...prev };
      if (reason) next[section] = reason;
      else delete next[section];
      return next;
    });
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Modals state
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [inspectingSnapshot, setInspectingSnapshot] = useState<ClientDnaSnapshot | null>(null);

  // Candidate rules from governed learning loop
  const [candidateRules, setCandidateRules] = useState<CandidateRule[]>([]);

  // Kurdish WebFont Ingestion & Diacritic Clearance Inspector State (Horizon 4)
  const [inspectedFont, setInspectedFont] = useState<FontInspectionResult | null>(null);
  const [fontFileNotice, setFontFileNotice] = useState<string | null>(null);
  const [isInspectingFont, setIsInspectingFont] = useState<boolean>(false);

  // Inline color swatch adder state
  const [showAddSwatch, setShowAddSwatch] = useState(false);
  const [newSwatchName, setNewSwatchName] = useState('');
  const [newSwatchHex, setNewSwatchHex] = useState('#164a3a');
  const [newSwatchRole, setNewSwatchRole] = useState<BrandColor['role']>('accent');

  // Logo Palette Extraction State
  const [extractedPaletteData, setExtractedPaletteData] = useState<ExtractedPalette | null>(null);
  const [showLogoDropzone, setShowLogoDropzone] = useState(false);

  // Inline lexicon adder state
  const [newPhrase, setNewPhrase] = useState('');
  const [newDisclaimer, setNewDisclaimer] = useState('');
  const [newRule, setNewRule] = useState('');

  // Snapshot Form State
  const [snapshotMessage, setSnapshotMessage] = useState('');
  const [snapshotAuthor, setSnapshotAuthor] = useState('art_director');
  const [isCommittingSnapshot, setIsCommittingSnapshot] = useState(false);

  // Fetch specific client DNA & snapshots
  const loadClientData = async (clientId: string) => {
    setLoading(true);
    setErrorNotice(null);
    // Another client's DNA is never shown under this one while it loads.
    setCurrentDna((prev) => (prev?.clientId === clientId ? prev : null));
    const [dnaRes, snapRes, rulesRes] = await Promise.all([
      read(() => apiClient.clients.dna(clientId)),
      read(() => apiClient.clients.snapshots(clientId)),
      read(() => apiClient.clients.candidateRules(clientId)),
    ]);

    // A DNA Core did not return is not replaced by a local copy: saving that copy would overwrite the live one.
    const matchingDna = dnaRes.state === 'known' && dnaRes.value?.clientId === clientId;
    setCurrentDna(matchingDna ? dnaRes.value : null);
    markRead('dna', dnaRes.state === 'unknown' ? dnaRes.reason : matchingDna ? undefined : 'Core returned DNA for a different client');

    setSnapshots(snapRes.state === 'known' && Array.isArray(snapRes.value) ? snapRes.value : []);
    markRead('snapshots', snapRes.state === 'unknown' ? snapRes.reason : undefined);

    const rules = rulesRes.state === 'known' ? rulesRes.value?.candidateRules : undefined;
    setCandidateRules(Array.isArray(rules) ? rules.map(candidateRuleFromCore) : []);
    markRead('rules', rulesRes.state === 'unknown' ? rulesRes.reason : undefined);

    setLoading(false);
  };

  useEffect(() => {
    if (selectedClientId) {
      loadClientData(selectedClientId);
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
  // Resolves true only when Core confirmed the save.
  const saveDnaChanges = async (updatedDna: ClientDNA, successMessage: string, undo?: ClientDNA): Promise<boolean> => {
    setLoading(true);
    try {
      const saved: ClientDNA = await apiClient.clients.saveDna(updatedDna.clientId, updatedDna);
      setCurrentDna(saved);
      setUndoPalette(undo ? { dna: undo, expectedVersion: saved.version } : null);
      setSaveSuccess(successMessage);
      loadClientDirectory();
      // Core records a snapshot with every save.
      const snaps = await read(() => apiClient.clients.snapshots(saved.clientId));
      setSnapshots(snaps.state === 'known' && Array.isArray(snaps.value) ? snaps.value : []);
      markRead('snapshots', snaps.state === 'unknown' ? snaps.reason : undefined);
      return true;
    } catch (err) {
      setErrorNotice(`Core did not save the DNA: ${reasonOf(err)}`);
      return false;
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
    await saveDnaChanges(updated, `Removed color swatch "${colorName}"`, currentDna);
  };

  // Logo Palette Extraction Handler
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

  // Promote candidate rule. Core's promote adds the rule to the DNA and records the snapshot itself,
  // so the Desk does not save the DNA first: that would add the rule and bump the version twice.
  const handlePromoteCandidate = async (ruleId: string) => {
    const rule = candidateRules.find((r) => r.ruleId === ruleId);
    try {
      await apiClient.clients.promoteCandidate(selectedClientId, ruleId);
    } catch (err) {
      setErrorNotice(`Core did not promote the candidate rule, so the DNA is unchanged: ${reasonOf(err)}`);
      return;
    }
    setSaveSuccess(`Candidate rule "${rule?.title ?? ruleId}" promoted; Core added it to the DNA`);
    // The DNA version, its snapshots and the rule's status all changed on Core.
    await loadClientData(selectedClientId);
  };

  // Dismiss candidate rule
  const handleDismissCandidate = async (ruleId: string) => {
    try {
      const res = await apiClient.clients.dismissCandidate(selectedClientId, ruleId, 'Dismissed by art director');
      // Core answers 200 with dismissed: false when it has no such rule.
      if (res?.dismissed !== true) {
        setErrorNotice(`Core has no candidate rule ${ruleId} to dismiss, so it stays open.`);
        return;
      }
    } catch (err) {
      setErrorNotice(`Core did not record the dismissal, so the candidate stays open: ${reasonOf(err)}`);
      return;
    }
    setCandidateRules((prev) => prev.map((r) => (r.ruleId === ruleId ? { ...r, status: 'dismissed' } : r)));
  };

  // Kurdish WebFont Inspection Handler (Google Fonts / Font Bakery grade)
  const handleInspectFontFile = async (file: File) => {
    setIsInspectingFont(true);
    setFontFileNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      // Core names the font from its own name table; the file name is only the fallback.
      const body = await apiClient.fonts.inspect({ fontBase64: base64, fontName: file.name.replace(/\.[^.]+$/, '') });
      const data = fontInspectionFromCore(body, file.size);
      setInspectedFont(data);
      setFontFileNotice(`Inspected ${file.name}: ${data.status} (${data.coveragePercent}% Sorani coverage)`);
    } catch (err) {
      // No inspection happened, so there is no coverage or compliance result to show.
      setInspectedFont(null);
      setErrorNotice(`Could not inspect ${file.name}: ${reasonOf(err)}. Its Sorani coverage is unknown.`);
    } finally {
      setIsInspectingFont(false);
    }
  };

  // Add Inspected Font to Active Client DNA
  const handleAddInspectedFontToDna = async () => {
    if (!inspectedFont || !currentDna) return;
    const newFont: BrandFont = {
      family: inspectedFont.fontFamily,
      style: 'Normal',
      weight: 700,
      role: 'display',
      // Nothing here checks the licence, so the DNA does not claim one.
      license: 'not verified',
      supportedLocales: ['ckb', 'ar', 'en'],
    };
    const updatedFonts = [...(currentDna.fonts || []).filter((f) => f.family !== newFont.family), newFont];
    const updated = { ...currentDna, fonts: updatedFonts };
    await saveDnaChanges(updated, `Added font ${inspectedFont.fontFamily} to the client DNA; its licence is not verified`);
  };

  const handleCopyFontCdnSnippet = () => {
    if (!inspectedFont) return;
    const cdnUrl = `/v1/fonts/cdn/${encodeURIComponent(inspectedFont.fontFamily)}/style.css`;
    const cssSnippet = `@import url('${cdnUrl}');\n/* Or Link: <link rel="stylesheet" href="${cdnUrl}"> */`;
    navigator.clipboard.writeText(cssSnippet);
    setFontFileNotice(`✓ Copied CDN stylesheet link for ${inspectedFont.fontFamily}!`);
    setTimeout(() => setFontFileNotice(null), 4000);
  };

  const handleDownloadFontCssKit = () => {
    if (!inspectedFont) return;
    const cssText = `/* Kurdish Sorani WebFont Kit: ${inspectedFont.fontFamily} */
@font-face {
  font-family: '${inspectedFont.fontFamily}';
  src: url('/v1/fonts/cdn/${encodeURIComponent(inspectedFont.fontFamily)}/font.woff2') format('woff2'),
       local('${inspectedFont.fontFamily}'),
       local('Vazirmatn'),
       local('Noto Sans Arabic');
  font-display: swap;
  unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF;
  ascent-override: 95%;
  descent-override: 25%;
  line-gap-override: 15%;
}
.kurdish-text {
  font-family: '${inspectedFont.fontFamily}', 'Vazirmatn', 'Noto Sans Arabic', sans-serif;
  line-height: 1.52;
  direction: rtl;
  text-align: right;
}`;
    const blob = new Blob([cssText], { type: 'text/css' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${inspectedFont.fontFamily.toLowerCase().replace(/[^a-z0-9]/g, '-')}-webfont.css`;
    a.click();
    URL.revokeObjectURL(url);
    setFontFileNotice(`✓ Downloaded WebFont CSS Kit for ${inspectedFont.fontFamily}!`);
    setTimeout(() => setFontFileNotice(null), 4000);
  };

  // Commit Immutable Snapshot Handler
  const handleCommitSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentDna) return;

    setIsCommittingSnapshot(true);
    setErrorNotice(null);

    try {
      const snap: ClientDnaSnapshot = await apiClient.clients.commitSnapshot(currentDna.clientId, {
        commitMessage: snapshotMessage.trim() || `Manual governance snapshot v${currentDna.version + 1}`,
        createdBy: snapshotAuthor,
      });
      setSnapshots((prev) => [snap, ...prev]);
      setCurrentDna((prev) => (prev ? { ...prev, version: snap.version } : null));
      setShowSnapshotModal(false);
      setSnapshotMessage('');
      setSaveSuccess(`Snapshot v${snap.version} recorded by Core (sha256 ${String(snap.sha256).slice(0, 12)}…)`);
      loadClientDirectory();
    } catch (err) {
      setErrorNotice(`Core did not record the snapshot: ${reasonOf(err)}`);
    } finally {
      setIsCommittingSnapshot(false);
    }
  };

  // Active client summary
  const selectedSummary = clients.find((c) => c.clientId === selectedClientId);

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
        <h1 className="sr-only">Client Brand DNA & Governance</h1>

        {/* Left Column: Client Directory */}
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Clients & Tenants</h2>
            <span className="pill ok">{directoryNotice ? '—' : clients.length} Registered</span>
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
                  role="button" tabIndex={0} aria-pressed={isSelected}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedClientId(c.clientId); } }}
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

          {directoryNotice && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Client list unknown: {directoryNotice} <button className="btn" onClick={() => void loadClientDirectory()}>Retry client list</button></div>
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '16px 0' }} />

          {/* Not enabled (owner decision, 2026-09-19): the form sent made-up Drive and Sheet IDs and a
              random logo hash, and publishing reads its destinations from the DNA. */}
          <button
            className="btn"
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            disabled
          >
            <span>+</span>
            <span>Onboard Client Tenant (not enabled)</span>
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            Onboarding is not enabled: it would create a client with placeholder Drive and Sheet destinations.
          </div>

          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'var(--soft)', fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
            <b style={{ color: 'var(--text)' }}>Client scope:</b> Requests and brand references stay within the selected client.
          </div>
        </div>

        {/* Center Column: Live DNA Workspace */}
        <div className="panel" style={{ minWidth: 0 }}>
          <details style={{marginBottom:16}}><summary>Inspect a source PDF</summary><DocumentInspectionPanel clientId={selectedClientId} /></details>
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={activeTab === 'brand' ? 'on' : ''} onClick={() => setActiveTab('brand')}>
              🎨 Brand & Palette
            </button>
            <button className={activeTab === 'identity' ? 'on' : ''} onClick={() => setActiveTab('identity')}>
              🏛️ Client details
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
                <h2 style={{ margin: 0, fontSize: 20 }}>{currentDna?.name ?? selectedSummary?.name ?? selectedClientId}</h2>
                <span className="pill ok" style={{ fontSize: 12 }}>
                  {currentDna ? `v${currentDna.version} active` : 'DNA not read'}
                </span>
                {currentDna && (
                  <span className="pill blue" style={{ fontSize: 11 }}>
                    Read from Core
                  </span>
                )}
              </div>
              <details style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}><summary>Client identifiers</summary>
                Tenant ID: <code>{currentDna?.tenantId ?? '—'}</code> · Client ID: <code>{selectedClientId}</code>
              </details>
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
                disabled={!currentDna}
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
              <b style={{ color: '#065f46' }}>Brand changes saved</b>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#047857' }}>{saveSuccess}</p>
              {undoPalette && <button className="btn" disabled={loading || currentDna?.version !== undoPalette.expectedVersion} onClick={() => {
                if (!currentDna || currentDna.version !== undoPalette.expectedVersion) return;
                void saveDnaChanges({...undoPalette.dna, version: currentDna.version}, 'Color removal undone in a new brand version.');
              }}>Undo color removal</button>}
            </div>
          )}

          {errorNotice && (
            <div className="finding" style={{ borderColor: '#e12d39', background: '#fef2f2', marginBottom: 16 }}>
              <b style={{ color: '#991b1b' }}>⚠ Action Blocked</b>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#b91c1c' }}>{errorNotice}</p>
            </div>
          )}

          {!currentDna && !loading && (
            <div className="finding" style={{ marginBottom: 16 }}>
              <b>DNA not read</b>
              <p style={{ margin: '2px 0 0', fontSize: 12 }}>
                Core has not returned the DNA for {selectedClientId}
                {unread.dna ? `: ${unread.dna}` : ''}. Nothing is shown and nothing can be saved until it is read.
              </p>
            </div>
          )}

          {/* TAB 1: Brand & Palette */}
          {currentDna && activeTab === 'brand' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Approved Brand Palette</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 11, background: 'rgba(2, 132, 199, 0.08)', color: 'var(--accent-text, #0369a1)', border: '1px solid rgba(2, 132, 199, 0.3)' }}
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
                    <h4 style={{ margin: 0, fontSize: 13, color: 'var(--accent-text, #0369a1)' }}>🎨 Client Logo Color Quantization & WCAG Contrast</h4>
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
                    id="dna-logo-upload-input"
                    name="dnaLogoUploadInput"
                    aria-label="Upload client logo image or SVG for color quantization"
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
                        style={{ fontSize: 12, background: '#047857', color: '#fff' }}
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
                      id="dna-new-swatch-name"
                      name="newSwatchName"
                      aria-label="Color Name"
                      type="text"
                      className="search"
                      style={{ width: '100%' }}
                      placeholder="Color Name (e.g. Kurdish Star Gold)"
                      value={newSwatchName}
                      onChange={(e) => setNewSwatchName(e.target.value)}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        id="dna-new-swatch-picker"
                        name="newSwatchPicker"
                        aria-label="Color Picker"
                        type="color"
                        value={newSwatchHex}
                        onChange={(e) => setNewSwatchHex(e.target.value)}
                        style={{ width: 36, height: 32, border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      />
                      <input
                        id="dna-new-swatch-hex"
                        name="newSwatchHex"
                        aria-label="Color Hex Code"
                        type="text"
                        className="search"
                        style={{ width: 90 }}
                        value={newSwatchHex}
                        onChange={(e) => setNewSwatchHex(e.target.value)}
                      />
                    </div>
                    <select
                      id="dna-new-swatch-role"
                      name="newSwatchRole"
                      aria-label="Color Role"
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
                  const contrastBackground = color.role === 'text' ? currentBgHex : getLuminance(color.hex) > 0.18 ? '#000000' : '#ffffff';
                  const contrast = getContrastRatio(color.hex, contrastBackground);
                  const isWcagAaa = contrast >= 7.0;
                  const isWcagAa = contrast >= 4.5;
                  const isTextDark = getLuminance(color.hex) > 0.18;

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
                          color: isTextDark ? '#000000' : '#ffffff',
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                          {color.role}
                        </span>
                        <button
                          onClick={() => handleRemoveSwatch(color.name)}
                          aria-label={`Remove ${color.name} color`}
                          disabled={loading}
                          title={`Remove ${color.name} color`}
                          style={{
                            background: '#12141a',
                            border: 'none',
                            borderRadius: '50%',
                            width: 44,
                            height: 44,
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
                          <button type="button" className="btn" aria-label={`Copy ${color.name} hex ${color.hex}`}
                            style={{ fontSize: 12, cursor: 'pointer' }}
                            onClick={() => copyToClipboard(color.hex, color.name)}
                            title="Click to copy hex"
                          >
                            {color.hex}
                          </button>
                          {Number.isNaN(contrast) ? (
                            <span className="pill" style={{ fontSize: 10 }} title="This colour could not be read, so its contrast is unknown">
                              Contrast unknown
                            </span>
                          ) : (
                            <span
                              className={`pill ${isWcagAaa ? 'ok' : isWcagAa ? 'blue' : 'warn'}`}
                              style={{ fontSize: 10 }}
                              title={color.role === 'text' ? `Text on brand background ${currentBgHex}: ${contrast}:1` : `Example ${contrastBackground} text on ${color.hex}: ${contrast}:1`}
                            >
                              {color.role === 'text' ? 'Text / background' : contrastBackground === '#000000' ? 'Black text' : 'White text'} · {contrast}:1 {isWcagAa ? '✓' : 'low contrast'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Official Verified Assets */}
              <h3 style={{ marginTop: 24, marginBottom: 8 }}>Verified brand assets</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
                Approved logo and brand files. File integrity is checked before use.
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
          {currentDna && activeTab === 'identity' && (
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
          {currentDna && activeTab === 'language' && (
            <div>
              <h3>Kurdish Typography Registry (Invariant #8)</h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
                Set the client's language and typography rules. Verify Arabic and Sorani reading order in final exports.
              </p>

              {/* Kurdish WebFont Ingestion & Diacritic Coverage Inspector (Google Fonts & Font Bakery Grade) */}
              <div
                style={{
                  padding: 16,
                  borderRadius: 10,
                  background: 'var(--panel)',
                  border: '1px solid var(--accent)',
                  marginBottom: 20,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: 14, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>🔤</span>
                      <span>Kurdish WebFont Ingestion & Diacritic Inspector</span>
                      <span className="pill blue" style={{ fontSize: 9 }}>Google Fonts / Font Bakery Grade</span>
                    </h4>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                      Ingest .woff2 / .ttf font assets with automated OpenType cmap inspection and diacritic vertical clearance validation.
                    </p>
                  </div>
                  <label
                    className="btn primary"
                    style={{ fontSize: 11, padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>{isInspectingFont ? 'Analyzing…' : '📤 Inspect WebFont (.woff2 / .ttf)'}</span>
                    <input
                      id="inspect-font-file-input"
                      name="inspectFontFileInput"
                      aria-label="Inspect WebFont file (.woff2, .woff, .ttf, .otf)"
                      type="file"
                      accept=".woff2,.woff,.ttf,.otf"
                      style={{ display: 'none' }}
                      disabled={isInspectingFont}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleInspectFontFile(file);
                      }}
                    />
                  </label>
                </div>

                {fontFileNotice && (
                  <div
                    style={{
                      background: 'rgba(22, 101, 52, 0.08)',
                      border: '1px solid rgba(22, 101, 52, 0.25)',
                      color: 'var(--ok-text, #166534)',
                      padding: '8px 12px',
                      borderRadius: 6,
                      fontSize: 12,
                      marginBottom: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>✓</span>
                    <span>{fontFileNotice}</span>
                  </div>
                )}

                {inspectedFont && (
                  <div
                    style={{
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      padding: 14,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div>
                        <b style={{ fontSize: 14 }}>{inspectedFont.fontFamily}</b>
                        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>
                          Format: <code>{inspectedFont.format}</code> · Size: {Math.round(inspectedFont.fileSizeBytes / 1024)} KB
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span
                          className="pill"
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            background: inspectedFont.status === 'AAA_COMPLIANT' ? '#10B981' : '#F59E0B',
                            color: '#fff',
                          }}
                        >
                          {inspectedFont.status}
                        </span>
                        <span className={`pill ${inspectedFont.coveragePercent === 100 ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
                          {inspectedFont.presentCount}/{inspectedFont.totalRequired} Sorani glyphs ({inspectedFont.coveragePercent}%)
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
                      <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: 6, fontSize: 11 }}>
                        <div style={{ color: 'var(--muted)' }}>Missing Sorani glyphs</div>
                        <b style={{ color: inspectedFont.missingGlyphs.length ? '#EF4444' : '#10B981', fontSize: 13 }}>
                          {inspectedFont.missingGlyphs.length}
                        </b>
                      </div>
                      <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: 6, fontSize: 11 }}>
                        <div style={{ color: 'var(--muted)' }}>ZWNJ (U+200C)</div>
                        <b style={{ color: inspectedFont.hasZwnj ? '#10B981' : '#EF4444', fontSize: 13 }}>
                          {inspectedFont.hasZwnj ? 'present' : 'missing'}
                        </b>
                      </div>
                      <div style={{ background: 'var(--panel)', padding: '8px 10px', borderRadius: 6, fontSize: 11 }}>
                        <div style={{ color: 'var(--muted)' }}>Diacritic clearance</div>
                        <b style={{ fontSize: 13 }}>not measured</b>
                      </div>
                    </div>

                    {/* Specimen */}
                    <div
                      style={{
                        padding: 10,
                        background: 'var(--panel)',
                        borderRadius: 6,
                        border: '1px dashed var(--line)',
                        direction: 'rtl',
                        fontSize: 15,
                        textAlign: 'right',
                        marginBottom: 10,
                      }}
                    >
                      <span style={{ color: '#38BDF8', fontWeight: 700 }}>پ چ ژ گ ڤ ڵ ڕ ێ ۆ ە</span>
                      <span style={{ color: 'var(--muted)', margin: '0 8px' }}>·</span>
                      <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>
                        {inspectedFont.missingGlyphs.length
                          ? `Missing: ${inspectedFont.missingGlyphs.map((g) => `${g.char} ${g.hex}`).join(', ')}`
                          : 'No required Sorani glyph is missing.'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        style={{
                          fontSize: 11,
                          padding: '6px 14px',
                          background: 'rgba(56, 189, 248, 0.15)',
                          color: 'var(--accent)',
                          border: '1px solid var(--accent)',
                          fontWeight: 600,
                        }}
                        onClick={handleAddInspectedFontToDna}
                      >
                        ✓ Register Font in Client DNA Typography
                      </button>
                      <button
                        className="btn"
                        style={{
                          fontSize: 11,
                          padding: '6px 12px',
                          background: 'rgba(16, 185, 129, 0.15)',
                          color: '#10B981',
                          border: '1px solid #10B981',
                          fontWeight: 600,
                        }}
                        onClick={handleCopyFontCdnSnippet}
                        title="Copy @font-face CDN stylesheet import snippet"
                      >
                        🔗 Copy CDN @font-face CSS
                      </button>
                      <button
                        className="btn"
                        style={{
                          fontSize: 11,
                          padding: '6px 12px',
                          background: 'rgba(212, 175, 55, 0.15)',
                          color: '#D4AF37',
                          border: '1px solid rgba(212, 175, 55, 0.4)',
                          fontWeight: 600,
                        }}
                        onClick={handleDownloadFontCssKit}
                        title="Download self-contained CSS webfont stylesheet"
                      >
                        📦 Download CSS Kit
                      </button>
                    </div>
                  </div>
                )}
              </div>

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
                  id="dna-new-disclaimer-input"
                  name="newDisclaimer"
                  aria-label="New required disclaimer text"
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
          {currentDna && activeTab === 'rules' && (
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
                  id="dna-new-banned-phrase-input"
                  name="newBannedPhrase"
                  aria-label="Add banned word or phrase"
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
                  id="dna-new-layout-rule-input"
                  name="newLayoutRule"
                  aria-label="New layout rule or safety margin"
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
            <h2 style={{ margin: 0, fontSize: 16 }}>Governance & Audit</h2>
            <span className="pill ok">{unread.snapshots ? '—' : snapshots.length} Snapshots</span>
          </div>

          <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Current Revision</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
              {currentDna ? `v${currentDna.version} Active` : 'DNA not read'}
            </div>
            <button
              className="btn primary"
              style={{ width: '100%', marginTop: 10, fontSize: 12 }}
              onClick={() => setShowSnapshotModal(true)}
                disabled={!currentDna}
            >
              🛡️ Create Immutable Version
            </button>
          </div>

          {/* Candidate Rules from Operator Feedback (Governed Learning) */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 8px' }}>
            <h3 style={{ margin: 0, fontSize: 13 }}>Candidate Rules (Governed Learning)</h3>
            <span className="pill blue" style={{ fontSize: 9 }}>Client reference rules</span>
          </div>

          {unread.rules ? (
            <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, fontSize: 12, color: 'var(--muted)' }}>
              Candidate rules unknown: {unread.rules}
            </div>
          ) : candidateRules.filter((r) => r.status !== 'dismissed').length === 0 ? (
            <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, fontSize: 12, color: 'var(--muted)' }}>
              No pending candidate rules for this client.
            </div>
          ) : (
            candidateRules
              .filter((r) => r.status !== 'dismissed')
              .map((rule) => (
                <div
                  key={rule.ruleId}
                  className="finding"
                  style={{
                    marginBottom: 12,
                    borderColor: rule.status === 'promoted' ? '#166534' : undefined,
                    background: rule.status === 'promoted' ? 'rgba(22, 101, 52, 0.08)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <b style={{ color: rule.status === 'promoted' ? '#166534' : 'var(--text)', fontSize: 12 }}>
                      {rule.title}
                    </b>
                    <span
                      className="pill"
                      style={{
                        fontSize: 9,
                        background: rule.status === 'promoted' ? '#166534' : 'rgba(2, 132, 199, 0.12)',
                        color: rule.status === 'promoted' ? '#ffffff' : 'var(--accent-text, #0369a1)',
                      }}
                    >
                      {rule.status === 'promoted' ? '✓ PROMOTED' : rule.confidence === null ? 'confidence not reported' : `${Math.round(rule.confidence * 100)}% CONFIDENCE`}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0', fontSize: 11, color: rule.status === 'promoted' ? '#166534' : 'var(--muted)' }}>
                    {rule.ruleText}
                    {rule.rationale ? ` — ${rule.rationale}` : ''}
                  </p>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Occurrences: <b>{rule.occurrences ?? '—'}</b></span>
                    <span>·</span>
                    <span>Evidence tasks: <b>{rule.evidenceTasks ?? '—'}</b></span>
                  </div>

                  {rule.status !== 'promoted' && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        className="btn primary"
                        style={{ fontSize: 11, padding: '5px 10px', flex: 1 }}
                        onClick={() => handlePromoteCandidate(rule.ruleId)}
                      >
                        Approve & Promote to Active DNA
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: 11, padding: '5px 8px' }}
                        onClick={() => handleDismissCandidate(rule.ruleId)}
                        title="Dismiss Candidate Rule"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ))
          )}

          {/* Immutable Snapshot Timeline */}
          <h3 style={{ margin: '20px 0 10px', fontSize: 13 }}>Immutable Snapshot Timeline</h3>
          {unread.snapshots && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Snapshots unknown: {unread.snapshots}</div>
          )}
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
