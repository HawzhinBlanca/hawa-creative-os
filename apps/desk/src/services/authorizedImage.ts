import { useEffect, useState } from 'react';
import { getAuthHeaders } from './auth.js';

/**
 * Pictures Core serves behind sign-in (ADR-035): a task's export, a studio candidate's preview, a
 * reference photo. An <img src> sends no Authorization header, so these tags used to show nothing
 * (or relied on an access_token in the query string, which is being retired). The hook fetches the
 * picture with the session's header and hands the <img> an object URL instead.
 *
 * The addresses are immutable (the file's hash or the export's id is in them), so one fetch serves
 * every component that shows the same address while any of them is mounted; the object URL is
 * revoked when the last of them unmounts. data: and blob: URLs are passed through untouched.
 */

interface Entry {
  users: number;
  promise: Promise<string>;
  objectUrl?: string;
}

const entries = new Map<string, Entry>();

function passThrough(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('blob:');
}

async function load(url: string): Promise<string> {
  const res = await fetch(url, { headers: getAuthHeaders(), credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

function acquire(url: string): Entry {
  let entry = entries.get(url);
  if (!entry) {
    const created: Entry = { users: 0, promise: Promise.resolve('') };
    created.promise = load(url).then((objectUrl) => {
      created.objectUrl = objectUrl;
      // Everyone left while it loaded: nothing will release it, so it goes now.
      if (created.users === 0 && entries.get(url) !== created) URL.revokeObjectURL(objectUrl);
      return objectUrl;
    });
    // A failed load is forgotten, so the next mount asks again (a session renewed, Core back).
    created.promise.catch(() => {
      if (entries.get(url) === created) entries.delete(url);
    });
    entry = created;
    entries.set(url, entry);
  }
  entry.users++;
  return entry;
}

function release(url: string, entry: Entry): void {
  entry.users--;
  if (entry.users > 0 || entries.get(url) !== entry) return;
  entries.delete(url);
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
}

export interface AuthorizedImage {
  /** What to put in <img src>: undefined until it has loaded, or when there is no picture. */
  src?: string;
  /** The picture could not be fetched (a 404, a signed-out session, no network). */
  failed: boolean;
}

export function useAuthorizedImage(url?: string | null): AuthorizedImage {
  const direct = url && passThrough(url) ? url : undefined;
  const [state, setState] = useState<{ url?: string | null; src?: string; failed: boolean }>({ url, failed: false });

  useEffect(() => {
    if (!url || passThrough(url)) return;
    let live = true;
    const entry = acquire(url);
    setState({ url, failed: false });
    entry.promise.then(
      (src) => live && setState({ url, src, failed: false }),
      () => live && setState({ url, failed: true })
    );
    return () => {
      live = false;
      release(url, entry);
    };
  }, [url]);

  if (!url) return { failed: false };
  if (direct) return { src: direct, failed: false };
  // A state left from the previous address is not this one's.
  return state.url === url ? { src: state.src, failed: state.failed } : { failed: false };
}

/** How many addresses are held, for tests. */
export function authorizedImageEntries(): number {
  return entries.size;
}
