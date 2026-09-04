export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number; // default: 3
  cooldownMs?: number; // default: 10,000ms
  successThreshold?: number; // default: 1 probe success in HALF_OPEN to close
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  totalTrips: number;
  lastFailureAt?: string;
  lastStateChangeAt: string;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private totalTrips = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private successThreshold: number;
  private consecutiveSuccesses = 0;
  private lastFailureAt?: string;
  private lastStateChangeAt: string;
  private nextAttemptAllowedAt = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 10000;
    this.successThreshold = options.successThreshold ?? 1;
    this.lastStateChangeAt = new Date().toISOString();
  }

  canExecute(): boolean {
    const now = Date.now();
    if (this.state === 'CLOSED') {
      return true;
    }
    if (this.state === 'OPEN') {
      if (now >= this.nextAttemptAllowedAt) {
        this.transitionTo('HALF_OPEN');
        return true;
      }
      return false;
    }
    if (this.state === 'HALF_OPEN') {
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(_error?: unknown): void {
    this.lastFailureAt = new Date().toISOString();
    this.consecutiveFailures++;

    if (this.state === 'HALF_OPEN') {
      this.trip();
    } else if (this.state === 'CLOSED') {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.trip();
      }
    }
  }

  private trip(): void {
    this.totalTrips++;
    this.nextAttemptAllowedAt = Date.now() + this.cooldownMs;
    this.transitionTo('OPEN');
  }

  private transitionTo(newState: CircuitBreakerState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.lastStateChangeAt = new Date().toISOString();
      if (newState === 'CLOSED') {
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
      } else if (newState === 'HALF_OPEN') {
        this.consecutiveSuccesses = 0;
      }
    }
  }

  getSnapshot(): CircuitBreakerSnapshot {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttemptAllowedAt) {
      this.transitionTo('HALF_OPEN');
    }
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalTrips: this.totalTrips,
      lastFailureAt: this.lastFailureAt,
      lastStateChangeAt: this.lastStateChangeAt,
    };
  }

  reset(): void {
    this.transitionTo('CLOSED');
  }
}
