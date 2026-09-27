import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('the independent Python collector passes durable spool, actual crash and transport controls', () => {
 const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'infra/monitoring', '-p', 'test_*.py', '-v'],
  { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 15000 });
 expect(result.status, result.stderr || String(result.error || '')).toBe(0);
});
