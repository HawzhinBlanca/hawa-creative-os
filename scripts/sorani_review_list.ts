/**
 * Writes plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md: every Sorani line the bot can
 * say to a requester, from the requester message catalogue (ADR-145), for a native speaker to review
 * before release. packages/integrations/test/requester-messages.test.ts fails when a Sorani line is
 * missing from the list, so run this after changing the catalogue:
 *
 *   npx tsx scripts/sorani_review_list.ts
 */
import { writeFileSync } from 'node:fs';
import { REQUESTER_CATALOGUE, type Phrase } from '../packages/integrations/src/requester-messages/index.js';

const out = new URL('../plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md', import.meta.url);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, '⏎');

const lines: string[] = [
  '# Sorani lines awaiting native review (ADR-145)',
  '',
  'Every Sorani string the bot can send to a requester, generated from the requester message catalogue',
  '(`packages/integrations/src/requester-messages/`) by `npx tsx scripts/sorani_review_list.ts`. **None has had a',
  'native review.** They were written by the engineering agents (ADR-144 and ADR-145) and must be checked by a native',
  'Sorani speaker before release: meaning, register (polite, plain, not literal translation), spelling, and the',
  'quotation marks around the words a requester is asked to say («بەڵێ», «نوێ», «گۆڕانکاری»).',
  '',
  'How to review: mark each row OK or give the corrected line in the last column, then edit the catalogue and',
  're-run the script. `⏎` is a line break; `{title}`, `{text}`, `{list}` are filled in by the bot (a design name,',
  'quoted words, a numbered list) and must stay as they are.',
  '',
  'Also awaiting review: the Sorani words the bot *reads* (approval, cancel, status, deadline and change phrases in',
  '`apps/core/src/services/requester-turn.ts`, the yes-words in `apps/core/src/services/lifecycle-source-reply.ts`, and',
  'the "that is the whole text" words in `apps/core/src/services/lifecycle-album.ts`, ADR-148).',
  '',
];
let count = 0;
for (const [section, book] of Object.entries(REQUESTER_CATALOGUE)) {
  const entries = Object.entries(book as Record<string, Phrase>);
  if (!entries.length) continue;
  lines.push(`## ${section}`, '', '| Id | English | Sorani | Review |', '|---|---|---|---|');
  for (const [name, phrase] of entries) {
    lines.push(`| \`${section}.${name}\` | ${cell(phrase.en)} | ${cell(phrase.ckb)} | needs native review |`);
    count++;
  }
  lines.push('');
}
lines.push(`${count} lines.`, '');
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${count} Sorani lines to ${out.pathname}`);
