import {expect,it} from 'vitest';
import {projectFixtureScore,fixtureEvaluationIdentity} from '../src/fixture-replay.js';
const labels={clients:new Set(['KAAE']),projects:new Set(['QA'])};
it('retains scoring fields and canonical corpus labels without arbitrary provider text',()=>{
  expect(projectFixtureScore({decision:'route_matched',confidence:0.9,clientId:'client-kaae',project:'QA',explanation:'PRIVATE RESPONSE'},'intake_router',labels))
    .toEqual({decision:'route_matched',confidence:0.9,clientId:'KAAE',projectId:'QA'});
  const wrong=projectFixtureScore({decision:'PRIVATE',clientId:'Unknown Name',projectId:'QA|OTHER',confidence:'PRIVATE'},'intake_router',labels);
  expect(JSON.stringify(wrong)).not.toMatch(/PRIVATE|Unknown Name|OTHER/);expect(wrong.decision).toBe('__invalid__');
});
it('retains only the numeric visual rubric fields used by scoring',()=>{
  expect(projectFixtureScore({decision:'APPROVED',confidence:0.8,passed:true,overallScore:8,rubricScores:{brandResemblance:7,artifacts:1,comment:'PRIVATE'},description:'PRIVATE'},'visual_judge',labels))
    .toEqual({decision:'approved',confidence:0.8,passed:true,overallScore:8,rubricScores:{brandResemblance:7,artifacts:1}});
});
it('binds replay to the corpus and source seal',()=>{expect(fixtureEvaluationIdentity().hash).toMatch(/^[0-9a-f]{64}$/);expect(fixtureEvaluationIdentity().clients.size).toBeGreaterThan(0);});
