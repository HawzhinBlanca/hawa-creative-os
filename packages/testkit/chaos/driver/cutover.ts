/**
 * Deploys of a release and its Telegram configuration on the chaos stack, in the order
 * infra/docker/deploy.sh makes them (ADR-129), for the R10 scenarios (driver/cutover-scenarios.ts).
 *
 * Two releases take part. `current` is this checkout (images hawa-chaos-*:local, built by the suite).
 * `previous` is the release production ran before this one, built from its commit into
 * hawa-chaos-*:prev (buildPreviousRelease; default RELEASE_MANIFEST.json's build commit, or
 * HAWA_CHAOS_PREVIOUS_RELEASE). Since ADR-135 the current release has no Core poller and no chat list,
 * so requests "made before the cutover" can only be made the way production made them: on the previous
 * release, with Core polling and no chat on the lifecycle. Rolling back means deploying the previous
 * release again (never switching to Core's poller).
 *
 *   step 7   Core is recreated with the target release and the poller it must keep: a move to the worker
 *            is held (Core keeps `core`), a move back is not (deploy.sh core_poller_hold; on the current
 *            release Core never polls, whatever it is given);
 *   step 7b  the idle worker colour is created from the target release, becomes healthy and is
 *            registered with Restate by the deploy's own script (scripts/restate-bluegreen.ts register);
 *            release_core_poller then recreates Core with the wanted poller (only when it was held);
 *            finish-drains deletes the old colour once nothing is pinned to it, and its container is
 *            removed (report_drains).
 *
 * What a container is created with comes from the release override (.run/release.compose.json, read by
 * every compose call of the shared project, driver/stack.ts): the image tag of its release and, for the
 * previous release only, HAWA_LIFECYCLE_CHATS. CHAOS_TELEGRAM_POLLER is read from this process's
 * environment (docker-compose.chaos.yml), as deploy.sh sets HAWA_TELEGRAM_POLLER on its command lines.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../../../scripts/restate-bluegreen.js';
import { CHAOS_DIR, compose, RELEASE_OVERRIDE, REPO_ROOT, RESTATE_ADMIN_URL, run, waitHealthy } from './stack.js';
import { finishDrains, registerColour } from './provision.js';

export type Poller = 'core' | 'worker';
export type Release = 'previous' | 'current';
/** `chats` is HAWA_LIFECYCLE_CHATS; null leaves it unset (the current release has no such setting). */
export interface StackConfig { release: Release; poller: Poller; chats: string | null }

/** The commit of the previous release: HAWA_CHAOS_PREVIOUS_RELEASE, else RELEASE_MANIFEST.json's build. */
export function previousReleaseCommit(): string {
  const named = (process.env.HAWA_CHAOS_PREVIOUS_RELEASE || '').trim();
  const commit = named || String(JSON.parse(readFileSync(join(REPO_ROOT, 'RELEASE_MANIFEST.json'), 'utf8'))?.build?.commit ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`no previous release commit (${JSON.stringify(commit)})`);
  const full = spawnSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (full.status !== 0) throw new Error(`previous release ${commit} is not a commit of this repository`);
  return full.stdout.trim();
}

/**
 * Builds hawa-chaos-core:prev and hawa-chaos-worker:prev from the previous release's commit, from a
 * `git archive` of it (never a checkout of this worktree), with the same Dockerfiles that release had.
 */
export function buildPreviousRelease(): { commit: string; ms: number } {
  const started = Date.now();
  const commit = previousReleaseCommit();
  const dir = join(CHAOS_DIR, '.run', 'previous-release');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = join(CHAOS_DIR, '.run', 'previous-release.tar');
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', tar, commit], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`git archive ${commit}: ${archive.stderr}`);
  run('tar', ['-xf', tar, '-C', dir]);
  rmSync(tar, { force: true });
  for (const [service, dockerfile] of [['core', 'Dockerfile.core'], ['worker', 'Dockerfile.worker']] as const) {
    run('docker', ['build', '-q', '-f', join(dir, 'infra', 'docker', dockerfile), '--build-arg', `HAWA_BUILD_COMMIT=${commit}`,
      '-t', `hawa-chaos-${service}:prev`, dir], { timeoutMs: 45 * 60_000 });
  }
  rmSync(dir, { recursive: true, force: true });
  return { commit, ms: Date.now() - started };
}

/** What the running containers were created with. */
let current: StackConfig = { release: 'current', poller: 'worker', chats: null };
export const currentConfig = (): StackConfig => ({ ...current });

/**
 * The release override every later compose call reads: image tags and, on the previous release, its
 * chat list. The current release with no chat list needs none, so the file is removed.
 */
function writeOverride(config: StackConfig): void {
  process.env.CHAOS_TELEGRAM_POLLER = config.poller;
  if (config.release === 'current' && config.chats === null) {
    rmSync(RELEASE_OVERRIDE, { force: true });
    return;
  }
  const tag = config.release === 'previous' ? 'prev' : 'local';
  const env = config.chats === null ? {} : { environment: { HAWA_LIFECYCLE_CHATS: config.chats } };
  const services = {
    core: { image: `hawa-chaos-core:${tag}`, ...env },
    'worker-blue': { image: `hawa-chaos-worker:${tag}`, ...env },
    'worker-green': { image: `hawa-chaos-worker:${tag}`, ...env },
  };
  mkdirSync(join(CHAOS_DIR, '.run'), { recursive: true });
  writeFileSync(RELEASE_OVERRIDE, JSON.stringify({ services }, null, 2));
}

/** Before the stack's first `up` of Core and the worker: they start on this release and configuration. */
export function startOnRelease(config: StackConfig): void {
  writeOverride(config);
  current = { ...config };
}

/** Restate's live and idle colour, as deploy.sh reads them (`restate-bluegreen.ts plan`). */
export async function plan(): Promise<{ live: string; idle: 'blue' | 'green' }> {
  const lines: string[] = [];
  const code = await runCli(['plan', '--admin', RESTATE_ADMIN_URL], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  const live = lines.map((l) => /^live=(.*)$/.exec(l)?.[1]).find(Boolean);
  const idle = lines.map((l) => /^idle=(.*)$/.exec(l)?.[1]).find(Boolean);
  if (code !== 0 || !live || (idle !== 'blue' && idle !== 'green')) throw new Error(`restate-bluegreen plan: exit ${code} ${lines.join(' | ')}`);
  return { live, idle };
}

export interface DeployHooks {
  /** After step 7 recreated Core, before the idle colour is registered (the old colour still polls). */
  afterCore?: () => Promise<void>;
  /** After the idle colour is registered, before Core takes a held poller. */
  afterRegister?: () => Promise<void>;
  /** After Core has its final poller, before the old colour is drained and removed. */
  beforeDrain?: () => Promise<void>;
}

export interface DeployReport {
  from: StackConfig;
  to: StackConfig;
  live: string;
  idle: string;
  coreHeldAt: Poller;
  register: { code: number; lines: string[] };
  drains: { code: number; lines: string[] };
  removed: string[];
  steps: string[];
}

/**
 * One deploy of a release and its Telegram configuration. Throws when Restate refuses the new colour;
 * everything else is reported (a drain that does not finish in time leaves the old colour running,
 * as deploy.sh).
 */
export async function deployConfig(to: StackConfig, hooks: DeployHooks = {}, drainWaitSeconds = 300): Promise<DeployReport> {
  const from = currentConfig();
  const steps: string[] = [];
  const stamp = (line: string) => steps.push(`${new Date().toISOString()} ${line}`);
  const shown = (c: StackConfig) => `release=${c.release} poller=${c.poller} chats=${c.chats === null ? '(unset)' : JSON.stringify(c.chats)}`;
  // deploy.sh core_poller_hold: Core stops polling only when it already runs with worker.
  const coreHeldAt: Poller = to.poller === 'worker' && from.poller === 'worker' ? 'worker' : 'core';

  // Step 7: Core from the target release, with the held poller.
  writeOverride({ ...to, poller: coreHeldAt });
  compose(['up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '240', 'core'], { timeoutMs: 10 * 60_000 });
  await waitHealthy('core');
  stamp(`step 7: core recreated with ${shown({ ...to, poller: coreHeldAt })}`);
  if (hooks.afterCore) await hooks.afterCore();

  // Step 7b: the idle colour, from the target release.
  const { live, idle } = await plan();
  writeOverride(to);
  compose(['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '240', `worker-${idle}`], { timeoutMs: 10 * 60_000 });
  await waitHealthy(`worker-${idle}`);
  stamp(`step 7b: worker-${idle} created with ${shown(to)} (live was ${live})`);
  const register = await registerColour(idle);
  stamp(`register ${idle}: exit ${register.code} ${register.lines.join(' ')}`);
  if (register.code !== 0) throw new Error(`register ${idle}: exit ${register.code} ${register.lines.join(' | ')}`);
  if (hooks.afterRegister) await hooks.afterRegister();

  // release_core_poller: only a held switch recreates Core a second time.
  if (coreHeldAt !== to.poller) {
    compose(['up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '240', 'core'], { timeoutMs: 10 * 60_000 });
    await waitHealthy('core');
    stamp(`release: core recreated with poller=${to.poller}`);
  }
  current = { ...to };
  if (hooks.beforeDrain) await hooks.beforeDrain();

  // finish-drains, then the drained colour's container goes (deploy.sh report_drains).
  const drains = await finishDrains(drainWaitSeconds);
  stamp(`finish-drains: exit ${drains.code} ${drains.lines.join(' | ')}`);
  const removed: string[] = [];
  for (const line of drains.lines) {
    const colour = /^deleted=(blue|green)$/.exec(line.trim())?.[1];
    if (!colour) continue;
    compose(['rm', '-sf', `worker-${colour}`], { allowFail: true });
    removed.push(colour);
    stamp(`removed worker-${colour}`);
  }
  return { from, to, live, idle, coreHeldAt, register, drains, removed, steps };
}
