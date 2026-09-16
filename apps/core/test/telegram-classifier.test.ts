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
  });

  describe('classifyInboundTelegramMessage with model & fallback', () => {
    it('uses gpt-6-astra when available to classify feedback', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
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
        )
      );

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
