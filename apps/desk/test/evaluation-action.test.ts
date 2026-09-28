// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {pendingEvaluation,retainEvaluation,clearEvaluation} from '../src/services/evaluation-action.js';
afterEach(()=>sessionStorage.clear());
it('retains the same action through refresh and only clears a matching completed action',()=>{
  const action={actionId:'12345678-1234-4234-8234-123456789abc',name:'Fixture evaluation'};
  retainEvaluation(action);expect(pendingEvaluation()).toEqual(action);
  clearEvaluation('another-action');expect(pendingEvaluation()).toEqual(action);
  clearEvaluation(action.actionId);expect(pendingEvaluation()).toBeNull();
});
