import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';

/**
 * Hunt-3: Settings' "Delete Webhook" clears a webhook set outside Hawa so the worker's poller can
 * read Telegram again. It asked Telegram to drop every pending update (the requesters' unread
 * messages the poller is about to read), on one click with no confirmation.
 */
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/screens/SettingsScreen.tsx'), 'utf8');
const FILE = ts.createSourceFile('SettingsScreen.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function lift<T>(name: string, closure: Record<string, unknown>): T {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) { found = node.initializer; return; }
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  if (!found) throw new Error(`SettingsScreen.tsx has no const ${name}`);
  const js = ts.transpileModule(`const __lifted = ${found.getText(FILE)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  const keys = Object.keys(closure);
  return new Function(...keys, `${js}\nreturn __lifted;`)(...keys.map((k) => closure[k])) as T;
}

describe('deleting the Telegram webhook (hunt-3)', () => {
  it('keeps the pending updates for the worker to read', async () => {
    setAuthToken(['hawa', 'sess', 'test'].join('_'));
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await apiClient.telegram.deleteWebhook();
    expect(fetcher.mock.calls[0][0]).toBe('/v1/adapters/telegram/webhook/delete');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ dropPendingUpdates: false });
  });

  it('asks before deleting, and a "no" sends nothing', async () => {
    const deleteWebhook = vi.fn().mockResolvedValue({ ok: true });
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('window', { confirm });
    const handler = lift<() => Promise<void>>('handleDeleteWebhook', {
      apiClient: { telegram: { deleteWebhook } }, setRegisteringWebhook: vi.fn(), setRegisterWebhookResult: vi.fn(),
      fetchTelegramStatus: vi.fn(), reasonOf: String,
    });
    await handler();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteWebhook).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await handler();
    expect(deleteWebhook).toHaveBeenCalledTimes(1);
  });
});
