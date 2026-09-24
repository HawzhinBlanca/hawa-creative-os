import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';

/**
 * Migration 021: reviewers' comments on a task (architecture programme 1.3, group G3), which Core
 * kept only in memory before. The application role may add and read comments of the tasks it can
 * see, never change or remove one, and a task's deletion takes its comments.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const OPERATOR = { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

describe.skipIf(!appUrl || !ownerUrl)('migration 021: review comments', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = createDb(appUrl!);
  beforeAll(async () => {
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await app.destroy();
  });

  const newTask = async () => {
    const task = randomUUID();
    await owner.query(`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'comment test')`, [task, TENANT, CLIENT]);
    return task;
  };
  const addComment = (task: string, scope: { tenantId: string; userId?: string; role?: string } = OPERATOR) =>
    withRlsContext(app, scope, (trx) => sql<{ id: string }>`
      INSERT INTO hawa.review_comments (tenant_id, task_id, author_role, author_user_id, author_display_name, body, category, priority)
      VALUES (${scope.tenantId}::uuid, ${task}::uuid, 'art_director', ${OPERATOR.userId}, 'Reviewer', 'Move the logo', 'layout', 'high')
      RETURNING id`.execute(trx));

  it('is recorded by the upgrade runner', async () => {
    const r = await owner.query(`SELECT name FROM hawa.schema_upgrades WHERE name = '021_review_comments.sql'`);
    expect(r.rowCount).toBe(1);
  });

  it('lets the application add and read a comment, and never change or remove one', async () => {
    const task = await newTask();
    const { rows } = await addComment(task);
    const read = await withRlsContext(app, OPERATOR, (trx) => sql<{ body: string }>`SELECT body FROM hawa.review_comments WHERE task_id = ${task}::uuid`.execute(trx));
    expect(read.rows).toEqual([{ body: 'Move the logo' }]);
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.review_comments SET body = 'x' WHERE id = ${rows[0].id}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`DELETE FROM hawa.review_comments WHERE id = ${rows[0].id}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('keeps each tenant to its own comments', async () => {
    const task = await newTask();
    await addComment(task);
    const other = randomUUID();
    const theirs = await withRlsContext(app, { tenantId: other, userId: OPERATOR.userId, role: 'operator' }, (trx) =>
      sql`SELECT id FROM hawa.review_comments WHERE task_id = ${task}::uuid`.execute(trx));
    expect(theirs.rows).toEqual([]);
    await expect(addComment(task, { tenantId: other, userId: OPERATOR.userId, role: 'operator' })).rejects.toThrow();
  });

  it('refuses a revision that does not exist, and goes with its task', async () => {
    const task = await newTask();
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`
      INSERT INTO hawa.review_comments (tenant_id, task_id, design_revision_id, author_role, author_user_id, author_display_name, body, category, priority)
      VALUES (${TENANT}::uuid, ${task}::uuid, ${randomUUID()}::uuid, 'art_director', 'u', 'R', 'b', 'c', 'p')`.execute(trx))).rejects.toMatchObject({ code: '23503' });
    await addComment(task);
    await owner.query('DELETE FROM hawa.tasks WHERE id = $1', [task]);
    const left = await owner.query('SELECT count(*)::int AS n FROM hawa.review_comments WHERE task_id = $1', [task]);
    expect(left.rows[0].n).toBe(0);
  });
});
