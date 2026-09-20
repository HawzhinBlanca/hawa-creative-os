import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  StudioGoldenBrief,
  StudioEvalRunResult,
  StudioEvalReport,
  CanaryResult,
  TournamentResult,
  ParityResult,
} from './types.js';

export interface LiveRunnerConfig {
  baseUrl?: string;
  bearerToken?: string;
  tier?: 'standard' | 'premium';
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export class LiveRunner {
  private baseUrl: string;
  private token: string;
  private tier: 'standard' | 'premium';
  private pollIntervalMs: number;
  private maxPollAttempts: number;

  constructor(config: LiveRunnerConfig = {}) {
    this.baseUrl = config.baseUrl || process.env.HAWA_API_URL || 'http://127.0.0.1:8080';
    this.tier = config.tier || 'premium';
    this.pollIntervalMs = config.pollIntervalMs || 4000;
    this.maxPollAttempts = config.maxPollAttempts || 150;

    let tok = config.bearerToken || process.env.HAWA_BEARER_TOKEN;
    if (!tok) {
      const envPath = path.resolve('infra/docker/.env.production');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('HAWA_BEARER_TOKEN=')) {
            tok = trimmed.split('=')[1];
            break;
          }
        }
      }
    }
    this.token = tok || '';
  }

  private getHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return headers;
  }

  async runBrief(brief: StudioGoldenBrief): Promise<StudioEvalRunResult> {
    const startTime = Date.now();
    const runKey = `studio-live-${brief.id}-${Date.now()}`;

    // 1. Create task
    const taskPayload = {
      title: brief.name,
      description: brief.rawRequestText,
      clientId: brief.clientId,
      priority: 3,
      copyBlocks: brief.copyBlocks,
      rawRequestText: brief.rawRequestText,
      designInstructions: brief.instructions,
    };

    const taskRes = await fetch(`${this.baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: this.getHeaders(`task-${brief.id}-${Date.now()}`),
      body: JSON.stringify(taskPayload),
    });

    if (!taskRes.ok) {
      const err = await taskRes.text();
      throw new Error(`Failed to create task for ${brief.id}: ${taskRes.status} ${err}`);
    }

    const taskData = (await taskRes.json()) as any;
    const taskId = taskData.id || taskData.taskId;

    // 2. Start Studio run
    const studioStartRes = await fetch(`${this.baseUrl}/v1/tasks/${taskId}/canva/studio`, {
      method: 'POST',
      headers: this.getHeaders(runKey),
      body: JSON.stringify({
        width: brief.width,
        height: brief.height,
        tier: this.tier,
      }),
    });

    if (!studioStartRes.ok) {
      const err = await studioStartRes.text();
      throw new Error(`Failed to start studio run for ${brief.id}: ${studioStartRes.status} ${err}`);
    }

    const startData = (await studioStartRes.json()) as any;
    const runId = startData.runId;

    // 3. Poll resume until terminal state
    let runStatus = startData.status;
    let attempts = 0;
    let lastResumeData: any = startData;

    while (
      !['transferred', 'degraded', 'failed'].includes(runStatus) &&
      attempts < this.maxPollAttempts
    ) {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      try {
        // Check current status via GET first in case a stage finished
        const statusRes = await fetch(`${this.baseUrl}/v1/tasks/${taskId}/canva/studio/${runId}`, {
          method: 'GET',
          headers: this.getHeaders(),
        });
        if (statusRes.ok) {
          const statusData = (await statusRes.json()) as any;
          const currentStatus = statusData.run?.status || statusData.status;
          if (['transferred', 'degraded', 'failed'].includes(currentStatus)) {
            runStatus = currentStatus;
            lastResumeData = statusData;
            break;
          }
        }

        const resumeRes = await fetch(
          `${this.baseUrl}/v1/tasks/${taskId}/canva/studio/${runId}/resume`,
          {
            method: 'POST',
            headers: this.getHeaders(`resume-${runId}-${attempts}`),
            body: JSON.stringify({}),
          }
        );

        if (!resumeRes.ok) {
          const err = await resumeRes.text();
          console.warn(`Resume attempt ${attempts} returned ${resumeRes.status}: ${err}`);
          continue;
        }

        lastResumeData = await resumeRes.json();
        runStatus = lastResumeData.status || lastResumeData.run?.status;
      } catch (pollErr: any) {
        console.warn(`Resume attempt ${attempts} poll error: ${pollErr.message || pollErr}`);
      }
    }

    // 4. Query full run evidence
    const fullRes = await fetch(`${this.baseUrl}/v1/tasks/${taskId}/canva/studio/${runId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    const fullRunData = fullRes.ok ? await fullRes.json() : lastResumeData;
    const runObj = fullRunData.run || fullRunData;

    // 5. Fetch preview PNG if winner exists
    let previewSha256 = '';
    const winnerId =
      runObj.winnerCandidateId ||
      fullRunData.winnerCandidateId ||
      lastResumeData.winnerCandidateId ||
      lastResumeData.candidateId;
    if (winnerId) {
      const pngRes = await fetch(
        `${this.baseUrl}/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${winnerId}/preview.png`,
        {
          headers: this.getHeaders(),
        }
      );
      if (pngRes.ok) {
        const arrayBuf = await pngRes.arrayBuffer();
        previewSha256 = createHash('sha256').update(Buffer.from(arrayBuf)).digest('hex');
      }
    }

    const durationMs = Date.now() - startTime;
    const spentUsd =
      runObj.budget?.spentUsd ??
      fullRunData.totalUsdEstimate ??
      fullRunData.budget?.spentUsd ??
      lastResumeData.spentUsd ??
      0;
    const callsCount =
      runObj.budget?.calls ??
      fullRunData.callsCount ??
      fullRunData.budget?.calls ??
      0;

    const winnerCand = fullRunData.candidates?.find((c: any) => c.id === winnerId);
    const winnerScore: number | undefined =
      typeof winnerCand?.score === 'number'
        ? winnerCand.score
        : typeof fullRunData.winnerScore === 'number'
          ? fullRunData.winnerScore
          : undefined;

    const canaryJudgments = (fullRunData.judgments || []).filter((j: any) => j.kind === 'canary');
    let canary: CanaryResult;
    if (canaryJudgments.length > 0) {
      const allCanariesPassed = canaryJudgments.every(
        (j: any) => j.verdict?.passed === true || j.verdict === 'PASS' || (typeof j.verdict?.score === 'number' && j.verdict.score >= 7.0)
      );
      canary = {
        winnerId: winnerId || '',
        passed: allCanariesPassed && runObj.judgeStatus !== 'UNRELIABLE',
        scoreAgainstDegraded1Normal: canaryJudgments[0]?.verdict?.scoreNormal,
        scoreAgainstDegraded1Swapped: canaryJudgments[0]?.verdict?.scoreSwapped,
        scoreAgainstDegraded2Normal: canaryJudgments[1]?.verdict?.scoreNormal,
        scoreAgainstDegraded2Swapped: canaryJudgments[1]?.verdict?.scoreSwapped,
        verdict: runObj.judgeStatus === 'UNRELIABLE' ? 'UNRELIABLE' : (allCanariesPassed ? 'RELIABLE' : 'UNRELIABLE'),
      };
    } else {
      canary = {
        winnerId: winnerId || '',
        passed: false,
        verdict: 'UNMEASURED',
      };
    }

    const tournamentJudgments = (fullRunData.judgments || []).filter((j: any) => j.kind === 'pairwise');
    let tournament: TournamentResult;
    if (tournamentJudgments.length > 0 || fullRunData.tournament) {
      tournament = {
        winnerId: winnerId || '',
        candidateScores: fullRunData.scores || {},
        swapConsistencyRate: fullRunData.tournament?.swapConsistencyRate ?? fullRunData.swapConsistencyRate,
        pairwiseRounds: tournamentJudgments.length || fullRunData.tournament?.pairwiseRounds,
      };
    } else {
      tournament = {
        winnerId: winnerId || '',
        candidateScores: fullRunData.scores || {},
        swapConsistencyRate: undefined,
        pairwiseRounds: 0,
      };
    }

    const parityStage = runObj.stages?.parity || fullRunData.parity;
    let parity: ParityResult | undefined = undefined;
    if (parityStage && (parityStage.parity || parityStage.divergences)) {
      parity = {
        parity: parityStage.parity || 'unmeasured',
        divergences: parityStage.divergences || [],
        fontSubstituted: parityStage.fontSubstituted ?? false,
        textReflowed: parityStage.textReflowed ?? false,
        copyVisibleIdentical: parityStage.copyVisibleIdentical,
      };
    }

    const hardQaEscapes: number | undefined =
      typeof runObj.hardQaEscapes === 'number'
        ? runObj.hardQaEscapes
        : typeof runObj.stages?.hardQa?.escapes === 'number'
          ? runObj.stages.hardQa.escapes
          : typeof fullRunData.hardQaEscapes === 'number'
            ? fullRunData.hardQaEscapes
            : undefined;

    let finalStatus: 'transferred' | 'degraded' | 'failed' | 'incomplete' = 'failed';
    if (runStatus === 'transferred') {
      if (!winnerId || !previewSha256 || winnerScore === undefined) {
        finalStatus = 'incomplete';
      } else {
        finalStatus = 'transferred';
      }
    } else if (runStatus === 'degraded') {
      finalStatus = 'degraded';
    } else {
      finalStatus = 'failed';
    }

    const fontFidelity: 'exact' | 'stand-in' | 'unmeasured' =
      runObj.fontFidelity || fullRunData.fontFidelity || 'unmeasured';

    return {
      briefId: brief.id,
      briefName: brief.name,
      language: brief.language,
      dimensions: `${brief.width}x${brief.height}`,
      status: finalStatus,
      ladderRung: runObj.diagnostic?.ladderRung ?? fullRunData.diagnostic?.ladderRung ?? 0,
      rungsTriggered: runObj.diagnostic?.rungsTriggered ?? fullRunData.diagnostic?.rungsTriggered ?? [],
      callsCount,
      spentUsd,
      durationMs,
      winnerScore,
      canary,
      tournament,
      hardQaEscapes,
      canvaDesignId: runObj.planId || fullRunData.plan?.designId || lastResumeData.designId,
      previewSha256,
      parity,
      fontFidelity,
    };
  }

  async runAll(briefs: StudioGoldenBrief[]): Promise<StudioEvalReport> {
    const results: StudioEvalRunResult[] = [];
    for (const brief of briefs) {
      console.log(`Starting live run for brief: ${brief.id} (${brief.name})`);
      const res = await this.runBrief(brief);
      results.push(res);
      console.log(`Completed ${brief.id}: status=${res.status}, spent=$${res.spentUsd}, calls=${res.callsCount}`);
    }

    const total = results.length;
    const completed = results.filter((r) => r.status === 'transferred').length;
    const degraded = results.filter((r) => r.status === 'degraded').length;
    const failed = results.filter((r) => r.status === 'failed' || r.status === 'incomplete').length;

    const canaryMeasured = results.filter((r) => r.canary.verdict !== 'UNMEASURED');
    const canaryPassed = canaryMeasured.filter((r) => r.canary.passed).length;
    const canaryPassRate = total > 0 ? canaryPassed / total : 0;

    const measuredSwapRates = results
      .map((r) => r.tournament.swapConsistencyRate)
      .filter((rate): rate is number => typeof rate === 'number');
    const tournamentSwapConsistencyRate =
      total > 0
        ? measuredSwapRates.reduce((a, b) => a + b, 0) / total
        : 0;

    const measuredScores = results
      .map((r) => r.winnerScore)
      .filter((s): s is number => typeof s === 'number');
    const meanWinnerScore =
      measuredScores.length > 0
        ? measuredScores.reduce((a, b) => a + b, 0) / measuredScores.length
        : 0;
    const minWinnerScore = measuredScores.length > 0 ? Math.min(...measuredScores) : 0;

    const totalSpent = results.reduce((acc, r) => acc + r.spentUsd, 0);
    const meanSpentUsd = total > 0 ? totalSpent / total : 0;

    const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);
    const meanDurationSeconds = total > 0 ? totalDuration / total / 1000 : 0;

    const hardQaEscapeCount = results.reduce(
      (acc, r) => acc + (typeof r.hardQaEscapes === 'number' ? r.hardQaEscapes : 0),
      0
    );

    const parityVerdicts = {
      match: results.filter((r) => r.parity?.parity === 'match').length,
      minor: results.filter((r) => r.parity?.parity === 'minor').length,
      major: results.filter((r) => r.parity?.parity === 'major').length,
    };

    return {
      timestamp: new Date().toISOString(),
      mode: 'live',
      totalBriefs: total,
      completedBriefs: completed,
      degradedBriefs: degraded,
      failedBriefs: failed,
      canaryPassRate,
      tournamentSwapConsistencyRate,
      meanWinnerScore: Number(meanWinnerScore.toFixed(2)),
      minWinnerScore: Number(minWinnerScore.toFixed(2)),
      hardQaEscapeCount,
      totalSpentUsd: Number(totalSpent.toFixed(4)),
      meanSpentUsd: Number(meanSpentUsd.toFixed(4)),
      meanDurationSeconds: Number(meanDurationSeconds.toFixed(2)),
      parityVerdicts,
      results,
    };
  }
}
