import fs from 'node:fs';
import path from 'node:path';
import type { StudioEvalReport } from './types.js';

export function generateMarkdownReport(report: StudioEvalReport): string {
  const lines: string[] = [];

  lines.push(`# Design Studio v2 Evaluation Report (${report.mode.toUpperCase()})`);
  lines.push(`\nGenerated at: ${report.timestamp}`);
  lines.push(`\n## 1. Executive Summary`);
  lines.push('');
  lines.push('| Metric | Value | Target | Status |');
  lines.push('|---|---|---|---|');
  lines.push(`| Qualification Completion | ${report.completedBriefs + report.degradedBriefs}/${report.totalBriefs} | 24/24 | ${report.completedBriefs + report.degradedBriefs === report.totalBriefs ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Hard QA Escapes | ${report.hardQaEscapeCount} | 0 | ${report.hardQaEscapeCount === 0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Canary Pass Rate | ${(report.canaryPassRate * 100).toFixed(1)}% (${Math.round(report.canaryPassRate * report.totalBriefs)}/${report.totalBriefs}) | ≥ 95.8% (≥23/24) | ${report.canaryPassRate >= 23 / 24 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Tournament Swap Consistency | ${(report.tournamentSwapConsistencyRate * 100).toFixed(1)}% | ≥ 80.0% | ${report.tournamentSwapConsistencyRate >= 0.8 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Mean Winner Score | ${report.meanWinnerScore.toFixed(2)}/10 | ≥ 8.0/10 | ${report.meanWinnerScore >= 8.0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Minimum Winner Score | ${report.minWinnerScore.toFixed(2)}/10 | ≥ 7.0/10 | ${report.minWinnerScore >= 7.0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Canva Parity (Match or Minor) | ${report.parityVerdicts.match + report.parityVerdicts.minor}/${report.totalBriefs} | ≥ 22/24 | ${report.parityVerdicts.match + report.parityVerdicts.minor >= 22 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Total Spend | $${report.totalSpentUsd.toFixed(2)} | — | — |`);
  lines.push(`| Mean Cost per Run | $${report.meanSpentUsd.toFixed(2)} | ≤ $5.00 | ${report.meanSpentUsd <= 5.0 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| Mean Duration per Run | ${report.meanDurationSeconds.toFixed(1)}s | ≤ 360s | ${report.meanDurationSeconds <= 360 ? 'PASS' : 'FAIL'} |`);

  lines.push('\n## 2. Per-Brief Qualification Results');
  lines.push('');
  lines.push('| ID | Brief Name | Lang | Format | Status | Calls | Cost | Dur | Score | Canary | Parity | Canva ID |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const r of report.results) {
    const canva = r.canvaDesignId ? `\`${r.canvaDesignId}\`` : '—';
    const parity = r.parity?.parity || '—';
    const canary = r.canary.verdict === 'RELIABLE' ? 'PASS' : 'FAIL';
    lines.push(
      `| \`${r.briefId}\` | ${r.briefName} | ${r.language.toUpperCase()} | ${r.dimensions} | \`${r.status}\` | ${r.callsCount} | $${r.spentUsd.toFixed(2)} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.winnerScore.toFixed(1)} | ${canary} | \`${parity}\` | ${canva} |`
    );
  }

  lines.push('\n## 3. Rungs and Degradation Summary');
  lines.push('');
  const rungsMap: Record<string, number> = {};
  for (const r of report.results) {
    for (const rung of r.rungsTriggered) {
      rungsMap[rung] = (rungsMap[rung] || 0) + 1;
    }
  }

  if (Object.keys(rungsMap).length === 0) {
    lines.push('Zero degradation rungs triggered; all runs completed on the primary premium pipeline.');
  } else {
    for (const [rung, count] of Object.entries(rungsMap)) {
      lines.push(`- **${rung}**: ${count} runs`);
    }
  }

  return lines.join('\n');
}

export function saveReport(
  report: StudioEvalReport,
  outputDir: string
): { jsonPath: string; mdPath: string } {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'report.json');
  const mdPath = path.join(outputDir, 'report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, generateMarkdownReport(report), 'utf8');

  return { jsonPath, mdPath };
}
