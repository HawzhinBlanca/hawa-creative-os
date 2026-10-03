import * as oidc from 'openid-client';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

/**
 * The office roles an allow-listed Google account may hold (hawa.membership_role without
 * `requester`, which is the customer/requester role and never a Desk sign-in).
 */
export const OFFICE_OIDC_ROLES = ['administrator', 'approver', 'operator', 'designer', 'language_reviewer',
  'client_dna_manager', 'model_evaluator', 'auditor'] as const;
export type OfficeOidcRole = typeof OFFICE_OIDC_ROLES[number];

export interface GoogleOidcSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Google Workspace domains whose members sign in only if already provisioned by subject (ADR-064). */
  hostedDomains: readonly string[];
  /** ADR-294 addendum: lower-cased verified emails admitted with exactly these roles, Gmail included. */
  allowedEmails: ReadonlyMap<string, readonly OfficeOidcRole[]>;
}

export interface OfficeOidcIdentity {
  subject: string;
  email: string;
  displayName: string;
  /** The Workspace domain (`hd` claim), or null for a consumer (e.g. Gmail) account. */
  hostedDomain: string | null;
  /** Set when the verified email is on HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: the roles it is enrolled with. */
  allowedRoles?: readonly OfficeOidcRole[];
}

export interface OfficeOidcProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  exchange(input: { callbackQuery: string; state: string; nonce: string; codeVerifier: string }): Promise<OfficeOidcIdentity>;
}

const ID_KEYS = ['HAWA_GOOGLE_OIDC_CLIENT_ID', 'HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'HAWA_GOOGLE_OIDC_REDIRECT_URI',
  'HAWA_GOOGLE_OIDC_HOSTED_DOMAINS', 'HAWA_GOOGLE_OIDC_ALLOWED_EMAILS'] as const;

/** A partially entered identity configuration must not leave shared-key review enabled. */
export function namedOfficeReviewMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return ID_KEYS.some((key) => Boolean(env[key]?.trim()));
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/**
 * Parses HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: `email:role[+role…]` entries separated by commas, for
 * example `owner@gmail.com:administrator,designer@gmail.com:operator+approver`. Anything else throws,
 * so a typo stops Core at start instead of silently admitting or refusing someone.
 */
export function parseAllowedOfficeEmails(raw: string | undefined): Map<string, readonly OfficeOidcRole[]> {
  const allowed = new Map<string, readonly OfficeOidcRole[]>();
  const value = (raw || '').trim();
  if (!value) return allowed;
  for (const [index, part] of value.split(',').entries()) {
    const entry = part.trim();
    const where = `HAWA_GOOGLE_OIDC_ALLOWED_EMAILS entry ${index + 1}`;
    const separator = entry.lastIndexOf(':');
    if (!entry || separator <= 0) throw new Error(`${where} must be email:role`);
    const email = entry.slice(0, separator).trim().toLowerCase();
    const roles = entry.slice(separator + 1).split('+').map((role) => role.trim());
    if (email.length > 254 || !EMAIL.test(email)) throw new Error(`${where} has an invalid email`);
    if (allowed.has(email)) throw new Error(`${where} repeats an email`);
    if (!roles.length || roles.some((role) => !(OFFICE_OIDC_ROLES as readonly string[]).includes(role)))
      throw new Error(`${where} has a role outside ${OFFICE_OIDC_ROLES.join(', ')}`);
    if (new Set(roles).size !== roles.length) throw new Error(`${where} repeats a role`);
    allowed.set(email, OFFICE_OIDC_ROLES.filter((role) => roles.includes(role)));
  }
  return allowed;
}

/**
 * An incomplete identity-provider configuration cannot accidentally enable the login route: it
 * returns null. A malformed HAWA_GOOGLE_OIDC_ALLOWED_EMAILS throws (Core refuses to start).
 * Either hosted domains or allowed emails (or both) must be configured.
 */
export function googleOidcSettings(env: NodeJS.ProcessEnv = process.env): GoogleOidcSettings | null {
  const clientId = (env.HAWA_GOOGLE_OIDC_CLIENT_ID || '').trim();
  const clientSecret = (env.HAWA_GOOGLE_OIDC_CLIENT_SECRET || '').trim();
  const redirectUri = (env.HAWA_GOOGLE_OIDC_REDIRECT_URI || '').trim();
  const hostedDomains = (env.HAWA_GOOGLE_OIDC_HOSTED_DOMAINS || '').split(',')
    .map((part) => part.trim().toLowerCase()).filter(Boolean);
  const allowedEmails = parseAllowedOfficeEmails(env.HAWA_GOOGLE_OIDC_ALLOWED_EMAILS);
  if (!clientId || !clientSecret || !redirectUri || (hostedDomains.length === 0 && allowedEmails.size === 0) ||
      hostedDomains.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) return null;
  try {
    const callback = new URL(redirectUri);
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
        !callback.pathname.endsWith('/auth/google/callback')) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, hostedDomains, allowedEmails };
}

/**
 * Additional office admission after openid-client has verified the token itself. The email must be
 * verified by Google in every case. An email on the allow-list is admitted with its listed roles,
 * with or without a Workspace `hd` (so Gmail works); otherwise the account must belong to a
 * configured Workspace domain and is admitted only if already provisioned by subject (ADR-064).
 */
export function officeIdentityFromClaims(claims: unknown, settings: GoogleOidcSettings): OfficeOidcIdentity {
  const value = claims && typeof claims === 'object' ? claims as Record<string, unknown> : {};
  if (typeof value.sub !== 'string' || !value.sub ||
      typeof value.email !== 'string' || !value.email || value.email_verified !== true) {
    throw new Error('Google identity is outside the configured, verified Workspace');
  }
  const hostedDomain = typeof value.hd === 'string' && value.hd ? value.hd.toLowerCase() : null;
  const allowedRoles = (settings.allowedEmails ?? new Map()).get(value.email.trim().toLowerCase());
  if (!allowedRoles && !(hostedDomain && settings.hostedDomains.includes(hostedDomain))) {
    throw new Error('Google identity is outside the configured, verified Workspace');
  }
  return { subject: value.sub, email: value.email,
    displayName: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.email,
    hostedDomain, ...(allowedRoles ? { allowedRoles } : {}) };
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
        // `hd` narrows Google's account chooser to the Workspace; it would hide allow-listed Gmail accounts.
        ...(settings.hostedDomains.length === 1 && settings.allowedEmails.size === 0 ? { hd: settings.hostedDomains[0] } : {}),
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
