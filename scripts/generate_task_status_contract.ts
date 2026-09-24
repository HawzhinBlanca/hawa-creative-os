#!/usr/bin/env tsx
/**
 * Writes the task-status enums of schemas/Task.schema.json and api/openapi.yaml from the one
 * vocabulary, packages/contracts/src/task-status.ts (architecture programme 1.2). The two files
 * listed 21 states and none; the database had 22 (it had 'rejected', the schema did not).
 *
 *   npx tsx scripts/generate_task_status_contract.ts          # rewrite both files
 *   npx tsx scripts/generate_task_status_contract.ts --check  # exit 1 when either has drifted
 *
 * Only the generated parts change: the `state` and `status` properties of Task.schema.json, and the
 * block between the GENERATED markers in openapi.yaml. packages/contracts/test/task-status.contract.test.ts
 * runs the same check.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASK_API_STATUSES, TASK_DB_STATES, TASK_TRANSITIONED_KEYS } from '../packages/contracts/src/task-status.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASK_SCHEMA_PATH = path.join(ROOT, 'schemas/Task.schema.json');
export const OPENAPI_PATH = path.join(ROOT, 'api/openapi.yaml');

export const OPENAPI_BEGIN = '    # BEGIN GENERATED task status: scripts/generate_task_status_contract.ts from packages/contracts/src/task-status.ts. Do not edit.';
export const OPENAPI_END = '    # END GENERATED task status';

/** Task.schema.json with its `state` and `status` properties from the module; every other part as it was. */
export function renderTaskSchema(current: string): string {
  const schema = JSON.parse(current) as { properties: Record<string, unknown> };
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (key === 'status') continue;
    properties[key] = key === 'state'
      ? { description: 'The database state (task_state in db/schema.sql).', enum: [...TASK_DB_STATES] }
      : value;
    // The API status sits next to the state it is derived from.
    if (key === 'state') {
      properties.status = { description: 'The API status of the state, as the Desk shows it.', enum: [...TASK_API_STATUSES] };
    }
  }
  return `${JSON.stringify({ ...schema, properties }, null, 2)}\n`;
}

/** The generated block of openapi.yaml, markers included. */
export function openApiBlock(): string {
  const list = (words: readonly string[]) => `[${words.join(', ')}]`;
  return [
    OPENAPI_BEGIN,
    '    TaskState:',
    '      description: A task\'s database state (task_state in db/schema.sql).',
    '      type: string',
    `      enum: ${list(TASK_DB_STATES)}`,
    '    TaskStatus:',
    '      description: A task\'s API status, as the Desk shows it. Each database state has exactly one.',
    '      type: string',
    `      enum: ${list(TASK_API_STATUSES)}`,
    '    TaskTransitionedEvent:',
    '      description: The payload of the live stream\'s task:transitioned event (the stream adds tenantId).',
    '      type: object',
    `      required: ${list(TASK_TRANSITIONED_KEYS)}`,
    '      properties:',
    '        taskId: {type: string}',
    "        from: {oneOf: [{$ref: '#/components/schemas/TaskStatus'}, {type: 'null'}]}",
    "        to: {$ref: '#/components/schemas/TaskStatus'}",
    "        version: {type: [integer, 'null'], minimum: 1}",
    '        at: {type: string, format: date-time}',
    OPENAPI_END,
  ].join('\n');
}

/** openapi.yaml with its generated block replaced, or appended to components.schemas (the file's last section). */
export function renderOpenApi(current: string): string {
  const begin = current.indexOf(OPENAPI_BEGIN);
  const end = current.indexOf(OPENAPI_END);
  if (begin >= 0 && end > begin) {
    return current.slice(0, begin) + openApiBlock() + current.slice(end + OPENAPI_END.length);
  }
  if (begin >= 0 || end >= 0) throw new Error('openapi.yaml has one task-status marker without the other');
  const lastTop = [...current.matchAll(/^([a-zA-Z]\S*):/gm)].pop();
  if (lastTop?.[1] !== 'components' || !/^  schemas:$/m.test(current.slice(lastTop.index))) {
    throw new Error('openapi.yaml must end with components.schemas for the task-status block to be appended');
  }
  return `${current.replace(/\s*$/, '')}\n${openApiBlock()}\n`;
}

/** The files whose generated parts differ from the module. */
export function driftedFiles(read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string[] {
  const drifted: string[] = [];
  const schema = read(TASK_SCHEMA_PATH);
  if (renderTaskSchema(schema) !== schema) drifted.push(path.relative(ROOT, TASK_SCHEMA_PATH));
  const openapi = read(OPENAPI_PATH);
  if (renderOpenApi(openapi) !== openapi) drifted.push(path.relative(ROOT, OPENAPI_PATH));
  return drifted;
}

function main(): void {
  if (process.argv.includes('--check')) {
    const drifted = driftedFiles();
    if (drifted.length > 0) {
      console.error(`Task status drifted from packages/contracts/src/task-status.ts in: ${drifted.join(', ')}. Run npx tsx scripts/generate_task_status_contract.ts`);
      process.exit(1);
    }
    console.log('Task.schema.json and openapi.yaml match packages/contracts/src/task-status.ts.');
    return;
  }
  writeFileSync(TASK_SCHEMA_PATH, renderTaskSchema(readFileSync(TASK_SCHEMA_PATH, 'utf8')));
  writeFileSync(OPENAPI_PATH, renderOpenApi(readFileSync(OPENAPI_PATH, 'utf8')));
  console.log('Wrote the task-status enums of schemas/Task.schema.json and api/openapi.yaml.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
