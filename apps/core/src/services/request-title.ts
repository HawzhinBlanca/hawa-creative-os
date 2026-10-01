/**
 * A new request's title, made from the requester's words without a model (ADR-182, ADR-180, ADR-231).
 *
 * The title is the office's name for a design and, without its "Client: " prefix, the requester's. It is
 * made from the first line of the brief as people say it: no greeting, no request around it, no
 * direction mark at its edges, and the client named once. On 2026-10-01 at 13:58Z the words "Can you
 * make an Instagram post announcing our Assessment Literacy Workshop for school principals? It's on
 * 15 October 2026 …" became "Instagram post announcing our Assessment Lite…": the format and the verb
 * around the subject were kept, and the subject cut off. ADR-231 strips that lead-in too and keeps the
 * subject ("Assessment Literacy Workshop").
 *
 * Pure. `chat-campaign-intake.ts` calls `requestTitle`; it is the fallback whenever no grounded
 * headline names the design.
 */
import { requestOperatingSubject } from '@hawa/domain';
import { trimTitleMarks } from '@hawa/integrations';
import { cutText, startsWithName } from '../core-helpers.js';

const TITLE_NOUNS = 'poster|postr|flyer|banner|design|invitation|invite|card|post|story|brochure|certificate|announcement|graphic|cover|leaflet|infographic|thumbnail|ad|advert';
const TITLE_GREETING = /^(?:(?:hi|hello|hey|dear\s+(?:team|all|colleagues|friends|sir|madam)|good\s+(?:morning|afternoon|evening)|salam|slaw|silav|سڵاو|بەڕێزان)(?=[\s,،!.:-]|$)[\s,،!.:-]*)+/iu;
const TITLE_REQUEST = new RegExp('^(?:(?:and|also|so|ok(?:ay)?|please|pls|plz|kindly)\\s+)*' +
  '(?:(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?(?:make|mak|create|design|prepare|produce|do)\\s+(?:us\\s+|me\\s+)?|' +
  "(?:we|i)\\s+(?:need|want|would\\s+like|'d\\s+like)\\s+|(?:please\\s+)?(?:make|mak|create|design|prepare|produce)\\s+(?:us\\s+|me\\s+)?)?" +
  "(?:(?:a|an|another|one\\s+more|new|the)\\s+)?" +
  `(?=(?:[\\p{L}'-]+\\s+){0,2}(?:${TITLE_NOUNS})s?\\b)`, 'iu');
const TITLE_NOUN_PLEASE = new RegExp(`^(?:${TITLE_NOUNS})s?\\s+(?:please|pls|plz)\\s*[:,-]\\s*`, 'iu');
/**
 * ADR-231: the format and the verb before the subject: "Instagram post announcing our …", "a poster
 * promoting the …", "flyer about our …", "story to announce …", "banner for our …". "Poster for the
 * graduation ceremony" keeps its words: "for" is a lead-in only before "our" or "my".
 */
const TITLE_FORMAT_LEAD = new RegExp('^(?:(?:a|an|the|one)\\s+)?' +
  '(?:(?:instagram|insta|facebook|fb|linkedin|twitter|tiktok|whatsapp|telegram|social[\\s-]+media|web|website|digital|printed|print|a[345]|square|vertical|story)\\s+)*' +
  `(?:${TITLE_NOUNS})s?\\s+` +
  '(?:announcing|advertising|promoting|introducing|celebrating|about|(?:to\\s+)?(?:announce|promote|advertise|celebrate|introduce)|' +
  'inviting\\s+(?:\\p{L}+\\s+){0,2}to|for(?=\\s+(?:our|my)\\b))\\s+(?:(?:our|my|the|this|a|an)\\s+)?', 'iu');
/** Small words inside a name ("Festival of Lights", "Art & Music Week"): kept between capitalised words. */
const NAME_JOINERS = /^(?:of|and|&|for|in|on|the|to|at|de|al|el)$/iu;

/**
 * The subject after a format lead-in, as far as its first sentence goes; a run of capitalised words
 * at its start ("Assessment Literacy Workshop for school principals") is its name.
 */
function subjectName(rest: string): string {
  const sentence = rest.split(/[?؟!]|\.(?=\s|$)|\n/u)[0].replace(/[\s,:;،]+$/u, '').trim();
  const words = sentence.split(/\s+/).filter(Boolean);
  const named: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const capital = /^[\p{Lu}\d]/u.test(word);
    if (capital) { named.push(word); continue; }
    if (named.length && NAME_JOINERS.test(word) && words[i + 1] && /^[\p{Lu}\d]/u.test(words[i + 1])) { named.push(word); continue; }
    break;
  }
  return named.length >= 2 ? named.join(' ').replace(/[\s,:;،'’-]+$/u, '') : sentence;
}

/**
 * ADR-182: a design's name as people say it: its first line without the greeting and the request
 * around it ("Hi, we need a poster for the graduation ceremony" → "Poster for the graduation
 * ceremony", "Another poster please: KAAE staff football tournament" → "KAAE staff football
 * tournament"). The requester hears the name in every answer ("I'm making a first draft of …"), which
 * read "a first draft of Hi, we need a poster for …". A line that is nothing but a request keeps its
 * words. ADR-231: "an Instagram post announcing our Assessment Literacy Workshop …" → "Assessment
 * Literacy Workshop".
 */
export function spokenTitle(line: string): string {
  const lead = line.replace(TITLE_GREETING, '').replace(TITLE_REQUEST, '').replace(TITLE_NOUN_PLEASE, '');
  const format = TITLE_FORMAT_LEAD.exec(lead);
  if (format) {
    const subject = subjectName(lead.slice(format[0].length));
    if (subject.split(/\s+/).filter(Boolean).length >= 2) return subject.replace(/^[a-z]/, (c) => c.toUpperCase());
  }
  if (lead === line) return line;
  const said = lead.replace(/[\s?؟.!,:]+$/u, '').trim();
  return said.split(/\s+/).filter(Boolean).length < 2 ? line : said.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * A request's title from its headline (the first line that names it) and its label (the client's short
 * name, else the sender's): "<label>: <name>…", or "<name>…" when the name already starts with the
 * label ("KAAE K-12 Pilot Study…", never "KAAE: KAAE K-12 Pilot Study…"), with no direction mark at
 * either edge. `rawText` lets an operating subject ("a poster for the …") name a headline that is only a
 * date or a role (`requestOperatingSubject`).
 */
export function requestTitle(input: { headline: string; label: string; rawText?: string }): string {
  const label = trimTitleMarks(input.label);
  const headline = input.rawText !== undefined ? requestOperatingSubject(input.rawText, input.headline) ?? input.headline : input.headline;
  const line = trimTitleMarks(spokenTitle(trimTitleMarks(headline)));
  if (!line) return `${label}: no copy sent`;
  const name = `${trimTitleMarks(cutText(line, 45))}…`;
  return label && !startsWithName(line, label) ? `${label}: ${name}` : name;
}
