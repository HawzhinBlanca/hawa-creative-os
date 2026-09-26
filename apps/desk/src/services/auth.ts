/**
 * Desk Authentication Helper
 *
 * Provides dynamic in-memory and ephemeral session token retrieval for API requests.
 * Tokens are strictly never written to localStorage by setAuthToken to prevent credential leakage.
 */

const TOKEN_KEY = 'hawa_operator_token';

let inMemoryToken: string | null = null;

export function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)hawa_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function hasCookieSession(): boolean {
  return Boolean(getCsrfToken());
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return inMemoryToken;

  // A completed Google sign-in owns this browser session. Discard a key left in this tab by
  // an earlier shared-key sign-in so requests cannot silently act as that older identity.
  if (hasCookieSession()) {
    inMemoryToken = null;
    try {
      window.localStorage?.removeItem(TOKEN_KEY);
      window.sessionStorage?.removeItem(TOKEN_KEY);
    } catch { /* A blocked storage API does not override the cookie identity. */ }
    return null;
  }

  const runtimeConfigToken = (window as any).__HAWA_CONFIG__?.apiToken;
  if (runtimeConfigToken) return runtimeConfigToken;

  if (window.sessionStorage) {
    const sessionToken = window.sessionStorage.getItem(TOKEN_KEY);
    if (sessionToken) return sessionToken;
  }

  // Backwards compatibility for test fixtures stubbing localStorage
  if (window.localStorage) {
    const legacyToken = window.localStorage.getItem(TOKEN_KEY);
    if (legacyToken) return legacyToken;

    // Both sessionStorage and localStorage are present and empty -> signed out
    return null;
  }

  return inMemoryToken;
}

export function setAuthToken(token: string): void {
  inMemoryToken = token;
  if (typeof window === 'undefined') return;

  // Explicitly ensure token is NOT written to localStorage (purges if previously present)
  try {
    window.localStorage?.removeItem(TOKEN_KEY);
    window.sessionStorage?.setItem(TOKEN_KEY, token);
  } catch {
    // Session storage fallback
  }
}

export function clearAuthToken(): void {
  inMemoryToken = null;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.removeItem(TOKEN_KEY);
    window.sessionStorage?.removeItem(TOKEN_KEY);
    document.cookie = 'hawa_csrf=; Max-Age=0; Path=/; Secure; SameSite=Strict';
  } catch {
    // Ignore
  }
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
