import crypto from 'node:crypto';

/**
 * Stream tickets (architecture programme 1.5, ADR-037, 2026-09-24).
 *
 * A browser's EventSource cannot send an Authorization header, so the Desk put its 24-hour session
 * token in the stream's address (`?access_token=`), where every proxy, access log and browser history
 * could keep it. Now the Desk asks for a ticket with its bearer header and opens the stream with
 * `?ticket=`. A ticket:
 *
 * - opens one stream, once: it is removed when redeemed, so a copied address is worthless;
 * - expires 60 s after it was issued, used or not;
 * - is accepted by the stream route only; every other route ignores it;
 * - stands for the credential it was issued with, and nothing more: the stream checks that credential
 *   again on every heartbeat, so a session revoked or expired later still closes the stream.
 *
 * Tickets live in this process only. A ticket outlives nothing worth keeping: after a Core restart
 * the Desk's reconnect asks for a new one.
 */

export const STREAM_TICKET_TTL_MS = 60_000;
/** More outstanding tickets than this means something is asking for them in a loop; the oldest go. */
const MAX_OUTSTANDING = 10_000;
/**
 * One session never needs more than a few (a tab asks for one per reconnect). A session asking in a
 * loop loses its own oldest tickets, so it cannot push another session's just-issued ticket out.
 */
export const MAX_TICKETS_PER_CREDENTIAL = 16;

export interface IssuedStreamTicket {
  ticket: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface StreamTicketStore {
  /** A new ticket that stands for `credential` (the bearer token it was requested with). */
  issue(credential: string): IssuedStreamTicket;
  /** The credential a live ticket stands for, once; undefined for an unknown, used or expired ticket. */
  redeem(ticket: string | undefined | null): string | undefined;
  /** Tickets issued and neither used nor expired (for tests and health). */
  outstanding(): number;
}

/** Tickets are stored by their hash, so a heap dump holds no usable ticket either. */
const hashOf = (ticket: string) => crypto.createHash('sha256').update(ticket).digest('hex');

export function createStreamTicketStore(opts: { ttlMs?: number; now?: () => number } = {}): StreamTicketStore {
  const ttlMs = opts.ttlMs ?? STREAM_TICKET_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const tickets = new Map<string, { credential: string; expiresAt: number }>();
  /** Each credential's outstanding ticket keys, oldest first (keys already gone are skipped). */
  const byCredential = new Map<string, string[]>();

  const prune = () => {
    const t = now();
    for (const [key, entry] of tickets) if (entry.expiresAt <= t) tickets.delete(key);
    for (const [credential, keys] of byCredential) if (!keys.some((key) => tickets.has(key))) byCredential.delete(credential);
    // Map iteration is insertion order: the first entries are the oldest.
    while (tickets.size >= MAX_OUTSTANDING) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
  };

  return {
    issue(credential) {
      if (!credential) throw new Error('a stream ticket needs the credential it stands for');
      prune();
      const own = (byCredential.get(credential) ?? []).filter((key) => tickets.has(key));
      while (own.length >= MAX_TICKETS_PER_CREDENTIAL) tickets.delete(own.shift()!);
      const ticket = `hawa_st_${crypto.randomBytes(24).toString('base64url')}`;
      const expiresAt = now() + ttlMs;
      const key = hashOf(ticket);
      tickets.set(key, { credential, expiresAt });
      own.push(key);
      byCredential.set(credential, own);
      return { ticket, expiresAt };
    },
    redeem(ticket) {
      if (!ticket || typeof ticket !== 'string' || !ticket.startsWith('hawa_st_')) return undefined;
      const key = hashOf(ticket);
      const entry = tickets.get(key);
      if (!entry) return undefined;
      tickets.delete(key);
      return entry.expiresAt > now() ? entry.credential : undefined;
    },
    outstanding() {
      prune();
      return tickets.size;
    },
  };
}
