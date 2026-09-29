import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';

/**
 * Bug hunt on b2bbbb8: questions, answers, sizes and rounds (PostgreSQL test DB).
 *
 * ADR-135 stage 2 deleted the legacy webhook these cases drove (answer, size and approve buttons,
 * replies to a draft, /status). What stays is the studio reading a chain of tasks: the tasks are
 * saved here as the legacy answer and size paths saved them, through persistChatIntake.
 */
const url = process.env.HAWA_ISOLATED_TEST_DB;
const PNG_A = 'data:image/png;base64,' + Buffer.from('hunt-photo-A').toString('base64');
const PNG_B = 'data:image/png;base64,' + Buffer.from('hunt-photo-B').toString('base64');

describe.skipIf(!url)('review of 2026-09-24: around a question, sizes and rounds', () => {
  const db = createDb(url!);
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  afterAll(async () => {
    await db.destroy();
  });

  it('the album photos filed under the question reach the answer, and any later change or size of it', async () => {
    const chat = String(60000000 + Math.floor(Math.random() * 9000000));
    const rawText = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';
    const base: ChatIntake = {
      platform: 'telegram', sourceEventId: '', sourceChannelId: chat, rawText, clientId: kaae,
      title: 'KAAE: KAAE members evening…', headlineEn: 'December 4, 2026', copyEn: 'Erbil',
      designInstructions: 'KAAE members evening', exactCopy: [{ id: 'copy_0', role: 'headline', text: 'December 4, 2026\nErbil' }],
      variant: { width: 1080, height: 1350 },
    };
    const save = async (options: ChatIntake['studioOptions'], title = base.title) =>
      String((await persistChatIntake(db, { ...base, sourceEventId: randomUUID(), title, ...(options ? { studioOptions: options } : {}) })).task.id);

    const parent = await save(undefined);
    // The change that stopped to ask a question, sent with the first photo of an album.
    const waiting = await save({ parentTaskId: parent, revisionRound: 1, revisionDirective: 'add these photos, less empty space', referenceImageBase64: PNG_A, mediaGroupId: 'hunt-album' }, 'KAAE members evening (Revision)');
    await withRlsContext(db, operator, (trx) => sql`UPDATE hawa.tasks SET state = 'paused' WHERE id = ${waiting}::uuid`.execute(trx));
    // The album's second photo, filed under the question's task.
    await persistChatIntake(db, {
      ...base, sourceEventId: randomUUID(), rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      title: 'x (reference image)', designInstructions: 'x', exactCopy: [], isInstructionOnly: true, autoGenerate: false,
      studioOptions: { referenceFor: waiting, referenceImageBase64: PNG_B, mediaGroupId: 'hunt-album' },
    });
    // The answer: a change of the same design that answers the waiting task's question.
    const answer = await save({
      parentTaskId: parent, revisionRound: 1, clarified: true, answers: waiting,
      revisionDirective: 'add these photos, less empty space\n\nAsked "Fill the space with what?", the client answered: bigger title text',
    }, 'KAAE members evening (Revision)');
    // A later change of the answer's design, and its story size.
    const later = await save({ parentTaskId: answer, revisionRound: 2, revisionDirective: 'make the title gold' }, 'KAAE members evening (Revision)');
    const story = await save({ parentTaskId: answer, revisionDirective: 'The same design as a story (1080x1920).', reformat: 'story' }, 'KAAE members evening (story)');

    const service = new DesignStudioService(db as any, undefined, { apiKey: 'x' });
    const scope = { tenantId: operator.tenantId, actorId: operator.userId };
    const asRun = (taskId: string, of: string, answers?: string) => ({ task_id: taskId, request: { pipelineV3: true, directed: { parentTaskId: of, ...(answers ? { answers } : {}) } } });
    const label = (u: string) => (u === PNG_A ? 'A' : u === PNG_B ? 'B' : 'other');
    const forAnswer = (await (service as any).imagesForRun(scope, asRun(answer, parent, waiting))).map(label);
    const forLater = (await (service as any).imagesForRun(scope, asRun(later, answer))).map(label);
    const forStory = (await (service as any).imagesForRun(scope, asRun(story, answer))).map(label);
    expect(forAnswer).toEqual(expect.arrayContaining(['A', 'B']));
    expect(forLater).toEqual(expect.arrayContaining(['A', 'B']));
    expect(forStory).toEqual(expect.arrayContaining(['A', 'B']));
  });
});
