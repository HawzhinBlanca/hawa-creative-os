import { describe, it, expect, vi } from 'vitest';
import {
  classifyWithHeuristics,
  classifyInboundTelegramMessage,
} from '../src/services/telegram-classifier.js';

describe('telegram-classifier: Intent & Instruction-Only Detection', () => {
  const activeTask = {
    id: '5f94e0e3-4934-4490-9c1f-44147a0e66b6',
    title: 'KAAE Gala Dinner Invitation',
    rawText: 'Join us for the annual KAAE diplomatic accreditation gala dinner.',
    copy: ['KAAE Gala Dinner', 'Honoring Ministers and Delegates', 'October 25, 2026'],
  };

  describe('classifyWithHeuristics', () => {
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
        { apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.intent).toBe('revision_feedback');
      expect(res.confidence).toBe(0.98);
      expect(res.isInstructionOnly).toBe(true);
      expect(res.directive).toContain('gradient or texture');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(passedBody.max_completion_tokens).toBe(300);
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
        { apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.kind).toBe('feedback');
      expect(res.callReceipt?.id).toBe('chatcmpl-test-vision-123');
      expect(res.callReceipt?.requestId).toBe('req-test-vision');
      const userMsg = passedBody.messages.find((m: any) => m.role === 'user');
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content.some((c: any) => c.type === 'image_url')).toBe(true);
    });

    it('triggers clarification question when confidence is below 0.75', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'other',
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
          messageText: 'hawa',
          recentTask: activeTask,
        },
        { apiKey: 'test-key', fetcher: mockFetch }
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
        { apiKey: 'test-key', fetcher: mockFetch }
      );

      expect(res.intent).toBe('revision_feedback');
      expect(res.isInstructionOnly).toBe(true);
    });
  });
});
