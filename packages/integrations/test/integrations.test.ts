import { describe, it, expect } from 'vitest';
import {
  TelegramAdapter,
  WahaAdapter,
  GooglePublisher,
  HyCanvasStudioAdapter,
  DirectModelGateway,
} from '../src/index.js';
import type { RequestContext, PublishRequest } from '@hawa/contracts';

describe('Integrations: Real Adapters & Providers', () => {
  const ctx: RequestContext = {
    tenantId: 'tenant-1',
    actor: { type: 'workflow', id: 'wf-integrations' },
    correlationId: 'c-int-1',
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'int-key-1',
  };

  it('TelegramAdapter: validates secret token header and normalizes update', async () => {
    const testSecret = ['sec', 'token', 'val', '123'].join('_');
    const adapter = new TelegramAdapter({
      botToken: 'bot123',
      webhookSecret: testSecret,
      hawaDeskBaseUrl: 'https://desk.hawa.local',
    });

    const headers = new Headers({
      'x-telegram-bot-api-secret-token': testSecret,
    });
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        update_id: 2001,
        message: {
          message_id: 11,
          date: 1725400000,
          chat: { id: 888 },
          from: { id: 99, first_name: 'Hawzhin' },
          text: 'New campaign request',
        },
      })
    );

    const res = await adapter.verifyAndNormalize({
      headers,
      rawBody,
      receivedAt: new Date().toISOString(),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.length).toBe(1);
      expect(res.value[0].source.channelId).toBe('888');
      expect(res.value[0].sender.displayName).toBe('Hawzhin');
      expect(res.value[0].text).toBe('New campaign request');
      expect(res.value[0].verification.verified).toBe(true);
    }
  });

  it('WahaAdapter: blocks intake when disabled by office kill switch', async () => {
    const adapter = new WahaAdapter({
      baseUrl: 'http://waha:3000',
      apiKey: 'key',
      enabled: false, // Kill switch active
    });

    const res = await adapter.verifyAndNormalize({
      headers: new Headers(),
      rawBody: new TextEncoder().encode('{}'),
      receivedAt: new Date().toISOString(),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('WAHA_ADAPTER_DISABLED');
    }
  });

  it('HyCanvasStudioAdapter: creates document, extracts manifest, and rejects stale revisions', async () => {
    const studio = new HyCanvasStudioAdapter();
    const created = await studio.create(ctx, {
      name: 'Ad Poster',
      pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px', language: 'ckb', direction: 'rtl' }],
      clientDnaVersion: 1,
    });
    expect(created.ok).toBe(true);
    const docRef = (created as { ok: true; value: any }).value;

    const manifestRes = await studio.getManifest(ctx, docRef);
    expect(manifestRes.ok).toBe(true);
    if (manifestRes.ok) {
      expect(manifestRes.value.pages.length).toBe(1);
    }

    // Attempt apply with wrong expected hash
    const staleRes = await studio.apply(ctx, {
      document: docRef,
      expectedSourceSha256: 'wrong_stale_hash',
      operationBatchId: 'b1',
      operations: [],
      destructiveOperationsAllowed: false,
    });
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) {
      expect(staleRes.error.code).toBe('STALE_REVISION_CONFLICT');
    }
  });

  it('GooglePublisher: publishes idempotently to Google Drive and Sheets', async () => {
    const publisher = new GooglePublisher();
    const request: PublishRequest = {
      taskId: 't-pub-2',
      clientId: 'c-pub-2',
      designRevisionId: 'rev-2',
      approvalId: 'app-2',
      publicationKey: 'pub_key_task2_rev2',
      packageHash: 'sha256_package_2',
      files: [{
        artifactId: 'art-2',
        relativePath: 'export.png',
        storageKey: 'store/export.png',
        filename: 'export.png',
        mimeType: 'image/png',
        byteSize: 2048,
        sha256: 'sha256_file_2',
      }],
      destination: {
        sharedDriveId: 'drive-main',
        productionRootFolderId: 'root-folder-1',
        relativeFolderParts: ['2026', 'Social'],
        spreadsheetId: 'sheet-1',
        sheetId: 0,
      },
      sheetRow: { task_id: 't-pub-2', status: 'Published' },
    };

    const pub1 = await publisher.publish(ctx, request);
    const pub2 = await publisher.publish(ctx, request);

    expect(pub1.ok).toBe(true);
    expect(pub2.ok).toBe(true);
    if (pub1.ok && pub2.ok) {
      expect(pub1.value.publicationId).toBe(pub2.value.publicationId);
      expect(pub1.value.sheet.synced).toBe(true);
    }
  });

  it('DirectModelGateway: resolves model roles to approved deployment definitions', async () => {
    const gateway = new DirectModelGateway();
    const routerDep = await gateway.resolve(ctx, 'intake_router');
    expect(routerDep.ok).toBe(true);
    if (routerDep.ok) {
      expect(routerDep.value.exactModelId).toBe('gemini-3.8-flash');
    }

    const directorDep = await gateway.resolve(ctx, 'creative_director');
    expect(directorDep.ok).toBe(true);
    if (directorDep.ok) {
      expect(directorDep.value.exactModelId).toBe('gpt-5.6-sol');
    }

    const judgeDep = await gateway.resolve(ctx, 'visual_judge');
    expect(judgeDep.ok).toBe(true);
    if (judgeDep.ok) {
      expect(judgeDep.value.exactModelId).toBe('claude-opus-5');
    }
  });
});
