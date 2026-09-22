import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { globalFeedbackMiner } from '@hawa/creative';
import { createApp } from '../src/app.js';
import { detectFontRequests, unavailableFontNotice } from '../src/services/feedback-font-request.js';

/**
 * A reviewer wrote "we want to use Calibri for Kurdish". The handler used to answer with a canned
 * rule naming Cinzel, Playfair Display and Plus Jakarta Sans, record it against the client, and
 * print it back to the sender as their applied preference. Calibri is not a face the studio has,
 * and nothing in the message said Cinzel.
 *
 * The first block tests the detector against the real font registry. The second sends the message
 * through the Telegram webhook with a captured bridge and reads what the sender is told.
 */

const KAAE_CLIENT_ID = 'c1000000-0000-4000-8000-000000000002';

describe('detectFontRequests: the face a reviewer named', () => {
  it('reads Calibri for Kurdish as a request the studio cannot meet, and offers what it has', () => {
    const [req, ...rest] = detectFontRequests('we wanna use Calibri font for kurdish here and there');
    expect(rest).toEqual([]);
    expect(req.family).toBe('Calibri');
    expect(req.script).toBe('arabic');
    expect(req.available).toBe(false);
    expect(req.alternatives).toContain('Noto Sans Arabic');
    expect(req.alternatives).not.toContain('Verdana');
    expect(req.alternatives).not.toContain('Cairo');
    expect(req.alternatives).not.toContain('Calibri');
    const notice = unavailableFontNotice(req);
    expect(notice).toMatch(/Calibri is not installed/);
    expect(notice).toMatch(/Kurdish and Arabic/);
    expect(notice).not.toMatch(/Cinzel/);
  });

  it('reads an installed face as available, on the script it is admitted for', () => {
    const [amiri] = detectFontRequests('use Amiri for the Kurdish title');
    expect(amiri).toMatchObject({ family: 'Amiri', script: 'arabic', available: true, admittedFor: 'arabic' });
    const [cinzel] = detectFontRequests('use Cinzel for headers');
    expect(cinzel).toMatchObject({ family: 'Cinzel', script: 'unspecified', available: true, admittedFor: 'latin' });
  });

  it('refuses an installed face asked for on a script it does not cover', () => {
    const [req] = detectFontRequests('Cinzel for the Kurdish body text');
    expect(req.family).toBe('Cinzel');
    expect(req.available).toBe(false);
    expect(req.alternatives).toContain('Amiri');
  });

  it('resolves a registry alias to the admitted family, and keeps what was asked for', () => {
    const [req] = detectFontRequests('can we try Cormorant Garamond');
    expect(req).toMatchObject({ family: 'Cinzel', askedAs: 'Cormorant Garamond', available: true });
    const [short] = detectFontRequests('use Playfair for the headers');
    expect(short).toMatchObject({ family: 'Playfair Display', askedAs: 'Playfair', available: true });
  });

  it('does not read a venue, a name or a broadcaster as a font', () => {
    expect(detectFontRequests('the venue is in Dubai, move it under the date')).toEqual([]);
    expect(detectFontRequests('Georgia will attend; add the NRT logo')).toEqual([]);
    expect(detectFontRequests('inter alia the date is wrong')).toEqual([]);
    // With a type cue the same word is a font again.
    expect(detectFontRequests('use the Dubai font for Arabic')[0]).toMatchObject({ family: 'Dubai', available: false });
  });

  it('offers only faces whose files draw the Kurdish letters', () => {
    const [req] = detectFontRequests('please use Cairo for Kurdish');
    // Cairo is admitted by flag but its file lacks ڕ ڵ ۆ ێ ە on this host (registry note, 2026-09-20).
    expect(req.family).toBe('Cairo');
    expect(req.available).toBe(false);
    expect(req.alternatives).not.toContain('Cairo');
    expect(req.alternatives).toEqual(expect.arrayContaining(['Amiri', 'Noto Sans Arabic', 'IBM Plex Sans Arabic']));
  });

  it('reads the script from the sender\'s words, not from the family name', () => {
    const [req] = detectFontRequests('use IBM Plex Sans Arabic for the English text');
    expect(req).toMatchObject({ family: 'IBM Plex Sans Arabic', script: 'latin', available: false });
  });

  it('does not read "Arabic" inside "Noto Sans Arabic" as a second request, and reads Sorani as Kurdish', () => {
    const reqs = detectFontRequests('Noto Sans Arabic for Sorani please');
    expect(reqs.map((r) => r.family)).toEqual(['Noto Sans Arabic']);
    expect(reqs[0]).toMatchObject({ script: 'arabic', available: true });
  });

  it('names nothing when no face is named', () => {
    expect(detectFontRequests('make the font bigger')).toEqual([]);
    expect(detectFontRequests('the colours are wrong')).toEqual([]);
  });
});

describe('Telegram feedback that asks for a font', () => {
  const telegramSecret = ['font', 'request', 'fixture', 'secret'].join('_');
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = telegramSecret;
  });
  afterAll(() => {
    process.env = saved;
  });

  const post = (app: any, chat: number, updateId: number, text: string) =>
    app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': telegramSecret },
      body: JSON.stringify({
        update_id: updateId,
        message: { message_id: updateId, from: { id: chat, is_bot: false, first_name: 'Office' }, chat: { id: chat, type: 'private' }, text },
      }),
    });

  it('tells the sender Calibri is not installed, applies nothing in its place, and proposes no rule', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const intake = await post(app, 910001, 910001, 'KAAE Annual Research Conference 2026');
    expect(intake.status).toBe(201);
    const { task } = await intake.json();
    const rulesBefore = globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length;

    const res = await post(app, 910001, 910002, `revise task ${task.id}: we wanna use Calibri font for kurdish here and there`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feedback).toBe(true);
    expect(body.unavailableFonts).toEqual([expect.objectContaining({ family: 'Calibri', script: 'arabic' })]);
    expect(body.unavailableFonts[0].alternatives).toContain('Noto Sans Arabic');
    // Nothing was applied to the design in Calibri's place: the rules on the task are the client's
    // standing ones and nothing else.
    const standing = globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID);
    const fromThisMessage = body.learnedRules.filter((r: string) => !standing.includes(r));
    expect(fromThisMessage).toEqual([]);
    expect(body.proposedRules).toEqual([]);
    expect(globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length).toBe(rulesBefore);

    const texts = dispatch.mock.calls.map((call) => String(call[1]?.text ?? ''));
    const refusal = texts.find((t) => /Calibri is not installed/.test(t));
    expect(refusal).toBeDefined();
    expect(refusal).toMatch(/Noto Sans Arabic/);
    expect(texts.join('\n')).not.toMatch(/Cinzel|Applied Preferences/);
  });

  it('applies an installed face to this design once, and says it was not made a standing rule', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const { task } = await (await post(app, 910002, 910003, 'KAAE Curriculum Framework')).json();
    const rulesBefore = globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length;

    const body = await (await post(app, 910002, 910004, `revise task ${task.id}: use Amiri for the Kurdish text`)).json();
    expect(body.scope).toBe('one_time');
    expect(body.learnedRules).toContain('Set Kurdish and Arabic text in Amiri.');
    expect(body.unavailableFonts).toEqual([]);
    expect(body.proposedRules).toEqual([]);
    expect(globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length).toBe(rulesBefore);
    const texts = dispatch.mock.calls.map((call) => String(call[1]?.text ?? '')).join('\n');
    expect(texts).not.toMatch(/Font not available/);
  });

  it('a complaint that happens to say "always" or "every time" is not a standing rule', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const { task } = await (await post(app, 910004, 910007, 'KAAE Board Meeting')).json();
    const before = globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length;
    for (const text of ['the logo always looks cramped', 'every time I open it the text overlaps', 'ئەم ناونیشانە هەمیشە زۆر بچووکە']) {
      const body = await (await post(app, 910004, 910008, `revise task ${task.id}: ${text}`)).json();
      expect(body.scope).toBe('one_time');
      expect(body.proposedRules).toEqual([]);
    }
    expect(globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).length).toBe(before);
  });

  it('"from now on" proposes a standing rule that waits for promotion', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const { task } = await (await post(app, 910003, 910005, 'KAAE Graduation Ceremony')).json();

    const body = await (await post(app, 910003, 910006, `revise task ${task.id}: from now on use IBM Plex Sans Arabic for all Kurdish text`)).json();
    expect(body.scope).toBe('client');
    expect(body.proposedRules).toContain('Set Kurdish and Arabic text in IBM Plex Sans Arabic.');
    // The sender's words are proposed as written, beside the derived font rule; no canned sentence.
    expect(body.proposedRules).toContain(`revise task ${task.id}: from now on use IBM Plex Sans Arabic for all Kurdish text`);
    expect(JSON.stringify(body.proposedRules)).not.toMatch(/Cinzel|authentic master brand seal|Direct all design reviews/);
    const proposed = globalFeedbackMiner.getCandidateRules(KAAE_CLIENT_ID).find((r) => r.ruleText === 'Set Kurdish and Arabic text in IBM Plex Sans Arabic.');
    expect(proposed?.status).toBe('PROPOSED');
    expect(globalFeedbackMiner.getPromotedRules(KAAE_CLIENT_ID)).not.toContain(proposed!.ruleText);
  });
});
