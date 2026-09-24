// Types for suite_stability_report.mjs, a plain script that the typed test imports.
/** One run's failures as rows [kind, name, message], from its JSON report text (null if none) and its log text. */
export function runFailures(reportText: string | null, logText: string, cwd?: string): string[][];
/** The summary of every failure across runs, from "<run>\t<kind>\t<name>\t<message>" rows. */
export function summarise(tsvText: string): string;
