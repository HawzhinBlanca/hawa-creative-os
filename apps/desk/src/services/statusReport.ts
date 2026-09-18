/**
 * Status the Desk reads from Core, and what it shows when it cannot read it.
 *
 * A failed read leaves a status unknown. It is never replaced with a plausible value: a screen
 * that shows "configured" or "healthy" after a network error tells the operator the opposite of
 * what happened.
 */

export type Reading<T> =
  | { state: 'loading' }
  | { state: 'known'; value: T }
  | { state: 'unknown'; reason: string };

export function reasonOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'the server did not answer';
}

export async function read<T>(load: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { state: 'known', value: await load() };
  } catch (err) {
    return { state: 'unknown', reason: reasonOf(err) };
  }
}

/** Fetches JSON; any answer other than 2xx throws with the server's own explanation. */
export async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body: any = await res.json().catch(() => null);
    const said = body?.detail || body?.title || body?.description || body?.error;
    throw new Error(said ? `HTTP ${res.status}: ${said}` : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface StatusView {
  tone: 'ok' | 'warn' | 'unknown';
  label: string;
  detail: string;
}

export interface TelegramAdapterStatus {
  botConfigured?: boolean;
  botUsername?: string;
  bridge?: {
    mode?: string;
    webhookActive?: boolean;
    webhookUrl?: string;
    degraded?: boolean;
    lastError?: string | null;
  };
}

const BRIDGE_MODES: Record<string, string> = {
  webhook_push: 'webhook delivery',
  live_polling: 'polling',
  offline_daemon: 'offline',
  poll: 'bridge not running',
};

export function describeTelegramBridge(reading: Reading<TelegramAdapterStatus>): StatusView {
  if (reading.state === 'loading') return { tone: 'unknown', label: 'checking…', detail: 'Reading adapter status' };
  if (reading.state === 'unknown') {
    return { tone: 'unknown', label: 'status unknown', detail: `Could not read the Telegram adapter: ${reading.reason}` };
  }
  const status = reading.value;
  const bot = status.botUsername ? `@${status.botUsername}` : 'bot name not reported';
  const mode = BRIDGE_MODES[status.bridge?.mode ?? ''] ?? 'mode not reported';
  if (!status.botConfigured) return { tone: 'warn', label: 'token missing', detail: `${bot} · ${mode}` };
  if (status.bridge?.degraded) {
    const lastError = status.bridge.lastError ? ` · last error: ${status.bridge.lastError}` : '';
    return { tone: 'warn', label: 'degraded', detail: `${bot} · ${mode}${lastError}` };
  }
  return { tone: 'ok', label: 'token configured', detail: `${bot} · ${mode}` };
}

export function describeWebhookMode(reading: Reading<TelegramAdapterStatus>): StatusView {
  if (reading.state === 'loading') return { tone: 'unknown', label: 'checking…', detail: 'Reading adapter status' };
  if (reading.state === 'unknown') {
    return { tone: 'unknown', label: 'unknown', detail: `Delivery mode unknown: ${reading.reason}` };
  }
  const bridge = reading.value.bridge;
  if (bridge?.webhookActive) {
    return { tone: 'ok', label: 'Webhook registered', detail: `Push delivery to ${bridge.webhookUrl || 'an unreported URL'}` };
  }
  return { tone: 'warn', label: 'Polling', detail: 'No webhook registered by this server; updates arrive by polling' };
}

/** Shape of GET /v1/adapters/telegram/webhook/info: Telegram's own getWebhookInfo answer, relayed. */
export interface WebhookInfoResponse {
  info?: {
    ok?: boolean;
    description?: string;
    result?: {
      url?: string;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
    };
  };
}

export interface CheckResult {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/**
 * Reports what Telegram says about delivery to our webhook. Telegram keeps its last delivery error
 * after later deliveries succeed, so an error is reported with its time rather than as a verdict.
 */
export function describeWebhookDelivery(reading: Reading<WebhookInfoResponse>): CheckResult {
  if (reading.state === 'loading') return { tone: 'error', text: 'Delivery status unknown: the check has not finished.' };
  if (reading.state === 'unknown') return { tone: 'error', text: `Delivery status unknown: ${reading.reason}` };
  const info = reading.value?.info;
  if (!info || info.ok !== true || !info.result) {
    return { tone: 'error', text: `Delivery status unknown: Telegram did not answer the check (${info?.description || 'no result returned'}).` };
  }
  const { url, pending_update_count: pending, last_error_date: errorAt, last_error_message: errorMessage } = info.result;
  const waiting = typeof pending === 'number' ? `${pending} update(s) waiting` : 'waiting updates not reported';
  if (!url) {
    return { tone: 'warn', text: `No webhook is registered with Telegram; updates arrive only by polling. ${waiting}.` };
  }
  if (errorAt) {
    const at = new Date(errorAt * 1000).toISOString();
    return { tone: 'error', text: `Telegram reports its most recent delivery error to ${url} at ${at}: ${errorMessage || 'no message given'}. ${waiting}.` };
  }
  return { tone: 'ok', text: `Telegram reports a webhook at ${url} with no delivery errors. ${waiting}.` };
}

export type ProviderStatusMap = Record<string, { configured?: boolean } | undefined>;

export function describeProvider(reading: Reading<ProviderStatusMap>, key: string): { configured: boolean; text: string } {
  if (reading.state === 'loading') return { configured: false, text: 'checking…' };
  if (reading.state === 'unknown') return { configured: false, text: 'status unknown' };
  const entry = reading.value[key];
  if (!entry) return { configured: false, text: 'not reported' };
  return entry.configured ? { configured: true, text: '✓ Configured' } : { configured: false, text: 'Not configured' };
}
