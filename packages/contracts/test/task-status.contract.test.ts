import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskState } from '@hawa/db';
import type { TaskStatus } from '@hawa/domain';
import {
  API_STATUS_OF_DB_STATE,
  APPROVABLE_TASK_STATUSES,
  IN_PROGRESS_TASK_STATUSES,
  DB_STATE_OF_API_STATUS,
  TASK_API_STATUSES,
  TASK_DB_STATES,
  TASK_STATUS_LABELS,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  UnknownTaskStatusError,
  parseTaskTransitioned,
  taskTransitioned,
  toApiTaskStatus,
  toDbTaskState,
  type TaskApiStatus,
  type TaskDbState,
} from '../src/task-status.js';
import { driftedFiles, openApiBlock, renderOpenApi, renderTaskSchema, OPENAPI_PATH, TASK_SCHEMA_PATH } from '../../../scripts/generate_task_status_contract.js';
import * as repository from '../../db/src/repositories/task.repository.js';
import { LEGAL_TRANSITIONS } from '../../domain/src/state-machine.js';
import { STATUS_VIEWS, taskStatusView } from '../../../apps/desk/src/services/taskStatus.js';

/**
 * One task-status vocabulary (architecture programme 1.2). Every layer that names a task's status is
 * checked against packages/contracts/src/task-status.ts: the database enum, the database package's
 * type and mappers, the JSON schema, OpenAPI, the domain state machine and the Desk. A layer that
 * adds, drops or renames a word fails here.
 */
const REPO = path.resolve(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');

// Type-level: the database and domain types are the module's (checked by scripts/typecheck_tests.ts).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const dbTypeIsTheModules: Equal<TaskState, TaskDbState> = true;
const domainTypeIsTheModules: Equal<TaskStatus, TaskApiStatus> = true;

describe('the database', () => {
  it('declares exactly the module\'s states, in order (db/schema.sql task_state)', () => {
    const enumBody = /CREATE TYPE task_state AS ENUM \(([^)]*)\)/.exec(read('db/schema.sql'))?.[1];
    expect(enumBody, 'db/schema.sql has no task_state enum').toBeDefined();
    const states = [...enumBody!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(states).toEqual([...TASK_DB_STATES]);
    expect(dbTypeIsTheModules && domainTypeIsTheModules).toBe(true);
  });

  it('the database package lists and maps with the module (packages/db task.repository.ts)', () => {
    expect([...repository.TASK_STATES]).toEqual([...TASK_DB_STATES]);
    for (const state of TASK_DB_STATES) expect(repository.toApiTaskStatus(state), state).toBe(API_STATUS_OF_DB_STATE[state]);
    for (const status of TASK_API_STATUSES) expect(repository.toDbTaskState(status), status).toBe(DB_STATE_OF_API_STATUS[status]);
  });

  it('refuses a word no layer defines instead of storing it as received', () => {
    for (const word of ['IN_PROGRESS', 'CHANGES_REQUESTED', 'COMPLETED', 'NEEDS_INFORMATION', 'DESIGN_IN_PROGRESS', 'HUMAN_REVIEW', 'Received', '', 'received ']) {
      expect(() => repository.toDbTaskState(word), word).toThrow(/Unknown task status/);
      expect(() => repository.toApiTaskStatus(word), word).toThrow(/Unknown task status/);
    }
    // A filter word the API never reports matches nothing (GET /tasks?statuses=).
    expect(repository.dbStatesForApiStatuses(['IN_PROGRESS'])).toEqual([]);
    expect(repository.dbStatesForApiStatuses(['OPERATOR_REQUIRED'])).toEqual(['failed_retryable', 'failed_operator']);
  });
});

describe('the mapping between database states and API statuses', () => {
  it('gives every state one status and every status one state', () => {
    expect(Object.keys(API_STATUS_OF_DB_STATE).sort()).toEqual([...TASK_DB_STATES].sort());
    expect(Object.keys(DB_STATE_OF_API_STATUS).sort()).toEqual([...TASK_API_STATUSES].sort());
    expect(new Set(Object.values(API_STATUS_OF_DB_STATE))).toEqual(new Set(TASK_API_STATUSES.filter((s) => s !== 'PUBLISH_RECONCILIATION')));
  });

  it('round-trips every word except the three listed pairs that share a word', () => {
    const lossy: string[] = [];
    for (const state of TASK_DB_STATES) if (toDbTaskState(toApiTaskStatus(state)) !== state) lossy.push(state);
    for (const status of TASK_API_STATUSES) if (toApiTaskStatus(toDbTaskState(status)) !== status) lossy.push(status);
    expect(lossy.sort()).toEqual(['PUBLISH_RECONCILIATION', 'context_ready', 'failed_retryable']);
  });
});

describe('the legal moves', () => {
  it('are the domain state machine\'s (packages/domain state-machine.ts)', () => {
    expect(LEGAL_TRANSITIONS).toEqual(TASK_TRANSITIONS);
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_API_STATUSES].sort());
    for (const [from, to] of Object.entries(TASK_TRANSITIONS)) for (const next of to) expect(TASK_API_STATUSES, `${from} -> ${next}`).toContain(next);
  });

  it('approval is possible only where the moves allow APPROVED; nothing leaves a terminal status', () => {
    expect([...APPROVABLE_TASK_STATUSES]).not.toEqual(expect.arrayContaining(['REVISION_REQUESTED', 'APPROVED', 'PUBLISHING', 'COMPLETE', 'REJECTED', 'CANCELLED']));
    expect(APPROVABLE_TASK_STATUSES).toEqual(expect.arrayContaining(['AWAITING_APPROVAL', 'OPERATOR_REQUIRED', 'RECEIVED']));
    for (const closed of ['REVISION_REQUESTED', 'APPROVED', 'PUBLISHING', 'COMPLETE', 'REJECTED', 'CANCELLED']) expect(APPROVABLE_TASK_STATUSES, closed).not.toContain(closed);
    for (const status of APPROVABLE_TASK_STATUSES) expect(TASK_TRANSITIONS[status], status).toContain('APPROVED');
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(['CANCELLED', 'COMPLETE', 'REJECTED']);
  });
});

describe('Task.schema.json and OpenAPI', () => {
  it('are generated from the module: scripts/generate_task_status_contract.ts --check finds no drift', () => {
    expect(driftedFiles()).toEqual([]);
  });

  it('the schema lists the database states and the API statuses', () => {
    const schema = JSON.parse(read('schemas/Task.schema.json'));
    expect(schema.properties.state.enum).toEqual([...TASK_DB_STATES]);
    expect(schema.properties.status.enum).toEqual([...TASK_API_STATUSES]);
  });

  it('every task-status enum in openapi.yaml is the module\'s, and the check fails when one gains a word', () => {
    const openapi = read('api/openapi.yaml');
    expect(openapi).toContain(openApiBlock());
    // Revision and job enums share words such as approved and cancelled; an enum naming a task's
    // first or review state is a task-status enum, and must be one of the module's two lists.
    let taskEnums = 0;
    for (const m of openapi.matchAll(/enum: \[([^\]]*)\]/g)) {
      const words = m[1].split(',').map((w) => w.trim());
      if (!words.some((w) => ['received', 'human_review', 'RECEIVED', 'AWAITING_APPROVAL'].includes(w))) continue;
      taskEnums += 1;
      expect([[...TASK_DB_STATES], [...TASK_API_STATUSES]], m[0]).toContainEqual(words);
    }
    expect(taskEnums).toBe(2);
    // A word added to the file's generated enum, or to the schema, is drift.
    const added = openapi.replace('CANCELLED]', 'CANCELLED, IN_PROGRESS]');
    expect(renderOpenApi(added)).not.toBe(added);
    const schema = fs.readFileSync(TASK_SCHEMA_PATH, 'utf8');
    const widened = schema.replace('"cancelled",', '"cancelled",\n        "in_progress",');
    expect(widened).not.toBe(schema);
    expect(renderTaskSchema(widened)).not.toBe(widened);
    expect(path.relative(REPO, OPENAPI_PATH)).toBe('api/openapi.yaml');
  });
});

describe('the Desk (apps/desk taskStatus.ts)', () => {
  it('has a view for exactly the module\'s statuses, labelled with the module\'s label', () => {
    expect(Object.keys(STATUS_VIEWS).sort()).toEqual([...TASK_API_STATUSES].sort());
    for (const status of TASK_API_STATUSES) {
      expect(taskStatusView(status).pill, status).toBe(TASK_STATUS_LABELS[status]);
      expect(taskStatusView(status).canApprove, status).toBe(APPROVABLE_TASK_STATUSES.includes(status));
    }
  });

  it('splits the module\'s in-progress statuses into its "In Design" and "Delivering" filters, and nothing else', () => {
    const working = TASK_API_STATUSES.filter((status) => ['in_design', 'delivering'].includes(STATUS_VIEWS[status].group));
    expect([...working].sort()).toEqual([...IN_PROGRESS_TASK_STATUSES].sort());
  });
});

/** Quoted upper-case words a source file sets on, or compares with, a task's status. */
function statusWordsIn(source: string): string[] {
  const words: string[] = [];
  // A task object: task, memTask, feedbackTargetTask, selectedTask, … or the list callbacks' `t`.
  const TASK = String.raw`\b(?:\w*[tT]ask\w*|t)\??\.status`;
  const patterns = [
    new RegExp(String.raw`${TASK}\s*(?:=(?!=)|===|!==)\s*'([A-Z][A-Z_]*)'`, 'g'),
    /\b(?:toStatus|fromStatus|targetStatus|currentStatus)\s*(?::|=(?!=)|===|!==)\s*'([A-Z][A-Z_]*)'/g,
    new RegExp(String.raw`${TASK}\s*=(?!=)[^;\n]*\?\s*'([A-Z][A-Z_]*)'\s*:\s*'([A-Z][A-Z_]*)'`, 'g'),
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) words.push(...m.slice(1).filter(Boolean));
  // A variable holding a task's status (taskStatus, currentTaskStatus, …): every word in its initialiser.
  for (const m of source.matchAll(/\b(?:const|let|var)\s+\w*[tT]askStatus\b[^;]*;/g)) {
    words.push(...[...m[0].matchAll(/'([A-Z][A-Z_]*)'/g)].map((w) => w[1]));
  }
  for (const m of source.matchAll(new RegExp(String.raw`\[([^\]]*)\]\.includes\(${TASK}\)`, 'g'))) {
    words.push(...[...m[1].matchAll(/'([A-Z][A-Z_]*)'/g)].map((w) => w[1]));
  }
  return words;
}

function sourceFiles(dir: string): string[] {
  const abs = path.join(REPO, dir);
  return fs
    .readdirSync(abs, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('node_modules'))
    .map((f) => path.join(dir, f));
}

describe('the words Core, the worker and the Desk use for a task\'s status', () => {
  const files = [...sourceFiles('apps/core/src'), ...sourceFiles('apps/worker/src'), ...sourceFiles('apps/desk/src')];

  it('are all the module\'s API statuses (no in-memory words such as IN_PROGRESS or CHANGES_REQUESTED)', () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const word of statusWordsIn(read(file))) {
        if (!(TASK_API_STATUSES as readonly string[]).includes(word)) unknown.push(`${file}: ${word}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the scan sees an in-memory word when one is added', () => {
    expect(statusWordsIn("task.status = 'IN_PROGRESS';")).toEqual(['IN_PROGRESS']);
    expect(statusWordsIn("memTask.status = ok ? 'AWAITING_APPROVAL' : 'CHANGES_REQUESTED';")).toContain('CHANGES_REQUESTED');
    expect(statusWordsIn("if (['AWAITING_APPROVAL', 'COMPLETED'].includes(memTask.status)) {}")).toContain('COMPLETED');
    // The publication-state route's fallback, which the first version of this scan missed.
    expect(statusWordsIn("const taskStatus = task?.status || (done ? 'COMPLETE' : (drive ? 'PUBLISH_RECONCILIATION' : 'PENDING'));")).toContain('PENDING');
  });

  it('task:transitioned is sent only through taskTransitioned, never as a hand-made object', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles('apps/core/src'), ...sourceFiles('apps/worker/src')]) {
      const source = read(file);
      if (/'task:transitioned'/.test(source)) offenders.push(`${file}: names 'task:transitioned' itself (use TASK_TRANSITIONED_EVENT)`);
      for (const m of source.matchAll(/broadcast(?:Event)?\(\s*TASK_TRANSITIONED_EVENT\s*,\s*([^\n]{0,40})/g)) {
        if (!m[1].startsWith('taskTransitioned(')) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('task:transitioned', () => {
  it('has one shape {taskId, from, to, version, at}, in API statuses', () => {
    const event = taskTransitioned({ taskId: 't1', from: 'human_review', to: 'APPROVED', version: 4, at: '2026-09-24T10:00:00.000Z' });
    expect(event).toEqual({ taskId: 't1', from: 'AWAITING_APPROVAL', to: 'APPROVED', version: 4, at: '2026-09-24T10:00:00.000Z' });
    expect(parseTaskTransitioned({ tenantId: 'x', ...event })).toEqual(event);
    expect(taskTransitioned({ taskId: 't1', to: 'RECEIVED' })).toMatchObject({ from: null, version: null });
  });

  it('refuses an unknown word, and the Desk reads none of the four old shapes as a move', () => {
    expect(() => taskTransitioned({ taskId: 't1', from: 'AWAITING_APPROVAL', to: 'IN_PROGRESS' })).toThrow(UnknownTaskStatusError);
    expect(() => taskTransitioned({ taskId: 't1', from: 'RECEIVED', to: 'HUMAN_REVIEW' })).toThrow(UnknownTaskStatusError);
    expect(() => taskTransitioned({ taskId: 't1', to: 'APPROVED', version: 0 })).toThrow();
    for (const old of [
      { taskId: 't1', status: 'AWAITING_APPROVAL', revisionId: 'r' },
      { taskId: 't1', fromStatus: 'AWAITING_APPROVAL', toStatus: 'IN_PROGRESS' },
      { taskId: 't1', action: 'recheck', revisionId: 'r' },
      { taskId: 't1', status: 'AWAITING_APPROVAL', toStatus: 'AWAITING_APPROVAL', action: 'redrive' },
      { taskId: 't1', from: 'RECEIVED', to: 'ON_HOLD', version: 2, at: 'now' },
    ]) {
      expect(parseTaskTransitioned(old), JSON.stringify(old)).toBeNull();
    }
  });
});
