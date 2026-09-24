import { createHash } from 'node:crypto';
import { sql, withRlsContext, ClientRulesRepository, type Database, type Kysely } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';
import { readBrandGuidelines, fontCaveat, type GuidelinesModel } from './brand-guidelines.js';
import { isPdf } from './telegram-media.js';
import { formatRuleSaved, formatRulesList, ruleNumber, type RulesCommand } from './standing-rules-chat.js';
import { log } from '../logging.js';

/**
 * The chat side of a client's standing rules: which client a message is about, saving a rule said
 * in chat, /rules and /forget, and reading a brand guidelines PDF into rules.
 */
export interface RulesIntakeDeps {
  db: Kysely<Database>;
  tenantId: string;
  userId: string;
  /**
   * The sender is one of the office's own people (TELEGRAM_ALLOWED_USERS): a client they name is
   * taken as named. Anyone else names only a client their chat has asked for designs for.
   */
  trustNamedClient?: boolean;
  bridge: {
    dispatchOutboundMessage(chatId: string | number, message: { text: string; parse_mode?: string }): Promise<unknown>;
    downloadFile(fileId: string): Promise<Buffer | undefined | null>;
  };
}

export interface RuleClient {
  id: string;
  name: string;
  /** Its code, registered name and aliases, which a guidelines document's brand name is checked against. */
  names?: string[];
  /** The message named it, rather than it being the chat's latest client. */
  named?: boolean;
}

const scope = (deps: RulesIntakeDeps) => ({ tenantId: deps.tenantId, userId: deps.userId, role: 'operator' as const });

/** "KAAE" rather than the registered long name, when the client has a short code. */
const displayName = (c: { code?: string; name?: string }) =>
  c.code && /^[a-z0-9]{2,8}$/i.test(c.code) ? c.code.toUpperCase() : String(c.name || c.code);

const word = (text: string, w: string) =>
  w.trim().length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * The client a rule is for: the one the message names (by code, name or alias), else the client of
 * this chat's most recent request in the last 30 days. Undefined when neither says, when the
 * message names two clients, or when it names one this chat may not use.
 */
export async function resolveRuleClient(deps: RulesIntakeDeps, sourceChannelId: string, text: string): Promise<RuleClient | undefined> {
  return withRlsContext(deps.db, scope(deps), async (trx) => {
    const clients = (await sql<{ id: string; code: string; name: string; aliases: string[] | null }>`SELECT id, code, name, aliases FROM hawa.clients WHERE tenant_id = ${deps.tenantId}::uuid`.execute(trx)).rows;
    const namesOf = (c: (typeof clients)[number]) =>
      [c.code, c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])].filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
    const asRuleClient = (c: (typeof clients)[number], named: boolean): RuleClient => ({ id: String(c.id), name: displayName(c), names: namesOf(c), named });
    const namedClients = clients.filter((c) => namesOf(c).some((w) => word(text, w)));
    // "Same as KAAE, for Drustee" is a rule for neither until the sender says which.
    if (namedClients.length > 1) return undefined;
    const named = namedClients[0];
    if (named) {
      // Naming a client in a message would otherwise let any chat read, add or remove that client's
      // rules; outside the office, the chat must have asked for that client's designs itself.
      const chatKnows =
        deps.trustNamedClient ||
        Boolean(
          (
            await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
              WHERE o.tenant_id = ${deps.tenantId}::uuid AND o.command_type = 'task.created'
                AND o.payload->>'sourceChannelId' = ${sourceChannelId} AND t.client_id = ${named.id}::uuid
                AND o.created_at > now() - interval '90 days'`.execute(trx)
          ).rows[0]?.n
        );
      // A client named but not this chat's is asked about, never swapped for the chat's latest
      // client: a KAAE rule from another client's chat was saved as that client's (2026-09-23).
      return chatKnows ? asRuleClient(named, true) : undefined;
    }
    const recent = (
      await sql<{ client_id: string }>`SELECT t.client_id FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${deps.tenantId}::uuid AND o.command_type = 'task.created'
          AND o.payload->>'sourceChannelId' = ${sourceChannelId}
          AND t.client_id IS NOT NULL AND o.created_at > now() - interval '30 days'
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)
    ).rows[0];
    let client = recent ? clients.find((c) => String(c.id) === String(recent.client_id)) : undefined;
    if (!client) {
      // The client this chat last gave a rule for, then the office's only client if it has one.
      const ruled = (
        await sql<{ client_id: string }>`SELECT r.client_id FROM hawa.rule_evidence e JOIN hawa.client_rules r ON r.id = e.rule_id
          WHERE r.tenant_id = ${deps.tenantId}::uuid AND e.source_kind = 'telegram_message'
            AND e.source_id LIKE ${`${sourceChannelId}:%`}
          ORDER BY e.created_at DESC LIMIT 1`.execute(trx)
      ).rows[0];
      client = ruled ? clients.find((c) => String(c.id) === String(ruled.client_id)) : clients.length === 1 ? clients[0] : undefined;
    }
    return client ? asRuleClient(client, false) : undefined;
  });
}

/** A client by id, with the name the office sees; undefined when the tenant has no such client. */
export async function ruleClientById(deps: RulesIntakeDeps, clientId: string): Promise<RuleClient | undefined> {
  return withRlsContext(deps.db, scope(deps), async (trx) => {
    const row = (await sql<{ id: string; code: string; name: string }>`SELECT id, code, name FROM hawa.clients
      WHERE tenant_id = ${deps.tenantId}::uuid AND id = ${clientId}::uuid`.execute(trx)).rows[0];
    return row ? { id: String(row.id), name: displayName(row) } : undefined;
  }).catch(() => undefined);
}

/** Lower case, letters and digits only: "K.A.A.E." and "kaae" are one name. */
const squash = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** "Kurdistan Accrediting Association for Education" as "kaae". */
const initials = (s: string) =>
  s.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^(for|of|and|the|in)$/i.test(w)).map((w) => w[0]).join('').toLowerCase();

/**
 * Whether the brand a guidelines document is for is this client: one name contains the other, or
 * one is the other's initials. Case, spaces and punctuation do not count.
 */
export function brandMatchesClient(brandName: string, clientNames: string[]): boolean {
  const brand = squash(brandName);
  if (!brand) return true;
  return clientNames.some((n) => {
    const name = squash(n);
    if (!name) return false;
    return (
      (name.length >= 3 && brand.includes(name)) ||
      (brand.length >= 3 && name.includes(brand)) ||
      (name.length >= 2 && initials(brandName) === name) ||
      (brand.length >= 2 && initials(n) === brand)
    );
  });
}

const noClient = (what: string) => ({
  text: `❓ <b>Which client is this ${what} for?</b>\n\n<i>Send it again with the client's name in it (for example KAAE).</i>`,
  parse_mode: 'HTML',
});

/** Saves a rule said in chat, and tells the sender it is in force. */
export async function saveChatRule(
  deps: RulesIntakeDeps,
  params: { sourceChannelId: string; sourceEventId: string; ruleText: string; originalText: string; client?: RuleClient }
): Promise<{ saved: boolean; created?: boolean; ruleId?: string; clientId?: string; ruleNumber?: number }> {
  const client = params.client || (await resolveRuleClient(deps, params.sourceChannelId, params.originalText));
  if (!client) {
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, noClient('rule'));
    return { saved: false };
  }
  const { rule, created, count, number } = await withRlsContext(deps.db, scope(deps), async (trx) => {
    const repo = new ClientRulesRepository(trx);
    const out = await repo.save({
      tenantId: deps.tenantId,
      clientId: client.id,
      humanRule: params.ruleText,
      source: { kind: 'telegram_message', id: `${params.sourceChannelId}:${params.sourceEventId}`, note: params.originalText.slice(0, 500) },
    });
    const active = await repo.listActive(deps.tenantId, client.id);
    return { ...out, count: active.length, number: ruleNumber(active, out.rule.id) };
  });
  await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
    text: formatRuleSaved(client.name, rule.humanRule, created, count, number),
    parse_mode: 'HTML',
  });
  return { saved: true, created, ruleId: rule.id, clientId: client.id, ruleNumber: number };
}

/** /rules and /forget. */
export async function handleRulesCommand(
  deps: RulesIntakeDeps,
  params: { sourceChannelId: string; command: RulesCommand; text: string }
): Promise<void> {
  if (params.command.kind === 'forget_usage') {
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
      text: 'ℹ️ Send /rules to see the numbered list, then /forget and the number, for example <code>/forget 2</code>.',
      parse_mode: 'HTML',
    });
    return;
  }
  const client = await resolveRuleClient(deps, params.sourceChannelId, params.text);
  if (!client) {
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, noClient('command'));
    return;
  }
  const command = params.command;
  const { rules, removed } = await withRlsContext(deps.db, scope(deps), async (trx) => {
    const repo = new ClientRulesRepository(trx);
    const before = await repo.listActive(deps.tenantId, client.id);
    const removed: string[] = [];
    if (command.kind === 'forget') {
      for (const n of command.numbers) {
        const target = before[n - 1];
        if (target && (await repo.deactivate(deps.tenantId, client.id, target.id))) removed.push(`${n}. ${target.humanRule}`);
      }
    }
    return { rules: await repo.listActive(deps.tenantId, client.id), removed };
  });
  if (command.kind === 'forget') {
    const missing = command.numbers.length - removed.length;
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
      text:
        (removed.length
          ? `🗑️ <b>No longer applied to ${escapeTelegramHtml(client.name)} designs:</b>\n${removed.map(escapeTelegramHtml).join('\n')}\n\n`
          : '') +
        (missing > 0 ? `<i>${missing} number${missing === 1 ? '' : 's'} did not match a rule.</i>\n\n` : '') +
        formatRulesList(client.name, rules),
      parse_mode: 'HTML',
    });
    return;
  }
  await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, { text: formatRulesList(client.name, rules), parse_mode: 'HTML' });
}

/**
 * A PDF sent to the bot. It is read as brand guidelines: the rules found are saved for the client
 * and listed back. Reading takes a minute or two, so the sender is answered at once and the result
 * follows; the returned promise settles when it has.
 */
export async function handleGuidelinesPdf(
  deps: RulesIntakeDeps & { model: GuidelinesModel },
  params: { sourceChannelId: string; fileId: string; fileUniqueId?: string; fileName: string; fileSize?: number; caption: string }
): Promise<{ accepted: boolean; done?: Promise<void> }> {
  const name = params.fileName || 'the PDF';
  if (params.fileSize && params.fileSize > 20 * 1024 * 1024) {
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
      text: `📘 <b>${escapeTelegramHtml(name)} is larger than 20 MB</b>, the most a bot can download from Telegram.\n\n<i>Send a smaller export of it (or the pages that set out colours, type and logo use).</i>`,
      parse_mode: 'HTML',
    });
    return { accepted: false };
  }
  const client = await resolveRuleClient(deps, params.sourceChannelId, `${params.caption} ${params.fileName}`);
  if (!client) {
    await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, noClient('document'));
    return { accepted: false };
  }
  await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
    text:
      `📘 <b>Reading ${escapeTelegramHtml(name)}</b> for ${escapeTelegramHtml(client.name)}.\n\n<i>If it is brand guidelines, the rules found are saved and listed here in a minute or two.</i>` +
      // A caption that reads like a request is not designed from: the PDF is read as guidelines.
      (params.caption.trim().length > 120 || params.caption.includes('\n')
        ? `\n\n<i>The text sent with the PDF was not used as a design request; if it is one, send it as its own message.</i>`
        : ''),
    parse_mode: 'HTML',
  });

  const done = (async () => {
    try {
      const bytes = await deps.bridge.downloadFile(params.fileId);
      if (!bytes || !bytes.length) throw new Error('The file could not be downloaded from Telegram.');
      if (!isPdf(bytes)) throw new Error('The file is not a PDF.');
      const reading = await readBrandGuidelines(deps.model, { pdf: { filename: name, bytes }, senderNote: params.caption });
      if (!reading.isBrandGuidelines) {
        await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
          text:
            `📄 <b>${escapeTelegramHtml(name)} does not read as brand guidelines</b>` +
            (reading.summary ? `: ${escapeTelegramHtml(reading.summary)}` : '.') +
            `\n\n<i>Nothing was saved. If it holds a design request, send its text as a message.</i>`,
          parse_mode: 'HTML',
        });
        return;
      }
      // Another brand's guidelines sent in this client's chat would become this client's rules.
      // A caption or file name that names the client is the sender saying which client they are for.
      if (reading.brandName && !client.named && !brandMatchesClient(reading.brandName, client.names?.length ? client.names : [client.name])) {
        await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
          text:
            `📘 <b>${escapeTelegramHtml(name)} reads as the brand guidelines of ${escapeTelegramHtml(reading.brandName)}, not ${escapeTelegramHtml(client.name)}</b>, so no rules were saved.\n\n` +
            `<i>Send it again with the client's name in the caption (for example ${escapeTelegramHtml(client.name)}), and its rules are saved for that client.</i>`,
          parse_mode: 'HTML',
        });
        return;
      }
      const sourceId = params.fileUniqueId || createHash('sha256').update(bytes).digest('hex').slice(0, 32);
      const saved = await withRlsContext(deps.db, scope(deps), async (trx) => {
        const repo = new ClientRulesRepository(trx);
        const out: Array<{ id: string; text: string; created: boolean; caveat?: string }> = [];
        for (const rule of reading.rules) {
          const { rule: row, created } = await repo.save({
            tenantId: deps.tenantId,
            clientId: client.id,
            humanRule: rule.rule,
            category: rule.category,
            machineRule: {
              ...(rule.fontFamily ? { fontFamily: rule.fontFamily, script: rule.script } : {}),
              ...(rule.colourHex ? { colourHex: rule.colourHex } : {}),
            },
            source: { kind: 'brand_guidelines', id: sourceId, note: name },
          });
          // Two lines of the document can read as one rule; it is listed once.
          if (!out.some((r) => r.id === row.id)) out.push({ id: row.id, text: row.humanRule, created, caveat: fontCaveat(rule) });
        }
        return { out, active: await repo.listActive(deps.tenantId, client.id) };
      });
      const fresh = saved.out.filter((r) => r.created).length;
      // Each rule under the number /rules shows and /forget takes. They were numbered 1..N in the
      // document's order, so "/forget 3" removed another rule than the one shown as 3 (2026-09-23).
      const numbered = saved.out
        .map((r) => ({ ...r, n: ruleNumber(saved.active, r.id) }))
        .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
      // Whole lines only, within Telegram's 4096 characters: a cut through a tag fails the message.
      const all = numbered.map((r) => `${r.n ? `${r.n}.` : '•'} ${escapeTelegramHtml(r.text)}${r.caveat ? `\n   <i>⚠️ ${escapeTelegramHtml(r.caveat)}</i>` : ''}`);
      const lines: string[] = [];
      for (const line of all) {
        if (lines.join('\n').length + line.length > 3000) {
          lines.push(`… and ${all.length - lines.length} more (/rules lists them all).`);
          break;
        }
        lines.push(line);
      }
      await deps.bridge.dispatchOutboundMessage(params.sourceChannelId, {
        text:
          `📘 <b>${escapeTelegramHtml(client.name)} brand guidelines read</b> (${escapeTelegramHtml(name)}): ` +
          `${fresh} new rule${fresh === 1 ? '' : 's'} saved${saved.out.length > fresh ? `, ${saved.out.length - fresh} already in force` : ''}.\n\n` +
          lines.join('\n') +
          `\n\n<i>Every new ${escapeTelegramHtml(client.name)} design follows these (${saved.active.length} rules in force). /rules lists them; /forget and a number removes one.</i>`,
        parse_mode: 'HTML',
      });
    } catch (err) {
      log.error(`[telegram] brand guidelines ${name} could not be read:`, (err as Error)?.message || err);
      await deps.bridge
        .dispatchOutboundMessage(params.sourceChannelId, {
          text: `⚠️ <b>${escapeTelegramHtml(name)} could not be read</b>, so no rules were saved from it.\n\n<i>Please send it again; if it fails twice, the office will add the rules by hand.</i>`,
          parse_mode: 'HTML',
        })
        .catch(() => undefined);
    }
  })();
  return { accepted: true, done };
}
