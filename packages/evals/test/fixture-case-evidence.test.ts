import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext, StructuredModelRequest } from '@hawa/contracts';
import { FakeModelGateway } from '@hawa/testkit';
import { EvaluationRunner } from '../src/runner.js';
import { readFixtureDataset, fixtureDatasetCatalog } from '../src/datasets.js';

class MissingVisualScores extends FakeModelGateway {
  async generateStructured<T>(ctx: RequestContext, request: StructuredModelRequest) {
    const result = await super.generateStructured<T>(ctx, request);
    if (result.ok && request.role === 'visual_judge') result.value.value = {decision:'approved',passed:true} as T;
    return result;
  }
}

describe('saved fixture evidence identifies the cases actually checked', () => {
  it('binds routing and retrieval outcomes to exact corpus bytes and reconciles every suite count', async () => {
    const report = await new EvaluationRunner().runFullTournament();
    for (const [suite,file] of [[report.routing,'evals/routing_brief.jsonl'],[report.retrieval,'evals/retrieval_eval.jsonl']] as const) {
      const content = readFileSync(file,'utf8');
      expect(suite.source).toEqual({file,sha256:createHash('sha256').update(content).digest('hex')});
      expect(suite.caseResults?.map(result=>result.caseId)).toEqual(content.trim().split('\n').map(line=>JSON.parse(line).id));
    }
    for (const suite of [report.routing,report.retrieval,report.copyGuard,report.visualJudge,report.adversarialSafety]) {
      expect(suite.caseResults).toHaveLength(suite.totalCases);
      expect(suite.caseResults?.filter(result=>result.status==='passed')).toHaveLength(suite.passedCases);
      expect(suite.caseResults?.filter(result=>result.status==='failed')).toHaveLength(suite.failedCases);
      expect(suite.admissionEligible).toBe(false);
      expect(suite.source?.file).not.toBe('evals/rtl_golden_cases.jsonl');
    }
  });
  it('never supplies missing visual scores from a generic passed boolean',async()=>{
    const report=await new EvaluationRunner(new MissingVisualScores()).runFullTournament();
    expect(report.visualJudge).toMatchObject({passedCases:7,failedCases:0,unreportedCases:3,passRate:null});
    expect(report.visualJudge.caseResults?.filter(result=>result.status==='unreported').map(result=>result.caseId))
      .toEqual(['brief_fulfillment','brand_fit','originality']);
    expect(report.overallPassRate).toBeNull();expect(report.admissionEligible).toBe(false);
  });
  it('does not describe unavailable judge evidence as ten measured rubric failures',async()=>{
    const gateway=new FakeModelGateway();gateway.setFailure('MODEL_SCHEMA_INVALID');
    const report=await new EvaluationRunner(gateway).runVisualJudgeEvaluation();
    expect(report).toMatchObject({passedCases:0,failedCases:0,unreportedCases:10,passRate:null,criticalViolations:1});
    expect(report.caseResults?.every(result=>result.status==='unreported')).toBe(true);
  });
  it('records the attempted failure and every unexecuted case without another model call',async()=>{
    const gateway=new FakeModelGateway();gateway.setFailure('MODEL_SCHEMA_INVALID');const call=vi.spyOn(gateway,'generateStructured');
    const report=await new EvaluationRunner(gateway).runFullTournament();
    expect(call).toHaveBeenCalledTimes(1);
    expect(report.routing.caseResults?.[0].status).toBe('failed');
    expect(report.routing.caseResults?.slice(1).every(result=>result.status==='not_executed')).toBe(true);
    expect(report.visualJudge.caseResults?.every(result=>result.status==='not_executed')).toBe(true);
    expect(report.routing.passRate).toBeNull();expect(report.overallPassRate).toBeNull();
  });
  it('counts the actual allowlisted corpus and refuses unknown dataset IDs',()=>{
    for(const dataset of fixtureDatasetCatalog()) {
      const loaded=readFixtureDataset(dataset.id)!;
      expect(dataset).toMatchObject({status:'available',casesCount:loaded.cases.length,source:loaded.source});
    }
    expect(readFixtureDataset('unknown')).toBeNull();expect(readFixtureDataset('../../private')).toBeNull();
  });
});
