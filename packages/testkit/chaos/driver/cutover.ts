/**
 * A configuration deploy on the chaos stack, in the order infra/docker/deploy.sh makes it (ADR-129),
 * for the R10 cutover scenarios: the Telegram poller (HAWA_TELEGRAM_POLLER) and the lifecycle chats
 * (HAWA_LIFECYCLE_CHATS) change the way production changed them on 2026-09-28, and back.
 *
 *   step 7   Core is recreated with the new chats and the poller it must keep: a move to the worker is
 *            held (Core keeps `core`), a move back to Core is not (deploy.sh core_poller_hold);
 *   step 7b  the idle worker colour is created with the new values, becomes healthy and is registered
 *            with Restate by the deploy's own script (scripts/restate-bluegreen.ts register);
 *            release_core_poller then recreates Core with the wanted poller (only when it was held);
 *            finish-drains deletes the old colour once nothing is pinned to it, and its container is
 *            removed (report_drains).
 *
 * Compose reads CHAOS_TELEGRAM_POLLER and CHAOS_LIFECYCLE_CHATS from this process's environment
 * (docker-compose.chaos.yml), so each step sets them before it recreates a container, as deploy.sh
 * sets HAWA_TELEGRAM_POLLER on its compose command lines.
 */
import { runCli } from '../../../../scripts/restate-bluegreen.js';
import { compose, RESTATE_ADMIN_URL, waitHealthy } from './stack.js';
import { finishDrains, registerColour } from './provision.js';

export type Poller = 'core' | 'worker';
export interface StackConfig { poller: Poller; chats: string }

/** What the running containers were created with (the suite starts with run.ts's values). */
let current: StackConfig = {
  poller: (process.env.CHAOS_TELEGRAM_POLLER || 'core').trim().toLowerCase() === 'worker' ? 'worker' : 'core',
  chats: process.env.CHAOS_LIFECYCLE_CHATS ?? '(compose default list)',
};
export const currentConfig = (): StackConfig => ({ ...current });

function setEnv(poller: Poller, chats: string): void {
  process.env.CHAOS_TELEGRAM_POLLER = poller;
  process.env.CHAOS_LIFECYCLE_CHATS = chats;
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
  /** After the idle colour is registered, before Core takes a held poller (both may poll here). */
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
 * One deploy of a new poller and chat list. Throws when Restate refuses the new colour; everything
 * else is reported (a drain that does not finish in time leaves the old colour running, as deploy.sh).
 */
export async function deployConfig(to: StackConfig, hooks: DeployHooks = {}, drainWaitSeconds = 300): Promise<DeployReport> {
  const from = currentConfig();
  const steps: string[] = [];
  const stamp = (line: string) => steps.push(`${new Date().toISOString()} ${line}`);
  // deploy.sh core_poller_hold: Core stops polling only when it already runs with worker.
  const coreHeldAt: Poller = to.poller === 'worker' && from.poller === 'worker' ? 'worker' : 'core';

  // Step 7: Core with the new chats and the held poller.
  setEnv(coreHeldAt, to.chats);
  compose(['up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '240', 'core'], { timeoutMs: 10 * 60_000 });
  await waitHealthy('core');
  stamp(`step 7: core recreated with poller=${coreHeldAt} chats=${JSON.stringify(to.chats)}`);
  if (hooks.afterCore) await hooks.afterCore();

  // Step 7b: the idle colour, built from the same images, with the new values.
  const { live, idle } = await plan();
  setEnv(to.poller, to.chats);
  compose(['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '240', `worker-${idle}`], { timeoutMs: 10 * 60_000 });
  await waitHealthy(`worker-${idle}`);
  stamp(`step 7b: worker-${idle} created with poller=${to.poller} chats=${JSON.stringify(to.chats)} (live was ${live})`);
  const register = await registerColour(idle);
  stamp(`register ${idle}: exit ${register.code} ${register.lines.join(' ')}`);
  if (register.code !== 0) throw new Error(`register ${idle}: exit ${register.code} ${register.lines.join(' | ')}`);
  if (hooks.afterRegister) await hooks.afterRegister();

  // release_core_poller: only a held switch recreates Core a second time.
  if (coreHeldAt !== to.poller) {
    setEnv(to.poller, to.chats);
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
