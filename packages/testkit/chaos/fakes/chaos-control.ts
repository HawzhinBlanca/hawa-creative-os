/**
 * The control side of chaosPoint() (packages/observability/src/chaos-point.ts).
 *
 * Every point a process passes is reported here (POST /reach). The driver arms a point before a step
 * (POST /hold), waits until a process reaches it (GET /wait), kills that process's container while
 * the point's answer is still held, and releases it (POST /release) when it wants the work to go on
 * instead. A point nobody armed is answered at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJson, readBody, sendJson } from './http-util.ts';

export interface ReachedPoint {
  seq: number;
  point: string;
  detail: Record<string, unknown>;
  service: string | null;
  pid: number | null;
  at: string;
  held: boolean;
}

interface Arm {
  id: number;
  point: string;
  /** Every key must be present in the detail and contain this text. */
  match: Record<string, string>;
  remaining: number;
}

interface Hold {
  reached: ReachedPoint;
  res: ServerResponse;
  keepAlive: ReturnType<typeof setInterval>;
  released: boolean;
}

interface Waiter {
  point: string;
  resolve: (reached: ReachedPoint) => void;
}

export class ChaosControl {
  private seq = 0;
  private armSeq = 0;
  private arms: Arm[] = [];
  private holds: Hold[] = [];
  private waiters: Waiter[] = [];
  readonly reached: ReachedPoint[] = [];

  arm(point: string, match: Record<string, string> = {}, n = 1): number {
    const id = ++this.armSeq;
    this.arms.push({ id, point, match, remaining: n });
    return id;
  }

  /** Forgets every arm and answers every held point; the log of reached points stays. */
  disarm(): void {
    this.arms = [];
    this.release();
  }

  /** Disarms, and empties the log of reached points. */
  reset(): void {
    this.disarm();
    this.reached.length = 0;
  }

  /** Releases held points (all, or those of one point): the processes holding them go on. */
  release(point?: string): number {
    let n = 0;
    for (const hold of this.holds) {
      if (hold.released || (point && hold.reached.point !== point)) continue;
      this.finish(hold);
      n++;
    }
    this.holds = this.holds.filter((h) => !h.released);
    return n;
  }

  /** The first held point with this name that is still held, now or when one is reached. */
  waitFor(point: string, timeoutMs: number): Promise<ReachedPoint | null> {
    const held = this.holds.find((h) => !h.released && h.reached.point === point);
    if (held) return Promise.resolve(held.reached);
    return new Promise((resolve) => {
      const waiter: Waiter = { point, resolve: (r) => { clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private finish(hold: Hold): void {
    hold.released = true;
    clearInterval(hold.keepAlive);
    if (!hold.res.writableEnded && !hold.res.destroyed) hold.res.end('{"released":true}\n');
  }

  private matches(arm: Arm, point: string, detail: Record<string, unknown>): boolean {
    if (arm.point !== point || arm.remaining <= 0) return false;
    return Object.entries(arm.match).every(([k, v]) => String(detail[k] ?? '').includes(v));
  }

  private onReach(body: any, res: ServerResponse): void {
    const point = String(body.point || '');
    const detail = body.detail && typeof body.detail === 'object' ? body.detail : {};
    const arm = this.arms.find((a) => this.matches(a, point, detail));
    const reached: ReachedPoint = {
      seq: ++this.seq,
      point,
      detail,
      service: typeof body.service === 'string' ? body.service : null,
      pid: Number.isFinite(body.pid) ? body.pid : null,
      at: new Date().toISOString(),
      held: Boolean(arm),
    };
    this.reached.push(reached);
    if (!arm) {
      sendJson(res, 200, { held: false });
      return;
    }
    arm.remaining--;
    // Headers now, the end of the body on release; a newline every 20 s keeps idle timeouts away.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const hold: Hold = { reached, res, released: false, keepAlive: setInterval(() => res.write('\n'), 20000) };
    // A process killed while held closes the connection; its hold is over.
    res.on('close', () => {
      if (!hold.released) {
        hold.released = true;
        clearInterval(hold.keepAlive);
      }
    });
    this.holds.push(hold);
    for (const waiter of this.waiters.filter((w) => w.point === point)) waiter.resolve(reached);
    this.waiters = this.waiters.filter((w) => w.point !== point);
  }

  /** Handles a request under the control prefix; `path` is the part after it. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method || 'GET';
    const body = method === 'POST' ? parseJson(await readBody(req)) : {};
    if (method === 'POST' && path === '/reach') return this.onReach(body, res);
    if (method === 'POST' && path === '/hold') {
      if (typeof body.point !== 'string' || !body.point) return sendJson(res, 400, { error: 'point required' });
      return sendJson(res, 200, { armId: this.arm(body.point, body.match || {}, Number(body.n) || 1) });
    }
    if (method === 'GET' && path === '/wait') {
      const reached = await this.waitFor(String(query.get('point') || ''), Number(query.get('timeoutMs')) || 60000);
      return reached ? sendJson(res, 200, reached) : sendJson(res, 408, { error: 'not reached' });
    }
    if (method === 'POST' && path === '/release') return sendJson(res, 200, { released: this.release(body.point) });
    if (method === 'POST' && path === '/reset') {
      this.reset();
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/reached') return sendJson(res, 200, { reached: this.reached });
    sendJson(res, 404, { error: 'unknown chaos control path' });
  }
}
