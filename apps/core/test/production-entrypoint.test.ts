import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * index.ts is the only production entrypoint and the only thing that can start Telegram polling.
 * Nothing else exercises it: the test suites build their own apps. Commit 36f6958 turned polling
 * into a createApp option and left this file calling createApp() with none, and the next deploy
 * ran for 80 minutes with the bridge idle while both client chats went unanswered.
 */
describe('the production entrypoint', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');

  it('starts Telegram polling', () => {
    expect(source).toMatch(/createApp\(\{[^}]*enableTelegramPolling:\s*true/);
  });
});
