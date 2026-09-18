export class StudioModelError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'StudioModelError';
  }
}

/**
 * An account out of credits answers 429 like a rate limit, but no wait can help it. The 2026-09-18
 * qualification retried "You have no credits remaining" for about a minute a call, then reported it
 * as RATE_LIMIT_EXCEEDED.
 */
export function isQuotaExhausted(status: number, responseBody: string): boolean {
  if (status !== 429) return false;
  try {
    const error = JSON.parse(responseBody)?.error;
    return error?.type === 'insufficient_quota' || error?.code === 'insufficient_quota' || error?.code === 'credit_balance_exhausted';
  } catch {
    return /insufficient_quota|credit_balance_exhausted/.test(responseBody);
  }
}

export function httpErrorCode(status: number, responseBody: string): string {
  if (isQuotaExhausted(status, responseBody)) return 'INSUFFICIENT_QUOTA';
  return status === 429 ? 'RATE_LIMIT_EXCEEDED' : `HTTP_${status}`;
}

export class StudioModelHttpError extends StudioModelError {
  constructor(public status: number, public responseBody: string) {
    super(`Model API returned HTTP ${status}: ${responseBody.substring(0, 200)}`, httpErrorCode(status, responseBody));
    this.name = 'StudioModelHttpError';
  }
}

export class StudioModelTimeoutError extends StudioModelError {
  public isUncertain = true;
  constructor(message = 'Model call timed out') {
    super(message, 'UNCERTAIN_TIMEOUT');
    this.name = 'StudioModelTimeoutError';
  }
}

export class StudioCircuitBreakerOpenError extends StudioModelError {
  constructor(provider = 'openai') {
    super(`Circuit breaker for ${provider} is OPEN after consecutive failures`, 'CIRCUIT_BREAKER_OPEN');
    this.name = 'StudioCircuitBreakerOpenError';
  }
}
