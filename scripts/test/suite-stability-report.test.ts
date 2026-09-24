import { describe, expect, it } from 'vitest';
// A plain script; its types are in suite_stability_report.d.mts.
import { runFailures, summarise } from '../suite_stability_report.mjs';

/**
 * The report and log below are what vitest 4.1.11 wrote for a run of
 * `vitest run --reporter=default --reporter=json --testTimeout=50 packages/creative/test/cutout-effect-raster.test.ts`,
 * cut to one timed-out test, one failed assertion and one error outside any test.
 */
const cwd = '/work/hawa';
const file = `${cwd}/packages/creative/test/cutout-effect-raster.test.ts`;
const runnerStack = [
  '    at task (file:///work/hawa/node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/chunk-artifact.js:1784:27)',
  '    at /work/hawa/packages/creative/test/cutout-effect-raster.test.ts:182:3',
].join('\n');

const report = JSON.stringify({
  numFailedTests: 2,
  success: false,
  testResults: [
    {
      name: file,
      status: 'failed',
      message: '',
      assertionResults: [
        {
          ancestorTitles: ['the effect picture'],
          fullName: 'the effect picture is the same bytes for the same inputs, computed twice',
          status: 'failed',
          title: 'is the same bytes for the same inputs, computed twice',
          failureMessages: [`Error: STACK_TRACE_ERROR\n${runnerStack}`],
        },
        {
          ancestorTitles: ['the effect picture'],
          fullName: 'the effect picture leaves out the opaque core',
          status: 'failed',
          title: 'leaves out the opaque core',
          failureMessages: ['AssertionError: expected 3 to be 4 // Object.is equality\n    at /work/hawa/x.test.ts:1:1'],
        },
        {
          ancestorTitles: ['the effect picture'],
          fullName: 'the effect picture draws nothing for a person with no width',
          status: 'passed',
          title: 'draws nothing for a person with no width',
          failureMessages: [],
        },
      ],
    },
  ],
});

const log = [
  '',
  ' RUN  v4.1.11 /work/hawa',
  '',
  ' ❯ packages/creative/test/cutout-effect-raster.test.ts (3 tests | 2 failed) 540ms',
  '     × is the same bytes for the same inputs, computed twice 484ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  packages/creative/test/cutout-effect-raster.test.ts > the effect picture > is the same bytes for the same inputs, computed twice',
  'Error: Test timed out in 50ms.',
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  ' ❯ packages/creative/test/cutout-effect-raster.test.ts:182:3',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
  '',
  ' FAIL  packages/creative/test/cutout-effect-raster.test.ts > the effect picture > leaves out the opaque core',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯',
  '',
  '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  'This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.',
  '',
  '⎯⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯⎯',
  'Error: connection terminated',
  'This error originated in "apps/worker/test/outbox-claims.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  2 failed | 1 passed (3)',
].join('\n');

describe('one run of the suite stability script', () => {
  it('gives a timed-out test the message the log carries, not the report\'s STACK_TRACE_ERROR placeholder', () => {
    const rows = runFailures(report, log, cwd);
    const timedOut = rows.find((r: string[]) => r[1].endsWith('computed twice'));
    expect(timedOut).toEqual([
      'test',
      'packages/creative/test/cutout-effect-raster.test.ts > the effect picture is the same bytes for the same inputs, computed twice',
      'Error: Test timed out in 50ms.',
    ]);
    expect(rows.some((r: string[]) => /STACK_TRACE_ERROR/.test(r[2]))).toBe(false);
  });

  it('keeps the report\'s own message for any other failure, and lists errors outside a test', () => {
    const rows = runFailures(report, log, cwd);
    expect(rows).toContainEqual([
      'test',
      'packages/creative/test/cutout-effect-raster.test.ts > the effect picture leaves out the opaque core',
      'AssertionError: expected 3 to be 4 // Object.is equality',
    ]);
    expect(rows).toContainEqual(['error', 'apps/worker/test/outbox-claims.test.ts', 'Error: connection terminated']);
    expect(rows).toHaveLength(3);
  });

  it('keeps the placeholder rather than inventing a message when the log has none', () => {
    const rows = runFailures(report, '', cwd);
    expect(rows.find((r: string[]) => r[1].endsWith('computed twice'))?.[2]).toBe('Error: STACK_TRACE_ERROR');
  });

  it('says so when vitest wrote no report at all', () => {
    expect(runFailures(null, 'killed', cwd)).toEqual([['error', '(the run)', 'no JSON report was written: vitest did not finish']]);
  });
});

describe('the summary of all runs', () => {
  it('counts the distinct runs a failure happened in, not its repeats within a run', () => {
    const tsv = [
      ['1', 'error', 'apps/worker/test/outbox-claims.test.ts', 'Error: connection terminated'],
      ['1', 'error', 'apps/worker/test/outbox-claims.test.ts', 'Error: connection terminated'],
      ['1', 'error', 'apps/worker/test/outbox-claims.test.ts', 'Error: connection terminated'],
      ['2', 'error', 'apps/worker/test/outbox-claims.test.ts', 'Error: connection terminated'],
      ['2', 'test', 'a.test.ts > b', 'Error: Test timed out in 30000ms.'],
    ].map((r) => r.join('\t')).join('\n');
    expect(summarise(tsv).split('\n')).toEqual([
      '  error: apps/worker/test/outbox-claims.test.ts',
      '    failed in 2 run(s): 1,2 (4 times in all)',
      '    Error: connection terminated',
      '  test: a.test.ts > b',
      '    failed in 1 run(s): 2',
      '    Error: Test timed out in 30000ms.',
    ]);
  });
});
