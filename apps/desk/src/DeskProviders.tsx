import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { QueryClientProvider, useQuery, type QueryClient } from '@tanstack/react-query';
import { apiClient } from './api/client.js';
import { clearAuthToken, getAuthToken, hasCookieSession } from './services/auth.js';
import { createDeskQueryClient, queryKeys } from './services/queryClient.js';
import { createDeskSession, type DeskSession, type SessionState } from './services/session.js';
import { clearPwaCaches } from './services/serviceWorker.js';
import { bridgeTaskEvents, pollIntervalFor, useStreamStatus, type LiveEventSource, type VisibilitySource } from './services/liveUpdates.js';

/**
 * What one Desk tab shares (ADR-037): one query cache, one session, one event stream. main.tsx makes
 * the real ones; a test passes a fake stream and document.
 */
export interface DeskRuntime {
  queryClient: QueryClient;
  session: DeskSession;
  stream: LiveEventSource;
  doc?: VisibilitySource;
}

export function createDeskRuntime(input: { stream: LiveEventSource; doc?: VisibilitySource }): DeskRuntime {
  const { stream, doc } = input;
  let queryClient: QueryClient | undefined;
  const session = createDeskSession({
    hasToken: () => Boolean(getAuthToken()) || hasCookieSession(),
    clearToken: clearAuthToken,
    // A signed-out tab keeps no answer read with the old session and listens to nothing. That includes
    // the service worker's copies of /v1/ reads, which stayed readable in Cache Storage after sign-out
    // on a shared machine (audit 2026-09-27 #21).
    onSignedOut: () => {
      stream.disconnect();
      queryClient?.clear();
      void clearPwaCaches().catch((err: unknown) => console.warn('[PWA] Could not clear the offline copies at sign-out:', err));
    },
    onSignedIn: () => stream.connect(),
  });
  // The one 401 handler: every query and mutation that meets a 401 ends up here; the session ends
  // once, whatever number of reads failed together.
  queryClient = createDeskQueryClient((error) => session.end(error.message));
  return { queryClient, session, stream, doc };
}

const DeskContext = createContext<DeskRuntime | null>(null);

export const DeskProviders: React.FC<{ runtime: DeskRuntime; children: React.ReactNode }> = ({ runtime, children }) => {
  useEffect(() => {
    const { queryClient, session, stream, doc } = runtime;
    const stopBridge = bridgeTaskEvents({ queryClient, stream, doc });
    // A 401 met outside a query (a panel's action, a screen not on the query layer yet) asks for the
    // session again; if it has ended, that read's 401 signs the tab out through the handler above.
    apiClient.auth.setUnauthorizedHint(() => {
      if (session.getState().status === 'signed_in') {
        void queryClient.refetchQueries({ queryKey: queryKeys.session }, { cancelRefetch: false });
      }
    });
    if (session.getState().status === 'signed_in') stream.connect();
    return () => {
      stopBridge();
      apiClient.auth.setUnauthorizedHint(null);
    };
  }, [runtime]);

  return (
    <QueryClientProvider client={runtime.queryClient}>
      <DeskContext.Provider value={runtime}>{children}</DeskContext.Provider>
    </QueryClientProvider>
  );
};

export function useDesk(): DeskRuntime {
  const runtime = useContext(DeskContext);
  if (!runtime) throw new Error('useDesk() needs <DeskProviders>');
  return runtime;
}

export function useSessionState(): SessionState {
  const { session } = useDesk();
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

/** The live stream's status, and the poll interval a stream-fed query uses (none while it is up). */
export function usePollInterval(): number | false {
  const { stream } = useDesk();
  return pollIntervalFor(useStreamStatus(stream));
}

/**
 * The signed-in user (GET /auth/session). The App keeps this read mounted while signed in, so an
 * ended session is noticed on any screen: when the tab is shown again after 30 s, every 30 s while
 * the stream is down, and when a call outside the query layer meets a 401.
 */
export function useSessionUser() {
  const signedIn = useSessionState().status === 'signed_in';
  const refetchInterval = usePollInterval();
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiClient.auth.getSession(),
    enabled: signedIn,
    refetchInterval,
    select: (session) => (session.authenticated && session.user ? session.user : null),
  });
}
