import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import { redactSecrets } from './redactor.js';

/**
 * Structured logs for Core and the worker (architecture programme 1.4).
 *
 * Every line is one JSON object on stdout. Docker keeps it, Vector copies it into daily files under
 * ~/.hawa/logs/, and scripts/request_logs.ts prints every line of one request from those files, so a
 * request can be followed across Core, the worker and nginx even after a deploy replaced the
 * containers that wrote them.
 *
 * What ties the lines together is one AsyncLocalStorage store per unit of work (an HTTP request, a
 * Telegram update, a Restate invocation, an outbox command). Every line written inside it carries the
 * store's fields, without any function in between passing them along.
 */

/** The fields every log line of one unit of work carries. */
export interface LogContext {
  requestId?: string;
  taskId?: string;
  chatId?: string;
  tenantId?: string;
}

const CONTEXT_KEYS = ['requestId', 'taskId', 'chatId', 'tenantId'] as const;

/** The header the correlation id travels in, between nginx, Core, the worker and Restate. */
export const REQUEST_ID_HEADER = 'x-request-id';

const storage = new AsyncLocalStorage<LogContext>();

function definedFields(fields: LogContext): LogContext {
  const out: LogContext = {};
  for (const key of CONTEXT_KEYS) {
    const value = fields[key];
    if (value !== undefined && value !== null && String(value) !== '') out[key] = String(value);
  }
  return out;
}

/**
 * Runs `fn` with its own log context. Fields not given are inherited from the context it runs in, so
 * a Telegram update handled inside an HTTP request keeps the request's id.
 */
export function runWithLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...definedFields(fields) }, fn);
}

/**
 * Adds fields to the current context, for what is only known part-way through (the tenant after
 * authentication, the chat once the update is parsed). Every later line of the same unit of work, in
 * any function, carries them. Returns false when there is no context to add to.
 */
export function bindLogContext(fields: LogContext): boolean {
  const store = storage.getStore();
  if (!store) return false;
  Object.assign(store, definedFields(fields));
  return true;
}

/** A copy of the current context, or undefined outside one. */
export function getLogContext(): LogContext | undefined {
  const store = storage.getStore();
  return store ? { ...store } : undefined;
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The header to send on a call that continues the current request, or nothing outside one. */
export function requestIdHeaders(): Record<string, string> {
  const id = currentRequestId();
  return id ? { [REQUEST_ID_HEADER]: id } : {};
}

/**
 * A request id someone else sent is accepted only in a plain shape: it is written into every log line,
 * and a header carrying a newline or a megabyte would forge or flood them.
 */
export function acceptRequestId(value: string | null | undefined): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : undefined;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------------------------
// Redaction

const REDACTED = '[REDACTED]';

/**
 * Keys whose values are never written. The match is on the end of the name (botToken, access_token,
 * x-telegram-bot-api-secret-token, clientSecret) so counts such as inputTokens or tokenCount survive.
 */
const SECRET_KEY = /(token|secret|password|passwd|authorization|apikey|cookie|credentials?)$/i;
const SECRET_KEY_PREFIX = /^(password|secret)/i;

export function isSecretKey(key: string): boolean {
  const flat = key.replace(/[^A-Za-z0-9]/g, '');
  return SECRET_KEY.test(flat) || SECRET_KEY_PREFIX.test(flat);
}

const SECRET_QUERY = /([?&;](?:access_token|[A-Za-z0-9_-]*(?:token|secret|password|passwd|api_?key)|key|sig|signature)=)[^&\s#"'<>]*/gi;
const TELEGRAM_BOT_PATH = /(\/bot)\d+:[A-Za-z0-9_-]+/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/** Long strings (a base64 picture in an error) are cut: a log line is for reading. */
const MAX_STRING = 4000;

export function redactLogString(input: string): string {
  let out = input
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(TELEGRAM_BOT_PATH, `$1${REDACTED}`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`);
  out = redactSecrets(out);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[${out.length - MAX_STRING} more chars]` : out;
}

function serializeError(err: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { type: err.name, message: redactLogString(String(err.message ?? '')) };
  if (err.stack) out.stack = redactLogString(err.stack);
  for (const [key, value] of Object.entries(err)) {
    if (key === 'message' || key === 'stack') continue;
    out[key] = isSecretKey(key) ? REDACTED : redactLogValue(value, depth + 1);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 4) out.cause = redactLogValue(cause, depth + 1);
  return out;
}

/**
 * A copy of `value` safe to write: secret-named keys replaced, secrets in strings (query strings,
 * bot URLs, bearer headers, API keys) masked, errors turned into plain objects, and depth and size
 * bounded. The original is never changed.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : typeof value === 'function' ? undefined : value;
  }
  if (depth > 6) return '[depth limit]';
  if (value instanceof Error) return serializeError(value, depth);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactLogString(value.toString());
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[${(value as { byteLength: number }).byteLength} bytes]`;
  }
  if (value instanceof Map) return redactLogValue(Object.fromEntries(value), depth);
  if (value instanceof Set) return redactLogValue([...value], depth);
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => redactLogValue(v, depth + 1));
    if (value.length > 50) items.push(`[${value.length - 50} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactLogValue(v, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The logger

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** LOG_LEVEL, else info. The test runs set warn (vitest.config.ts): their access lines would drown the failures. */
function defaultLevel(): string {
  return process.env.LOG_LEVEL?.trim() || 'info';
}

let destination: pino.DestinationStream = pino.destination({ dest: 1, sync: true });
let level = defaultLevel();
let generation = 0;
let root: pino.Logger | null = null;

function rootLogger(): pino.Logger {
  if (root) return root;
  root = pino(
    {
      level,
      base: undefined,
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      // Errors are already plain, redacted objects (formatters.log); pino's own error serializer
      // would rebuild them and name every one "Object".
      serializers: { err: (value: unknown) => value },
      formatters: {
        level: (label) => ({ level: label }),
        // The serializer for every line: whatever a caller passes, secrets never reach the output.
        log: (object) => redactLogValue(object) as Record<string, unknown>,
      },
      // The context's fields are on every line; a field the call names itself wins.
      mixin: () => ({ ...storage.getStore() }),
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? redactLogString(a) : a)) as typeof args;
          return method.apply(this, cleaned);
        },
      },
    },
    destination
  );
  return root;
}

export interface HawaLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  /** The same as info, so that console.log can be replaced word for word. */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): HawaLogger;
}

/**
 * Takes arguments the way console does, so replacing console.* changes nothing at the call site:
 * strings and numbers form the message, the first Error becomes `err`, and other objects `detail`.
 * A first argument that is a plain object is taken as the line's fields, the way pino takes it.
 */
function toLine(args: unknown[]): { fields: Record<string, unknown>; msg: string } {
  const fields: Record<string, unknown> = {};
  const words: string[] = [];
  const details: unknown[] = [];
  let rest = args;
  const first = args[0];
  if (first && typeof first === 'object' && !(first instanceof Error) && !Array.isArray(first) && args.length > 1 && typeof args[1] === 'string') {
    Object.assign(fields, first);
    rest = args.slice(1);
  }
  for (const arg of rest) {
    if (typeof arg === 'string') words.push(arg);
    else if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') words.push(String(arg));
    else if (arg === undefined) words.push('undefined');
    else if (arg instanceof Error && fields.err === undefined) fields.err = arg;
    else details.push(arg);
  }
  if (details.length === 1) fields.detail = details[0];
  else if (details.length > 1) fields.detail = details;
  return { fields, msg: words.join(' ') };
}

function makeLogger(bindings: Record<string, unknown>): HawaLogger {
  let cached: pino.Logger | null = null;
  let cachedGeneration = -1;
  const target = () => {
    if (!cached || cachedGeneration !== generation) {
      cached = rootLogger().child(bindings);
      cachedGeneration = generation;
    }
    return cached;
  };
  const at = (lvl: Level) => (...args: unknown[]) => {
    const logger = target();
    if (!logger.isLevelEnabled(lvl)) return;
    const { fields, msg } = toLine(args);
    logger[lvl](fields, msg);
  };
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    log: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => makeLogger({ ...bindings, ...more }),
  };
}

/** A logger whose every line names the service that wrote it ("core", "worker"). */
export function createLogger(service: string): HawaLogger {
  return makeLogger({ service });
}

function resetRoot(): void {
  root = null;
  generation++;
}

/** One captured line, parsed. */
export type LogLine = Record<string, unknown> & { level: string; msg: string; service?: string } & LogContext;

/**
 * For tests: sends every line to memory instead of stdout, at every level, until `restore`.
 * Lines are parsed JSON exactly as they would have been written, so a test sees what redaction left.
 */
export function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const previous = { destination, level };
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const text of String(chunk).split('\n')) if (text.trim()) lines.push(JSON.parse(text));
      done();
    },
  });
  destination = sink;
  level = 'trace';
  resetRoot();
  return {
    lines,
    restore: () => {
      destination = previous.destination;
      level = previous.level;
      resetRoot();
    },
  };
}
