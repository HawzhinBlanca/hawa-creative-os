/**
 * A fake Canva Connect API: the paths packages/integrations/src/canva-connect-client.ts calls, and the
 * export download host Core admits (export-download.canva.com, served over the chaos CA).
 *
 * An imported deck becomes a design whose PPTX export is the deck itself, so Core's copy and font
 * check reads exactly what Core sent. Every creation is written to a ledger, so the driver can check
 * that no deck was imported twice and no export was paid for twice.
 */
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJson, readBody, sendJson, sha256 } from './http-util.ts';

export interface CanvaFault {
  method: string;
  /** A regular expression the path (after /rest/v1) must match. */
  path: string;
  kind: '5xx' | '429';
  n: number;
}

export interface CanvaLedgerEntry {
  seq: number;
  kind: 'import' | 'export' | 'design' | 'token' | 'download' | 'manual_edit';
  id: string;
  sourceSha256?: string;
  designId?: string;
  format?: string;
  status: number;
  at: string;
}

/** `updatedAt` stays fixed: Core reads a design's updated_at around an export, and a change means someone edited it (the export is stale). */
interface Design { id: string; title: string; source: Buffer | null; width: number; height: number; updatedAt: number }
interface Job { id: string; kind: 'import' | 'export'; designId: string; format?: string; polls: number }

/** A solid-colour PNG of the given size; Core stores and forwards it as the draft preview. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [10, 22, 40]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export class FakeCanva {
  private seq = 0;
  // Job and design ids stay unique across restarts of the fakes: Core keeps the old ones.
  private readonly run = Date.now().toString(36);
  private designs = new Map<string, Design>();
  private jobs = new Map<string, Job>();
  private faults: CanvaFault[] = [];
  readonly ledger: CanvaLedgerEntry[] = [];

  /** Test control only: synthetic bytes stand in for a person's native edit. Never an import. */
  editDesign(id: string, source: Buffer): void {
    const design=this.designs.get(id);
    if (!design || source.length < 32 || source.length > 25*1024*1024) throw new Error('Invalid synthetic edit');
    design.source=source; design.updatedAt++;
    this.note({kind:'manual_edit',id,designId:id,sourceSha256:sha256(source),status:200});
  }

  reset(): void {
    this.faults = [];
    this.ledger.length = 0;
  }

  clearFaults(): void {
    this.faults = [];
  }

  addFault(fault: CanvaFault): void {
    this.faults.push({ ...fault, n: fault.n ?? 1 });
  }

  private note(entry: Omit<CanvaLedgerEntry, 'seq' | 'at'>): void {
    this.ledger.push({ ...entry, seq: ++this.seq, at: new Date().toISOString() });
  }

  private takeFault(method: string, path: string): CanvaFault | null {
    const fault = this.faults.find((f) => f.n > 0 && f.method === method && new RegExp(f.path).test(path));
    if (!fault) return null;
    fault.n--;
    return fault;
  }

  private designBody(d: Design) {
    return {
      id: d.id,
      title: d.title,
      page_count: 1,
      owner: { user_id: 'chaos-user', team_id: 'chaos-team' },
      urls: { edit_url: `https://www.canva.com/design/${d.id}/edit`, view_url: `https://www.canva.com/design/${d.id}/view` },
      created_at: d.updatedAt,
      updated_at: d.updatedAt,
    };
  }

  /** The Connect REST API; `path` is the part after /rest/v1. */
  async handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method || 'GET';
    const body = await readBody(req);
    const fault = this.takeFault(method, path);
    if (fault?.kind === '429') return sendJson(res, 429, { code: 'too_many_requests', message: 'chaos fault' }, { 'Retry-After': '1' });
    if (fault?.kind === '5xx') return sendJson(res, 503, { code: 'internal_error', message: 'chaos fault' });

    if (method === 'POST' && path === '/oauth/token') {
      this.note({ kind: 'token', id: `tok-${this.seq + 1}`, status: 200 });
      // Throwaway tokens, made up per call: the fake accepts any bearer.
      const token = () => randomBytes(12).toString('hex');
      return sendJson(res, 200, { access_token: token(), refresh_token: token(), token_type: 'Bearer', expires_in: 14400 });
    }
    if (method === 'POST' && path === '/imports') {
      const id = `imp-${this.run}-${this.seq + 1}`;
      const designId = `DAchaos${this.run}${String(this.seq + 1).padStart(6, '0')}`;
      let title = 'Imported';
      try { title = Buffer.from(JSON.parse(String(req.headers['import-metadata'] || '{}')).title_base64 || '', 'base64').toString() || title; } catch { /* keep default */ }
      this.designs.set(designId, { id: designId, title, source: body, width: 1080, height: 1350, updatedAt: Math.floor(Date.now() / 1000) });
      this.jobs.set(id, { id, kind: 'import', designId, polls: 0 });
      this.note({ kind: 'import', id, designId, sourceSha256: sha256(body), status: 200 });
      return sendJson(res, 200, { job: { id, status: 'in_progress' } });
    }
    const importRead = /^\/imports\/([^/]+)$/.exec(path);
    if (method === 'GET' && importRead) {
      const job = this.jobs.get(importRead[1]);
      if (!job) return sendJson(res, 404, { code: 'not_found', message: 'no such import' });
      const d = this.designs.get(job.designId)!;
      return sendJson(res, 200, { job: { id: job.id, status: 'success', result: { designs: [{ id: d.id, title: d.title, urls: this.designBody(d).urls }] } } });
    }
    if (method === 'POST' && path === '/designs') {
      const json = parseJson(body);
      const id = `DAchaos${this.run}${String(this.seq + 1).padStart(6, '0')}`;
      const d = { id, title: String(json.title || 'Design'), source: null, width: Number(json.design_type?.width) || 1080, height: Number(json.design_type?.height) || 1350, updatedAt: Math.floor(Date.now() / 1000) };
      this.designs.set(id, d);
      this.note({ kind: 'design', id, designId: id, status: 200 });
      return sendJson(res, 200, { design: this.designBody(d) });
    }
    const designRead = /^\/designs\/([^/]+)$/.exec(path);
    if (method === 'GET' && designRead) {
      const d = this.designs.get(designRead[1]);
      return d ? sendJson(res, 200, { design: this.designBody(d) }) : sendJson(res, 404, { code: 'not_found', message: 'no such design' });
    }
    if (method === 'POST' && path === '/exports') {
      const json = parseJson(body);
      const d = this.designs.get(String(json.design_id));
      if (!d) return sendJson(res, 404, { code: 'not_found', message: 'no such design' });
      const id = `exp-${this.run}-${this.seq + 1}`;
      const format = String(json.format?.type || 'png');
      this.jobs.set(id, { id, kind: 'export', designId: d.id, format, polls: 0 });
      this.note({ kind: 'export', id, designId: d.id, format, status: 200 });
      return sendJson(res, 200, { job: { id, status: 'in_progress' } });
    }
    const exportRead = /^\/exports\/([^/]+)$/.exec(path);
    if (method === 'GET' && exportRead) {
      const job = this.jobs.get(exportRead[1]);
      if (!job || job.kind !== 'export') return sendJson(res, 404, { code: 'not_found', message: 'no such export' });
      const ext = job.format === 'pptx' ? 'pptx' : job.format === 'pdf' ? 'pdf' : 'png';
      return sendJson(res, 200, { job: { id: job.id, status: 'success', urls: [`https://export-download.canva.com/${job.id}/design.${ext}`] } });
    }
    sendJson(res, 404, { code: 'not_found', message: `chaos fakes: ${method} ${path} is not faked` });
  }

  /** A signed export download on export-download.canva.com. */
  handleDownload(res: ServerResponse, path: string): void {
    const m = /^\/([^/]+)\/design\.(png|pptx|pdf)$/.exec(path);
    const job = m ? this.jobs.get(m[1]) : undefined;
    const d = job ? this.designs.get(job.designId) : undefined;
    if (!job || !d) {
      res.writeHead(404);
      res.end();
      return;
    }
    let bytes: Buffer;
    let type: string;
    if (job.format === 'pptx') {
      bytes = d.source ?? Buffer.alloc(0);
      type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    } else if (job.format === 'pdf') {
      bytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
      type = 'application/pdf';
    } else {
      bytes = solidPng(Math.min(d.width, 1200), Math.min(d.height, 1700));
      type = 'image/png';
    }
    this.note({ kind: 'download', id: job.id, designId: d.id, format: job.format, status: 200 });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length) });
    res.end(bytes);
  }
}
