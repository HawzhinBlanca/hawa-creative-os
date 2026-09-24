/**
 * Whether this tab is signed in, and why it is not (ADR-037, 2026-09-24).
 *
 * The Desk used to learn that a session had ended in the Work screen alone: each 401 called every
 * listener, and the listener lived in the Work screen, so on any other screen an expired session left
 * the Desk showing stale data and failing quietly. Now the query cache's error handler ends the
 * session here, once however many reads failed together: the token is dropped, the cached answers
 * are cleared, the live stream is closed, and the App shows sign-in in place of whatever screen was
 * open.
 */

export type SessionStatus = 'signed_in' | 'signed_out';

export interface SessionState {
  status: SessionStatus;
  /** Why the tab was signed out, for the sign-in prompt; null for a tab that never signed in or signed out itself. */
  reason: string | null;
  /** How many times a session has ended in this tab (each end shows sign-in once). */
  ended: number;
}

export interface DeskSession {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** A 401 from Core: signs the tab out with Core's reason. Does nothing when already signed out. */
  end(reason: string): void;
  /** The office member pressed Sign Out (the server call is the caller's). */
  signOut(): void;
  /** A sign-in succeeded and the token is stored. */
  signedIn(): void;
}

export interface SessionEffects {
  /** Whether a token is stored now. */
  hasToken(): boolean;
  /** Drops the stored token. */
  clearToken(): void;
  /** Everything else a signed-out tab must stop: the cache and the live stream. */
  onSignedOut(): void;
  /** And what a signed-in tab starts. */
  onSignedIn(): void;
}

export function createDeskSession(effects: SessionEffects): DeskSession {
  let state: SessionState = { status: effects.hasToken() ? 'signed_in' : 'signed_out', reason: null, ended: 0 };
  const listeners = new Set<() => void>();
  const set = (next: SessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const leave = (reason: string | null, ended: number) => {
    effects.clearToken();
    set({ status: 'signed_out', reason, ended });
    effects.onSignedOut();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    end(reason) {
      if (state.status === 'signed_out') return;
      const hadSession = effects.hasToken();
      leave(
        hadSession
          ? `Your session has ended (Core answered: ${reason}). Sign in again to continue.`
          : 'Authentication required: sign in to continue.',
        state.ended + 1
      );
    },
    signOut() {
      if (state.status === 'signed_out') return;
      leave(null, state.ended);
    },
    signedIn() {
      set({ status: 'signed_in', reason: null, ended: state.ended });
      effects.onSignedIn();
    },
  };
}
