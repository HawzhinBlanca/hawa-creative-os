import { assert, describe, it, expect, beforeEach } from 'vitest';
import {
  RetrievalService,
  VaultSearchEngine,
  sanitizeUntrustedUpload,
} from '@hawa/retrieval';
import {
  kaaeClientDNA,
  drusteeClientDNA,
  asterClientDNA,
  validateClientDna,
  type ClientDNA,
} from '@hawa/domain';
import crypto from 'node:crypto';

function metadataOf(item: Record<string, unknown>): Record<string, unknown> {
  const value = item.metadata;
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('CV-09: Preserve Original Client Knowledge, Assets & Retrieval Boundaries', () => {
  let retrievalService: RetrievalService;
  let searchEngine: VaultSearchEngine;

  beforeEach(() => {
    retrievalService = new RetrievalService();
    searchEngine = new VaultSearchEngine();

    // Index all three authentic clients
    retrievalService.indexClientDna(kaaeClientDNA);
    retrievalService.indexClientDna(drusteeClientDNA);
    retrievalService.indexClientDna(asterClientDNA);

    // Populate search engine for universal search
    for (const dna of [kaaeClientDNA, drusteeClientDNA, asterClientDNA]) {
      searchEngine.indexItem({
        id: `client_${dna.code}`,
        category: 'clients',
        clientId: dna.clientId,
        title: dna.name,
        bodyText: `${dna.name} ${dna.guidelines.voiceAndTone} ${dna.guidelines.requiredDisclaimers.join(' ')}`,
        updatedAt: dna.updatedAt,
      });

      for (const asset of dna.assets) {
        searchEngine.indexItem({
          id: asset.assetId,
          category: 'assets',
          clientId: dna.clientId,
          title: asset.name,
          bodyText: `${asset.name} ${asset.role} ${asset.storageKey} sha256:${asset.sha256}`,
          updatedAt: dna.updatedAt,
        });
      }

      for (const [idx, rule] of dna.guidelines.layoutRules.entries()) {
        searchEngine.indexItem({
          id: `rule_${dna.code}_${idx}`,
          category: 'rules',
          clientId: dna.clientId,
          title: `${dna.code} Layout Rule ${idx + 1}`,
          bodyText: rule,
          updatedAt: dna.updatedAt,
        });
      }
    }
  });

  it('1. Three-client retrieval isolation: strictly prevents cross-client retrieval and brand bleed', async () => {
    const kaaeCtx = {
      correlationId: 'req_retrieval_kaae',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: kaaeClientDNA.tenantId,
      clientId: kaaeClientDNA.clientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    const drusteeCtx = {
      correlationId: 'req_retrieval_drustee',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: drusteeClientDNA.tenantId,
      clientId: drusteeClientDNA.clientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    const asterCtx = {
      correlationId: 'req_retrieval_aster',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: asterClientDNA.tenantId,
      clientId: asterClientDNA.clientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // A. KAAE Retrieval: only returns KAAE items
    const kaaeResult = await retrievalService.retrieve(kaaeCtx, [
      { kinds: ['official_asset', 'rule'], query: 'accreditation logo standards', topK: 10 },
    ]);
    expect(kaaeResult.ok).toBe(true); assert(kaaeResult.ok);
    if (kaaeResult.ok) {
      const pack = kaaeResult.value;
      expect(pack.clientId).toBe(kaaeClientDNA.clientId);
      // All authoritative assets and rules must belong exclusively to KAAE
      for (const item of pack.evidence) {
        expect(item.clientId).toBe(kaaeClientDNA.clientId);
      }
      expect(pack.authoritative.assets.length).toBeGreaterThan(0);
      expect(pack.authoritative.rules.some((r) => typeof r.text === 'string' && r.text.includes('Law No. 6 of 2022'))).toBe(true);
    }

    // B. Negative Control: Querying Drustee botanical keywords while scoped to KAAE returns 0 Drustee items
    const kaaeBleedTest = await retrievalService.retrieve(kaaeCtx, [
      { kinds: ['official_asset', 'rule'], query: 'botanical vitamin supplement herbal', topK: 10 },
    ]);
    expect(kaaeBleedTest.ok).toBe(true); assert(kaaeBleedTest.ok);
    if (kaaeBleedTest.ok) {
      for (const item of kaaeBleedTest.value.evidence) {
        expect(item.clientId).toBe(kaaeClientDNA.clientId);
        expect(item.title).not.toContain('Drustee');
      }
    }

    // C. Negative Control: Querying KAAE keywords while scoped to Aster returns 0 KAAE items
    const asterBleedTest = await retrievalService.retrieve(asterCtx, [
      { kinds: ['official_asset', 'rule'], query: 'accreditation university parliamentary law', topK: 10 },
    ]);
    expect(asterBleedTest.ok).toBe(true); assert(asterBleedTest.ok);
    if (asterBleedTest.ok) {
      for (const item of asterBleedTest.value.evidence) {
        expect(item.clientId).toBe(asterClientDNA.clientId);
        expect(item.title).not.toContain('KAAE');
      }
    }

    // D. VaultSearchEngine Client Isolation check
    const searchResKaae = searchEngine.search({
      q: 'botanical',
      clientId: kaaeClientDNA.clientId,
    });
    expect(searchResKaae.hits.length).toBe(0); // KAAE has no botanical items

    const searchResDrustee = searchEngine.search({
      q: 'botanical',
      clientId: drusteeClientDNA.clientId,
    });
    expect(searchResDrustee.hits.length).toBeGreaterThan(0); // Drustee has botanical items
    for (const hit of searchResDrustee.hits) {
      expect(hit.item.clientId).toBe(drusteeClientDNA.clientId);
    }
  });

  it('2. Canva mapping validation: requires verified team ID and brand kit ID, rejects naked kit names', () => {
    // Valid KAAE DNA
    const validKaae = validateClientDna(kaaeClientDNA);
    expect(validKaae.ok).toBe(true); assert(validKaae.ok);
    expect(kaaeClientDNA.canvaMapping?.canvaTeamId).toBe('team_kaae_erbil');
    expect(kaaeClientDNA.canvaMapping?.canvaBrandKitId).toBe('kit_kaae_2026');

    // Valid Drustee DNA
    const validDrustee = validateClientDna(drusteeClientDNA);
    expect(validDrustee.ok).toBe(true); assert(validDrustee.ok);
    expect(drusteeClientDNA.canvaMapping?.canvaTeamId).toBe('team_drustee_erbil');

    // Valid Aster DNA
    const validAster = validateClientDna(asterClientDNA);
    expect(validAster.ok).toBe(true); assert(validAster.ok);
    expect(asterClientDNA.canvaMapping?.canvaTeamId).toBe('team_aster_erbil');

    // Negative test: Naked kit name without Team ID is rejected
    const invalidDna: ClientDNA = {
      ...kaaeClientDNA,
      canvaMapping: {
        canvaTeamId: '', // Missing team ID
        canvaBrandKitId: 'kit_name_only',
        canvaTemplateIds: {},
      },
    };
    const invalidResult = validateClientDna(invalidDna);
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.error.code).toBe('INVALID_CANVA_TEAM_MAPPING');
      expect(invalidResult.error.message).toContain('kit names alone are insufficient');
    }

    // Negative test: Missing Brand Kit ID is rejected
    const missingKitDna: ClientDNA = {
      ...kaaeClientDNA,
      canvaMapping: {
        canvaTeamId: 'team_valid_123',
        canvaBrandKitId: '   ', // Whitespace / empty
        canvaTemplateIds: {},
      },
    };
    const missingKitResult = validateClientDna(missingKitDna);
    expect(missingKitResult.ok).toBe(false);
    if (!missingKitResult.ok) {
      expect(missingKitResult.error.code).toBe('INVALID_CANVA_BRAND_KIT_MAPPING');
      expect(missingKitResult.error.message).toContain('kit names alone are insufficient');
    }
  });

  it('3. Missing guideline/asset defense: causes a visible block or clarification, never invented branding', async () => {
    // Create an empty client with no assets in retrieval
    const emptyClientId = 'c1000000-0000-4000-8000-000000000099';
    const ctx = {
      correlationId: 'req_missing_asset',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: kaaeClientDNA.tenantId,
      clientId: emptyClientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    const result = await retrievalService.retrieve(ctx, [
      { kinds: ['official_asset'], query: 'primary logo', topK: 10 },
    ]);

    expect(result.ok).toBe(true); assert(result.ok);
    if (result.ok) {
      const pack = result.value;
      expect(pack.authoritative.assets.length).toBe(0);
      expect(pack.unresolvedConflicts.length).toBeGreaterThan(0);
      const conflict = pack.unresolvedConflicts[0];
      expect(conflict.conflictType).toBe('MISSING_BRAND_ASSET');
      expect(conflict.type).toBe(conflict.conflictType);
      expect(conflict.sourceIds).toEqual([]);
      expect(conflict.message).toBe(conflict.description);
      expect(conflict.severity).toBe('BLOCKING');
      expect(conflict.description).toContain('Cannot invent substitute branding');
      expect(conflict.safeAction).toContain('Upload official vector logo/assets');
    }
  });

  it('4. Conflicting guideline & prohibited lexicon defense: detects prohibited claims and blocks generation', async () => {
    const drusteeCtx = {
      correlationId: 'req_drustee_conflict',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: drusteeClientDNA.tenantId,
      clientId: drusteeClientDNA.clientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // Query containing a prohibited phrase for Drustee ("Magic cure")
    const result = await retrievalService.retrieve(drusteeCtx, [
      { kinds: ['rule'], query: 'Post announcing magic cure for seasonal fatigue', topK: 10 },
    ]);

    expect(result.ok).toBe(true); assert(result.ok);
    if (result.ok) {
      const pack = result.value;
      expect(pack.unresolvedConflicts.length).toBeGreaterThan(0);
      const violation = pack.unresolvedConflicts.find(
        (c) => c.conflictType === 'PROHIBITED_LEXICON_VIOLATION'
      );
      expect(violation).toBeDefined();
      expect(violation?.severity).toBe('BLOCKING');
      expect(violation?.description).toContain('Magic cure');
      expect(violation?.safeAction).toContain('Remove prohibited phrase');
      expect(violation?.sourceIds).toHaveLength(1);
      expect(violation?.type).toBe(violation?.conflictType);
      expect(violation?.message).toBe(violation?.description);
    }
  });

  it('5. Untrusted upload sanitization: neutralizes active SVG scripts while preserving clean vectors', () => {
    // Malicious SVG upload containing <script> and onload handler
    const maliciousSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
        <script>alert("XSS Attack!");</script>
        <rect width="200" height="200" fill="#4770A3" onload="stealCookies()" />
        <path d="M 10 10 H 90 V 90 H 10 L 10 10" fill="#F7B500" />
      </svg>
    `;

    const sanitized = sanitizeUntrustedUpload({
      filename: 'malicious_logo.svg',
      mimeType: 'image/svg+xml',
      content: maliciousSvg,
    });

    expect(sanitized.ok).toBe(true); assert(sanitized.ok);
    if (sanitized.ok) {
      const output = sanitized.value;
      const cleanText = output.sanitizedContent.toString('utf8');

      // Scripts and onload must be stripped
      expect(cleanText).not.toContain('<script>');
      expect(cleanText).not.toContain('alert');
      expect(cleanText).not.toContain('onload');

      // Genuine vector path must be preserved
      expect(cleanText).toContain('M 10 10 H 90');
      expect(output.warnings.length).toBeGreaterThan(0);
      expect(output.sha256).toBe(
        crypto.createHash('sha256').update(output.sanitizedContent).digest('hex')
      );
    }

    // Negative test: Unsupported executable file upload rejected
    const exeUpload = sanitizeUntrustedUpload({
      filename: 'exploit.exe',
      mimeType: 'application/x-msdownload',
      content: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    });
    expect(exeUpload.ok).toBe(false);
    if (!exeUpload.ok) {
      expect(exeUpload.error.code).toBe('UNSUPPORTED_MIME_TYPE');
    }
  });

  it('6. Ground-truth KAAE reference retrieval before generation', async () => {
    const kaaeCtx = {
      correlationId: 'req_kaae_pre_gen',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: kaaeClientDNA.tenantId,
      clientId: kaaeClientDNA.clientId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    const res = await retrievalService.retrieve(kaaeCtx, [
      { kinds: ['official_asset', 'rule'], query: 'official emblem logo law 2022', topK: 10 },
    ]);

    expect(res.ok).toBe(true); assert(res.ok);
    if (res.ok) {
      const pack = res.value;
      // Must contain verified primary logo with authentic ground-truth hash
      const primaryLogo = pack.authoritative.assets.find(
        (a) => metadataOf(a).role === 'logo_primary'
      );
      expect(primaryLogo).toBeDefined();
      assert(primaryLogo);
      expect([
        '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc',
        'accadd24fd04d26d8e700ef2fb07ce50f128beb2924562d7cc4a5b02e4670be7',
      ]).toContain(metadataOf(primaryLogo).sha256);

      // Must retrieve Law No. 6 of 2022 disclaimer
      const disclaimer = pack.authoritative.rules.find((r) =>
        typeof r.text === 'string' && r.text.includes('Law No. 6 of 2022')
      );
      expect(disclaimer).toBeDefined();
      expect(disclaimer?.text).toContain('Kurdistan Regional Parliament');
    }
  });
});
