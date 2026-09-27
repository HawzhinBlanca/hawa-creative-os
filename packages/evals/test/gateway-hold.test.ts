import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResilientModelGateway } from '@hawa/integrations';
import { EvaluationRunner } from '../src/runner.js';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('evaluation batches preserve uncertain provider holds',()=>{
  it('stops an unquotable budget before transport without treating unexecuted cases as failures',async()=>{
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));vi.stubEnv('GEMINI_API_KEY','synthetic-eval-key');
    const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Must not dispatch'));
    const report=await new EvaluationRunner(new ResilientModelGateway()).runFullTournament();
    expect(fetcher).not.toHaveBeenCalled();
    expect(report).toMatchObject({executionStatus:'stopped',overallPassRate:null,
      modelCallHold:{code:'MODEL_BUDGET_UNQUOTABLE',detail:{requiresReconciliation:false,estimatedCostUsd:0}},
      routing:{failedCases:1,execution:{attemptedCases:1}},visualJudge:{failedCases:0,execution:{attemptedCases:0}}});
  });
  it.each([500,408,200])('stops after HTTP %s uncertainty without a second routing or visual call',async status=>{
    vi.stubEnv('GEMINI_API_KEY','synthetic-eval-key');
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('PRIVATE_PROVIDER_BODY',{
      status,headers:{'x-request-id':'receipt-for-reconciliation'},
    }));
    const report=await new EvaluationRunner(new ResilientModelGateway()).runFullTournament();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({executionStatus:'stopped',overallPassRate:null,admissionEligible:false,
      modelCallHold:{retryable:false,detail:{provider:'google',attempts:1,providerRequestId:'receipt-for-reconciliation',estimatedCostUsd:null,requiresReconciliation:true}},
      routing:{passedCases:0,failedCases:1,execution:{status:'stopped',attemptedCases:1}},
      visualJudge:{passedCases:0,failedCases:0,execution:{status:'stopped',attemptedCases:0}},
    });
    expect(report.routing.execution?.unexecutedCases).toBe(report.routing.totalCases-1);
    expect(report.visualJudge.execution?.unexecutedCases).toBe(report.visualJudge.totalCases);
    expect(report.routing.execution?.stopReason).toEqual(report.modelCallHold);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PROVIDER_BODY');
  });
});
