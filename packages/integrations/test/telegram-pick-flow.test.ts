import { assert, describe, it, expect, beforeEach } from 'vitest';
import {
  TelegramPickFlowService,
  type PickCandidate,
} from '../src/telegram-pick-flow.js';
import { TelegramActionTokenService } from '../src/telegram-security.js';

describe('P08 — Telegram Pick Flow (Approve, Edit, Reject, Non-Blocking Timeout)', () => {
  const testHmacSecret = 'test_hmac_sec';
  let tokenService: TelegramActionTokenService;
  let pickService: TelegramPickFlowService;

  const mockCandidates: PickCandidate[] = [
    {
      id: 'candidate_01',
      title: 'Central Statutory Spine',
      copyText: 'Advancing Academic Rigor & Institutional Quality: KAAE sets mandatory accreditation benchmarks under Law No. 6 of 2022.',
      compositeScore: 0.955,
      critiqueQuickFixes: ['Bigger title', 'Lighter background', 'More space'],
    },
    {
      id: 'candidate_02',
      title: 'Editorial Mandate',
      copyText: 'Advancing Academic Rigor & Institutional Quality: KAAE sets mandatory accreditation benchmarks under Law No. 6 of 2022.',
      compositeScore: 0.942,
      critiqueQuickFixes: ['Larger crest', 'Center subtitle', 'Increase margins'],
    },
    {
      id: 'candidate_03',
      title: 'Hero Statement Grid',
      copyText: 'Advancing Academic Rigor & Institutional Quality: KAAE sets mandatory accreditation benchmarks under Law No. 6 of 2022.',
      compositeScore: 0.958,
      critiqueQuickFixes: ['Darker navy field', 'Gold border', 'Reduce footer size'],
    },
  ];

  beforeEach(() => {
    tokenService = new TelegramActionTokenService(testHmacSecret);
    pickService = new TelegramPickFlowService(tokenService);
  });

  it('presents 3 surviving renders as media group with exact copy and signed inline buttons', async () => {
    const res = await pickService.presentCandidatePick({
      taskId: 'task_p08_test_01',
      revisionId: 'rev_1',
      actorId: 'user_450405554',
      chatId: 450405554,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    expect(res.mediaGroupMessage.media).toHaveLength(3);
    expect(res.mediaGroupMessage.media[0].caption).toContain('Draft 1: Central Statutory Spine');
    expect(res.mediaGroupMessage.media[0].caption).toContain('Advancing Academic Rigor');

    // Inline buttons check
    const keyboard = res.controlMessage.replyMarkup.inline_keyboard;
    expect(keyboard).toHaveLength(4); // 3 candidate rows + 1 None of these row
    expect(keyboard[0][0].text).toBe('Use Draft #1');
    expect(keyboard[0][1].text).toBe('Edit #1');
    expect(keyboard[3][0].text).toContain('None of these');

    // Tokens check
    expect(keyboard[0][0].callback_data).toMatch(/^act:t_[a-f0-9]+:[a-f0-9]{16}$/);
    expect(keyboard[3][0].callback_data).toMatch(/^act:t_[a-f0-9]+:[a-f0-9]{16}$/);
  });

  it('Path 1 (Use this): selects candidate, consumes token, and enters PICKED state', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_use',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    const useButton1 = presentation.controlMessage.replyMarkup.inline_keyboard[0][0];

    const result = await pickService.handleCallbackQuery(
      presentation.sessionId,
      useButton1.callback_data,
      'user_lead'
    );

    expect(result.handled).toBe(true);
    expect(result.verificationResult.ok).toBe(true);
    expect(result.status).toBe('PICKED');
    expect(result.outboundMessage?.text).toContain('Draft #1 (Central Statutory Spine) selected');

    const session = pickService.getSession(presentation.sessionId);
    expect(session?.selectedCandidateId).toBe('candidate_01');
    expect(session?.journal.some((j) => j.event === 'CANDIDATE_PICKED')).toBe(true);
  });

  it('Path 2 (Edit): opens 3 critique-derived one-tap fixes plus free text prompt', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_edit',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    const editButton1 = presentation.controlMessage.replyMarkup.inline_keyboard[0][1];

    const editRes = await pickService.handleCallbackQuery(
      presentation.sessionId,
      editButton1.callback_data,
      'user_lead'
    );

    expect(editRes.handled).toBe(true);
    expect(editRes.verificationResult.ok).toBe(true);
    expect(editRes.status).toBe('EDITING');
    expect(editRes.outboundMessage?.text).toContain('Editing Draft #1');
    expect(editRes.outboundMessage?.text).toContain('Choose a one-tap quick fix');

    const fixButtons = editRes.outboundMessage?.replyMarkup?.inline_keyboard;
    expect(fixButtons).toHaveLength(3);
    expect(fixButtons?.[0][0].text).toBe('⚡ Bigger title');
    expect(fixButtons?.[1][0].text).toBe('⚡ Lighter background');
    expect(fixButtons?.[2][0].text).toBe('⚡ More space');

    // Selecting a quick fix
    const quickFixRes = await pickService.handleCallbackQuery(
      presentation.sessionId,
      fixButtons![0][0].callback_data,
      'user_lead'
    );

    expect(quickFixRes.handled).toBe(true);
    expect(quickFixRes.verificationResult.ok).toBe(true);
    expect(quickFixRes.outboundMessage?.text).toContain('Quick fix requested: "Bigger title"');
  });

  it('Path 3 (None of these): allows 1 redrive round, then escalates to Hawa Desk on second rejection', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_reject',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    const noneButton = presentation.controlMessage.replyMarkup.inline_keyboard[3][0];

    // Round 1 None of these
    const reject1 = await pickService.handleCallbackQuery(
      presentation.sessionId,
      noneButton.callback_data,
      'user_lead'
    );

    expect(reject1.handled).toBe(true);
    expect(reject1.status).toBe('PENDING'); // Redrives candidate generation
    expect(reject1.outboundMessage?.text).toContain('Generating one alternate candidate set (Round 2/2)');

    // Present fresh round 2 controls
    const round2 = await pickService.presentCandidatePick({
      taskId: 'task_p08_reject',
      revisionId: 'rev_2',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    // Artificially simulate 1 prior noneOfThese on the session
    const session = pickService.getSession(round2.sessionId)!;
    session.noneOfTheseCount = 1;

    const noneButton2 = round2.controlMessage.replyMarkup.inline_keyboard[3][0];
    const reject2 = await pickService.handleCallbackQuery(
      round2.sessionId,
      noneButton2.callback_data,
      'user_lead'
    );

    expect(reject2.status).toBe('REJECTED');
    expect(reject2.outboundMessage?.text).toContain('Second round completed without selection');
    expect(reject2.outboundMessage?.text).toContain('Task sent to Hawa Desk for manual guidance');
  });

  it('Security: refusers replayed one-time action tokens', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_replay',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    const useButton = presentation.controlMessage.replyMarkup.inline_keyboard[0][0];

    // First use: succeeds
    const firstAttempt = await pickService.handleCallbackQuery(
      presentation.sessionId,
      useButton.callback_data,
      'user_lead'
    );
    expect(firstAttempt.verificationResult.ok).toBe(true);

    // Second use (Replay): refused
    const replayAttempt = await pickService.handleCallbackQuery(
      presentation.sessionId,
      useButton.callback_data,
      'user_lead'
    );
    expect(replayAttempt.verificationResult.ok).toBe(false); assert(!replayAttempt.verificationResult.ok);
    expect(replayAttempt.verificationResult.code).toBe('REPLAY_DETECTED');
    expect(replayAttempt.outboundMessage?.text).toContain('This one-time token has already been consumed');
  });

  it('Non-blocking timeout: auto-advances with highest-judged candidate', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_timeout',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'en',
      candidates: mockCandidates, // candidate_03 has highest score 0.958
      secretKey: testHmacSecret,
      tokenService,
    });

    const timeoutRes = pickService.handleTimeout(presentation.sessionId);
    expect(timeoutRes.timedOut).toBe(true);
    expect(timeoutRes.highestCandidate?.id).toBe('candidate_03');
    expect(timeoutRes.outboundMessage?.text).toContain('Auto-advancing with highest-judged Draft #3 (Hero Statement Grid)');
    expect(timeoutRes.outboundMessage?.text).toContain('0.958');

    const session = pickService.getSession(presentation.sessionId);
    expect(session?.status).toBe('TIMEOUT_AUTO_PICKED');
    expect(session?.selectedCandidateId).toBe('candidate_03');
  });

  it('Language parity: provides Sorani Kurdish texts accurately', async () => {
    const presentation = await pickService.presentCandidatePick({
      taskId: 'task_p08_sorani',
      revisionId: 'rev_1',
      actorId: 'user_lead',
      chatId: 1001,
      language: 'ku',
      candidates: mockCandidates,
      secretKey: testHmacSecret,
      tokenService,
    });

    expect(presentation.controlMessage.text).toContain('ستۆدیۆی دیزاین');
    expect(presentation.controlMessage.replyMarkup.inline_keyboard[0][0].text).toContain('بەکارهێنانی ڕەشنووسی #1');
    expect(presentation.controlMessage.replyMarkup.inline_keyboard[0][1].text).toContain('دەستکاری #1');
    expect(presentation.controlMessage.replyMarkup.inline_keyboard[3][0].text).toContain('هیچکام لەمانە');
  });
});
