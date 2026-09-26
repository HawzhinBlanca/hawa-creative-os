import { describe, expect, it, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService, asksForPictures, contentPhotoFromDataUrl } from '../src/services/design-studio/design-studio-service.js';
import { photosBrief } from '../src/services/design-studio/stages/layouts.stage.js';
import { studioStatusNote } from '../src/services/design-studio/studio-status-note.js';

/**
 * "I need a graphic with these texts and two pictures in it." The two portraits sent with that
 * request on 2026-09-22 were read as a style reference, the design shipped without them, and the
 * note to the sender said "checks passed". The request decides what its images are.
 */

const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('what a request says its images are', () => {
  it('asks for pictures in English, Sorani and Arabic', () => {
    expect(asksForPictures('I need a graphic with these texts and two pictures in it')).toBe(true);
    expect(asksForPictures('use the attached photo of the speaker')).toBe(true);
    expect(asksForPictures('پۆستەرێک لەگەڵ وێنەی قسەکەر')).toBe(true);
    expect(asksForPictures('follow this style, same colours')).toBe(false);
    expect(asksForPictures('')).toBe(false);
  });

  it('decodes a data URL into bytes with its pixel size', () => {
    const p = contentPhotoFromDataUrl(photo);
    expect(p.mimeType).toBe('image/jpeg');
    expect(p.bytes.length).toBeGreaterThan(100);
    expect(p.width).toBe(1);
    expect(p.height).toBe(1);
  });

  it('tells the layout model how many photos to place and how', () => {
    expect(photosBrief(undefined, 1080, 1350)).toBe('');
    const line = photosBrief([{ ...contentPhotoFromDataUrl(photo), width: 800, height: 800 }, contentPhotoFromDataUrl(photo)], 1080, 1350);
    expect(line).toMatch(/Client photographs to place \(2\)/);
    expect(line).toMatch(/0: 800x800 \(square, aspect 1.00\)/);
    expect(line).toMatch(/22% of the canvas's short side \(238px here\)/);
    expect(line).toMatch(/never under text or the logo/);
  });

  it('the note to the sender says what became of their photos', () => {
    const run = (photosSent: number, placed: number, referenceSeen = false) => ({
      run: { stages: JSON.stringify({ brief: { photosSent, referenceSeen }, conceive: { pipeline: 'v3' } }), winner_candidate_id: 'w' },
      candidates: [{ id: 'w', score: 0.9, layouts: JSON.stringify([{ text: [{ fontFamily: 'Verdana' }], photos: Array.from({ length: placed }, (_, i) => ({ photoIndex: i })) }]), concept: JSON.stringify({ artStrategy: 'procedural', motif: 'gradient-wash' }) }],
    });
    expect(studioStatusNote(run(2, 2))).toMatch(/your 2 photos placed/);
    expect(studioStatusNote(run(2, 0))).toMatch(/⚠️ 0 of your 2 photos placed/);
    expect(studioStatusNote(run(0, 0, true))).toMatch(/used as a style reference, not placed/);
    expect(studioStatusNote(run(0, 0))).not.toMatch(/photo/);
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('the request carries every image sent with it', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  afterAll(() => db.destroy());
  const service = () => new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: (async () => { throw new Error('no calls'); }) as any });

  it('two photos sent before the brief, then the brief: both are the request\'s images, oldest first', async () => {
    const channel = `photos-${randomUUID().slice(0, 8)}`;
    const a = photo.replace('AAD/2wBD', 'AAD/2wBE');
    for (const img of [a, photo]) {
      await persistChatIntake(db, {
        platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId: null,
        title: 'Sewa: reference image (awaiting request)', rawText: 'reference', designInstructions: '', exactCopy: [],
        isInstructionOnly: true, autoGenerate: false, studioOptions: { referenceImageBase64: img },
      });
    }
    const taskId = (await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
      title: 'KAAE: Her path, her power', rawText: 'HER PATH, HER POWER\n---\nSeptember 25, 2026',
      designInstructions: 'I need a graphic with these texts and two pictures in it', exactCopy: [], designStudio: true,
    })).task.id as string;
    const images = await (service() as any).requestImages(scope, taskId);
    expect(images).toEqual([a, photo]);
    // The brief's reference is the latest image when the request does not ask for pictures.
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);

    // The same words re-sent later without images carry the earlier request's images.
    const resent = (await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
      title: 'KAAE: Her path, her power', rawText: 'HER PATH, HER POWER\n---\nSeptember 25, 2026',
      designInstructions: 'I need a graphic with these texts and two pictures in it', exactCopy: [], designStudio: true,
    })).task.id as string;
    expect(await (service() as any).requestImages(scope, resent)).toEqual([a, photo]);

    // Different words from the same chat do not.
    const other = (await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
      title: 'KAAE: Something else', rawText: 'ANOTHER EVENT\n---\nOctober 2, 2026',
      designInstructions: '', exactCopy: [], designStudio: true,
    })).task.id as string;
    expect(await (service() as any).requestImages(scope, other)).toEqual([]);
  });

  it('does not borrow a nearby unbound photo for a request-owned design', async () => {
    const channel = `owned-photos-${randomUUID().slice(0, 8)}`;
    await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId: null,
      title: 'Unbound photo', rawText: 'reference', designInstructions: '', exactCopy: [],
      isInstructionOnly: true, autoGenerate: false,
      studioOptions: { referenceImageBase64: photo },
    });
    const owned = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
      title: 'A separate owned request', rawText: 'New design', designInstructions: 'New design',
      exactCopy: [], designStudio: true,
    });
    const requestId = randomUUID();
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: 'operator' }, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
        parent_request_id, owner, stage, rev, chat_id)
        VALUES (${requestId}::uuid, ${scope.tenantId}::uuid, ${owned.task.id}::uuid,
          ${owned.task.id}::uuid, null, 'restate', 'manual', 1, ${channel})`.execute(trx);
      await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
        WHERE tenant_id = ${scope.tenantId}::uuid AND id = ${owned.task.id}::uuid`.execute(trx);
    });
    expect(await (service() as any).requestImages(scope, owned.task.id)).toEqual([]);

    const attached = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
      title: 'Request with its own photo', rawText: 'Another design', designInstructions: 'Another design',
      exactCopy: [], designStudio: true, studioOptions: { referenceImageBase64: photo },
    });
    const attachedRequestId = randomUUID();
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId, role: 'operator' }, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
        parent_request_id, owner, stage, rev, chat_id)
        VALUES (${attachedRequestId}::uuid, ${scope.tenantId}::uuid, ${attached.task.id}::uuid,
          ${attached.task.id}::uuid, null, 'restate', 'manual', 1, ${channel})`.execute(trx);
      await sql`UPDATE hawa.tasks SET request_id = ${attachedRequestId}::uuid
        WHERE tenant_id = ${scope.tenantId}::uuid AND id = ${attached.task.id}::uuid`.execute(trx);
    });
    expect(await (service() as any).requestImages(scope, attached.task.id)).toEqual([photo]);
  });
});

import { hardQaContextFor } from '../src/services/design-studio/stages/v3.stage.js';
describe('hard QA knows how many photos the request carries', () => {
  // Run b7fc5555 (2026-09-22): three candidates placed both portraits correctly, and QA refused all
  // three with "Design places 2 photo(s); the request has 0", because this context carried no count.
  it('passes the photo count through', () => {
    const base = { width: 1080, height: 1350, copyBlocks: [{ text: 'T', script: 'latin' }], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', referencePack: { palette: ['#0A1628'] }, logoAspect: 1 } as any;
    expect(hardQaContextFor({ ...base, photos: [contentPhotoFromDataUrl(photo), contentPhotoFromDataUrl(photo)] }).photoCount).toBe(2);
    expect(hardQaContextFor(base).photoCount).toBe(0);
  });
});
