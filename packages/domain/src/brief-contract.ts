import { createHash } from 'node:crypto';

/**
 * The executable brief contract (ADR-125).
 *
 * The Studio brief is a model's reading of a request. It is useful, but it is not an authority for
 * the client's copy, assets or order, and its stylistic guesses are not requirements. This record
 * states, per fact, which layer it belongs to and which single authority decides it:
 *
 * - exact content: approved copy and client assets, by hash; never rewritten, omitted or reordered.
 * - communication intent: the client's words and the model's reading of hierarchy and order.
 * - protected design: relations existing checks enforce (source-copy order, safe area, overlap, aspect).
 * - permitted change: what composition may freely decide.
 * - soft preference: model proposals applied as defaults or used as advice.
 * - unknown: what the brief could not establish.
 *
 * A model proposal can never sit in the exact-content, protected or permitted layers. The model's
 * readingOrder stays a proposal; source-copy order stays protected (ADR-109/116). Disagreements
 * are recorded with the authority that resolved them, and a conflict no layout can satisfy is
 * blocking: it carries a short explanation and only the choices someone is authorized to make.
 * Nothing here shrinks, omits, splits or rewords copy to make a conflict disappear.
 *
 * Pure domain logic: measurements and policy identities arrive as input evidence.
 */
export const BRIEF_CONTRACT_VERSION = 'brief-contract.v1';

export const LAYOUT_RELATION_KINDS = ['align', 'group', 'readingOrder', 'gap', 'keepInside', 'anchor', 'aspect', 'crop', 'noOverlap'] as const;
export type LayoutRelationKind = (typeof LAYOUT_RELATION_KINDS)[number];

export const BRIEF_CONTRACT_LAYERS = ['exact_content', 'communication_intent', 'protected_design', 'permitted_change', 'soft_preference', 'unknown'] as const;
export type BriefContractLayer = (typeof BRIEF_CONTRACT_LAYERS)[number];

export type BriefAuthority = 'source_copy' | 'run_effective_copy' | 'client_asset' | 'client_instruction' | 'client_rule' | 'house_policy' | 'model_proposal';

/** The only choices a conflict may offer. Each is a decision a client or office human is authorized to make. */
export const BRIEF_CONTRACT_CHOICES = [
  'CLIENT_APPROVES_REVISED_COPY', 'CHOOSE_WIDER_APPROVED_FORMAT', 'KEEP_SOURCE_ORDER', 'CLIENT_CONFIRMS_VISUAL_ORDER',
  'KEEP_CLIENT_PHOTOS', 'CLIENT_WITHDRAWS_PHOTOS', 'ACCEPT_PALETTE_COLOUR', 'AUTHORIZED_PALETTE_CHANGE',
] as const;
export type BriefContractChoice = (typeof BRIEF_CONTRACT_CHOICES)[number];

export interface BriefContractElement { id: string; kind: 'canvas' | 'region' | 'text' | 'logo' | 'photo'; script?: string }

export interface BriefContractItem {
  /** Stable fact identity; one item, and so one authority, per fact. */
  id: string;
  layer: BriefContractLayer;
  authority: BriefAuthority;
  /** Stable element IDs (renderer IDs: text-copy-N, logo, photo-N). */
  subject: string[];
  relation?: LayoutRelationKind;
  value?: unknown;
  /** Defect codes of the existing checks that enforce it, or `preparation`, `advisory`, `model_instruction_only`. */
  enforcedBy: string[];
  /** For a model proposal that competes with a protected fact: whether it was adopted. */
  adopted?: boolean;
}

export interface BriefContractConflict {
  code: string;
  blocking: boolean;
  subject: string[];
  explanation: string;
  authorizedChoices: BriefContractChoice[];
  /** How authority resolved a non-blocking disagreement. */
  resolution?: string;
}

export interface PolicyIdentity { id: string; version: string; sha256: string }

export interface ExecutableBriefContract {
  version: typeof BRIEF_CONTRACT_VERSION;
  /** sha256 of the canonical JSON of every other field. */
  sha256: string;
  /** sha256 of the canonical JSON of the model brief the proposals were read from. */
  briefSha256: string | null;
  canvas: { width: number; height: number };
  elements: BriefContractElement[];
  items: BriefContractItem[];
  conflicts: BriefContractConflict[];
  policies: PolicyIdentity[];
}

/** The model brief, as stored: every field optional because historical briefs lack some. */
export interface BriefProposalInput {
  occasion?: string; audience?: string; formality?: number; toneWords?: string[]; kurdishLeads?: boolean;
  readingOrder?: number[];
  roles?: Array<{ copyIndex: number; role: string; importance?: number }>;
  must?: string[]; mustNot?: string[];
  imageryStrategy?: string; imageryRationale?: string;
  riskFlags?: string[];
  requestedBackground?: string;
  referenceRole?: string; referenceNotes?: string; referenceSeen?: boolean;
  imageRoles?: Array<{ index: number; role: string; notes?: string }>;
  styleSpec?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CopyFeasibilityEvidence {
  version: string;
  safeWidthPx: number;
  minimumFontPx: number;
  blocks: Array<{ copyIndex: number; status: 'fits' | 'exceeds_safe_width' | 'unknown'; narrowestPx?: number; family?: string; measuredFaces: number; unmeasured: string[] }>;
}

export interface BriefContractInput {
  canvas: { width: number; height: number };
  safeArea?: { x: number; y: number; width: number; height: number };
  copy: Array<{ text: string; script: string }>;
  /** Whose copy this is: the request's, or copy a directed edit of this run already changed. */
  copyAuthority: 'source_copy' | 'run_effective_copy';
  instructions?: string;
  clientRules?: string;
  logo?: { sha256: string } | null;
  photos: Array<{ sha256: string; width?: number; height?: number }>;
  reference?: { sha256: string } | null;
  brief: BriefProposalInput;
  /** The palette colour preparation actually applies as the background, if any. */
  appliedBackground?: string;
  policies: PolicyIdentity[];
  copyFeasibility?: CopyFeasibilityEvidence;
}

/** JSON with object keys sorted at every depth, so the digest survives JSONB storage. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const bodyDigest = (contract: Omit<ExecutableBriefContract, 'sha256'>) => sha256(canonicalJson(contract));

const EXACT_AUTHORITIES: BriefAuthority[] = ['source_copy', 'run_effective_copy', 'client_asset'];
const MODEL_LAYERS: BriefContractLayer[] = ['communication_intent', 'soft_preference', 'unknown'];

export function buildBriefContract(input: BriefContractInput): ExecutableBriefContract {
  const brief = input.brief ?? {};
  const textIds = input.copy.map((_, i) => `text-copy-${i}`);
  const logoIds = input.logo ? ['logo'] : [];
  const photoIds = input.photos.map((_, i) => `photo-${i}`);
  const elements: BriefContractElement[] = [
    { id: 'canvas', kind: 'canvas' }, { id: 'canvas.safe-area', kind: 'region' },
    ...input.copy.map((c, i) => ({ id: textIds[i], kind: 'text' as const, script: c.script })),
    ...logoIds.map((id) => ({ id, kind: 'logo' as const })),
    ...photoIds.map((id) => ({ id, kind: 'photo' as const })),
  ];
  const items: BriefContractItem[] = [];
  const conflicts: BriefContractConflict[] = [];
  const add = (item: BriefContractItem) => items.push(item);
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

  // Exact content: the approved copy and client assets, by identity. The text stays in the request.
  input.copy.forEach((c, i) => add({ id: `content/${textIds[i]}`, layer: 'exact_content', authority: input.copyAuthority, subject: [textIds[i]],
    value: { sha256: sha256(c.text), characters: [...c.text].length, script: c.script }, enforcedBy: ['COPY_PLACEMENT', 'copy_by_reference'] }));
  if (input.logo) add({ id: 'content/logo', layer: 'exact_content', authority: 'client_asset', subject: ['logo'], value: { sha256: input.logo.sha256 }, enforcedBy: ['LOGO', 'CLIENT_LOGO_REQUIRED'] });
  input.photos.forEach((p, i) => add({ id: `content/${photoIds[i]}`, layer: 'exact_content', authority: 'client_asset', subject: [photoIds[i]],
    value: { sha256: p.sha256, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) }, enforcedBy: ['PHOTOS'] }));

  // Communication intent: the client's words are authority but only a model can read them.
  if (input.instructions?.trim()) add({ id: 'client/instructions', layer: 'communication_intent', authority: 'client_instruction', subject: ['canvas'],
    value: { sha256: sha256(input.instructions), characters: [...input.instructions].length }, enforcedBy: ['model_instruction_only'] });
  const summary = Object.fromEntries((['occasion', 'audience', 'formality', 'toneWords', 'kurdishLeads'] as const)
    .filter((k) => brief[k] !== undefined && brief[k] !== '').map((k) => [k, brief[k]]));
  if (Object.keys(summary).length) add({ id: 'proposal/summary', layer: 'communication_intent', authority: 'model_proposal', subject: ['canvas'], value: summary, enforcedBy: ['advisory'] });
  const roles = (Array.isArray(brief.roles) ? brief.roles : []).filter((r) => r && Number.isInteger(r.copyIndex) && r.copyIndex >= 0 && r.copyIndex < textIds.length);
  if (roles.length) add({ id: 'proposal/hierarchy', layer: 'communication_intent', authority: 'model_proposal', subject: roles.map((r) => textIds[r.copyIndex]),
    value: roles.map((r) => ({ element: textIds[r.copyIndex], role: r.role, ...(r.importance !== undefined ? { importance: r.importance } : {}) })), enforcedBy: ['advisory'] });
  const sourceOrder = textIds;
  if (Array.isArray(brief.readingOrder)) {
    const proposed = [...new Set(brief.readingOrder.filter((i) => Number.isInteger(i) && i >= 0 && i < textIds.length))].map((i) => textIds[i]);
    const adopted = proposed.length === sourceOrder.length && proposed.every((id, i) => id === sourceOrder[i]);
    add({ id: 'proposal/reading-order', layer: 'communication_intent', authority: 'model_proposal', subject: proposed, relation: 'readingOrder', adopted, enforcedBy: ['advisory'] });
    if (!adopted) conflicts.push({ code: 'READING_ORDER_PROPOSAL_NOT_ADOPTED', blocking: false, subject: proposed,
      explanation: `The brief proposed reading ${proposed.join(' > ')}; source copy order ${sourceOrder.join(' > ')} is protected and kept.`,
      authorizedChoices: ['KEEP_SOURCE_ORDER', 'CLIENT_CONFIRMS_VISUAL_ORDER'], resolution: 'source_copy_order_protected' });
  }

  // Protected design: relations existing checks enforce.
  if (textIds.length) add({ id: 'relation/reading-order/source', layer: 'protected_design', authority: input.copyAuthority, subject: sourceOrder, relation: 'readingOrder', enforcedBy: ['COPY_ORDER'] });
  add({ id: 'relation/keep-inside/safe-area', layer: 'protected_design', authority: 'house_policy', subject: [...textIds, ...logoIds, 'canvas.safe-area'], relation: 'keepInside',
    ...(input.safeArea ? { value: input.safeArea } : {}), enforcedBy: ['BOUNDS'] });
  add({ id: 'relation/no-overlap/text-logo', layer: 'protected_design', authority: 'house_policy', subject: [...textIds, ...logoIds], relation: 'noOverlap', enforcedBy: ['OVERLAP'] });
  if (photoIds.length) add({ id: 'relation/no-overlap/photos', layer: 'protected_design', authority: 'house_policy', subject: [...photoIds, ...textIds, ...logoIds], relation: 'noOverlap', enforcedBy: ['PHOTOS'] });
  if (logoIds.length) add({ id: 'relation/aspect/logo', layer: 'protected_design', authority: 'client_asset', subject: logoIds, relation: 'aspect', enforcedBy: ['LOGO'] });
  if (photoIds.length) add({ id: 'relation/aspect/photos', layer: 'protected_design', authority: 'client_asset', subject: photoIds, relation: 'aspect', enforcedBy: ['renderer_cover_fit'] });
  if (input.clientRules?.trim()) add({ id: 'rule/client', layer: 'protected_design', authority: 'client_rule', subject: ['canvas'],
    value: { sha256: sha256(input.clientRules) }, enforcedBy: ['model_instruction_only'] });

  // Permitted change: what a new composition may decide.
  add({ id: 'change/composition', layer: 'permitted_change', authority: 'house_policy', subject: [...textIds, ...logoIds, ...photoIds],
    value: { position: true, size: true, lineBreaks: 'between_words', typeSize: 'at_or_above_minimum', fonts: 'admitted', colours: 'client_palette' },
    enforcedBy: ['BOUNDS', 'MIN_SIZE', 'FONT_NOT_ADMITTED', 'PALETTE'] });
  photoIds.forEach((id) => add({ id: `change/crop/${id}`, layer: 'permitted_change', authority: 'house_policy', subject: [id], relation: 'crop',
    value: 'cover_fit_around_detected_faces', enforcedBy: ['renderer_cover_fit'] }));

  // Soft preferences: model proposals, applied by preparation or used as advice. Never requirements.
  if (strings(brief.must).length) add({ id: 'proposal/must', layer: 'soft_preference', authority: 'model_proposal', subject: ['canvas'], value: strings(brief.must), enforcedBy: ['advisory'] });
  if (strings(brief.mustNot).length) add({ id: 'proposal/must-not', layer: 'soft_preference', authority: 'model_proposal', subject: ['canvas'], value: strings(brief.mustNot), enforcedBy: ['advisory'] });
  if (typeof brief.imageryStrategy === 'string') add({ id: 'proposal/imagery', layer: 'soft_preference', authority: 'model_proposal', subject: ['canvas'],
    value: { strategy: brief.imageryStrategy, ...(brief.imageryRationale ? { rationale: brief.imageryRationale } : {}) }, enforcedBy: ['preparation'] });
  for (const [key, value] of Object.entries(brief.styleSpec && typeof brief.styleSpec === 'object' ? brief.styleSpec : {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value === 'as_generated' || value === false || value === undefined || value === null) continue;
    const anchored = key === 'logoCorner' && logoIds.length > 0;
    add({ id: `proposal/style/${key}`, layer: 'soft_preference', authority: 'model_proposal', subject: anchored ? logoIds : ['canvas'],
      ...(anchored ? { relation: 'anchor' as const } : {}), value, enforcedBy: ['preparation'] });
  }
  const requested = typeof brief.requestedBackground === 'string' ? brief.requestedBackground.trim() : '';
  if (requested || input.appliedBackground) add({ id: 'proposal/background', layer: 'soft_preference', authority: 'model_proposal', subject: ['canvas'],
    value: { ...(requested ? { requested } : {}), ...(input.appliedBackground ? { applied: input.appliedBackground } : {}) }, enforcedBy: ['preparation'] });
  if (typeof brief.referenceNotes === 'string' && brief.referenceNotes.trim() && input.reference) add({ id: 'proposal/reference-notes', layer: 'soft_preference',
    authority: 'model_proposal', subject: ['canvas'], value: { referenceSha256: input.reference.sha256, notes: brief.referenceNotes }, enforcedBy: ['advisory'] });

  // Unknown: what the brief could not establish.
  strings(brief.riskFlags).forEach((flag, i) => add({ id: `unknown/risk/${i}`, layer: 'unknown', authority: 'model_proposal', subject: ['canvas'], value: flag, enforcedBy: ['advisory'] }));
  (Array.isArray(brief.imageRoles) ? brief.imageRoles : []).filter((r) => r && r.role === 'unrelated' && Number.isInteger(r.index))
    .forEach((r) => add({ id: `unknown/image/${r.index}`, layer: 'unknown', authority: 'model_proposal', subject: ['canvas'], value: { imageIndex: r.index, role: 'unrelated' }, enforcedBy: ['advisory'] }));
  if (input.reference && brief.referenceSeen === false) add({ id: 'unknown/reference-unseen', layer: 'unknown', authority: 'model_proposal', subject: ['canvas'],
    value: { referenceSha256: input.reference.sha256 }, enforcedBy: ['advisory'] });

  // Copy no layout can set: blocking, with only authorized choices. Unmeasured copy is unknown, not a conflict.
  const fit = input.copyFeasibility;
  const fitConflicts: BriefContractConflict[] = [];
  for (const block of fit?.blocks ?? []) {
    const id = textIds[block.copyIndex];
    if (!id) continue;
    if (block.status === 'unknown') add({ id: `unknown/fit/${id}`, layer: 'unknown', authority: 'house_policy', subject: [id],
      value: { version: fit!.version, unmeasured: block.unmeasured }, enforcedBy: ['COPY_UNMEASURED'] });
    if (block.status === 'exceeds_safe_width') fitConflicts.push({ code: 'COPY_UNBREAKABLE_AT_MINIMUM_SIZE', blocking: true, subject: [id],
      explanation: `${id} contains an unbroken run ${block.narrowestPx}px wide at the ${fit!.minimumFontPx}px minimum in its narrowest admitted face` +
        `${block.family ? ` (${block.family})` : ''}; the safe width is ${fit!.safeWidthPx}px, so no layout can pass QA. ` +
        'The copy is not shrunk, omitted, split or reworded automatically.',
      authorizedChoices: ['CLIENT_APPROVES_REVISED_COPY', 'CHOOSE_WIDER_APPROVED_FORMAT'] });
  }
  conflicts.unshift(...fitConflicts);

  if (brief.imageryStrategy === 'none' && photoIds.length) conflicts.push({ code: 'IMAGERY_NONE_WITH_CLIENT_PHOTOS', blocking: false, subject: photoIds,
    explanation: 'The brief chose no imagery, but the client sent photographs to place. The photographs stay; only optional artwork is suppressed.',
    authorizedChoices: ['KEEP_CLIENT_PHOTOS', 'CLIENT_WITHDRAWS_PHOTOS'], resolution: 'client_photos_retained_optional_art_suppressed' });
  if (/^#[0-9a-f]{6}$/i.test(requested)) {
    if (!input.appliedBackground) conflicts.push({ code: 'REQUESTED_BACKGROUND_NOT_APPLIED', blocking: false, subject: ['canvas'],
      explanation: `The brief read a background request for ${requested}; no palette colour is available to apply.`,
      authorizedChoices: ['AUTHORIZED_PALETTE_CHANGE'], resolution: 'not_applied' });
    else if (input.appliedBackground.toLowerCase() !== requested.toLowerCase()) conflicts.push({ code: 'REQUESTED_BACKGROUND_MAPPED_TO_PALETTE', blocking: false, subject: ['canvas'],
      explanation: `The brief read a background request for ${requested}; the client palette colour ${input.appliedBackground} is applied instead.`,
      authorizedChoices: ['ACCEPT_PALETTE_COLOUR', 'AUTHORIZED_PALETTE_CHANGE'], resolution: 'nearest_palette_colour' });
  }

  const body: Omit<ExecutableBriefContract, 'sha256'> = {
    version: BRIEF_CONTRACT_VERSION,
    briefSha256: input.brief ? sha256(canonicalJson(input.brief)) : null,
    canvas: { width: input.canvas.width, height: input.canvas.height },
    elements, items, conflicts,
    policies: input.policies.map((p) => ({ id: p.id, version: p.version, sha256: p.sha256 })),
  };
  const contract = { ...body, sha256: bodyDigest(body) };
  const violations = validateBriefContract(contract);
  if (violations.length) throw new Error(`BRIEF_CONTRACT_INVALID: ${violations.join(', ')}`);
  return contract;
}

/** Structural invariants: one authority per fact, no promoted proposals, known elements and choices. */
export function validateBriefContract(contract: ExecutableBriefContract): string[] {
  const violations: string[] = [];
  const elements = new Set(contract.elements.map((e) => e.id));
  const seen = new Set<string>();
  for (const item of contract.items) {
    if (seen.has(item.id)) violations.push(`DUPLICATE_FACT:${item.id}`);
    seen.add(item.id);
    if (!BRIEF_CONTRACT_LAYERS.includes(item.layer)) violations.push(`UNKNOWN_LAYER:${item.id}`);
    if (item.authority === 'model_proposal' && !MODEL_LAYERS.includes(item.layer)) violations.push(`MODEL_PROPOSAL_PROMOTED:${item.id}`);
    if (item.layer === 'exact_content' && !EXACT_AUTHORITIES.includes(item.authority)) violations.push(`EXACT_CONTENT_AUTHORITY:${item.id}`);
    if (item.relation !== undefined && !LAYOUT_RELATION_KINDS.includes(item.relation)) violations.push(`UNKNOWN_RELATION:${item.id}`);
    for (const id of item.subject) if (!elements.has(id)) violations.push(`UNKNOWN_ELEMENT:${item.id}:${id}`);
  }
  for (const conflict of contract.conflicts) {
    for (const choice of conflict.authorizedChoices) if (!BRIEF_CONTRACT_CHOICES.includes(choice)) violations.push(`UNAUTHORIZED_CHOICE:${conflict.code}:${choice}`);
    if (conflict.blocking && conflict.authorizedChoices.length === 0) violations.push(`BLOCKING_WITHOUT_CHOICES:${conflict.code}`);
    for (const id of conflict.subject) if (!elements.has(id)) violations.push(`UNKNOWN_ELEMENT:${conflict.code}:${id}`);
  }
  return violations;
}

/** The digest still matches the recorded body, whatever key order storage returned it in. */
export function verifyBriefContractIntegrity(contract: ExecutableBriefContract): boolean {
  if (!contract || contract.version !== BRIEF_CONTRACT_VERSION || typeof contract.sha256 !== 'string') return false;
  const { sha256: recorded, ...body } = contract;
  return bodyDigest(body) === recorded;
}

export function blockingBriefConflicts(contract: ExecutableBriefContract): BriefContractConflict[] {
  return contract.conflicts.filter((c) => c.blocking);
}

/** The compact statement a layout model receives. Copy text is supplied separately, by index. */
export function renderBriefContractForPrompt(contract: ExecutableBriefContract): string {
  const byId = new Map(contract.items.map((i) => [i.id, i]));
  const ids = (kind: BriefContractElement['kind']) => contract.elements.filter((e) => e.kind === kind).map((e) => e.id);
  const text = ids('text'), logo = ids('logo'), photos = ids('photo');
  const order = byId.get('relation/reading-order/source');
  const proposal = byId.get('proposal/reading-order');
  const lines = [
    `Executable brief contract ${contract.version} (${contract.sha256.slice(0, 12)}). Each line states its authority. ` +
      'Model proposals are advisory; they never override exact content or protected relations.',
    `Exact content (approved copy and client assets): ${[...text, ...logo, ...photos].join(', ')}. Copy is supplied by index; never rewrite, omit, split or reorder it.`,
    `Protected: ${order ? `readingOrder ${order.subject.join(' > ')} (source copy order; protected); ` : ''}keepInside safe area for text and logo; ` +
      `noOverlap between text, logo${photos.length ? ' and photos' : ''}; ${logo.length || photos.length ? `aspect of ${[...logo, ...(photos.length ? ['photos'] : [])].join(' and ')} preserved.` : ''}`.trimEnd(),
    `Permitted: position, size, line breaks between words, type at or above the minimum size, admitted fonts, the client palette${photos.length ? ', photo crop by cover fit' : ''}.`,
  ];
  if (byId.has('rule/client') || byId.has('client/instructions')) lines.push('Client rules and instructions (stated separately) are requirements a model must read; no automatic check verifies them.');
  if (proposal) lines.push(`Model proposal: proposed reading order ${proposal.subject.join(' > ')} (${proposal.adopted ? 'matches source order' : 'not adopted'}). Other proposals: the structured brief below.`);
  const resolved = contract.conflicts.filter((c) => !c.blocking && c.code !== 'READING_ORDER_PROPOSAL_NOT_ADOPTED');
  if (resolved.length) lines.push(`Resolved disagreements: ${resolved.map((c) => `${c.code} (${c.resolution})`).join('; ')}.`);
  const unknown = contract.items.filter((i) => i.layer === 'unknown');
  if (unknown.length) lines.push(`Unknown: ${unknown.map((i) => i.id).join(', ')}. Do not invent facts for them.`);
  return lines.join('\n');
}
