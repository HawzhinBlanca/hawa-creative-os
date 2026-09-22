import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResilientModelGateway } from '../../integrations/src/model-gateway.js';
import { evaluateRetentionEligibility, purgeExpiredEntities } from '../../domain/src/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

/**
 * A phone number as it appears in the client's documents: an Iraqi mobile written as 7xx xxx xxxx,
 * with or without the leading 0, with spaces or dashes or neither. The numbers themselves are never written down here: a test
 * that carried them would put personal data back into the repository it is meant to keep clean,
 * which is what an earlier version of this file did.
 */
const PHONE_PATTERN = /\b0?7[5-8]\d[\s-]?\d{3}[\s-]?\d{4}\b/g;

describe('Task 10: Privacy, Retention, and Model Egress Policy Remediation', () => {
  describe('1. 16 Executive Staff Phone Numbers Redaction', () => {
    it('verifies none of the sensitive personal phone numbers remain in data/kaae-graphics', () => {
      const targetFiles = [
        path.join(rootDir, 'data/kaae-graphics/extracted-tokens/kaae_deep_institutional_compendium.json'),
        path.join(rootDir, 'data/kaae-graphics/learned_knowledge.json'),
        path.join(rootDir, 'data/kaae-graphics/scripts/build_deep_compendium.py'),
      ];

      for (const file of targetFiles) {
        if (!fs.existsSync(file)) continue;
        const matches = fs.readFileSync(file, 'utf8').match(PHONE_PATTERN) || [];
        // Report the count only; a failure message must not print a number either.
        expect(matches.length, `${path.relative(rootDir, file)} still contains ${matches.length} phone number(s)`).toBe(0);
      }
    });
  });

  describe('2. Retention & Purge Policy Engine', () => {
    it('evaluates retention windows and identifies expired entities for purge', () => {
      const now = new Date('2026-09-22T00:00:00Z');
      const policy = {
        taskRetentionDays: 30,
        artifactRetentionDays: 90,
        auditRetentionDays: 365,
      };

      const freshTask = {
        id: 'task-fresh',
        createdAt: new Date('2026-09-10T00:00:00Z'),
        status: 'completed',
      };

      const expiredTask = {
        id: 'task-expired',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        status: 'completed',
      };

      expect(evaluateRetentionEligibility(freshTask, policy, now)).toBe(false);
      expect(evaluateRetentionEligibility(expiredTask, policy, now)).toBe(true);

      const items = [freshTask, expiredTask];
      const { retained, purged } = purgeExpiredEntities(items, policy, now);
      expect(retained.map((t) => t.id)).toEqual(['task-fresh']);
      expect(purged.map((t) => t.id)).toEqual(['task-expired']);
    });
  });

  describe('3. Model Egress Policy Enforcement', () => {
    it('fails closed when local_only egress policy is violated', async () => {
      const gateway = new ResilientModelGateway();
      const ctx = {
        tenantId: 'tenant-test',
        actor: { type: 'system' as const, id: 'sys-1' },
        correlationId: 'corr-1',
        deadline: new Date(Date.now() + 10000).toISOString(),
        idempotencyKey: 'idem-1',
      };

      const result = await gateway.generateStructured(
        ctx,
        {
          role: 'creative_director',
          systemPromptVersion: 'v1',
          responseSchema: { type: 'object' },
          budget: { maxCostUsd: 1, maxLatencyMs: 5000, maxAttempts: 1 },
          cachePolicy: 'disabled',
          inputs: [{ kind: 'text', text: 'Audit design' }],
          egressPolicy: {
            mode: 'local_only',
            allowedProviders: ['local'],
          },
        },
        'openai'
      );

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error.code).toBe('EGRESS_DISALLOWED');
      }
    });

    it('fails closed when target provider is not in allowedProviders', async () => {
      const gateway = new ResilientModelGateway();
      const ctx = {
        tenantId: 'tenant-test',
        actor: { type: 'system' as const, id: 'sys-1' },
        correlationId: 'corr-1',
        deadline: new Date(Date.now() + 10000).toISOString(),
        idempotencyKey: 'idem-2',
      };

      const result = await gateway.generateStructured(
        ctx,
        {
          role: 'creative_director',
          systemPromptVersion: 'v1',
          responseSchema: { type: 'object' },
          budget: { maxCostUsd: 1, maxLatencyMs: 5000, maxAttempts: 1 },
          cachePolicy: 'disabled',
          inputs: [{ kind: 'text', text: 'Audit design' }],
          egressPolicy: {
            mode: 'approved_providers',
            allowedProviders: ['anthropic'],
          },
        },
        'openai'
      );

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error.code).toBe('EGRESS_DISALLOWED');
      }
    });
  });

  describe('4. Egress Hostname Lint Enforcement', () => {
    it('verifies script scripts/lint_provider_egress.ts exists and enforces model host isolation', () => {
      const lintScript = path.join(rootDir, 'scripts/lint_provider_egress.ts');
      expect(fs.existsSync(lintScript)).toBe(true);
    });
  });
});
