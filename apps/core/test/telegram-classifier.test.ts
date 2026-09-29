import { describe, it, expect, vi } from 'vitest';
import {
  classifyWithHeuristics,
  classifyInboundTelegramMessage,
  isAcknowledgement,
} from '../src/services/telegram-classifier.js';

const allowedEgress = { egressDecision: {
  clientId: 'c1000000-0000-4000-8000-000000000002',
  dataClass: 'client_message' as const,
  mode: 'approved_providers' as const,
  allowedProviders: ['openai'],
} };

describe('telegram-classifier: Intent & Instruction-Only Detection', () => {
  const activeTask = {
    id: '5f94e0e3-4934-4490-9c1f-44147a0e66b6',
    title: 'KAAE Gala Dinner Invitation',
    rawText: 'Join us for the annual KAAE diplomatic accreditation gala dinner.',
    copy: ['KAAE Gala Dinner', 'Honoring Ministers and Delegates', 'October 25, 2026'],
  };

  describe('classifyWithHeuristics', () => {
    it('does not turn short unrelated chatter into a brief', () => {
      expect(classifyWithHeuristics('Duplicate test', false).kind).toBe('other');
      expect(classifyWithHeuristics('New poster request', false).kind).toBe('new_brief');
    });
    it('correctly classifies "the background is simple and solid, i want some kind of gradient or texture" as revision_feedback', () => {
      const res = classifyWithHeuristics(
        'the background is simple and solid, i want some kind of gradient or texture',
        true
      );
      expect(res.intent).toBe('revision_feedback');
      expect(res.isInstructionOnly).toBe(true);
    });

    it('correctly classifies "can you make it look better more high end and professional" as revision_feedback', () => {
      const res = classifyWithHeuristics(
        'can you make it look better more high end and professional',
        true
      );
      expect(res.intent).toBe('revision_feedback');
      expect(res.isInstructionOnly).toBe(true);
    });

    it('correctly classifies "thats the same design again" as revision_feedback', () => {
      const res = classifyWithHeuristics(
        'thats the same design again',
        true
      );
      expect(res.intent).toBe('revision_feedback');
    });

    it('correctly classifies "change the whole design, thats really bad, looks basic and cheap" as revision_feedback', () => {
      const res = classifyWithHeuristics(
        'change the whole design, thats really bad, looks basic and cheap',
        true
      );
      expect(res.intent).toBe('revision_feedback');
      expect(res.isInstructionOnly).toBe(true);
    });

    it('correctly classifies Kurdish revision "دیزاینێکی تر دروست بکە باشتر بێت" as revision_feedback', () => {
      const res = classifyWithHeuristics(
        'دیزاینێکی تر دروست بکە باشتر بێت',
        true
      );
      expect(res.intent).toBe('revision_feedback');
    });

    it('flags instruction-only message when there is NO prior task in chat', () => {
      const res = classifyWithHeuristics(
        'the background is simple and solid, i want some kind of gradient or texture',
        false
      );
      expect(res.intent).toBe('new_brief');
      expect(res.isInstructionOnly).toBe(true);
    });

    it('recognizes a genuine multi-paragraph design brief as new_brief and not instruction-only', () => {
      const fullBrief = `KAAE Accreditation Ceremony 2026

Date: October 28, 2026
Venue: Rotana Hotel Grand Ballroom, Erbil
Cordially invites all university presidents and quality assurance directors.`;

      const res = classifyWithHeuristics(fullBrief, true);
      expect(res.intent).toBe('new_brief');
      expect(res.isInstructionOnly).toBe(false);
    });

    it('classifies full brief with styling keywords and divider as new_brief even with active prior task', () => {
      const userBrief = `I need a an invitation design for Kaae, here is all the information. Make it nice and professional, in english. It needs to go with kaaes brand guidelines, currently we prefer the dark blue navy as a background, feel free to add textures as you see fit in the brand guidelines. Don’t change anything from my content, i only need the design. I have attached the kaae logo as well so please use that 
__________


THE NATIONAL STANDARDS FOR QUALITY ASSURANCE IN EDUCATION

Mr. / Ms. / Dr. [Full Name]

The Kurdistan Accrediting Association for Education
cordially requests the honor of your presence at this landmark occasion.

September 9, 2026 | 2:30 PM
Saad Abdullah Conference Hall

By Invitation Only`;

      const res = classifyWithHeuristics(userBrief, true, false);
      expect(res.intent).toBe('new_brief');
      expect(res.isInstructionOnly).toBe(false);
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('does not hijack a short brief mentioning passive keywords (gold, navy, title) into a revision when prior task exists', () => {
      const shortBrief = 'New poster: Gold and Navy Gala, Erbil International Hotel, 8 PM';
      const res = classifyWithHeuristics(shortBrief, true, false);
      expect(res.intent).toBe('new_brief');
      expect(res.kind).toBe('new_brief');
    });

    it('does not hijack a brand-new design request with color notes into a revision', () => {
      const newBrief = 'Please design a new flyer for our annual meeting with gold accents and navy background';
      const res = classifyWithHeuristics(newBrief, true, false);
      expect(res.intent).toBe('new_brief');
      expect(res.kind).toBe('new_brief');
    });

    it('still correctly classifies explicit revision directives on colors or titles as revision_feedback', () => {
      const revisionDirective = 'make the title larger and gold';
      const res = classifyWithHeuristics(revisionDirective, true, false);
      expect(res.intent).toBe('revision_feedback');
      expect(res.kind).toBe('feedback');
    });
  });

  describe('classifyInboundTelegramMessage with model & fallback', () => {
    it('keeps an unresolved client message local even when a model key exists', async () => {
      const fetcher = vi.fn(async () => { throw new Error('Unscoped text must not leave the office'); });
      const input = { messageText: 'please make the title gold', recentTask: activeTask };
      const noDecision = await classifyInboundTelegramMessage(input, { apiKey: 'test-key', fetcher });
      const localOnly = await classifyInboundTelegramMessage(input, { apiKey: 'test-key', fetcher,
        egressDecision: { ...allowedEgress.egressDecision, mode: 'local_only' } });
      const wrongProvider = await classifyInboundTelegramMessage(input, { apiKey: 'test-key', fetcher,
        egressDecision: { ...allowedEgress.egressDecision, allowedProviders: ['anthropic'] } });
      expect([noDecision.kind, localOnly.kind, wrongProvider.kind]).toEqual(['feedback', 'feedback', 'feedback']);
      expect([noDecision.isInstructionOnly, localOnly.isInstructionOnly, wrongProvider.isInstructionOnly])
        .toEqual([true, true, true]);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('keeps an empty explicit copy section as a new task without a paid model call', async () => {
      const fetcher = vi.fn(async () => { throw new Error('The classifier must not call a provider'); });
      const classified = await classifyInboundTelegramMessage(
        { messageText: 'تکایە پۆستێک بۆ فاستپەی دروست بکە\nدەق:', recentTask: null },
        { ...allowedEgress, apiKey: 'test-key', fetcher },
      );
      expect(classified).toMatchObject({ kind: 'new_brief', isInstructionOnly: false });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('uses gpt-6-astra when available to classify feedback with max_completion_tokens', async () => {
      let passedBody: any;
      const mockFetch = vi.fn(async (_url: any, init: any) => {
        passedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: 'revision_feedback',
                    confidence: 0.98,
                    isInstructionOnly: true,
                    directive: 'Add a subtle gradient or texture to the solid navy background',
                    reason: 'Client is providing direct aesthetic feedback on the background of the previous design',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const res = await classifyInboundTelegramMessage(
        {
          messageText: 'the background is simple and solid, i want some kind of gradient or texture',
          recentTask: activeTask,
        },
        { ...allowedEgress, apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.intent).toBe('revision_feedback');
      expect(res.confidence).toBe(0.98);
      expect(res.isInstructionOnly).toBe(true);
      expect(res.directive).toContain('gradient or texture');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(passedBody.max_completion_tokens).toBe(1200);
      expect(passedBody.max_tokens).toBeUndefined();
      expect(passedBody.temperature).toBeUndefined();
      expect(passedBody.response_format.type).toBe('json_schema');
      expect(passedBody.response_format.json_schema.name).toBe('telegram_classifier');
      expect(passedBody.response_format.json_schema.strict).toBe(true);
    });

    it('passes preview image as image_url when available in recentTask', async () => {
      let passedBody: any;
      const mockFetch = vi.fn(async (_url: any, init: any) => {
        passedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test-vision-123',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'feedback',
                    confidence: 0.96,
                    isInstructionOnly: true,
                    directive: 'Make the title larger and gold',
                    reason: 'Client wants title scaled up based on image',
                    documentKind: 'design_piece',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'x-request-id': 'req-test-vision' } }
        );
      });

      const res = await classifyInboundTelegramMessage(
        {
          messageText: 'make the title larger and gold',
          recentTask: {
            ...activeTask,
            previewImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        },
        { ...allowedEgress, apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.kind).toBe('feedback');
      expect(res.callReceipt?.id).toBe('chatcmpl-test-vision-123');
      expect(res.callReceipt?.requestId).toBe('req-test-vision');
      const userMsg = passedBody.messages.find((m: any) => m.role === 'user');
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content.some((c: any) => c.type === 'image_url')).toBe(true);
    });

    it('asks, below 0.75, only whether to change the last design or start a new one', async () => {
      const answering = (kind: string) => vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind, confidence: 0.6, isInstructionOnly: false, directive: '', reason: 'unsure', documentKind: 'design_piece', standingRule: '' }) } }] }),
          { status: 200 }
        )
      );
      // A doubtful "thanks" or greeting is answered as one, not questioned.
      const chatter = await classifyInboundTelegramMessage({ messageText: 'hawa', recentTask: activeTask }, { ...allowedEgress, apiKey: 'test-key', fetcher: answering('other') });
      expect(chatter.needsClarification).toBe(false);
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'feedback',
                    confidence: 0.6,
                    isInstructionOnly: false,
                    directive: '',
                    reason: 'Ambiguous short message',
                    documentKind: 'design_piece',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

      const res = await classifyInboundTelegramMessage(
        {
          messageText: 'new design please',
          recentTask: activeTask,
        },
        { ...allowedEgress, apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.needsClarification).toBe(true);
      expect(res.clarifyingQuestion).toBeDefined();
      expect(res.clarifyingQuestion).toContain('Could you please clarify');
    });

    it('falls back seamlessly to heuristics if model API fails with 500', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 })
      );

      const res = await classifyInboundTelegramMessage(
        {
          messageText: 'can you make it look better more high end and professional',
          recentTask: activeTask,
        },
        { ...allowedEgress, apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.intent).toBe('revision_feedback');
      expect(res.isInstructionOnly).toBe(true);
    });
  });
});

/**
 * Found on 2026-09-23: common thanks were not recognised, so under a draft they cost a model call
 * and, when the model was slow, the reply rule started a paid revision on "great work".
 */
describe('telegram-classifier: thanks and praise under a draft start nothing paid', () => {
  const draft = { id: '5f94e0e3-4934-4490-9c1f-44147a0e66b6', title: 'KAAE Gala Dinner Invitation' };
  const thanks = [
    'thank you so much', 'Thanks a lot!', 'thank u', 'good job', 'Looks good', 'great work', 'perfect', 'nice', 'approved',
    'thanks 👍🏻', '🙏🏼', '👍🏽👍🏽', '❤️', 'دەستخۆش', 'دەستت خۆش بێت', 'سوپاست دەکەم', 'زۆر سوپاس', 'مەمنون', 'سپاس',
  ];

  for (const text of thanks) {
    it(`"${text}" in reply to a draft is 'other', with no model call`, async () => {
      const fetcher = vi.fn();
      const res = await classifyInboundTelegramMessage({ messageText: text, recentTask: draft, hasReplyTo: true }, { ...allowedEgress, apiKey: 'test-key', fetcher });
      expect(res.kind).toBe('other');
      expect(res.needsClarification).toBeFalsy();
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  it('is thanks only when the whole short message is', () => {
    expect(isAcknowledgement('looks good but move the logo')).toBe(false);
    expect(isAcknowledgement('thanks, now make the title gold')).toBe(false);
    expect(isAcknowledgement(`thanks ${'very '.repeat(12)}much`)).toBe(false);
  });

  const failing = {
    'a 500': vi.fn(async () => new Response('{}', { status: 500 })),
    'a timeout': vi.fn(async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }),
  };
  for (const [how, fetcher] of Object.entries(failing)) {
    it(`asks, after ${how}, whether praise in reply to a draft is a change, and never starts one`, async () => {
      const res = await classifyInboundTelegramMessage(
        { messageText: 'great work, the client will love this one', recentTask: draft, hasReplyTo: true },
        { ...allowedEgress, apiKey: 'test-key', fetcher }
      );
      expect(fetcher).toHaveBeenCalled();
      expect(['feedback', 'new_brief', 'standing_rule']).not.toContain(res.kind);
      expect(res.needsClarification).toBe(true);
      expect(res.clarifyingQuestion).toMatch(/is this a change to the design\? Reply "revise"/);
    });

    it(`still revises, after ${how}, a reply that asks for a change`, async () => {
      for (const messageText of ['move the logo left', 'the title font is wrong', 'use the navy background instead', 'ڕەنگەکە تۆختر بکە']) {
        const res = await classifyInboundTelegramMessage({ messageText, recentTask: draft, hasReplyTo: true }, { ...allowedEgress, apiKey: 'test-key', fetcher });
        expect(res.kind).toBe('feedback');
        expect(res.needsClarification).toBeFalsy();
      }
    });
  }

  it('asks in Kurdish when the reply is Kurdish, with the answer intake reads as "revise"', () => {
    const res = classifyWithHeuristics('زۆر جوانە، کڕیارەکە حەزی لێ دەکات', true, true);
    expect(res.kind).toBe('other');
    expect(res.clarifyingQuestion).toContain('دەستکاری');
  });
});

describe('telegram-classifier: a model-stated rule needs the words of one', () => {
  const draft = { id: '5f94e0e3-4934-4490-9c1f-44147a0e66b6', title: 'KAAE Gala Dinner Invitation' };
  const answering = (kind: string, standingRule: string) =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind, confidence: 0.95, isInstructionOnly: true, directive: '', reason: 'r', documentKind: 'design_piece', standingRule }) } }] }),
        { status: 200 }
      )
    );

  it('drops a rule the model restated from a one-off change or brief', async () => {
    const change = await classifyInboundTelegramMessage({ messageText: 'make the title gold', recentTask: draft }, { ...allowedEgress, apiKey: 'test-key', fetcher: answering('feedback', 'Make titles gold.') });
    expect(change.kind).toBe('feedback');
    expect(change.standingRule).toBeUndefined();
    const brief = await classifyInboundTelegramMessage({ messageText: 'KAAE open day, gold titles', recentTask: draft }, { ...allowedEgress, apiKey: 'test-key', fetcher: answering('new_brief', 'Use gold titles.') });
    expect(brief.standingRule).toBeUndefined();
    // With no design to change, a one-off change is a brief, not a rule.
    const noDraft = await classifyInboundTelegramMessage({ messageText: 'make the title gold', recentTask: null }, { ...allowedEgress, apiKey: 'test-key', fetcher: answering('feedback', 'Make titles gold.') });
    expect(noDraft.kind).toBe('new_brief');
    expect(noDraft.standingRule).toBeUndefined();
  });

  it('keeps it when the message says "from now on", and always for a standing rule', async () => {
    const both = await classifyInboundTelegramMessage(
      { messageText: 'make the title gold, and from now on always use gold titles', recentTask: draft },
      { ...allowedEgress, apiKey: 'test-key', fetcher: answering('feedback', 'Use gold titles.') }
    );
    expect(both.standingRule).toBe('Use gold titles.');
    const rule = await classifyInboundTelegramMessage({ messageText: 'for all KAAE designs, gold titles please', recentTask: draft }, { ...allowedEgress, apiKey: 'test-key', fetcher: answering('standing_rule', 'Use gold titles.') });
    expect(rule.kind).toBe('standing_rule');
    expect(rule.standingRule).toBe('Use gold titles.');
  });
});

/**
 * Found on 2026-09-29 (chaos R10.H1): "Thank you, we received the files." after a delivery was
 * 'new_brief' ("Standard new design brief text"), so with no waiting request Core's intake opened a
 * lifecycle request for it and the requester was told an art director would review it (ADR-140).
 */
describe('telegram-classifier: thanks and receipts are not briefs', () => {
  const receipts = [
    'Thank you, we received the files.', 'thanks', 'Thanks!', 'thank you, received', 'Received, thanks!',
    'We have received everything safely, thank you so much 🙏', 'files received', 'All files received.',
    'All received with thanks', 'got them, thanks', "I've got it", "we've received the final design, thanks again",
    'the posters arrived, thank you', 'everything has been received',
    'سوپاس', 'زۆر سوپاس', 'سوپاس، پێمان گەیشت', 'فایلەکان گەیشتن، زۆر سوپاس', 'هەموو فایلەکان گەیشتن',
    'وەرمانگرت سوپاس', 'فایلەکانمان وەرگرت 🙏', 'گەیشت', 'شكراً',
  ];
  for (const text of receipts) {
    it(`"${text}" with no design in the chat is 'other', not a brief`, () => {
      expect(isAcknowledgement(text)).toBe(true);
      const res = classifyWithHeuristics(text, false, false);
      expect(res).toMatchObject({ kind: 'other', intent: 'question_or_other', reason: 'Acknowledgement' });
      expect(res.needsClarification).toBeFalsy();
      // After a delivery the chat has a recent design; the receipt is not a change to it either.
      expect(classifyWithHeuristics(text, true, false).kind).toBe('other');
    });
  }

  it('is answered without a model call when the model is allowed', async () => {
    const fetcher = vi.fn();
    const res = await classifyInboundTelegramMessage({ messageText: 'Thank you, we received the files.', recentTask: null },
      { ...allowedEgress, apiKey: 'test-key', fetcher });
    expect(res.kind).toBe('other');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps one-line briefs that open with thanks or mention receiving something', () => {
    for (const text of [
      'Thank you, we received the files. Please make a poster for the gala on 5 May',
      'Thanks! New poster for the KAAE open day',
      'We received an award, make a poster',
      'received the accreditation certificate, design a congratulation post',
      'Poster for KAAE open day',
      'سوپاس، پۆستەرێکی نوێ بۆ ڕۆژی کراوە',
    ]) {
      expect(isAcknowledgement(text), text).toBe(false);
      expect(classifyWithHeuristics(text, false, false).kind, text).toBe('new_brief');
    }
  });

  it('keeps a change that follows a receipt a change', () => {
    expect(isAcknowledgement('received, but please change the date')).toBe(false);
    expect(classifyWithHeuristics('got it, now make the title gold', true, true).kind).toBe('feedback');
  });
});
