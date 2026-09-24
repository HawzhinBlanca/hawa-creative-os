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

# Reading a run's report and log, and the summary of all runs, are in scripts/suite_stability_report.mjs
# (tested in scripts/test/suite-stability-report.test.ts). One line per failure: "<kind>\t<name>\t<first error line>".
REPORT_JS="$ROOT_DIR/scripts/suite_stability_report.mjs"

ALL_FAILURES="$OUT_DIR/failures.tsv"
: > "$ALL_FAILURES"
green=0
streak=0
best_streak=0
for ((i = 1; i <= RUNS; i++)); do
  log="$OUT_DIR/run-$i.log"
  report="$OUT_DIR/run-$i.json"
  load="$(uptime | sed 's/.*load averages*: //')"
  # A reused output directory must not lend this run the report of an earlier one, should vitest die before writing its own.
  rm -f "$log" "$report"
  started=$(date +%s)
  npx vitest run --reporter=default --reporter=json --outputFile.json="$report" ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"} > "$log" 2>&1
  status=$?
  seconds=$(( $(date +%s) - started ))
  failures="$(node "$REPORT_JS" failures "$report" "$log")"
  counts="$(grep -E '^ +(Test Files|Tests) ' "$log" | perl -pe 's/\e\[[0-9;]*m//g; s/^ *//' | tr -s ' ' | paste -sd ';' -)"
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
  node "$REPORT_JS" summary "$ALL_FAILURES"
fi
[[ $green -eq $RUNS ]]
