import { describe, it, expect } from 'vitest';
import {
  loadClientPacks,
  parseClientPacks,
  findClientPack,
  matchClientPack,
  loadClientReference,
  defaultCanvasFor,
  FORMAT_PRESETS,
  ClientPackError,
  type ClientPack,
} from '../src/index.js';

/** ADR-038: clients are data. These are the packs that ship, and the rules every pack obeys. */
const KAAE_ID = 'c1000000-0000-4000-8000-000000000002';

const packs = loadClientPacks();
const kaae = findClientPack('kaae')!;
const doc = (pack: object, file?: string) => ({ source: `clients/${file ?? (pack as ClientPack).code}.json`, json: structuredClone(pack) });

describe('the client packs that ship', () => {
  it('are KAAE and the four clients being set up', () => {
    expect(packs.map((p) => p.code)).toEqual(['erbil-edition', 'halwest-news', 'kaae', 'kawa-ba-hawlery', 'zar-podcast']);
    // A second live client first needs the renderer's KAAE logo default removed (ADR-038, section 3).
    expect(packs.filter((p) => p.status === 'live').map((p) => p.code), 'see ADR-038 before setting a second client live').toEqual(['kaae']);
  });

  it('keep KAAE on its existing row, reference pack and logo', () => {
    expect(kaae.id).toBe(KAAE_ID);
    const { reference, logo } = loadClientReference(kaae);
    expect(reference.clientId).toBe(KAAE_ID);
    expect(logo.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(defaultCanvasFor(kaae)).toMatchObject({ width: 1080, height: 1350, aspect: '4:5' });
  });

  it('start the thumbnail clients on a YouTube canvas, with nothing guessed', () => {
    for (const code of ['zar-podcast', 'halwest-news', 'kawa-ba-hawlery', 'erbil-edition']) {
      const pack = findClientPack(code)!;
      expect(pack.status).toBe('onboarding');
      expect(pack.playbook).toBe('video-thumbnail');
      expect(defaultCanvasFor(pack)).toMatchObject({ width: 1280, height: 720, aspect: '16:9' });
      expect(pack.formats).toContain('story-reel');
      expect(pack.reference).toBeNull();
      // Kurdish spellings and chats come from the office; none is invented.
      expect(pack.routing.scriptAliases).toEqual([]);
      expect(pack.routing.telegramChatIds).toEqual([]);
      expect(pack.onboarding.missing).toEqual(expect.arrayContaining(['logo', 'reference-pack', 'kurdish-aliases', 'telegram-chats']));
      expect(() => loadClientReference(pack)).toThrow(/no verified reference pack/);
    }
  });

  it('are found by id, code or the legacy client-<code> form', () => {
    expect(findClientPack(KAAE_ID)?.code).toBe('kaae');
    expect(findClientPack('client-kaae')?.code).toBe('kaae');
    expect(findClientPack('ZAR-PODCAST')?.code).toBe('zar-podcast');
    expect(findClientPack('client-fastpay')).toBeUndefined();
    expect(findClientPack(null)).toBeUndefined();
  });

  it('use canvases the studio accepts', () => {
    for (const preset of Object.values(FORMAT_PRESETS)) {
      expect(preset.width).toBeGreaterThanOrEqual(640);
      expect(preset.height).toBeLessThanOrEqual(2400);
    }
  });
});

describe('which client a request belongs to', () => {
  const match = (rawText: string, chatId?: string, from: ClientPack[] = packs) => {
    const m = matchClientPack({ rawText, chatId }, from);
    return m.kind === 'chat' || m.kind === 'named' ? `${m.kind}:${m.pack.code}` : m.kind === 'ambiguous' ? `ambiguous:${m.packs.map((p) => p.code).join(',')}` : 'none';
  };

  it('reads KAAE exactly as intake did before packs', () => {
    expect(match('Poster for KAAE conference')).toBe('named:kaae');
    expect(match('پۆستەرێک بۆ KAAEی')).toBe('named:kaae');
    expect(match('ڕاگەیاندنی باوەڕپێدان')).toBe('named:kaae');
    expect(match('University open day')).toBe('named:kaae');
    expect(match('kaaeish thing')).toBe('none');
  });

  it('names the new clients by their English names only', () => {
    expect(match('New episode thumbnail for ZAR Podcast, guest Ahmed')).toBe('named:zar-podcast');
    expect(match('thumbnail zarpodcast ep 14')).toBe('named:zar-podcast');
    expect(match('Halwest News breaking thumbnail')).toBe('named:halwest-news');
    expect(match('Kawa  ba Hawlery episode 3')).toBe('named:kawa-ba-hawlery');
    expect(match('Erbil Edition cover')).toBe('named:erbil-edition');
    // "zar" alone and "Erbil" alone are ordinary words, not clients.
    expect(match('the zar exchange rate')).toBe('none');
    expect(match('events in Erbil this week')).toBe('none');
  });

  it('routes nowhere when a message names two clients', () => {
    expect(match('KAAE interview on Erbil Edition')).toBe('ambiguous:erbil-edition,kaae');
  });

  it('routes a bound chat to its client before reading any word', () => {
    const bound = packs.map((p) => (p.code === 'halwest-news' ? { ...p, routing: { ...p.routing, telegramChatIds: ['-1001234567890'] } } : p));
    expect(match('Poster for KAAE conference', '-1001234567890', bound)).toBe('chat:halwest-news');
    expect(match('Poster for KAAE conference', '555', bound)).toBe('named:kaae');
  });
});

describe('a pack that breaks the rules is refused at load', () => {
  const zar = findClientPack('zar-podcast')!;

  it('when two packs claim the same word', () => {
    const clash = { ...zar, routing: { ...zar.routing, latinAliases: ['kaae'] } };
    expect(() => parseClientPacks([doc(kaae), doc(clash)])).toThrow(/alias "kaae" is claimed by both/);
  });

  it('when two packs claim the same chat or id', () => {
    const a = { ...zar, routing: { ...zar.routing, telegramChatIds: ['-100777'] } };
    const b = { ...findClientPack('erbil-edition')!, routing: { ...findClientPack('erbil-edition')!.routing, telegramChatIds: ['-100777'] } };
    expect(() => parseClientPacks([doc(a), doc(b)])).toThrow(/telegram chat "-100777"/);
    expect(() => parseClientPacks([doc(kaae), doc({ ...zar, id: KAAE_ID })])).toThrow(/id "c1000000-0000-4000-8000-000000000002"/);
  });

  it('when a live client has no reference, or still lists something missing', () => {
    expect(() => parseClientPacks([doc({ ...zar, status: 'live' })])).toThrow(ClientPackError);
    expect(() => parseClientPacks([doc({ ...kaae, onboarding: { missing: ['logo'] } })])).toThrow(/a live client needs/);
  });

  it("when a reference pack belongs to another client", () => {
    const borrowed = { ...zar, status: 'live', reference: kaae.reference, onboarding: { missing: [] } };
    expect(() => parseClientPacks([doc(borrowed)])).toThrow(/belongs to client c1000000-0000-4000-8000-000000000002, not zar-podcast/);
  });

  it('when the default format is not one it orders, or the file is misnamed', () => {
    expect(() => parseClientPacks([doc({ ...zar, defaultFormat: 'social-square' })])).toThrow(/defaultFormat social-square/);
    expect(() => parseClientPacks([doc(zar, 'zar')])).toThrow(/named after the pack's code/);
  });
});
