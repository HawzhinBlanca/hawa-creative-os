import type { Result, AppError } from '@hawa/contracts';

export interface FaultInjectionConfig {
  dropProbability?: number;
  duplicateProbability?: number;
  timeoutMs?: number;
  staleRevisionProb?: number;
}

export class ChaosInjector {
  private config: FaultInjectionConfig;
  private callCount: number = 0;

  constructor(config: FaultInjectionConfig = {}) {
    this.config = config;
  }

  async maybeInjectFault<T>(action: () => Promise<T>): Promise<T> {
    this.callCount += 1;

    if (this.config.dropProbability && Math.random() < this.config.dropProbability) {
      throw new Error('CHAOS_INJECTED_NETWORK_DROP: Connection reset by peer');
    }

    if (this.config.timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.timeoutMs));
    }

    return await action();
  }

  simulateProcessRestart() {
    // In-memory simulator resets transient caches but preserves durable state
    return { restarted: true, timestamp: new Date().toISOString() };
  }
}
