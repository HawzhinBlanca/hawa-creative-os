import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestOfficePhotoFolder, parseOfficePhotoTagSheet } from '@hawa/creative';
import {
  attachOfficeLibraryPhotos,
  officePhotoLibraryEnabled,
  restoreOfficeLibrarySelection,
  type OfficeLibraryRunRecord,
} from '../src/services/design-studio/office-photo-library.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { contentPhotoFromDataUrl } from '../src/services/design-studio/design-studio-service.js';
import type { StageContext } from '../src/services/design-studio/types.js';
import { syntheticPhoto } from '../../../packages/creative/test/fixtures/synthetic-photos.js';

/**
 * ADR-280: the hook that gives a picture-less request the office's own archive photos. Flag off,
 * a requester photo, a website request or the briefing stage leave the run exactly as it was.
 */

const CLIENT = 'c1000000-0000-4000-8000-000000000002';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let root = '';
const ON = (dir = root) => ({ HAWA_OFFICE_PHOTO_LIBRARY: 'on', HAWA_OFFICE_PHOTO_LIBRARY_DIR: dir });
const visitPhoto = syntheticPhoto(1080, 1350, 31);
const forumPhoto = syntheticPhoto(1500, 1000, 32, [100, 110, 150]);

beforeAll(async () => {
  root = tmp('olp-core-');
  const source = tmp('olp-core-src-');
  writeFileSync(path.join(source, 'visit.png'), visitPhoto);
  writeFileSync(path.join(source, 'forum.png'), forumPhoto);
  writeFileSync(path.join(source, 'private.png'), syntheticPhoto(1080, 1350, 33));
  await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: CLIENT, now: () => new Date('2026-10-03T00:00:00.000Z'),
    tagRows: parseOfficePhotoTagSheet([
      'source,description,subjects,events,keywords,shot,people,consent,usable',
      'visit.png,Evaluators with pupils in a classroom,school; k12,field visit,pilot,classroom_or_interior,yes,granted,yes',
      'forum.png,Speaker at the education forum,forum; speaker,conference,education,event_or_stage,yes,granted,yes',
      // A perfect match the office has not cleared: people shown, consent refused.
      'private.png,Pupils at a field visit,school; k12,field visit,pilot,classroom_or_interior,yes,not_granted,yes',
    ].join('\n'), 'csv') });
});

function context(over: Partial<StageContext> = {}): StageContext {
  return {
    runId: 'run-1', tenantId: 't', taskId: 'task-1', clientId: CLIENT, actorId: 'a', width: 1080, height: 1350, tier: 'standard',
    instructions: 'Please make a post for the report.',
    copyBlocks: [{ text: 'KAAE K-12 Pilot Study', script: 'latin', locale: 'en' }, { text: 'Field Visit Report', script: 'latin', locale: 'en' }],
    ...over,
  } as unknown as StageContext;
}
const stagesWithBrief = () => ({ brief: { occasion: 'K-12 school field visit report', subjectTags: ['field_visit', 'k12'], toneWords: ['formal', 'institutional', 'educational'], photosSent: 0 } }) as Record<string, any>;
const input = (over: Partial<Parameters<typeof attachOfficeLibraryPhotos>[2]> = {}) => ({ status: 'conceiving', requesterImages: 0, request: {}, env: ON(), ...over });

/** A deep copy that keeps Buffers comparable, for "untouched" checks. */
const snapshot = (v: unknown) => JSON.stringify(v, (_k, x) => (x && x.type === 'Buffer' && Array.isArray(x.data) ? `buffer:${sha(Buffer.from(x.data))}` : x));

describe('the flag (ADR-280)', () => {
  it('is off unless set to 1, on, true or yes', () => {
    for (const v of [undefined, '', '0', 'off', 'false', 'no', 'enabled']) expect(officePhotoLibraryEnabled({ HAWA_OFFICE_PHOTO_LIBRARY: v })).toBe(false);
    for (const v of ['1', 'on', 'ON', 'true', 'yes']) expect(officePhotoLibraryEnabled({ HAWA_OFFICE_PHOTO_LIBRARY: v })).toBe(true);
  });

  it('off: the context and stages are byte-identical and the library is never read', async () => {
    // A library root whose manifest cannot be parsed: any read would record it as unavailable.
    const broken = tmp('olp-broken-');
    mkdirSync(path.join(broken, CLIENT), { recursive: true });
    writeFileSync(path.join(broken, CLIENT, 'library.json'), '{ not json');
    for (const env of [{}, { HAWA_OFFICE_PHOTO_LIBRARY: 'off', HAWA_OFFICE_PHOTO_LIBRARY_DIR: broken }, { HAWA_OFFICE_PHOTO_LIBRARY_DIR: root }]) {
      for (const status of ['briefing', 'conceiving', 'laying_out']) {
        const ctx = context();
        const stages = stagesWithBrief();
        const before = { ctx: snapshot(ctx), stages: snapshot(stages), keys: Object.keys(ctx).sort() };
        await attachOfficeLibraryPhotos(ctx, stages, input({ status, env }));
        restoreOfficeLibrarySelection(ctx, stages);
        expect({ ctx: snapshot(ctx), stages: snapshot(stages), keys: Object.keys(ctx).sort() }).toEqual(before);
      }
    }
  });
});

describe('the hook with the flag on (ADR-280)', () => {
  it('attaches the matching library photo as content, with provenance, a choose selection and reasons; the brief is untouched', async () => {
    const ctx = context();
    const stages = stagesWithBrief();
    const brief = snapshot(stages.brief);
    await attachOfficeLibraryPhotos(ctx, stages, input());
    const record = stages.officePhotoLibrary as OfficeLibraryRunRecord;
    expect(record).toMatchObject({ version: 1, provenance: 'office_library', status: 'attached', clientId: CLIENT, stage: 'conceiving', photoSelection: { mode: 'choose', minimum: 1 } });
    expect(record.photos[0]).toMatchObject({ photoIndex: 0, sha256: sha(visitPhoto), storedSha256: sha(visitPhoto), description: 'Evaluators with pupils in a classroom' });
    expect(record.photos[0].reasons.join(' ')).toMatch(/same kind of event: field visit/);
    expect(record.photos.map((p) => p.sha256)).not.toContain(sha(syntheticPhoto(1080, 1350, 33)));
    expect(record.excluded).toMatchObject({ no_consent: 1 });
    expect(ctx.photos?.[0].bytes.equals(visitPhoto)).toBe(true);
    expect(ctx.photos?.[0]).toMatchObject({ mimeType: 'image/png', width: 1080, height: 1350, review: { shot: 'classroom_or_interior', quietArea: 'top' } });
    expect(ctx.photos?.[0].notes).toMatch(/^Office archive photo from the client's photo library, not sent by the requester: /);
    expect(ctx.photoSelection).toEqual({ mode: 'choose', minimum: 1 });
    // The requester's photo count and the copy are not touched.
    expect(snapshot(stages.brief)).toBe(brief);
    expect(ctx.copyBlocks.map((b) => b.text)).toEqual(['KAAE K-12 Pilot Study', 'Field Visit Report']);
  });

  it('keeps the same photos at a later stage even when the library has changed since', async () => {
    const ctx = context();
    const stages = stagesWithBrief();
    await attachOfficeLibraryPhotos(ctx, stages, input());
    const chosen = snapshot(stages.officePhotoLibrary);
    // Next stage, fresh context: the recorded choice is reloaded, not re-ranked.
    const later = context();
    await attachOfficeLibraryPhotos(later, stages, input({ status: 'laying_out' }));
    expect(snapshot(stages.officePhotoLibrary)).toBe(chosen);
    expect(later.photos?.map((p) => sha(p.bytes))).toEqual((stages.officePhotoLibrary as OfficeLibraryRunRecord).photos.map((p) => p.storedSha256));
  });

  it('records a photo that changed on disk after it was chosen as unavailable, and attaches nothing', async () => {
    const copy = tmp('olp-copy-');
    const source = tmp('olp-copy-src-');
    writeFileSync(path.join(source, 'visit.png'), visitPhoto);
    await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: copy, clientId: CLIENT,
      tagRows: parseOfficePhotoTagSheet('source,subjects,events,people,consent,usable\nvisit.png,school,field visit,yes,granted,yes', 'csv') });
    const stages = stagesWithBrief();
    await attachOfficeLibraryPhotos(context(), stages, input({ env: ON(copy) }));
    expect((stages.officePhotoLibrary as OfficeLibraryRunRecord).status).toBe('attached');
    writeFileSync(path.join(copy, CLIENT, 'photos', `${sha(visitPhoto)}.png`), syntheticPhoto(1080, 1350, 99));
    const later = context();
    await attachOfficeLibraryPhotos(later, stages, input({ status: 'laying_out', env: ON(copy) }));
    expect(stages.officePhotoLibrary).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/does not match its recorded sha256/) });
    expect(later.photos).toBeUndefined();
  });

  it('records no_match and attaches nothing when no usable photo fits the request', async () => {
    const ctx = context({ copyBlocks: [{ text: 'Eid Mubarak', script: 'latin', locale: 'en' }], instructions: 'A greeting card' });
    const stages: Record<string, any> = { brief: { occasion: 'Eid greeting', subjectTags: ['occasion'] } };
    await attachOfficeLibraryPhotos(ctx, stages, input());
    expect(stages.officePhotoLibrary).toMatchObject({ status: 'no_match', photos: [], eligible: 2 });
    expect(ctx.photos).toBeUndefined();
    expect(ctx.photoSelection).toBeUndefined();
  });

  it('a client without a library is untouched; an unreadable library is recorded as unavailable', async () => {
    const empty = tmp('olp-empty-');
    const ctx = context();
    const stages = stagesWithBrief();
    const before = snapshot({ ctx, stages });
    await attachOfficeLibraryPhotos(ctx, stages, input({ env: ON(empty) }));
    expect(snapshot({ ctx, stages })).toBe(before);
    mkdirSync(path.join(empty, CLIENT));
    writeFileSync(path.join(empty, CLIENT, 'library.json'), JSON.stringify({ version: 1, clientId: CLIENT, updatedAt: '2026-10-03T00:00:00.000Z', photos: [{ id: 'x' }] }));
    await attachOfficeLibraryPhotos(ctx, stages, input({ env: ON(empty) }));
    expect(stages.officePhotoLibrary).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/OFFICE_PHOTO_LIBRARY_INVALID/) });
    expect(ctx.photos).toBeUndefined();
  });
});

describe('what the hook never touches (ADR-280)', () => {
  const requesterPhoto = contentPhotoFromDataUrl(`data:image/png;base64,${syntheticPhoto(400, 500, 41).toString('base64')}`);
  const cases: Array<[string, Partial<StageContext>, Partial<ReturnType<typeof input>>]> = [
    ['the briefing stage', {}, { status: 'briefing' }],
    ['a request with the requester\'s own photos', { photos: [requesterPhoto], photoSelection: { mode: 'all', minimum: 1 } }, { requesterImages: 1 }],
    ['a request whose only image was read as its logo', {}, { requesterImages: 1 }],
    ['a request with a style reference', { attachedImage: requesterPhoto.dataUrl, reference: { dataUrl: requesterPhoto.dataUrl, notes: 'follow this' } }, { requesterImages: 1 }],
    ['a website (customer) request', { webPhotoPolicy: { photoCount: 0, usage: { mode: 'auto' } } as StageContext['webPhotoPolicy'] }, {}],
  ];
  it.each(cases)('%s', async (_name, over, hook) => {
    const ctx = context(over);
    const stages = stagesWithBrief();
    const before = snapshot({ ctx, stages });
    await attachOfficeLibraryPhotos(ctx, stages, input(hook));
    expect(snapshot({ ctx, stages })).toBe(before);
    expect(stages.officePhotoLibrary).toBeUndefined();
  });
});

describe('revisions and pinned stages (ADR-280)', () => {
  it('a revision keeps its parent\'s library photos, and a revision of a design without them gets none', async () => {
    const parentStages = stagesWithBrief();
    await attachOfficeLibraryPhotos(context(), parentStages, input());
    const parent = parentStages.officePhotoLibrary as OfficeLibraryRunRecord;
    const request = { directed: { parentTaskId: 'parent-task' } };
    const ctx = context({ copyBlocks: [{ text: 'Something else entirely', script: 'latin', locale: 'en' }] });
    const stages: Record<string, any> = {};
    await attachOfficeLibraryPhotos(ctx, stages, input({ request, parentRecord: async (id) => (id === 'parent-task' ? parent : undefined) }));
    expect(stages.officePhotoLibrary).toMatchObject({ status: 'attached', inheritedFromParent: true, photos: parent.photos });
    expect(ctx.photos?.map((p) => sha(p.bytes))).toEqual(parent.photos.map((p) => p.storedSha256));

    const plain = context();
    const plainStages = stagesWithBrief();
    await attachOfficeLibraryPhotos(plain, plainStages, input({ request, parentRecord: async () => undefined }));
    expect(plain.photos).toBeUndefined();
    expect(plainStages.officePhotoLibrary).toBeUndefined();
  });

  it('after the pin is restored, the library photos keep their choose selection; other photos do not get it', async () => {
    const stages = stagesWithBrief();
    const first = context();
    await attachOfficeLibraryPhotos(first, stages, input());
    const restored = context({ photos: first.photos });
    restoreOfficeLibrarySelection(restored, stages);
    expect(restored.photoSelection).toEqual({ mode: 'choose', minimum: 1 });
    const other = context({ photos: [contentPhotoFromDataUrl(`data:image/png;base64,${forumPhoto.toString('base64')}`)] });
    restoreOfficeLibrarySelection(other, stages);
    expect(other.photoSelection).toBeUndefined();
  });
});

describe('the requester\'s note (ADR-280)', () => {
  it('says the photo is from the office archive and never calls it theirs', () => {
    const run = (library: boolean) => ({
      run: { stages: JSON.stringify({ brief: { photosSent: 0 }, photoSizes: [{ width: 400, height: 500 }], ...(library ? { officePhotoLibrary: { version: 1, provenance: 'office_library', status: 'attached', photos: [{ id: 'olp_1' }] } } : {}) }), winner_candidate_id: 'w' },
      candidates: [{ id: 'w', layouts: JSON.stringify([{ photos: [{ photoIndex: 0, x: 0, y: 0, width: 1080, height: 1350 }] }]) }],
    });
    const notes = requesterDraftNotes(run(true) as never).join('\n');
    expect(notes).toMatch(/The photo on this draft is from the office photo archive, not one you sent\./);
    expect(notes).not.toMatch(/your photo|Send a larger version|as you sent it/i);
    expect(requesterDraftNotes(run(false) as never).join('\n')).toMatch(/Send a larger version/);
  });
});
