import {expect,it} from 'vitest';
import {parseSpendingPolicyChange,spendingPolicyChanges} from '../src/spending-policy.js';
const base={expectedVersion:1,expectedLimitsSha256:'a'.repeat(64),reason:'Review office limits',limits:{officeUsd:30,clientUsd:20,roleUsd:10,clients:{},roles:{}}};
it('accepts zero and exact micro-dollars, trims the reason and canonicalizes override order',()=>{
  expect(parseSpendingPolicyChange({...base,reason:'  Reviewed  ',limits:{...base.limits,officeUsd:0,roleUsd:.000001,roles:{visual_judge:.3,creative_director:1}}}))
    .toMatchObject({reason:'Reviewed',limits:{officeUsd:0,roleUsd:.000001,roles:{creative_director:1,visual_judge:.3}}});
});
it('rejects malformed, coercible, unbounded and fractional-micro-dollar policies',()=>{
  for(const n of [NaN,Infinity,-1,1000000.000001,.0000001,'2',null])
    expect(parseSpendingPolicyChange({...base,limits:{...base.limits,officeUsd:n}})).toBeNull();
  for(const body of [{...base,extra:true},{...base,expectedVersion:1.5},{...base,reason:' '},{...base,expectedLimitsSha256:'bad'},
    {...base,limits:{...base.limits,roles:{invented:2}}},{...base,limits:{...base.limits,clients:{unknown:2}}},
    {...base,limits:{...base.limits,clients:Array(2)}},{...base,limits:{...base.limits,extra:2}}]) expect(parseSpendingPolicyChange(body)).toBeNull();
});
it('shows explicit override removal as inheritance from the proposed default',()=>{
  const before={...base.limits,roles:{visual_judge:2}},after={...base.limits,roleUsd:7};
  expect(spendingPolicyChanges(before,after)).toEqual([{scope:'Default role daily limit',before:'$10.000000',after:'$7.000000'},
    {scope:'Role: visual_judge',before:'$2.000000',after:'Default $7.000000'}]);
});
