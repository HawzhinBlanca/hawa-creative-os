import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AskLedgerView, type LedgerRound } from '../src/components/AskLedger.js';

const round = (over: Partial<LedgerRound>): LedgerRound => ({ taskId: 't', title: 'x', round: 1, asks: [], sideEffects: [], frustrated: false, taskState: 'human_review', ...over });

describe('the ask ledger in the task view', () => {
  it('shows nothing for a design that was never changed', () => {
    expect(renderToStaticMarkup(React.createElement(AskLedgerView, { rounds: [round({ round: 0 })] }))).toBe('');
  });

  it('lists each round with its asks, why not, how an ask was read, and what moved to make room', () => {
    const html = renderToStaticMarkup(
      React.createElement(AskLedgerView, {
        rounds: [
          round({ round: 0, taskId: 'a' }),
          round({
            taskId: 'b',
            directive: 'cut the panelists out and less empty space',
            asks: [
              { ask: 'cut the panelists out', status: 'done', op: 'photo_cutout', by: 'rule' },
              { ask: 'less empty space', status: 'done', assumption: 'bigger photos', seen: { made: false, why: 'the gaps look the same' } },
              { ask: 'retouch her face', status: 'not_possible', reason: 'a designer is needed' },
            ],
            sideEffects: ['the date'],
            frustrated: true,
          }),
          round({ taskId: 'c', round: 2, directive: 'change the colour', question: { question: 'Which colour?', options: ['gold', 'white'], answered: false }, asks: [{ ask: 'change the colour', status: 'asked' }] }),
        ],
      })
    );
    expect(html).toContain('What the requester asked (2 rounds)');
    expect(html).toContain('✅ cut the panelists out');
    expect(html).toContain('photo cutout, made by rule');
    expect(html).toContain('Read as: bigger photos');
    expect(html).toContain('🔍 The visual check did not agree: the gaps look the same');
    expect(html).toContain('❌ retouch her face');
    expect(html).toContain('Why: a designer is needed');
    expect(html).toContain('Moved to make room: the date');
    expect(html).toContain('the requester sounded frustrated');
    expect(html).toContain('❓ Asked: Which colour? (gold / white), no answer yet');
  });
});
