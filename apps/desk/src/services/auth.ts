/**
 * Desk Authentication Helper
 *
 * Provides dynamic session token retrieval for API requests.
 * Replaces hardcoded bearer token strings.
 */

const TOKEN_KEY = 'hawa_operator_token';

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as any).__HAWA_CONFIG__?.apiToken ||
    window.sessionStorage?.getItem(TOKEN_KEY) ||
    window.localStorage?.getItem(TOKEN_KEY) ||
    null
  );
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.sessionStorage?.removeItem(TOKEN_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
