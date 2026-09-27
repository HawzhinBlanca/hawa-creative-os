/** Restores the real candidate at two external-effect boundaries; external services remain fakes. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAOS_DIR, FAKES_URL, REPO_ROOT, closeDb, compose, fakes, query, restateQuery, sql } from './stack.js';
import { sentTo, waitUntil, type InvariantResult } from './scenario.js';

export async function restorePendingDelivery(taskId: string, chat: string, started: number,
  events: string[]): Promise<InvariantResult[]> {
  const checks: InvariantResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({name, ok, detail});
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const restore = async (phase: string) => {
    await closeDb();
    const output = join(CHAOS_DIR, '.run', `recovery-${phase}.json`);
    const process = spawnSync('python3', [join(REPO_ROOT, 'infra/backup/candidate_recovery.py'),
      '--task-id', taskId, '--started-after', new Date(started).toISOString(), '--output', output],
    {cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024});
    if (process.status !== 0) throw new Error(`Coordinated ${phase} restore failed: ${process.stdout.slice(-1000)} ${process.stderr.slice(-1500)}`);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    check(`${phase}: fresh stores match before any writer resumes`, receipt.allRowsAndPoliciesMatch &&
      receipt.allStoreFilesMatch && receipt.externalServiceSurvived && receipt.writersStoppedBeforeCaptureAndDuringValidation,
    `${receipt.tableCount} tables / ${receipt.policyCount} policies; ${receipt.restoreValidationSeconds}s startup verification`);
    check(`${phase}: restored blob rows have exact bytes before writer admission`, receipt.verifiedBlobCount > 0 &&
      receipt.missingBlobReferences === 0, `${receipt.verifiedBlobCount} registered blobs verified`);
    compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '--wait', 'core']);
    compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '--wait', 'worker-blue']);
    // nginx retains upstream addresses across container replacement.
    compose(['restart', 'nginx']);
    events.push(`${phase}: restored PostgreSQL, Restate and blobs from authenticated encrypted archives to new volumes; resumed exact images`);
    return receipt;
  };

  const held = await fakes.wait('core.delivery.after-drive');
  check('delivery held after external Drive effect', held?.held && held.detail?.mode === 'workflow', JSON.stringify(held));
  const beforeDrive = (await fakes.driveFiles()).filter(file => file.properties?.taskId === taskId);
  check('Drive already has the selected export before capture', beforeDrive.length === 1, `${beforeDrive.length} files`);
  await fakes.hold('worker.sender.after-telegram', {commandType: 'lifecycle', kind: 'document', chat});
  const first = await restore('drive');
  await fakes.release('core.delivery.after-drive');

  const sent = await fakes.wait('worker.sender.after-telegram');
  check('restored pending delivery reaches Telegram without another Deliver press', sent?.held && sent.detail?.chat === chat, JSON.stringify(sent));
  const docs = (await sentTo(chat)).filter(item => item.method === 'sendDocument');
  check('one approved file has reached Telegram before its receipt', docs.length === 1, `${docs.length} documents`);
  const [attempt] = await query<{n:string}>(sql`SELECT count(*) AS n FROM hawa.inbox_events
    WHERE source_account_id='telegram_delivery' AND source_event_id=${`lc:${sent.detail.key}:send`}
      AND payload->>'outcome'='attempted'`);
  check('uncertain Telegram attempt is committed before the second capture', Number(attempt.n) === 1, `attempt marks=${attempt.n}`);
  const second = await restore('telegram');
  check('pending Delivery retains its original invocation and deployment across both restores',
    JSON.stringify(first.pendingDelivery) === JSON.stringify(second.pendingDelivery), JSON.stringify(second.pendingDelivery));
  await fakes.release('worker.sender.after-telegram');
  await waitUntil('restored delivery journal completion', async () => {
    const runs = await restateQuery<{status:string}>(`SELECT status FROM sys_invocation WHERE id='${second.pendingDelivery[0].id}'`);
    return runs.length === 1 && runs[0].status === 'completed' ? true : null;
  });
  const afterDrive = (await fakes.driveFiles()).filter(file => file.properties?.taskId === taskId);
  const afterDocs = (await sentTo(chat)).filter(item => item.method === 'sendDocument');
  check('Drive recovery adopted the existing external file', afterDrive.length === 1 && afterDrive[0].id === beforeDrive[0].id,
    `before=${beforeDrive[0].id}; after=${afterDrive.map(file=>file.id).join(',')}`);
  check('restored unconfirmed Telegram send was never repeated', afterDocs.length === 1 &&
    afterDocs[0].documentSha256 === docs[0].documentSha256, `${afterDocs.length} documents`);
  const alerts = await waitUntil('one uncertain-send alert', async () => {
    const messages = (await sentTo('9000001')).filter(item=>item.text?.includes(taskId));
    return messages.length ? messages : null;
  });
  check('restored uncertain send is surfaced once to the office', alerts.length === 1, `${alerts.length} alerts`);
  const publications = await query<{id:string;state:string}>(sql`SELECT id,state FROM hawa.publications WHERE task_id=${taskId}::uuid`);
  check('restored delivery records exactly one completed publication', publications.length === 1 && publications[0].state === 'complete',
    JSON.stringify(publications));
  const sheet = await fetch(`${FAKES_URL}/google/v4/spreadsheets/chaos-kaae-tracker/values/A:Z`);
  const rows = (await sheet.json() as {values?:unknown[][]}).values ?? [];
  const matching = rows.filter(row=>row.some(value=>String(value).includes(taskId)));
  check('surviving external sheet contains one task row after both restores', sheet.ok && matching.length === 1, `${matching.length} rows`);
  return checks;
}
