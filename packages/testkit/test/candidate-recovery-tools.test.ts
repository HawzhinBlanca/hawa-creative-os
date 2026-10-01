import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('coordinated restore refuses unsafe evidence and binds private cleanup to its own recovery', () => {
  const result=spawnSync('python3',['-m','unittest','discover','-s','infra/backup','-p','test_candidate_recovery.py','-v'],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',timeout:20000,
  });
  expect(result.status,result.stderr || String(result.error || '')).toBe(0);
});
