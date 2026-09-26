import * as oidc from 'openid-client';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

export interface GoogleOidcSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  hostedDomains: readonly string[];
}

export interface OfficeOidcIdentity {
  subject: string;
  email: string;
  displayName: string;
  hostedDomain: string;
}

export interface OfficeOidcProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  exchange(input: { callbackQuery: string; state: string; nonce: string; codeVerifier: string }): Promise<OfficeOidcIdentity>;
}

/** A partially entered identity configuration must not leave shared-key review enabled. */
export function namedOfficeReviewMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['HAWA_GOOGLE_OIDC_CLIENT_ID', 'HAWA_GOOGLE_OIDC_CLIENT_SECRET',
    'HAWA_GOOGLE_OIDC_REDIRECT_URI', 'HAWA_GOOGLE_OIDC_HOSTED_DOMAINS']
    .some((key) => Boolean(env[key]?.trim()));
}

/** An incomplete identity-provider configuration cannot accidentally enable the login route. */
export function googleOidcSettings(env: NodeJS.ProcessEnv = process.env): GoogleOidcSettings | null {
  const clientId = (env.HAWA_GOOGLE_OIDC_CLIENT_ID || '').trim();
  const clientSecret = (env.HAWA_GOOGLE_OIDC_CLIENT_SECRET || '').trim();
  const redirectUri = (env.HAWA_GOOGLE_OIDC_REDIRECT_URI || '').trim();
  const hostedDomains = (env.HAWA_GOOGLE_OIDC_HOSTED_DOMAINS || '').split(',')
    .map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!clientId || !clientSecret || !redirectUri || hostedDomains.length === 0 ||
      hostedDomains.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) return null;
  try {
    const callback = new URL(redirectUri);
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
        !callback.pathname.endsWith('/auth/google/callback')) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, hostedDomains };
}

/** Additional office admission after openid-client has verified the token itself. */
export function officeIdentityFromClaims(claims: unknown, settings: GoogleOidcSettings): OfficeOidcIdentity {
  const value = claims && typeof claims === 'object' ? claims as Record<string, unknown> : {};
  if (typeof value.sub !== 'string' || !value.sub ||
      typeof value.email !== 'string' || !value.email || value.email_verified !== true ||
      typeof value.hd !== 'string' || !settings.hostedDomains.includes(value.hd.toLowerCase())) {
    throw new Error('Google identity is outside the configured, verified Workspace');
  }
  return { subject: value.sub, email: value.email,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.email,
    hostedDomain: value.hd.toLowerCase() };
}

/** The library verifies Google's signature, issuer, audience, expiry, state, nonce and PKCE. */
export function createGoogleOidcProvider(settings: GoogleOidcSettings): OfficeOidcProvider {
  let discovered: Promise<oidc.Configuration> | undefined;
  const config = () => discovered ??= oidc.discovery(GOOGLE_ISSUER, settings.clientId, settings.clientSecret);
  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      const url = oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: settings.redirectUri,
        response_type: 'code', scope: 'openid email profile', state, nonce,
        code_challenge: codeChallenge, code_challenge_method: 'S256',
        ...(settings.hostedDomains.length === 1 ? { hd: settings.hostedDomains[0] } : {}),
      });
      return url.href;
    },
    async exchange({ callbackQuery, state, nonce, codeVerifier }) {
      // Never trust the Host header as the token request's redirect URI. The configured callback
      // is the sole URI registered with Google; only its returned query is taken from the browser.
      const callback = new URL(settings.redirectUri);
      callback.search = callbackQuery;
      const tokens = await oidc.authorizationCodeGrant(await config(), callback, {
        expectedState: state, expectedNonce: nonce, pkceCodeVerifier: codeVerifier,
      });
      return officeIdentityFromClaims(tokens.claims(), settings);
    },
  };
}

export const oidcCodeVerifier = oidc.randomPKCECodeVerifier;
export const oidcCodeChallenge = oidc.calculatePKCECodeChallenge;
