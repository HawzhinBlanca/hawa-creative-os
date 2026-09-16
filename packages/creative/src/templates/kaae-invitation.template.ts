import type { StudioOperation } from '@hawa/contracts';
import { KAAE_PRIMARY_LOGO_SHA256 } from './kaae-certificate.template.js';
import { wrapTextToLines } from '../operations-to-svg.js';

export interface KaaeInvitationParams {
  pageId?: string;
  width?: number;
  height?: number;
  title?: string;
  salutation?: string;
  hostProse?: string;
  keynoteBody?: string;
  mouBody?: string;
  dateTime?: string;
  venue?: string;
  accessBadge?: string;
  protocolNotice?: string;
  extraParagraphs?: string[];
  statutoryRule?: string;
  footerTokens?: string;
  logoSha256?: string;
  learnedRules?: string[];
}

export function parseInvitationContent(rawText: string): Partial<KaaeInvitationParams> {
  const paragraphs = rawText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let title = '';
  let salutation = '';
  let hostProse = '';
  let keynoteBody = '';
  let mouBody = '';
  let dateTime = '';
  let venue = '';
  let accessBadge = '';
  let protocolNotice = '';
  const extraParagraphs: string[] = [];

  for (const p of paragraphs) {
    if (/non-transferable|do not share/i.test(p)) {
      if (!protocolNotice) protocolNotice = p; else extraParagraphs.push(p);
    } else if (/by invitation only|invitation only/i.test(p)) {
      if (!accessBadge) accessBadge = p; else extraParagraphs.push(p);
    } else if (/^(?:mr|ms|mrs|dr|h\.e\.)\b|\[full name\]|\[name\]/i.test(p)) {
      if (!salutation) salutation = p; else extraParagraphs.push(p);
    } else if (/cordially requests|honor of your presence|honour of your presence|requests the honor|requests the pleasure/i.test(p)) {
      if (!hostProse) hostProse = p; else extraParagraphs.push(p);
    } else if (/prime minister|officially announce/i.test(p)) {
      if (!keynoteBody) keynoteBody = p; else extraParagraphs.push(p);
    } else if (/memorandum of understanding|mou|minister of education/i.test(p)) {
      if (!mouBody) mouBody = p; else extraParagraphs.push(p);
    } else if (/(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b202\d\b/i.test(p)) {
      if (!dateTime) {
        const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
        dateTime = lines[0];
        if (lines.length > 1 && !venue) {
          venue = lines.slice(1).join(' ');
        }
      } else {
        extraParagraphs.push(p);
      }
    } else if (/hall|hotel|center|auditorium|saad abdullah|erbil/i.test(p)) {
      if (!venue) venue = p; else extraParagraphs.push(p);
    } else if (!title && p.length < 120) {
      title = p;
    } else {
      extraParagraphs.push(p);
    }
  }

  return {
    title: title || undefined,
    salutation: salutation || undefined,
    hostProse: hostProse || undefined,
    keynoteBody: keynoteBody || undefined,
    mouBody: mouBody || undefined,
    dateTime: dateTime || undefined,
    venue: venue || undefined,
    accessBadge: accessBadge || undefined,
    protocolNotice: protocolNotice || undefined,
    extraParagraphs: extraParagraphs.length > 0 ? extraParagraphs : undefined,
  };
}

/** Editable local layout recipe. Native Canva capture is a separate boundary. */
export function buildKaaeInvitationOperations(params?: KaaeInvitationParams, overrides?: Partial<KaaeInvitationParams>): StudioOperation[] {
  const merged = { ...params, ...overrides };
  const pageId = merged.pageId || 'page_invitation';
  const width = merged.width || 1080;
  const height = merged.height || 1350;
  const logoSha = merged.logoSha256 || KAAE_PRIMARY_LOGO_SHA256;
  const title = merged.title || 'THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION';
  const salutation = merged.salutation || 'Mr. / Ms. / Dr. [Full Name]';
  const hostProse =
    merged.hostProse ||
    'The Kurdistan Accrediting Association for Education cordially requests the honor of your presence at this landmark occasion.';
  const keynoteBody =
    merged.keynoteBody ||
    'His Excellency Prime Minister Masrour Barzani will officially announce the National Standards for Quality Assurance in Education, marking a defining moment in the advancement of educational quality across the Kurdistan Region. The occasion will bring together government, educational institutions, and international partners around a shared national vision for excellence, accountability, and continuous improvement.';
  const mouBody =
    merged.mouBody ||
    'As part of the official launch, the Minister of Education and the Minister of Higher Education and Scientific Research will sign a Memorandum of Understanding (MoU), marking a significant commitment to cooperation and the advancement of quality assurance across the education sector.';
  const dateTime = merged.dateTime || 'September 9, 2026 | 2:30 PM';
  const venue = merged.venue || 'Saad Abdullah Conference Hall';
  const accessBadge = merged.accessBadge ? merged.accessBadge.trim() : 'By Invitation Only';
  const protocolNotice =
    merged.protocolNotice ||
    'This invitation is personal and non-transferable. Kindly do not share this invitation.';


  if (width < 700 || height < 1100) throw new Error('Invitation requires a larger canvas or a separately reviewed layout');
  const ops: StudioOperation[] = [{ op: 'addVector', nodeId: 'inv_bg', pageId,
    x: 0, y: 0, width, height, locked: true,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="navy"><stop stop-color="#163554"/><stop offset="1" stop-color="#091829"/></radialGradient></defs><rect width="${width}" height="${height}" fill="url(#navy)"/><rect x="28" y="28" width="${width-56}" height="${height-56}" fill="none" stroke="#BDA56B" stroke-opacity=".5"/></svg>` }];
  ops.push({ op: 'addImage', nodeId: 'inv_logo', pageId,
    asset: { storageKey: `assets/logos/${logoSha}.png`, sha256: logoSha, mimeType: 'image/png' },
    x: width/2-70, y: 48, width: 140, height: 140, fit: 'contain', locked: true });
  let y = 218;
  const margin = 84;
  const contentWidth = width - margin * 2;
  const addCopy = (id: string, text: string, role: string, fontSize: number, gap: number,
      family = 'Plus Jakarta Sans', color = '#F5F3ED', align = 'left') => {
    if (!text) return;
    const lineHeight = 1.45;
    const lines = wrapTextToLines(text, Math.max(16, Math.floor(contentWidth/(fontSize*.58))));
    const boxHeight = Math.ceil(fontSize + (lines.length-1)*fontSize*lineHeight + 6);
    ops.push({ op: 'addText', nodeId: id, pageId, text, role, x: margin, y, width: contentWidth, height: boxHeight,
      style: { fontFamily: family, fontSize, lineHeight, textAlign: align, color, fontWeight: role === 'headline' ? 'bold' : 'normal' }, locked: true });
    y += boxHeight + gap;
  };
  const rules = merged.learnedRules || [];
  let headerFont = 'Cinzel';
  let accentColor = '#D9C188';

  for (const rule of rules) {
    const lower = rule.toLowerCase();
    if (lower.includes('playfair')) headerFont = 'Playfair Display';
    else if (lower.includes('cinzel')) headerFont = 'Cinzel';

    const hexMatch = rule.match(/#[0-9a-fA-F]{6}\b/);
    if (hexMatch) {
      accentColor = hexMatch[0];
    }
  }

  addCopy('inv_title', title, 'headline', 30, 30, headerFont, '#F5F3ED', 'center');
  addCopy('inv_salutation', salutation, 'body', 28, 24, 'Playfair Display', accentColor, 'center');
  addCopy('inv_host_prose', hostProse, 'body', 22, 26, 'Plus Jakarta Sans', '#F5F3ED', 'center');
  addCopy('inv_keynote', keynoteBody, 'body', 20, 22);
  addCopy('inv_mou', mouBody, 'body', 20, 28);
  for (const [i, paragraph] of (merged.extraParagraphs || []).entries()) addCopy(`inv_extra_${i}`, paragraph, 'body', 20, 18);
  ops.push({ op: 'addVector', nodeId: 'inv_divider', pageId, x: margin, y, width: contentWidth, height: 2, locked: true,
    source: `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 1 H${contentWidth}" stroke="${accentColor}"/></svg>` });
  y += 22;
  addCopy('inv_date_val', dateTime, 'body', 23, 10, 'Plus Jakarta Sans', accentColor, 'center');
  addCopy('inv_venue_val', venue, 'body', 23, 24, 'Plus Jakarta Sans', '#F5F3ED', 'center');
  addCopy('inv_access_badge', accessBadge, 'body', 20, 14, headerFont === 'Cinzel' ? 'Cinzel' : headerFont, accentColor, 'center');
  addCopy('inv_protocol', protocolNotice, 'disclaimer', 17, 8, 'Plus Jakarta Sans', '#D1D8E0', 'center');
  if (merged.statutoryRule) addCopy('inv_statutory', merged.statutoryRule, 'disclaimer', 17, 8);
  if (merged.footerTokens) addCopy('inv_footer', merged.footerTokens, 'disclaimer', 17, 8);
  if (y > height - 48) throw new Error('Invitation copy exceeds safe canvas bounds; choose a larger format');
  return ops;
}
