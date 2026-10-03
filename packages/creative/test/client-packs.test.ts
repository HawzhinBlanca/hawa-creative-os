import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  loadClientPacks,
  parseClientPacks,
  findClientPack,
  matchClientPack,
  defaultCanvasFor,
  clientExemplarManifestPath,
  creativeAssetPath,
  FORMAT_PRESETS,
  ClientPackError,
  type ClientPack,
} from '../src/index.js';

/**
 * Client packs (ADR-127, ported from studio-v2's a5a50dad): clients are data. These are the packs
 * that ship, and the rules every pack obeys. A pack carries no brand authority on this branch: the
 * design reference is the client's active Client DNA.
 */
const KAAE_ID = 'c1000000-0000-4000-8000-000000000002';

const packs = loadClientPacks();
const kaae = findClientPack('kaae')!;
const doc = (pack: object, file?: string) => ({ source: `clients/${file ?? (pack as ClientPack).code}.json`, json: structuredClone(pack) });

describe('the client packs that ship', () => {
  it('are KAAE, the four clients being set up and the nightly canary\'s test client', () => {
    expect(packs.map((p) => p.code)).toEqual(['canary-test', 'erbil-edition', 'halwest-news', 'kaae', 'kawa-ba-hawlery', 'zar-podcast']);
    expect(packs.filter((p) => p.status === 'live').map((p) => p.code)).toEqual(['kaae']);
  });

  it('keep the canary\'s test client (ADR-254) on its fixed row, never drafted automatically, and named only as "Canary Test"', () => {
    const canary = findClientPack('canary-test')!;
    expect(canary.id).toBe('c1000000-0000-4000-8000-000000000099');
    expect(canary.displayName).toBe('Canary Test');
    // An onboarding pack: Core never starts an automatic (paid) draft for it (autoDraftAllowedFor).
    expect(canary.status).toBe('onboarding');
    expect(canary.onboarding.missing).toEqual(expect.arrayContaining(['client-dna', 'logo']));
    expect(canary.exemplars).toBeNull();
    // No chat is bound to it: the canary's third brief must still be asked "who is this for?".
    expect(canary.routing).toEqual({ telegramChatIds: [], latinAliases: ['canary test'], scriptAliases: [], phrases: [] });
    // Its row is in the seed with the same id and code, as the other packs' are.
    const seed = readFileSync(new URL('../../../db/seed.sql', import.meta.url), 'utf8');
    expect(seed).toContain("('c1000000-0000-4000-8000-000000000099'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'canary-test', 'Canary Test', 'en', 'active')");
  });

  it('keep KAAE on its existing row and 4:5 canvas', () => {
    expect(kaae.id).toBe(KAAE_ID);
    expect(defaultCanvasFor(kaae)).toMatchObject({ width: 1080, height: 1350, aspect: '4:5' });
    expect(kaae.playbook).toBe('institutional-announcement');
  });

  it('start the thumbnail clients on a YouTube canvas, with nothing guessed', () => {
    for (const code of ['zar-podcast', 'halwest-news', 'kawa-ba-hawlery', 'erbil-edition']) {
      const pack = findClientPack(code)!;
      expect(pack.status).toBe('onboarding');
      expect(pack.playbook).toBe('video-thumbnail');
      expect(defaultCanvasFor(pack)).toMatchObject({ width: 1280, height: 720, aspect: '16:9' });
      expect(pack.formats).toContain('story-reel');
      // Kurdish spellings and chats come from the office; none is invented.
      expect(pack.routing.scriptAliases).toEqual([]);
      expect(pack.routing.telegramChatIds).toEqual([]);
      expect(pack.onboarding.missing).toEqual(expect.arrayContaining(['logo', 'client-dna', 'kurdish-aliases', 'telegram-chats']));
    }
  });

  it('carry no brand reference: that stays in Client DNA', () => {
    for (const pack of packs) {
      expect(Object.keys(pack)).not.toContain('reference');
      expect(Object.keys(pack)).not.toContain('palette');
    }
    expect(() => parseClientPacks([doc({ ...kaae, reference: { pack: 'kaae-reference.json', logo: 'logos/kaae-official-logo.png' } })]))
      .toThrow(/Unrecognized key/);
  });

  it('name KAAE in the profile the models see exactly as its English name and Client DNA do', () => {
    // Review finding (2026-09-28): studio-v2's profile said "Agency"; the name is "Association".
    const dna = JSON.parse(readFileSync(new URL('../../../config/clients/kaae.dna.json', import.meta.url), 'utf8')) as { identity: { officialName: string } };
    const officialName = dna.identity.officialName;
    expect(kaae.names.en).toBe(officialName);
    expect(kaae.profile).toContain(kaae.names.en);
    expect(kaae.profile).not.toMatch(/Agency/);
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

  it('names the canary\'s test client only by its two words, as the canary writes them (ADR-254)', () => {
    expect(match('Could you design a Canary Test poster for our Amber Reading Workshop? It\'s on 16 November 2026 at 10:00 AM in the Main Hall, Erbil.')).toBe('named:canary-test');
    expect(match("it's for Canary Test")).toBe('named:canary-test');
    expect(match("it's for CANARY TEST")).toBe('named:canary-test');
    // "canary" alone is a colour and a bird, never the client.
    expect(match('a canary yellow background please')).toBe('none');
    expect(match('it\'s for canary')).toBe('none');
    expect(match('canary testing day')).toBe('none');
  });

  it('names a client by its own full name, as a whole name (brief phrasing fuzz, 2026-10-03, class 8)', () => {
    expect(match('It is for the Kurdistan Accrediting Association for Education.')).toBe('named:kaae');
    expect(match('a flyer for Kurdistan Accrediting Association for Education')).toBe('named:kaae');
    expect(match('kurdistan accrediting\nassociation for education')).toBe('named:kaae');
    expect(match('the Kurdistan-Accrediting Association for Education conference')).toBe('named:kaae');
    expect(match("the Kurdistan Accrediting Association's annual conference")).toBe('named:kaae');
    // Part of the name is not the name; nor is a name with another word inside it.
    expect(match('the Kurdistan Association of Engineers dinner')).toBe('none');
    expect(match('Kurdistan Association for Education')).toBe('none');
    expect(match('Kurdistan Accrediting body')).toBe('none');
    // Every pack's name routes, not only KAAE's: a name the aliases leave out still names its client.
    const zar = packs.find((p) => p.code === 'zar-podcast')!;
    const renamed = packs.map((p) => (p === zar ? { ...p, names: { en: 'Zar Talks Weekly' }, routing: { ...p.routing, latinAliases: ['zarpodcast'] } } : p));
    expect(match('thumbnail for zar talks weekly episode 4', undefined, renamed)).toBe('named:zar-podcast');
    expect(match('thumbnail for zar talks', undefined, renamed)).toBe('none');
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

describe("a client's own exemplars (ported from studio-v2 24a787cd)", () => {
  it("are KAAE's manifest for KAAE, and none for a client being set up", () => {
    expect(kaae.exemplars).toBe('kaae-exemplars.json');
    expect(clientExemplarManifestPath(kaae)).toBe(creativeAssetPath('kaae-exemplars.json'));
    for (const code of ['zar-podcast', 'halwest-news', 'kawa-ba-hawlery', 'erbil-edition']) {
      const pack = findClientPack(code)!;
      expect(pack.exemplars).toBeNull();
      expect(clientExemplarManifestPath(pack)).toBeUndefined();
      expect(pack.onboarding.missing).toContain('exemplars');
    }
  });

  it('are refused for a client being set up, or when two packs claim one manifest', () => {
    const zar = findClientPack('zar-podcast')!;
    expect(() => parseClientPacks([doc({ ...zar, exemplars: 'zar-exemplars.json' })])).toThrow(/only a live client has confirmed exemplars/);
    const twin = { ...kaae, id: 'c1000000-0000-4000-8000-0000000000ff', code: 'kaae-twin', routing: { ...kaae.routing, latinAliases: [], phrases: [] } };
    expect(() => parseClientPacks([doc(kaae), doc(twin)])).toThrow(/exemplar manifest "kaae-exemplars.json" is claimed by both/);
  });
});

describe('a pack that breaks the rules is refused at load', () => {
  const zar = findClientPack('zar-podcast')!;

  it('when two packs claim the same word', () => {
    const clash = { ...zar, routing: { ...zar.routing, latinAliases: ['kaae'] } };
    expect(() => parseClientPacks([doc(kaae), doc(clash)])).toThrow(/alias "kaae" is claimed by both/);
  });

  it('when one pack\'s full name is another\'s alias', () => {
    const clash = { ...zar, routing: { ...zar.routing, latinAliases: ['kurdistan accrediting association for education'] } };
    expect(() => parseClientPacks([doc(kaae), doc(clash)])).toThrow(/is claimed by both/);
  });

  it('when two packs claim the same chat or id', () => {
    const a = { ...zar, routing: { ...zar.routing, telegramChatIds: ['-100777'] } };
    const erbil = findClientPack('erbil-edition')!;
    const b = { ...erbil, routing: { ...erbil.routing, telegramChatIds: ['-100777'] } };
    expect(() => parseClientPacks([doc(a), doc(b)])).toThrow(/telegram chat "-100777"/);
    expect(() => parseClientPacks([doc(kaae), doc({ ...zar, id: KAAE_ID })])).toThrow(/id "c1000000-0000-4000-8000-000000000002"/);
  });

  it('when a live client still lists something missing, or an onboarding one lists nothing', () => {
    expect(() => parseClientPacks([doc({ ...zar, status: 'live' })])).toThrow(ClientPackError);
    expect(() => parseClientPacks([doc({ ...kaae, onboarding: { missing: ['logo'] } })])).toThrow(/a live client lists nothing missing/);
    expect(() => parseClientPacks([doc({ ...zar, onboarding: { missing: [] } })])).toThrow(/lists what it still needs/);
  });

  it('when the default format is not one it orders, or the file is misnamed', () => {
    expect(() => parseClientPacks([doc({ ...zar, defaultFormat: 'social-square' })])).toThrow(/defaultFormat social-square/);
    expect(() => parseClientPacks([doc(zar, 'zar')])).toThrow(/named after the pack's code/);
  });
});
