#!/usr/bin/env bash
# ==============================================================================
# Suite stability: runs the full vitest suite N times in a row and reports every failure.
#
# Architecture programme item 1.1 asks for 20 consecutive green full-suite runs, with no test
# passing only by luck. One green run proves little about a test that fails one time in ten, so
# this runs the suite N times, prints each run's result as it ends, and then lists every test that
# failed in any run, how often, and its first error, plus errors vitest reported outside a test
# (an unhandled rejection, a console call pending at teardown), which fail a run with every test green.
#
# Usage: scripts/suite_stability.sh [-n RUNS] [-o OUT_DIR] [--stop-on-fail] [-- <vitest args>]
#   -n RUNS          how many runs (default 20)
#   -o OUT_DIR       where each run's log and JSON report go (default: a new temporary directory)
#   --stop-on-fail   stop after the first run that is not green
#   -- <args>        passed to `vitest run` (for example a subset of files while trying this out)
#
# Workers: HAWA_TEST_WORKERS as the suite reads it (vitest.config.ts); the default here is 2, since
# the machine also runs the office's containers. Exit status 0 only if every run was green.
# ==============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS=20
OUT_DIR=""
STOP_ON_FAIL=0
VITEST_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) RUNS="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    --stop-on-fail) STOP_ON_FAIL=1; shift ;;
    --) shift; VITEST_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "-n needs a positive whole number, not '$RUNS'" >&2
  exit 2
fi
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hawa-suite-stability-XXXXXX")"
fi
mkdir -p "$OUT_DIR"
export HAWA_TEST_WORKERS="${HAWA_TEST_WORKERS:-2}"

cd "$ROOT_DIR"
echo "Suite stability: $RUNS run(s), HAWA_TEST_WORKERS=$HAWA_TEST_WORKERS, commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (uncommitted changes)')"
echo "Logs and reports: $OUT_DIR"

# Reads one run's JSON report and log and prints one line per failure: "<kind>\t<name>\t<first error line>".
# Kinds: test (a failed test), file (a file that failed outside its tests: an import, a hook),
# error (an error vitest reported outside any test, which fails the run although every test passed).
read -r -d '' FAILURES_JS <<'JS'
const fs = require('node:fs');
const [reportPath, logPath] = process.argv.slice(1);
const out = [];
const firstLine = (text) => String(text || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find((l) => l) || '(no message)';
let report = null;
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* no report: the run died before writing it */ }
if (report) {
  for (const file of report.testResults || []) {
    const rel = String(file.name || '').replace(process.cwd() + '/', '');
    const failed = (file.assertionResults || []).filter((a) => a.status === 'failed');
    for (const a of failed) out.push(['test', `${rel} > ${a.fullName || a.title}`, firstLine((a.failureMessages || [])[0])]);
    if (file.status === 'failed' && failed.length === 0) out.push(['file', rel, firstLine(file.message)]);
  }
}
let log = '';
try { log = fs.readFileSync(logPath, 'utf8').replace(/\u001b\[[0-9;]*m/g, ''); } catch { /* no log */ }
// Errors outside tests are printed after an "Unhandled Errors" rule, each under a rule of its own
// ("Unhandled Rejection", "Unhandled Error"), before the run's counts.
const start = log.search(/⎯+ Unhandled Errors? ⎯+/);
if (start >= 0) {
  const end = log.indexOf('\n Test Files ', start);
  const section = log.slice(start, end >= 0 ? end : undefined);
  const blocks = section.split(/^⎯{3,}.*$/m).map((b) => b.split('\n').map((l) => l.trim()).filter((l) => l && !/^Vitest caught|^This might cause false positive/.test(l)));
  for (const lines of blocks) {
    if (!lines.length) continue;
    const origin = lines.find((l) => /^This error originated in|^The latest test that might've caused/.test(l)) || '';
    const where = /"([^"]+)"/.exec(origin)?.[1] || '(outside any file)';
    out.push(['error', where, lines[0]]);
  }
}
if (!report && !out.length) out.push(['error', '(the run)', 'no JSON report was written: vitest did not finish']);
for (const row of out) console.log(row.map((c) => String(c).replace(/\t/g, ' ')).join('\t'));
JS

ALL_FAILURES="$OUT_DIR/failures.tsv"
: > "$ALL_FAILURES"
green=0
streak=0
best_streak=0
for ((i = 1; i <= RUNS; i++)); do
  log="$OUT_DIR/run-$i.log"
  report="$OUT_DIR/run-$i.json"
  load="$(uptime | sed 's/.*load averages*: //')"
  started=$(date +%s)
  npx vitest run --reporter=default --reporter=json --outputFile.json="$report" ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"} > "$log" 2>&1
  status=$?
  seconds=$(( $(date +%s) - started ))
  failures="$(node -e "$FAILURES_JS" "$report" "$log")"
  counts="$(grep -E '^ +(Test Files|Tests) ' "$log" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/^ *//' | tr -s ' ' | paste -sd ';' -)"
  if [[ $status -eq 0 && -z "$failures" ]]; then
    green=$((green + 1))
    streak=$((streak + 1))
    (( streak > best_streak )) && best_streak=$streak
    echo "run $i/$RUNS: PASS in ${seconds}s (load $load) $counts"
  else
    streak=0
    echo "run $i/$RUNS: FAIL in ${seconds}s (load $load, exit $status) $counts"
    if [[ -n "$failures" ]]; then
      while IFS=$'\t' read -r kind name message; do
        echo "    $kind: $name"
        echo "      $message"
        printf '%s\t%s\t%s\t%s\n' "$i" "$kind" "$name" "$message" >> "$ALL_FAILURES"
      done <<< "$failures"
    else
      echo "    vitest exited $status with no failure it reported; see $log"
      printf '%s\t%s\t%s\t%s\n' "$i" "error" "(the run)" "exit $status with no reported failure" >> "$ALL_FAILURES"
    fi
    if [[ $STOP_ON_FAIL -eq 1 ]]; then
      RUNS=$i
      break
    fi
  fi
done

echo
echo "Summary: $green of $RUNS run(s) green; longest green streak $best_streak."
if [[ -s "$ALL_FAILURES" ]]; then
  echo "Every failure, with the runs it happened in and its first error:"
  # One entry per failing test: the runs, then the first message seen.
  awk -F'\t' '{ key = $2 "\t" $3; runs[key] = (key in runs) ? runs[key] "," $1 : $1; if (!(key in msg)) msg[key] = $4 }
    END { for (k in runs) { split(k, p, "\t"); n = split(runs[k], r, ","); printf "  %s: %s\n    failed in %d run(s): %s\n    %s\n", p[1], p[2], n, runs[k], msg[k] } }' "$ALL_FAILURES"
fi
[[ $green -eq $RUNS ]]
