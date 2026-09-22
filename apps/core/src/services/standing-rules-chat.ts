import type { ClientRule } from '@hawa/db';

/**
 * How the office states, lists and removes a client's standing rules in chat.
 *
 * A standing rule is a time word ("from now on", "always", "every time", "for future designs",
 * لەمەودوا, هەمیشە) together with an instruction verb ("use", "keep", "put", بەکاربهێنە). Either
 * alone is not one: "the logo always looks cramped" is a complaint about this design.
 */
const STANDING_TIME_EN =
  /\b(from now on|going forward|always|every ?time|for (all )?future designs|in (all )?future designs|for all designs|in all designs|as a rule|future (client )?rule|permanent (client )?rule|future guideline|never)\b/i;
const STANDING_TIME_CKB = /لەمەودوا|لە\s*ئێستا\s*بەدواوە|لە داهاتوو|هەمیشە|لە هەموو دیزاینەکان|هەرگیز/;
// "never" is a time word, never also the verb: "the logo never looks right" is a complaint.
const STANDING_VERB_EN = /\b(use|put|keep|make|set|place|write|add|leave|apply|prefer|should|must|avoid)\b/i;
const STANDING_VERB_CKB = /بەکاربهێنە|بەکاربهێنن|بەکاربێنە|دابنێ|دابنێن|با |دەبێت|نابێت|مەکە|مەنووسە|بنووسە|بکە/;

export function isStandingRule(text: string): boolean {
  const t = text || '';
  return (STANDING_TIME_EN.test(t) || STANDING_TIME_CKB.test(t)) && (STANDING_VERB_EN.test(t) || STANDING_VERB_CKB.test(t));
}

export type RulesCommand = { kind: 'list' } | { kind: 'forget'; numbers: number[] } | { kind: 'forget_usage' };

/** "/rules", "/forget 2", "/forget 2 5". Telegram appends "@botname" to commands in groups. */
export function parseRulesCommand(text: string): RulesCommand | null {
  const m = (text || '').trim().match(/^\/(rules|forget)(?:@\w+)?(?:\s+(.*))?$/is);
  if (!m) return null;
  if (m[1].toLowerCase() === 'rules') return { kind: 'list' };
  const numbers = [...new Set((m[2] || '').split(/[\s,]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  return numbers.length ? { kind: 'forget', numbers } : { kind: 'forget_usage' };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The numbered list the office sees; the numbers are what /forget takes. */
export function formatRulesList(clientName: string, rules: ClientRule[]): string {
  if (!rules.length) {
    return (
      `📌 <b>No standing rules for ${esc(clientName)} yet.</b>\n\n` +
      `<i>Say one in a message ("From now on, put the logo bottom-right") or send the brand guidelines as a PDF, and every later ${esc(clientName)} design follows it.</i>`
    );
  }
  const lines = rules.map((r, i) => `${i + 1}. ${esc(r.humanRule)}`);
  return (
    `📌 <b>Standing rules for ${esc(clientName)}</b> (${rules.length})\n\n${lines.join('\n')}\n\n` +
    `<i>Every new ${esc(clientName)} design follows these; a later rule wins over an earlier one, and a request's own instructions win over both. Remove one with /forget and its number, for example /forget 2.</i>`
  );
}

export function formatRuleSaved(clientName: string, rule: string, created: boolean, count: number): string {
  return created
    ? `📌 <b>Saved as a standing rule for ${esc(clientName)}:</b>\n"${esc(rule)}"\n\n<i>Every new ${esc(clientName)} design follows it (${count} rule${count === 1 ? '' : 's'} in force). /rules lists them; /forget removes one.</i>`
    : `📌 <b>Already a standing rule for ${esc(clientName)}:</b>\n"${esc(rule)}"\n\n<i>/rules lists them; /forget removes one.</i>`;
}
