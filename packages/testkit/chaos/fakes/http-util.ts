import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function parseJson(body: Buffer): any {
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return {};
  }
}

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Drops the connection without an answer: the request may have been acted on, the caller cannot tell. */
export function dropConnection(res: ServerResponse): void {
  res.socket?.destroy();
}
