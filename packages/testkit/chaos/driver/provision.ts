/**
 * Makes a fresh hawa-chaos project ready for scripted requests, the way production's database and
 * Restate are made ready:
 *  - Postgres ran the roles, schema, RLS, runtime grants and seed at first start (docker-compose.chaos.yml
 *    mounts the files docker-compose.prod.yml mounts as init scripts); the versioned upgrades run here,
 *    through the runner deploy.sh uses (packages/db/src/upgrade.ts);
 *  - the Primary Operator's Canva connection is stored, sealed with the chaos key, as the OAuth
 *    callback would store it (the worker calls Core as that operator);
 *  - KAAE's client DNA names a Drive folder and sheet, so a delivery is archived (to the fake Drive);
 *  - the blue worker is registered with Restate by the deploy's own script (scripts/restate-bluegreen.ts),
 *    with the admin URL pointed at the chaos Restate.
 */
import { randomBytes } from 'node:crypto';
import { upgradeCanvaSchema } from '../../../db/src/upgrade.js';
import { CanvaTokenCipher } from '../../../../apps/core/src/services/canva-connect-service.js';
import { runCli } from '../../../../scripts/restate-bluegreen.js';
import { PORTS, RESTATE_ADMIN_URL, query, secrets, sql, type Service } from './stack.js';

export const TENANT_ID = '00000000-0000-4000-a000-000000000001';
/** The operator HAWA_BEARER_TOKEN maps to in Core (app.ts operatorUserId). */
export const OPERATOR_USER_ID = '00000000-0000-4000-b000-000000000001';

export async function upgradeSchema(): Promise<{ applied: string[]; verified: string[] }> {
  // No grants of its own: db/03-grants.sql ran at init, as in production, and the upgrades grant
  // their own tables. The driver used to grant every table in full, which hid that production's init
  // left the worker unable to lease a command (2026-09-24).
  return upgradeCanvaSchema(`postgresql://hawa_owner:${secrets().CHAOS_OWNER_PASSWORD}@127.0.0.1:${PORTS.postgres}/hawa_chaos`);
}

export async function connectCanva(): Promise<void> {
  const cipher = new CanvaTokenCipher(secrets().CHAOS_CANVA_KEY);
  // Far from expiry, so no refresh runs unless a scenario asks for one.
  // Throwaway tokens: the fake Canva accepts any bearer.
  const token = () => randomBytes(12).toString('hex');
  const sealed = cipher.seal({ access_token: token(), refresh_token: token(), expires_in: 30 * 86400, token_type: 'Bearer' }, `${TENANT_ID}:${OPERATOR_USER_ID}`);
  await query(sql`INSERT INTO hawa.canva_connections (tenant_id, actor_id, encrypted_tokens, expires_at, status, generation)
    VALUES (${TENANT_ID}::uuid, ${OPERATOR_USER_ID}, ${sealed}, now() + interval '30 days', 'active', gen_random_uuid())
    ON CONFLICT (tenant_id, actor_id) DO UPDATE SET encrypted_tokens = excluded.encrypted_tokens, expires_at = excluded.expires_at, status = 'active'`);
}

export const KAAE_CLIENT_ID = 'c1000000-0000-4000-8000-000000000002';

/**
 * KAAE's client DNA, with the Drive folder and tracking sheet delivery archives to (in the fake
 * Drive). Production reads it from this table; Core drops in-memory seed clients in production.
 */
export async function kaaeClientDna(): Promise<void> {
  const dna = {
    clientId: KAAE_CLIENT_ID,
    name: 'Kurdistan Accrediting Association for Education',
    code: 'KAAE',
    version: 1,
    status: 'active',
    defaultLocale: 'ckb',
    defaultDirection: 'rtl',
    // KAAE Brand Guidelines, Excellence Edition (KAAE_Guidelines4.pdf, 2025), as packages/domain's KAAE fixture.
    colors: [{ name: 'White', hex: '#FFFFFF', role: 'background' }, { name: 'KAAE Blue', hex: '#4770A3', role: 'primary' },
      { name: 'KAAE Gold', hex: '#F7B500', role: 'accent' }, { name: 'Midnight', hex: '#0A1628', role: 'text' }],
    fonts: [{ family: 'Inter', style: 'Regular', weight: 400, role: 'body', license: 'OFL-1.1', supportedLocales: ['en'] },
      { family: 'Noto Sans Arabic', style: 'Regular', weight: 400, role: 'body', license: 'OFL-1.1', supportedLocales: ['ckb', 'ar'] }],
    destinations: { productionFolderId: 'chaos-kaae-production', spreadsheetId: 'chaos-kaae-tracker', sheetId: 0 },
    approvalPolicy: { requiredRoles: ['art_director'], allowAutoApproval: false, autoApprovalEligibleTemplates: [] },
  };
  await query(sql`INSERT INTO hawa.client_dna_versions (tenant_id, client_id, version, status, dna, content_hash, effective_from)
    VALUES (${TENANT_ID}::uuid, ${KAAE_CLIENT_ID}::uuid, 1, 'active', ${JSON.stringify(dna)}::jsonb, md5(${JSON.stringify(dna)}), now())
    ON CONFLICT (client_id, version) DO NOTHING`);
}

/** Registers a colour with Restate as deploy.sh does; returns the script's output lines. */
export async function registerColour(colour: 'blue' | 'green'): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(['register', colour, '--admin', RESTATE_ADMIN_URL], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, lines };
}

export async function finishDrains(waitSeconds = 120): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(['finish-drains', '--wait-seconds', String(waitSeconds), '--interval-seconds', '2', '--admin', RESTATE_ADMIN_URL], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, lines };
}

export async function provision(): Promise<{ upgrades: number; registered: string }> {
  const upgrades = await upgradeSchema();
  await connectCanva();
  await kaaeClientDna();
  const reg = await registerColour('blue');
  if (reg.code !== 0) throw new Error(`registering the blue worker failed (${reg.code}): ${reg.lines.join(' | ')}`);
  return { upgrades: upgrades.applied.length + upgrades.verified.length, registered: reg.lines.join(' ') };
}

export type { Service };
