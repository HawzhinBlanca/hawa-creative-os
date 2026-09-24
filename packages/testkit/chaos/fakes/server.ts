/**
 * The chaos suite's fakes container (PHASE2_DESIGN.md section 6.2): Telegram, the model providers,
 * Canva Connect, Google Drive and Sheets, and the chaos control, in one Node process with no
 * dependencies beyond Node itself. Node runs it by stripping the types (Node 22.18 or later), so it
 * needs no build and starts from the node base stage of the worker's Dockerfile.
 *
 *   HTTPS :443  the hard-coded provider hosts (network aliases of this container; see ca.ts)
 *   HTTP :9000  /canva/rest/v1 (CANVA_BASE_URL), /google (GOOGLE_*_BASE_URL), /__chaos (chaos points),
 *               /__fakes (the driver's control of the fakes), /__core (Core's API, for the driver:
 *               Core has no host port), /health
 *
 * Nothing here calls out: every provider answer is made up or read from fixtures.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeChaosCertificates, type ChaosCertificates } from './ca.ts';
import { ChaosControl } from './chaos-control.ts';
import { FakeTelegram } from './telegram.ts';
import { FakeModels, loadModelFixtures } from './models.ts';
import { FakeCanva } from './canva.ts';
import { parseJson, readBody, sendJson } from './http-util.ts';
import { startFakeDriveServer, type FakeDriveServer } from '../../../integrations/test/fake-drive-server.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface Fakes {
  telegram: FakeTelegram;
  models: FakeModels;
  canva: FakeCanva;
  control: ChaosControl;
  drive: FakeDriveServer;
  http: http.Server;
  https: https.Server;
  caPem: string;
  close(): Promise<void>;
}

/** Forwards a request: to the reused fake Drive server (packages/integrations/test/fake-drive-server.ts), or to Core. */
async function proxy(req: IncomingMessage, res: ServerResponse, target: string, path: string): Promise<void> {
  const body = await readBody(req);
  const upstream = http.request(`${target}${path}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => sendJson(res, 502, { error: `proxy to ${target}: ${err.message}` }));
  upstream.end(body);
}

/**
 * The certificates kept in the CA volume, made on the project's first start. Core and the workers
 * read the CA once, at their own start (NODE_EXTRA_CA_CERTS), so a restarted fakes container must
 * keep serving under the same one. Each file appears whole or not at all (written, then renamed);
 * the keys stay in a directory only the fakes' user can read.
 */
function certificatesIn(dir: string): ChaosCertificates {
  const files = { caPem: join(dir, 'ca.pem'), certPem: join(dir, 'server.pem'), keyPem: join(dir, 'private', 'server-key.pem') };
  if (Object.values(files).every((f) => existsSync(f))) {
    return { caPem: readFileSync(files.caPem, 'utf8'), certPem: readFileSync(files.certPem, 'utf8'), keyPem: readFileSync(files.keyPem, 'utf8') };
  }
  const made = makeChaosCertificates();
  mkdirSync(join(dir, 'private'), { recursive: true, mode: 0o700 });
  const put = (file: string, text: string, mode: number) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  };
  put(files.keyPem, made.keyPem, 0o600);
  put(files.certPem, made.certPem, 0o644);
  // A throwaway Google service-account key for Core (GOOGLE_APPLICATION_CREDENTIALS): Core signs its
  // token request with it, as with the office's key, and the fake token endpoint accepts it.
  const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  put(join(dir, 'google-service-account.json'), JSON.stringify({
    type: 'service_account',
    project_id: 'hawa-chaos',
    private_key_id: crypto.randomBytes(8).toString('hex'),
    private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'hawa-chaos@hawa-chaos.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  }), 0o644);
  // Last: the health check waits for ca.pem, so the other two are there once it is.
  put(files.caPem, made.caPem, 0o644);
  return made;
}

export async function startFakes(options: { httpPort?: number; httpsPort?: number; host?: string; caDir?: string; fixturesDir?: string } = {}): Promise<Fakes> {
  const certs = options.caDir ? certificatesIn(options.caDir) : makeChaosCertificates();
  const telegram = new FakeTelegram();
  const models = new FakeModels(loadModelFixtures(options.fixturesDir || join(here, '..', 'fixtures', 'models')));
  const canva = new FakeCanva();
  const control = new ChaosControl();
  const drive = await startFakeDriveServer();
  // Delays on the fake Drive and Sheets: a slow Google makes a Deliver request last long enough to
  // kill Core in the middle of it (Core has no chaos points yet).
  let googleDelays: Array<{ path: string; delayMs: number; n: number }> = [];
  const google = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const delay = googleDelays.find((d) => d.n > 0 && new RegExp(d.path).test(path));
    if (delay) {
      delay.n--;
      await new Promise((r) => setTimeout(r, delay.delayMs));
    }
    return proxy(req, res, drive.url, path);
  };

  const admin = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const body = req.method === 'POST' ? parseJson(await readBody(req)) : {};
    switch (`${req.method} ${path}`) {
      case 'POST /reset':
        telegram.reset();
        models.reset();
        canva.reset();
        control.reset();
        drive.reset();
        return sendJson(res, 200, { ok: true });
      case 'POST /google/faults':
        googleDelays.push({ path: String(body.path || '.'), delayMs: Number(body.delayMs) || 1000, n: Number(body.n) || 1 });
        return sendJson(res, 200, { ok: true });
      case 'POST /faults/clear':
        // Faults a scenario armed and did not use up must not reach the next scenario.
        telegram.clearFaults();
        canva.clearFaults();
        models.clearDelays();
        googleDelays = [];
        control.disarm();
        return sendJson(res, 200, { ok: true });
      case 'POST /telegram/updates':
        return sendJson(res, 200, { updateIds: telegram.enqueue(Array.isArray(body.updates) ? body.updates : []) });
      case 'POST /telegram/faults':
        telegram.addFault(body);
        return sendJson(res, 200, { ok: true });
      case 'POST /telegram/files':
        telegram.addFile(body);
        return sendJson(res, 200, { ok: true });
      case 'GET /telegram/sent':
        return sendJson(res, 200, { sent: telegram.sent });
      case 'GET /telegram/polls':
        return sendJson(res, 200, { polls: telegram.polls, pending: telegram.pending().map((u) => u.update_id), calls: telegram.calls.length });
      case 'POST /canva/faults':
        canva.addFault(body);
        return sendJson(res, 200, { ok: true });
      case 'GET /canva/ledger':
        return sendJson(res, 200, { ledger: canva.ledger });
      case 'GET /models/ledger':
        return sendJson(res, 200, { ledger: models.ledger, paid: models.paidCounts(), arrivals: models.arrivals });
      case 'POST /models/delays':
        models.addDelay(body);
        return sendJson(res, 200, { ok: true });
      case 'GET /drive/files':
        return sendJson(res, 200, { files: drive.getUploadedFiles().map(({ content, ...meta }) => ({ ...meta, bytes: content.length })) });
    }
    sendJson(res, 404, { error: `unknown fakes path ${req.method} ${path}` });
  };

  const route = async (req: IncomingMessage, res: ServerResponse, secure: boolean) => {
    const url = new URL(req.url || '/', 'http://fakes');
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const path = url.pathname;
    try {
      if (secure) {
        if (host === 'api.telegram.org') return await telegram.handle(req, res, path, url.searchParams);
        if (host === 'api.openai.com' || host === 'generativelanguage.googleapis.com' || host === 'api.anthropic.com') return await models.handle(req, res, host, path);
        if (host === 'api.canva.com' && path.startsWith('/rest/v1')) return await canva.handleApi(req, res, path.slice('/rest/v1'.length));
        if (host === 'export-download.canva.com' || host === 'document-export.canva.com') return canva.handleDownload(res, path);
        if (host === 'oauth2.googleapis.com' && path === '/token') return sendJson(res, 200, { access_token: crypto.randomBytes(12).toString('hex'), expires_in: 3600, token_type: 'Bearer' });
        if (host === 'www.googleapis.com' || host === 'sheets.googleapis.com') return await google(req, res, path.replace(/^\/upload/, '') + url.search);
        return sendJson(res, 404, { error: `chaos fakes: ${host} is not faked` });
      }
      if (path === '/health') return sendJson(res, 200, { ok: true });
      if (path.startsWith('/__chaos/')) return await control.handle(req, res, path.slice('/__chaos'.length), url.searchParams);
      if (path.startsWith('/__fakes/')) return await admin(req, res, path.slice('/__fakes'.length));
      // Core is on the internal network only; the driver reaches its API through here.
      if (path.startsWith('/__core/') && process.env.CHAOS_CORE_URL) return await proxy(req, res, process.env.CHAOS_CORE_URL, path.slice('/__core'.length) + url.search);
      if (path.startsWith('/canva/rest/v1/')) return await canva.handleApi(req, res, path.slice('/canva/rest/v1'.length));
      if (path.startsWith('/google/')) return await google(req, res, path.slice('/google'.length) + url.search);
      sendJson(res, 404, { error: `chaos fakes: ${path} is not faked` });
    } catch (err) {
      sendJson(res, 500, { error: `chaos fakes: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const plain = http.createServer((req, res) => void route(req, res, false));
  const secure = https.createServer({ cert: certs.certPem, key: certs.keyPem }, (req, res) => void route(req, res, true));
  // Held chaos points and long polls stay open for minutes.
  plain.requestTimeout = 0;
  plain.headersTimeout = 0;
  secure.requestTimeout = 0;
  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((r) => plain.listen(options.httpPort ?? 9000, host, r));
  await new Promise<void>((r) => secure.listen(options.httpsPort ?? 443, host, r));

  return {
    telegram, models, canva, control, drive, http: plain, https: secure, caPem: certs.caPem,
    close: async () => {
      control.reset();
      plain.closeAllConnections();
      secure.closeAllConnections();
      await Promise.all([new Promise((r) => plain.close(r)), new Promise((r) => secure.close(r)), drive.close()]);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startFakes({
    httpPort: Number(process.env.CHAOS_HTTP_PORT || 9000),
    httpsPort: Number(process.env.CHAOS_HTTPS_PORT || 443),
    caDir: process.env.CHAOS_CA_DIR || '/chaos-ca',
    fixturesDir: process.env.CHAOS_FIXTURES_DIR,
  }).then(() => console.log('[chaos-fakes] listening on :9000 (control, Canva, Google) and :443 (provider hosts)'));
  process.on('SIGTERM', () => process.exit(0));
}
