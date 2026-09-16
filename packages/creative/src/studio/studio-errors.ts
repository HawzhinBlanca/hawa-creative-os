export class StudioModelError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'StudioModelError';
  }
}

export class StudioModelHttpError extends StudioModelError {
  constructor(public status: number, public responseBody: string) {
    super(`Model API returned HTTP ${status}: ${responseBody.substring(0, 200)}`, status === 429 ? 'RATE_LIMIT_EXCEEDED' : `HTTP_${status}`);
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
