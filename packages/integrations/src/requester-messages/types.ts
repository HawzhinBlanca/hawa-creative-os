/** The shapes of the requester message catalogue (index.ts). */
export type RequesterLang = 'en' | 'ckb';

/** One thing the bot can say, in both languages. */
export interface Phrase {
  en: string;
  ckb: string;
}

/** A section of the catalogue: named phrases. */
export type PhraseBook = Record<string, Phrase>;
