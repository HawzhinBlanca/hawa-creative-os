import { sql, withRlsContext, ClientRulesRepository, type Database, type Kysely } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';
import { formatRuleSaved, formatRulesList, ruleNumber, type RulesCommand } from './standing-rules-chat.js';

/**
 * The chat side of a client's standing rules: which client a message is about, saving a rule said
 * in chat, /rules and /forget (lifecycle-chat-answers.ts). Reading a brand guidelines PDF into rules
 * went with the old intake (ADR-135 stage 2): a PDF is a lifecycle source now.
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
