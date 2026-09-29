import type { ClientRule } from '@hawa/db';
import { CONVERSATION_MESSAGES, say, type RequesterLang } from '@hawa/integrations';

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

/**
 * Arabic-Indic (٠–٩) and Extended Arabic-Indic (۰–۹) digits as ASCII. A Kurdish keyboard types
 * "/forget ١", which Number() reads as NaN, so the office got the usage reply (2026-09-23).
 */
const asciiDigits = (s: string) =>
  s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - (d >= '\u06F0' ? 0x06f0 : 0x0660)));

/** "/rules", "/forget 2", "/forget 2 5". Telegram appends "@botname" to commands in groups. */
export function parseRulesCommand(text: string): RulesCommand | null {
  const m = (text || '').trim().match(/^\/(rules|forget)(?:@\w+)?(?:\s+(.*))?$/is);
  if (!m) return null;
  if (m[1].toLowerCase() === 'rules') return { kind: 'list' };
  const numbers = [...new Set(asciiDigits(m[2] || '').split(/[\s,،]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  return numbers.length ? { kind: 'forget', numbers } : { kind: 'forget_usage' };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The numbered list of a client's lasting preferences. The numbers are what /forget takes; the list
 * names no command (ADR-145): whoever reads it is told to say what should change.
 */
export function formatRulesList(clientName: string, rules: ClientRule[], lang: RequesterLang = 'en'): string {
  const client = esc(clientName);
  if (!rules.length) return `📌 ${say(CONVERSATION_MESSAGES.preferencesNone, lang, { client })}`;
  // Whole lines within Telegram's 4096 characters: two guidelines PDFs can hold 50 rules, and a
  // message over the limit is refused and the sender gets nothing.
  const all = rules.map((r, i) => `${i + 1}. ${esc(r.humanRule)}`);
  const lines: string[] = [];
  for (const line of all) {
    if (lines.join('\n').length + line.length > 3200) {
      lines.push(say(CONVERSATION_MESSAGES.preferencesMore, lang, { count: all.length - lines.length }));
      break;
    }
    lines.push(line);
  }
  return (
    `📌 <b>${say(CONVERSATION_MESSAGES.preferencesHeader, lang, { client, count: rules.length })}</b>\n\n${lines.join('\n')}\n\n` +
    `<i>${say(CONVERSATION_MESSAGES.preferencesFooter, lang)}</i>`
  );
}

/** The number /rules shows for a rule and /forget takes, or undefined when it is not active. */
export function ruleNumber(activeRules: Array<Pick<ClientRule, 'id'>>, ruleId: string): number | undefined {
  const i = activeRules.findIndex((r) => r.id === ruleId);
  return i < 0 ? undefined : i + 1;
}

/**
 * The reply to a rule said in chat (ADR-145, #74): what every later design of the client will follow,
 * in the sender's language, with no command to learn. `count` and `number` are the office's (how many
 * rules are in force, and this one's place in the list /forget takes); the requester is not shown them.
 */
export function formatRuleSaved(clientName: string, rule: string, created: boolean, _count: number, _number?: number,
  lang: RequesterLang = 'en'): string {
  const text = say(created ? CONVERSATION_MESSAGES.preferenceSaved : CONVERSATION_MESSAGES.preferenceAlreadySaved, lang,
    { client: esc(clientName), rule: esc(rule) });
  return `📌 ${text}`;
}
