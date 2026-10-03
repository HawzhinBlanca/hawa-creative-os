import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * infra/cloudflared/install.sh (ADR-294) with a fake cloudflared and a fake launchctl: a dry run changes
 * nothing and contacts nobody; --apply creates the tunnel once, renders the configuration, routes both
 * names, installs the launchd agent, and a second run changes nothing; --stop takes the tunnel off.
 * The rendered template is also checked by the real cloudflared, offline, when it is installed.
 */
const repo = path.resolve(import.meta.dirname, '../..');
const script = path.join(repo, 'infra/cloudflared/install.sh');
const TUNNEL_ID = '6f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-cloudflared-install-'));
  dirs.push(root);
  const cf = path.join(root, 'cloudflared-home'), bin = path.join(root, 'bin'), log = path.join(root, 'calls'), state = path.join(root, 'state');
  fs.mkdirSync(cf); fs.mkdirSync(bin); fs.mkdirSync(state);
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'cloudflared'), `#!/bin/bash
printf 'cloudflared %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  --version) echo 'cloudflared version 2026.8.3 (fake)';;
  *'ingress validate'*) cfg="$3"; grep -q 'service: http_status:404' "$cfg" && grep -q 'tunnel: ' "$cfg" || exit 1; echo OK;;
  'tunnel list --name hawa-office --output json')
    if [[ -e "$STATE/tunnel" ]]; then echo '[{"id":"${TUNNEL_ID}","name":"hawa-office","deleted_at":"0001-01-01T00:00:00Z"}]'; else echo '[]'; fi;;
  'tunnel create hawa-office') touch "$STATE/tunnel"; echo '{}' > "$CF_HOME/${TUNNEL_ID}.json";;
  'tunnel token --cred-file '*) echo '{}' > "$4";;
  'tunnel route dns hawa-office '*) [[ "$ROUTE_FAIL" == "$5" ]] && { echo 'record exists' >&2; exit 1; }; echo "routed $5";;
  *) echo "unexpected: $*" >&2; exit 9;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash
printf 'launchctl %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  print) [[ -e "$STATE/loaded" ]];;
  bootstrap) touch "$STATE/loaded";;
  bootout) rm -f "$STATE/loaded";;
  kickstart) :;;
  *) exit 9;;
esac
`, { mode: 0o755 });
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, CALL_LOG: log, STATE: state, CF_HOME: cf,
      CLOUDFLARED_BIN: path.join(bin, 'cloudflared'), LAUNCHCTL_BIN: path.join(bin, 'launchctl'), HAWA_CLOUDFLARED_DIR: cf,
      HAWA_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'), HAWA_LOG_DIR: path.join(root, 'logs'), ...env } });
    const calls = fs.readFileSync(log, 'utf8');
    fs.writeFileSync(log, '');
    return { status: r.status, out: r.stdout + r.stderr, calls };
  };
  return { root, cf, state, run, plist: path.join(root, 'LaunchAgents/com.hawa.cloudflared.plist'), config: path.join(cf, 'config.yml'),
    login: () => fs.writeFileSync(path.join(cf, 'cert.pem'), 'fake account certificate') };
}

describe('infra/cloudflared/install.sh', () => {
  it('a dry run prints every change, writes nothing and makes no call to Cloudflare', () => {
    const w = world();
    w.login();
    const r = w.run([]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Mode: dry run/);
    expect(r.out).toMatch(/would run: \S+cloudflared tunnel create hawa-office/);
    expect(r.out).toMatch(/would run: \S+cloudflared tunnel route dns hawa-office design-api\.hawzhin\.app/);
    expect(r.out).toMatch(/would run: \S+cloudflared tunnel route dns hawa-office desk\.hawzhin\.app/);
    expect(r.out).toMatch(/would run: \S+launchctl bootstrap gui\/\d+ \S+com\.hawa\.cloudflared\.plist/);
    // Only the local version query, the offline rule check and launchctl's read-only print ran.
    expect(r.calls.trim().split('\n').map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual(
      ['cloudflared --version', 'cloudflared tunnel --config', `launchctl print gui/${process.getuid?.()}/com.hawa.cloudflared`]);
    expect(fs.existsSync(w.config)).toBe(false);
    expect(fs.existsSync(w.plist)).toBe(false);
    expect(fs.existsSync(path.join(w.root, 'logs'))).toBe(false);
  });

  it('--apply stops before anything when cloudflared tunnel login has not been done', () => {
    const w = world();
    const r = w.run(['--apply']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/cert\.pem is missing: run `cloudflared tunnel login` first/);
    expect(r.calls).not.toMatch(/tunnel (create|list|route)/);
    expect(fs.existsSync(w.config)).toBe(false);
  });

  it('--apply sets everything up once, and a second run changes nothing', () => {
    const w = world();
    w.login();
    const first = w.run(['--apply']);
    expect(first.status, first.out).toBe(0);
    expect(first.calls).toMatch(/^cloudflared tunnel create hawa-office$/m);
    expect(first.calls).toMatch(/^cloudflared tunnel route dns hawa-office design-api\.hawzhin\.app$/m);
    expect(first.calls).toMatch(/^cloudflared tunnel route dns hawa-office desk\.hawzhin\.app$/m);
    expect(first.calls).not.toMatch(/overwrite-dns/);
    expect(first.calls).toMatch(/^launchctl bootstrap gui\/\d+ .*com\.hawa\.cloudflared\.plist$/m);
    const config = fs.readFileSync(w.config, 'utf8');
    expect(fs.statSync(w.config).mode & 0o777).toBe(0o600);
    expect(config).toContain(`tunnel: ${TUNNEL_ID}`);
    expect(config).toContain(`credentials-file: ${path.join(w.cf, `${TUNNEL_ID}.json`)}`);
    expect(config).toMatch(/- hostname: design-api\.hawzhin\.app\n\s+path: \^\/v1\/customer\/\n\s+service: http:\/\/127\.0\.0\.1:8081\n/);
    expect(config).toMatch(/- hostname: desk\.hawzhin\.app\n\s+service: http:\/\/127\.0\.0\.1:8082\n/);
    expect(config).toMatch(/- service: http_status:404\n?$/);
    expect(config.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')).not.toMatch(/httpHostHeader|noTLSVerify|originServerName|__[A-Z_]+__/);
    const plist = fs.readFileSync(w.plist, 'utf8');
    for (const s of ['<key>KeepAlive</key><true/>', '<key>RunAtLoad</key><true/>', '<string>--no-autoupdate</string>', '<string>hawa-office</string>',
      `<string>${w.config}</string>`, `${path.join(w.root, 'logs')}/cloudflared.err.log`]) expect(plist).toContain(s);
    expect(fs.existsSync(path.join(w.root, 'logs'))).toBe(true);

    const second = w.run(['--apply']);
    expect(second.status, second.out).toBe(0);
    expect(second.calls).not.toMatch(/tunnel create|tunnel token|bootstrap|bootout|kickstart/);
    expect(second.out).toMatch(/exists: 6f1c2d4e/);
    expect(second.out).toMatch(/running, configuration unchanged/);
    expect(fs.readdirSync(w.cf).filter((f) => f.includes('.bak.'))).toEqual([]);
  });

  it('a changed port rewrites the configuration, keeps the old one and restarts the agent', () => {
    const w = world();
    w.login();
    expect(w.run(['--apply']).status).toBe(0);
    const r = w.run(['--apply'], { HAWA_CUSTOMER_GATEWAY_PORT: '9081' });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(w.config, 'utf8')).toContain('service: http://127.0.0.1:9081');
    expect(fs.readdirSync(w.cf).filter((f) => f.startsWith('config.yml.bak.'))).toHaveLength(1);
    expect(r.calls).toMatch(/^launchctl kickstart -k gui\/\d+\/com\.hawa\.cloudflared$/m);
    expect(r.calls).not.toMatch(/bootstrap/);
  });

  it('fetches the credentials of a tunnel created elsewhere, and stops when a name already points elsewhere', () => {
    const w = world();
    w.login();
    fs.writeFileSync(path.join(w.state, 'tunnel'), '');
    const r = w.run(['--apply'], { ROUTE_FAIL: 'desk.hawzhin.app' });
    expect(r.calls).toMatch(/^cloudflared tunnel token --cred-file \S+\.json hawa-office$/m);
    expect(r.calls).not.toMatch(/tunnel create/);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/record exists/);
    expect(r.calls).not.toMatch(/bootstrap/);
  });

  it('--stop takes the tunnel off and --apply brings it back', () => {
    const w = world();
    w.login();
    expect(w.run(['--apply']).status).toBe(0);
    const dry = w.run(['--stop']);
    expect(dry.out).toMatch(/would run: \S+launchctl bootout gui\/\d+\/com\.hawa\.cloudflared/);
    expect(fs.existsSync(w.plist)).toBe(true);
    const stop = w.run(['--stop', '--apply']);
    expect(stop.status).toBe(0);
    expect(stop.calls).toMatch(/^launchctl bootout gui\/\d+\/com\.hawa\.cloudflared$/m);
    expect(fs.existsSync(w.plist)).toBe(false);
    expect(fs.existsSync(`${w.plist}.disabled`)).toBe(true);
    const back = w.run(['--apply']);
    expect(back.status).toBe(0);
    expect(back.calls).toMatch(/^launchctl bootstrap /m);
  });

  it('refuses an unknown argument', () => {
    expect(world().run(['--force']).status).toBe(2);
  });
});

const realCloudflared = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!realCloudflared)('the template, read by the real cloudflared (offline)', () => {
  it('validates and routes each name and path to the intended listener', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-cloudflared-rules-'));
    dirs.push(root);
    const file = path.join(root, 'config.yml');
    fs.writeFileSync(file, fs.readFileSync(path.join(repo, 'infra/cloudflared/config.template.yml'), 'utf8')
      .replaceAll('__TUNNEL_ID__', TUNNEL_ID).replaceAll('__CREDENTIALS_FILE__', path.join(root, 'creds.json'))
      .replaceAll('__CUSTOMER_PORT__', '8081').replaceAll('__DESK_PORT__', '8082'));
    const cf = (...args: string[]) => spawnSync('cloudflared', ['tunnel', '--config', file, 'ingress', ...args], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    expect(cf('validate').status).toBe(0);
    const service = (url: string) => /service: (\S+)/.exec(cf('rule', url).stdout)?.[1];
    expect(service('https://design-api.hawzhin.app/v1/customer/session')).toBe('http://127.0.0.1:8081');
    expect(service('https://design-api.hawzhin.app/v1/customer/jobs/x/preview/y')).toBe('http://127.0.0.1:8081');
    for (const p of ['/v1/health', '/', '/api/', '/v1/internal/x', '/v1/tasks']) expect(service(`https://design-api.hawzhin.app${p}`), p).toBe('http_status:404');
    expect(service('https://desk.hawzhin.app/')).toBe('http://127.0.0.1:8082');
    expect(service('https://desk.hawzhin.app/v1/tasks')).toBe('http://127.0.0.1:8082');
    for (const u of ['https://hawzhin.app/', 'https://www.hawzhin.app/', 'https://other.hawzhin.app/']) expect(service(u), u).toBe('http_status:404');
  });
});
