#!/usr/bin/env node
// ==============================================================================
// The reading half of scripts/suite_stability.sh: what failed in one run, and the summary of all runs.
//
//   node scripts/suite_stability_report.mjs failures <run.json> <run.log>
//     prints one line per failure of that run: "<kind>\t<name>\t<first error line>"
//   node scripts/suite_stability_report.mjs summary <failures.tsv>
//     prints every failure of every run once, with the distinct runs it happened in
//
// Kinds: test (a failed test), file (a file that failed outside its tests: an import, a hook),
// error (an error vitest reported outside any test, which fails the run although every test passed).
// Kept apart from the shell script so that its tests (scripts/test/suite-stability-report.test.ts)
// can feed it the report and log vitest really writes.
// ==============================================================================
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI = /\u001b\[[0-9;]*m/g;
const lines = (text) => String(text || '').replace(ANSI, '').split('\n').map((l) => l.trim());
const firstLine = (text) => lines(text).find((l) => l) || '';

// Vitest 4's JSON report does not carry the message of some failures. A test that ran past its
// timeout is reported as "Error: STACK_TRACE_ERROR" and a stack into the runner; the message
// ("Error: Test timed out in 30000ms.") is only in the default reporter's log. Timeouts are the
// commonest flake under load, so for those the message comes from the log.
const PLACEHOLDER = /^(Error: )?STACK_TRACE_ERROR$/;

/**
 * The log's "Failed Tests" section names each failed test on a line of its own,
 * " FAIL  <file> > <describe> > ... > <title>", and its error on the first line after it.
 */
function messageInLog(logLines, header) {
  const at = logLines.indexOf(header);
  if (at < 0) return '';
  for (let i = at + 1; i < logLines.length; i++) {
    const line = logLines[i];
    if (!line) continue;
    // The next block's rule or header: the test had no message of its own.
    if (/^⎯{3,}/.test(line) || /^FAIL /.test(line)) return '';
    return line;
  }
  return '';
}

/** One run's failures, from the text of its JSON report (null if none was written) and of its log. */
export function runFailures(reportText, logText, cwd = process.cwd()) {
  const out = [];
  let report = null;
  try { report = reportText == null ? null : JSON.parse(reportText); } catch { /* a report cut short: the run died writing it */ }
  const log = String(logText || '').replace(ANSI, '');
  const logLines = lines(log);
  if (report) {
    for (const file of report.testResults || []) {
      const rel = String(file.name || '').replace(cwd.replace(/\/?$/, '/'), '');
      const failed = (file.assertionResults || []).filter((a) => a.status === 'failed');
      for (const a of failed) {
        let message = firstLine((a.failureMessages || [])[0]);
        if (!message || PLACEHOLDER.test(message)) {
          const header = ['FAIL  ' + rel, ...(a.ancestorTitles || []), a.title].join(' > ');
          message = messageInLog(logLines, header) || message;
        }
        out.push(['test', `${rel} > ${a.fullName || a.title}`, message || '(no message)']);
      }
      if (file.status === 'failed' && failed.length === 0) out.push(['file', rel, firstLine(file.message) || '(no message)']);
    }
  }
  // Errors outside tests are printed after an "Unhandled Errors" rule, each under a rule of its own
  // ("Unhandled Rejection", "Unhandled Error"), before the run's counts.
  const start = log.search(/⎯+ Unhandled Errors? ⎯+/);
  if (start >= 0) {
    const end = log.indexOf('\n Test Files ', start);
    const section = log.slice(start, end >= 0 ? end : undefined);
    const blocks = section.split(/^⎯{3,}.*$/m).map((b) => lines(b).filter((l) => l && !/^Vitest caught|^This might cause false positive/.test(l)));
    for (const block of blocks) {
      if (!block.length) continue;
      const origin = block.find((l) => /^This error originated in|^The latest test that might've caused/.test(l)) || '';
      const where = /"([^"]+)"/.exec(origin)?.[1] || '(outside any file)';
      out.push(['error', where, block[0]]);
    }
  }
  if (!report && !out.length) out.push(['error', '(the run)', 'no JSON report was written: vitest did not finish']);
  return out.map((row) => row.map((c) => String(c).replace(/\t/g, ' ')));
}

/**
 * Every failure once, from the rows "<run>\t<kind>\t<name>\t<message>" of all runs: the distinct runs
 * it happened in, how many times in all when that is more (one file's unhandled errors repeat within
 * a run), and the first message seen. Most frequent first.
 */
export function summarise(tsvText) {
  const seen = new Map();
  for (const row of String(tsvText || '').split('\n')) {
    if (!row) continue;
    const [run, kind, name, message] = row.split('\t');
    const key = `${kind}\t${name}`;
    const entry = seen.get(key) ?? { kind, name, runs: [], times: 0, message };
    if (!entry.runs.includes(run)) entry.runs.push(run);
    entry.times += 1;
    seen.set(key, entry);
  }
  const entries = [...seen.values()].sort((a, b) => b.runs.length - a.runs.length || a.name.localeCompare(b.name));
  const out = [];
  for (const e of entries) {
    const times = e.times > e.runs.length ? ` (${e.times} times in all)` : '';
    out.push(`  ${e.kind}: ${e.name}`);
    out.push(`    failed in ${e.runs.length} run(s): ${e.runs.join(',')}${times}`);
    out.push(`    ${e.message}`);
  }
  return out.join('\n');
}

function readOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'failures') {
    for (const row of runFailures(readOrNull(args[0]), readOrNull(args[1]))) console.log(row.join('\t'));
  } else if (command === 'summary') {
    const text = summarise(readOrNull(args[0]));
    if (text) console.log(text);
  } else {
    console.error('usage: suite_stability_report.mjs failures <run.json> <run.log> | summary <failures.tsv>');
    process.exit(2);
  }
}
