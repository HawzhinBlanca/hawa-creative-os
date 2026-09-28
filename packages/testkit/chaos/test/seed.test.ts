/**
 * The seeded run's credential fence (driver/seed.ts, ADR-137): which restored columns count as
 * credentials that must be empty before any application container starts, and how the compose file
 * keeps Core and the workers off the internet. No Docker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_COLUMN } from '../driver/seed.ts';
import { CHAOS_DIR } from '../driver/stack.ts';

describe('seeded chaos runs: the fence around restored production data', () => {
  it('treats every stored credential column of the schema as one', () => {
    for (const column of ['encrypted_tokens', 'encrypted_verifier', 'token_hash', 'config_encrypted', 'refresh_token', 'client_secret', 'api_key', 'password_hash']) {
      expect(CREDENTIAL_COLUMN.test(column), column).toBe(true);
    }
  });

  it('leaves client content and ordinary keys alone', () => {
    for (const column of ['raw_payload_encrypted', 'request_key', 'idempotency_key', 'content_hash', 'chat_id', 'design_id']) {
      expect(CREDENTIAL_COLUMN.test(column), column).toBe(false);
    }
  });

  it('keeps Core and the workers on internal networks only, with every provider host an alias of the fakes', () => {
    const compose = readFileSync(join(CHAOS_DIR, 'docker-compose.chaos.yml'), 'utf8');
    expect(compose).toMatch(/\n {2}chaos:\n {4}internal: true/);
    expect(compose).toMatch(/\n {2}parser:\n {4}internal: true/);
    const service = (name: string) => compose.slice(compose.indexOf(`\n  ${name}:\n`), compose.indexOf('\n\n', compose.indexOf(`\n  ${name}:\n`)));
    expect(service('core')).toContain('networks: [chaos, parser]');
    expect(compose).toMatch(/x-worker: &worker[\s\S]*?networks: \[chaos\]/);
    for (const host of ['api.telegram.org', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.canva.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']) {
      expect(service('fakes')).toContain(`- ${host}`);
    }
    // Provider keys in the stack are placeholders or throwaway values from .run/chaos.env.
    expect(compose).toContain('OPENAI_API_KEY: chaos-not-a-real-key');
    expect(compose).toContain('TELEGRAM_BOT_TOKEN: ${CHAOS_BOT_TOKEN:?}');
  });
});
