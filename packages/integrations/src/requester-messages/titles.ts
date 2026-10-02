/**
 * ADR-231: a design's name as a requester reads it, the same everywhere the bot names it (Core's
 * answers, RequestLifecycle's notices, the delivered files' captions).
 *
 * Titles stored on 2026-10-01 carried a right-to-left mark before Latin copy ("‏KAAE K-12 Pilot
 * Study…"), and the delivery's title named the client twice ("KAAE: ‏KAAE K-12 Pilot Study…"). The
 * caption the requester received read "‏KAAE K-12 Pilot Study…, final". A direction mark at the
 * edge of a name is invisible, but it moves the punctuation around the name in a line of the other
 * direction and makes two equal names compare different.
 */

/** Direction marks: LRM, RLM, ALM, the embeddings and overrides, the isolates, and a stray BOM. */
const EDGE_MARKS = /^[\s‎‏؜‪-‮⁦-⁩﻿]+|[\s‎‏؜‪-‮⁦-⁩﻿]+$/gu;

/** A title without direction marks or spaces at its edges, nor at the edges of the part after "Client: ". */
export function trimTitleMarks(value: string | null | undefined): string {
  const title = String(value ?? '').replace(EDGE_MARKS, '');
  const m = /^([^:\n]{1,40}):([\s\S]*)$/u.exec(title);
  if (!m) return title;
  const client = m[1].replace(EDGE_MARKS, '');
  const name = m[2].replace(EDGE_MARKS, '');
  return client && name ? `${client}: ${name}` : (client || name);
}

/** The length a request title's name is cut at (Core's `requestTitle`); "…" marks a cut. */
export const TITLE_CUT_LENGTH = 45;
const ELLIPSIS_BEFORE_PART = /^([\s\S]+?)…(\s\(\d+\/\d+\))?$/u;

/**
 * ADR-255 (live 2026-10-02): titles stored before ADR-255 end in "…" even when nothing was cut, so a
 * requester read "Harvest Fair… (1/2)". A name shorter than the cut is shown whole, without it; a
 * "(1/2)" part number stays.
 */
export function withoutDecorativeEllipsis(name: string): string {
  const m = ELLIPSIS_BEFORE_PART.exec(name);
  return m && Array.from(m[1]).length < TITLE_CUT_LENGTH ? `${m[1].trimEnd()}${m[2] ?? ''}` : name;
}

/**
 * The name a requester reads: the office's "Client: " prefix dropped, no direction mark at its edges,
 * spaces collapsed, at most 60 characters. Empty for a request named neutrally ("New design request from
 * Sewa", ADR-200 addendum) or with no name: callers then say "your design".
 */
export function requesterTitleName(value: unknown): string {
  const name = withoutDecorativeEllipsis(trimTitleMarks(String(value ?? '')).replace(/^[^:]{1,40}:\s*/u, '').replace(EDGE_MARKS, '').replace(/\s+/g, ' ').trim());
  if (!name || /^New design request from\s/.test(name)) return '';
  return Array.from(name).length > 60 ? `${Array.from(name).slice(0, 59).join('')}…` : name;
}
