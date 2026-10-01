/**
 * Fake model providers for the chaos suite, and the paid-call ledger.
 *
 * No call here reaches a real provider, and no answer was recorded from one: the programme's rules
 * for this suite forbid paid calls, so the design's "record once against the real APIs" step is not
 * used. Answers come from fixtures instead (fixtures/models/*.json), matched by the JSON schema the
 * caller names (`response_format.json_schema.name`) and, optionally, by text in the request. The
 * Canva planner's layout is built from the request it receives (every copy block placed once, the
 * logo at the requested aspect), which is what a correct model answer must satisfy.
 *
 * Every call is written to the ledger with a fingerprint of (model, system prompt, first user
 * message): the driver checks that no fingerprint was paid for twice. A call no fixture answers is
 * refused with HTTP 500 and recorded as `unmatched`, so a pipeline stage the fixtures do not cover
 * shows up in the report instead of passing silently.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJson, readBody, sendJson, sha256 } from './http-util.ts';

export interface ModelFixture {
  /** The caller's `response_format.json_schema.name`. */
  schema: string;
  /** Answer only when the first user message contains this text. */
  whenText?: string;
  /** The JSON object returned as the assistant message's content. */
  answer: Record<string, unknown>;
}

export interface LedgerEntry {
  seq: number;
  provider: 'openai' | 'gemini' | 'anthropic';
  route: string;
  model: string;
  fingerprint: string;
  status: number;
  /** Hashes of attached data-url image bytes, never the image contents. */
  imageSha256?: string[];
  at: string;
}

export function loadModelFixtures(dir: string): ModelFixture[] {
  const out: ModelFixture[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    out.push(...(Array.isArray(parsed.fixtures) ? parsed.fixtures : []));
  }
  return out;
}

type Content = string | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
const textOf = (content: Content | undefined): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n') : '';

/**
 * A layout the Canva planner accepts (apps/core/src/services/canva-design-planner.ts: `layout`, the
 * logo aspect check, the palette and font policies): each copy block once, stacked under the logo.
 */
export function plannerLayout(request: any): Record<string, unknown> {
  const width = Number(request.width) || 1080;
  const height = Number(request.height) || 1350;
  const copy: string[] = Array.isArray(request.copy) ? request.copy : [];
  const scripts: string[] = Array.isArray(request.copyScripts) ? request.copyScripts : [];
  const palette: string[] = (request.reference?.rules?.palette as string[]) || [];
  const pick = (hex: string) => (palette.length === 0 || palette.map((c) => c.toLowerCase()).includes(hex.toLowerCase()) ? hex : palette[0]);
  const logoWidth = 120;
  const logoHeight = Math.round((logoWidth / (Number(request.logoAspect) || 1)) * 1000) / 1000;
  const top = 70 + logoHeight + 40;
  const slot = Math.max(60, Math.floor((height - top - 70) / Math.max(1, copy.length)));
  const fonts = request.formalBodyFonts || { latin: 'Verdana', arabic: 'Noto Sans Arabic' };
  return {
    width,
    height,
    background: pick('#0A1628'),
    text: copy.map((_, i) => ({
      copyIndex: i,
      role: i === 0 ? 'headline' : 'body',
      x: 80,
      y: top + i * slot,
      width: width - 160,
      height: slot - 20,
      fontSize: i === 0 ? Math.min(48, Math.floor((slot - 20) / 2)) : Math.min(26, Math.floor((slot - 20) / 3)),
      fontFamily: scripts[i] === 'arabic' ? fonts.arabic : fonts.latin,
      color: pick('#FDF8F3'),
      align: scripts[i] === 'arabic' ? 'right' : 'center',
      bold: i === 0,
    })),
    shapes: [],
    logo: { x: Math.round((width - logoWidth) / 2), y: 70, width: logoWidth, height: logoHeight },
  };
}

/** A slow answer for one schema: long enough to kill the caller while it waits for it. */
export interface ModelDelay {
  schema: string;
  delayMs: number;
  n: number;
}

/**
 * A refusal for one schema (ADR-142 scenario): the provider answers HTTP `status` before doing any
 * work, as it does for a malformed or unaffordable request, so the design run ends without a draft.
 */
export interface ModelFault {
  schema: string;
  status: number;
  n: number;
}

export class FakeModels {
  readonly ledger: LedgerEntry[] = [];
  /** Requests as they arrive (the ledger records them when answered). */
  readonly arrivals: Array<{ schema: string | null; at: string }> = [];
  private delays: ModelDelay[] = [];
  private faults: ModelFault[] = [];
  private geminiFailures: Array<{ model: string; n: number }> = [];
  private seq = 0;
  private fixtures: ModelFixture[];

  // No parameter properties: Node runs these files by stripping types, which cannot rewrite them.
  constructor(fixtures: ModelFixture[]) {
    this.fixtures = fixtures;
  }

  reset(): void {
    this.ledger.length = 0;
    this.arrivals.length = 0;
    this.delays = [];
    this.faults = [];
    this.geminiFailures = [];
  }

  addFault(fault: ModelFault): void {
    this.faults.push({ schema: String(fault.schema), status: Number(fault.status) || 400, n: Number(fault.n) || 1 });
  }

  /** Explicit uncertain HTTP response; never supplies a successful model answer. */
  addGeminiFailure(fault: { model: string; n?: number }): void {
    const n = fault.n ?? 1;
    if (typeof fault.model !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(fault.model) ||
        !Number.isInteger(n) || n < 1 || n > 10) throw new Error('Invalid Gemini failure fixture');
    this.geminiFailures.push({ model: fault.model, n });
  }

  addDelay(delay: ModelDelay): void {
    this.delays.push({ ...delay, n: delay.n ?? 1 });
  }

  clearDelays(): void {
    this.delays = [];
    this.faults = [];
    this.geminiFailures = [];
  }

  setFixtures(fixtures: ModelFixture[]): void {
    this.fixtures = fixtures;
  }

  /** How many times each fingerprint was paid for (answered with 200). */
  paidCounts(): Record<string, { route: string; n: number }> {
    const out: Record<string, { route: string; n: number }> = {};
    for (const e of this.ledger.filter((l) => l.status === 200)) {
      out[e.fingerprint] = { route: e.route, n: (out[e.fingerprint]?.n || 0) + 1 };
    }
    return out;
  }

  private note(provider: LedgerEntry['provider'], route: string, model: string, fingerprint: string, status: number,
    imageSha256: string[] = []): void {
    this.ledger.push({ seq: ++this.seq, provider, route, model, fingerprint, status,
      ...(imageSha256.length ? { imageSha256 } : {}), at: new Date().toISOString() });
  }

  private chatAnswer(body: any): { route: string; content: string } | null {
    const messages: Array<{ role: string; content: Content }> = Array.isArray(body.messages) ? body.messages : [];
    const user = textOf(messages.find((m) => m.role === 'user')?.content);
    const schema = body.response_format?.json_schema?.name;
    if (schema === 'canva_design_plan') {
      // The planner sends the request as JSON: alone, or as the first text part of a vision message.
      const first = user.trim().startsWith('{') ? user.trim().split('\n')[0]
        : /^Design Brief:\s*\n([^\n]+)/.exec(user.trim())?.[1] || '';
      let request: any = null;
      try { request = JSON.parse(first || user); } catch { request = null; }
      return request ? { route: 'canva_design_plan', content: JSON.stringify(plannerLayout(request)) } : null;
    }
    if (typeof schema === 'string') {
      const fixture = this.fixtures.find((f) => f.schema === schema && (!f.whenText || user.includes(f.whenText)));
      return fixture ? { route: schema, content: JSON.stringify(fixture.answer) } : null;
    }
    // Core's billing probe: one token, no schema.
    if (Number(body.max_tokens ?? body.max_completion_tokens) <= 16) return { route: 'billing-probe', content: 'ok' };
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, host: string, path: string): Promise<void> {
    const body = parseJson(await readBody(req));
    const geminiModel = host === 'generativelanguage.googleapis.com'
      ? /^\/v1beta\/models\/([A-Za-z0-9_.-]{1,100}):generateContent$/.exec(path)?.[1] : undefined;
    const model = host === 'generativelanguage.googleapis.com' ? geminiModel || '' : String(body.model || '');
    const messages: Array<{ role: string; content: Content }> = Array.isArray(body.messages) ? body.messages : [];
    const system = textOf(messages.find((m) => m.role === 'system')?.content ?? body.system ?? body.systemInstruction?.parts?.[0]?.text);
    const firstUser = textOf(messages.find((m) => m.role === 'user')?.content);
    const fingerprint = sha256(`${model}\n${system}\n${firstUser || JSON.stringify(body.contents ?? body.input ?? '')}`);
    const imageSha256 = messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.flatMap((part) => {
          const data = part.type === 'image_url' && typeof part.image_url?.url === 'string'
            ? /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(part.image_url.url)?.[1] : null;
          return data ? [sha256(Buffer.from(data, 'base64'))] : [];
        }) : []);

    const schema: string | null = body.response_format?.json_schema?.name ?? null;
    this.arrivals.push({ schema, at: new Date().toISOString() });
    const geminiFailure = req.method === 'POST' && geminiModel
      ? this.geminiFailures.find(fault => fault.n > 0 && fault.model === geminiModel) : undefined;
    if (geminiFailure) {
      geminiFailure.n--;
      this.note('gemini', 'fault:generateContent', model, fingerprint, 503, imageSha256);
      return sendJson(res, 503, { error: { message: 'chaos fault: provider acceptance unknown', type: 'server_error' } });
    }
    const delay = this.delays.find((d) => d.n > 0 && d.schema === schema);
    if (delay) {
      delay.n--;
      await new Promise((r) => setTimeout(r, delay.delayMs));
    }
    const fault = this.faults.find((f) => f.n > 0 && f.schema === schema);
    if (fault && host === 'api.openai.com' && path === '/v1/chat/completions') {
      fault.n--;
      this.note('openai', `fault:${schema}`, model, fingerprint, fault.status, imageSha256);
      return sendJson(res, fault.status, { error: { message: 'chaos fault: refused before any work', type: 'invalid_request_error' } });
    }
    if (host === 'api.openai.com' && path === '/v1/chat/completions') {
      const answer = this.chatAnswer(body);
      if (!answer) {
        this.note('openai', 'unmatched', model, fingerprint, 500, imageSha256);
        return sendJson(res, 500, { error: { message: 'chaos fakes: no fixture answers this request', type: 'server_error' } });
      }
      this.note('openai', answer.route, model, fingerprint, 200, imageSha256);
      const promptTokens = Math.ceil((system.length + firstUser.length) / 4);
      return sendJson(res, 200, {
        id: `chatcmpl-chaos-${this.seq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(answer.content.length / 4), total_tokens: promptTokens + Math.ceil(answer.content.length / 4) },
      });
    }
    // Other endpoints (OpenAI images and responses, Gemini, Anthropic) serve the studio, which these
    // fixtures do not cover: refused, and visible in the ledger.
    const provider: LedgerEntry['provider'] = host.includes('anthropic') ? 'anthropic' : host.includes('googleapis') ? 'gemini' : 'openai';
    this.note(provider, `unmatched:${path}`, model, fingerprint, 500, imageSha256);
    sendJson(res, 500, { error: { message: `chaos fakes: ${host}${path} has no fixtures`, type: 'server_error' } });
  }
}
