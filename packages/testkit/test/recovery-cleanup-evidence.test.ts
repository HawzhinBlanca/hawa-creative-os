import { describe, expect, it } from 'vitest';
import { hasOwnedRecoveryCleanup } from '../chaos/driver/recovery-cleanup-evidence.js';

const identity='0123456789abcdef';
const taskId='11111111-1111-4111-a111-111111111111';
const valid=()=>({taskId,recoveryId:identity,privateArtifactsCleanup:{removed:true,scope:'this_recovery'},
  restoredVolumes:{chaos_postgres:{name:`hawa-recovery-${identity}-postgres`},
    chaos_restate:{name:`hawa-recovery-${identity}-restate`},chaos_blobs:{name:`hawa-recovery-${identity}-blobs`}}});

describe('restore-owned private cleanup evidence',()=>{
  it('requires the exact caller nonce, task and complete restored store set',()=>{
    expect(hasOwnedRecoveryCleanup(valid(),{recoveryId:identity,taskId})).toBe(true);
    expect(hasOwnedRecoveryCleanup(valid(),{recoveryId:'f'.repeat(16),taskId})).toBe(false);
    expect(hasOwnedRecoveryCleanup(valid(),{recoveryId:identity,taskId:'other task'})).toBe(false);
    expect(hasOwnedRecoveryCleanup(valid(),{recoveryId:'../foreign',taskId})).toBe(false);
  });
  it.each<unknown>([null,[],{},
    {...valid(),privateArtifactsCleanup:{removed:false,scope:'this_recovery'}},
    {...valid(),privateArtifactsCleanup:{removed:true,scope:'all_recoveries'}},
    {...valid(),restoredVolumes:{...valid().restoredVolumes,foreign:{name:'foreign'}}},
    {...valid(),restoredVolumes:{chaos_postgres:valid().restoredVolumes.chaos_postgres}},
    {...valid(),restoredVolumes:{...valid().restoredVolumes,chaos_blobs:{name:'foreign'}}},
  ])('refuses absent, unowned or incomplete cleanup evidence %#',receipt=>{
    expect(hasOwnedRecoveryCleanup(receipt,{recoveryId:identity,taskId})).toBe(false);
  });
});
