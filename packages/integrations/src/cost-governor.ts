/**
 * Real-Time AI Generation Budget & Token/GPU Cost Controller (B-082, FR-079)
 * Inspired by Langfuse, Helicone, and AWS Cost Allocation tags.
 * Provides deterministic pre-flight budget checks and multi-provider token/GPU accounting.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CostReceipt {
  id: string;
  clientId: string;
  taskId: string;
  role: string;
  provider: 'google' | 'anthropic' | 'openai' | 'comfyui_gpu' | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  gpuSeconds: number;
  costUsd: number;
  timestamp: string;
  status: 'COMMITTED' | 'QUOTA_REJECTED';
  reservationId?: string;
}

export interface ClientBudgetConfig {
  clientId: string;
  clientName: string;
  month: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd?: number;
  warningThreshold: number; // 0.8 = 80%
  status: 'HEALTHY' | 'WARNING' | 'EXCEEDED';
  receipts: CostReceipt[];
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentUsageUsd: number;
  reservedUsd?: number;
  remainingUsd: number;
  capUsd: number;
  utilizationPercent: number;
  warningTriggered: boolean;
}

export interface BudgetReservation {
  id: string;
  clientId: string;
  amountUsd: number;
  expiresAt: number;
}

export interface BudgetReservationResult {
  allowed: boolean;
  reservationId?: string;
  reason?: string;
  remainingUsd: number;
  capUsd: number;
  currentUsageUsd: number;
  reservedUsd: number;
}

export class CostGovernor {
  private budgets = new Map<string, ClientBudgetConfig>();
  private reservations = new Map<string, BudgetReservation>();

  public readonly pricingRates: Record<string, { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; cacheWritePer1M?: number; gpuPerSec?: number; imagePer1M?: number }> = {
    'openai:gpt-6-astra': { inputPer1M: 10.0, outputPer1M: 50.0, cacheReadPer1M: 1.0, cacheWritePer1M: 12.5 },
    'openai:gpt-image-2.5-sunburst': { inputPer1M: 0.0, outputPer1M: 0.0, imagePer1M: 30.0, gpuPerSec: 0.04 },
    'openai:gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'openai:gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'openai:gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
    'openai:o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },
    'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
    'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },
    'comfyui:sdxl-turbo': { inputPer1M: 0.0, outputPer1M: 0.0, gpuPerSec: 0.0003 },
    'comfyui:sdxl-lightning': { inputPer1M: 0.0, outputPer1M: 0.0, gpuPerSec: 0.0003 }
  };

  private storagePath?: string;

  constructor(options?: { storagePath?: string }) {
    this.storagePath = options?.storagePath || process.env.HAWA_BUDGETS_FILE;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.hydrateState(parsed);
      } catch {
        this.seedDefaultClients();
      }
    } else {
      this.seedDefaultClients();
    }
  }

  public exportState(): {
    budgets: [string, ClientBudgetConfig][];
    reservations: [string, BudgetReservation][];
  } {
    return {
      budgets: Array.from(this.budgets.entries()),
      reservations: Array.from(this.reservations.entries()),
    };
  }

  public hydrateState(state: {
    budgets?: [string, ClientBudgetConfig][];
    reservations?: [string, BudgetReservation][];
  }): void {
    if (state.budgets) {
      for (const [id, b] of state.budgets) {
        this.budgets.set(id, b);
      }
    }
    if (state.reservations) {
      for (const [id, r] of state.reservations) {
        this.reservations.set(id, r);
      }
    }
  }

  public persist(): void {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.exportState(), null, 2), 'utf8');
    } catch {
      // Non-fatal
    }
  }

  private getCurrentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  private seedDefaultClients(): void {
    const currentMonth = this.getCurrentMonth();
    const defaults = [
      { id: 'client-drustee', name: 'Drustee Evidence-First Health', cap: 10.0 },
      { id: 'client-aster', name: 'Aster Hotel & Resort', cap: 5.0 },
      { id: 'client-nova', name: 'Nova Tech Systems', cap: 8.0 },
      { id: 'client-rona', name: 'Rona Haute Couture', cap: 5.0 },
      { id: 'client-office-1', name: 'Hawa Creative Internal', cap: 20.0 }
    ];

    for (const c of defaults) {
      this.budgets.set(c.id, {
        clientId: c.id,
        clientName: c.name,
        month: currentMonth,
        capUsd: c.cap,
        spentUsd: 0.0,
        warningThreshold: 0.8,
        status: 'HEALTHY',
        receipts: []
      });
    }
  }

  private cleanExpiredReservations(): void {
    const now = Date.now();
    for (const [id, res] of this.reservations.entries()) {
      if (res.expiresAt <= now) {
        this.reservations.delete(id);
      }
    }
  }

  public getActiveReservationUsd(clientId: string): number {
    this.cleanExpiredReservations();
    let total = 0;
    for (const res of this.reservations.values()) {
      if (res.clientId === clientId) {
        total += res.amountUsd;
      }
    }
    return Number(total.toFixed(6));
  }

  public reserveBudget(params: {
    clientId: string;
    amountUsd: number;
    leaseDurationMs?: number;
  }): BudgetReservationResult {
    const clientId = params.clientId;
    const amountUsd = Math.max(0, Number(params.amountUsd) || 0);
    const leaseDurationMs = Math.max(1000, Math.min(600_000, Number(params.leaseDurationMs) || 60_000));

    const budget = this.getOrCreateClientBudget(clientId);
    this.cleanExpiredReservations();
    const activeReserved = this.getActiveReservationUsd(clientId);
    const projected = Number((budget.spentUsd + activeReserved + amountUsd).toFixed(6));
    const effectiveSpent = Number((budget.spentUsd + activeReserved).toFixed(6));
    const remainingUsd = Number(Math.max(0, budget.capUsd - effectiveSpent).toFixed(6));

    if (projected > budget.capUsd) {
      return {
        allowed: false,
        reason: `Monthly AI budget exceeded for client ${clientId}. Cap: $${budget.capUsd.toFixed(2)}, Current: $${budget.spentUsd.toFixed(2)}${activeReserved > 0 ? `, Active Reservations: $${activeReserved.toFixed(4)}` : ''}, Required: $${amountUsd.toFixed(4)}.`,
        remainingUsd,
        capUsd: budget.capUsd,
        currentUsageUsd: budget.spentUsd,
        reservedUsd: activeReserved,
      };
    }

    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this.reservations.set(reservationId, {
      id: reservationId,
      clientId,
      amountUsd,
      expiresAt: Date.now() + leaseDurationMs,
    });

    return {
      allowed: true,
      reservationId,
      remainingUsd: Number(Math.max(0, budget.capUsd - projected).toFixed(6)),
      capUsd: budget.capUsd,
      currentUsageUsd: budget.spentUsd,
      reservedUsd: Number((activeReserved + amountUsd).toFixed(6)),
    };
  }

  public releaseReservation(reservationId?: string): boolean {
    if (!reservationId) return false;
    return this.reservations.delete(reservationId);
  }

  public getOrCreateClientBudget(clientId: string, clientName?: string): ClientBudgetConfig {
    const currentMonth = this.getCurrentMonth();
    let config = this.budgets.get(clientId);

    if (!config || config.month !== currentMonth) {
      config = {
        clientId,
        clientName: clientName || clientId,
        month: currentMonth,
        capUsd: config && Number.isFinite(config.capUsd) ? config.capUsd : 5.0,
        spentUsd: 0.0,
        warningThreshold: 0.8,
        status: 'HEALTHY',
        receipts: []
      };
      this.budgets.set(clientId, config);
    }

    config.reservedUsd = this.getActiveReservationUsd(clientId);
    return config;
  }

  public calculateEstimatedCost(
    provider: string,
    model: string,
    tokens: { input: number; output: number },
    gpuSeconds = 0
  ): number {
    const key = `${provider}:${model}`.toLowerCase();
    const rates = this.pricingRates[key] || { inputPer1M: 0.5, outputPer1M: 1.5, gpuPerSec: 0.0003 };

    const safeInput = Math.max(0, Number(tokens?.input) || 0);
    const safeOutput = Math.max(0, Number(tokens?.output) || 0);
    const safeGpu = Math.max(0, Number(gpuSeconds) || 0);

    const tokenCost = (safeInput * rates.inputPer1M + safeOutput * rates.outputPer1M) / 1_000_000;
    const gpuCost = safeGpu * (rates.gpuPerSec || 0.0003);

    return Number((tokenCost + gpuCost).toFixed(6));
  }

  /**
   * Pre-flight gate check: verify whether the estimated operation cost fits within client monthly budget.
   */
  public checkBudget(clientId: string, estimatedCostUsd: number): BudgetCheckResult {
    const budget = this.getOrCreateClientBudget(clientId);
    const safeCost = Math.max(0, Number(estimatedCostUsd) || 0);
    this.cleanExpiredReservations();
    const activeReserved = this.getActiveReservationUsd(clientId);
    const projected = Number((budget.spentUsd + activeReserved + safeCost).toFixed(6));
    const effectiveSpent = Number((budget.spentUsd + activeReserved).toFixed(6));
    const remainingUsd = Number(Math.max(0, budget.capUsd - effectiveSpent).toFixed(6));
    const utilizationPercent = Math.min(100, Math.round((effectiveSpent / budget.capUsd) * 100));

    if (projected > budget.capUsd) {
      return {
        allowed: false,
        reason: `Monthly AI budget exceeded for client ${clientId}. Cap: $${budget.capUsd.toFixed(2)}, Current: $${budget.spentUsd.toFixed(2)}${activeReserved > 0 ? `, Active Reservations: $${activeReserved.toFixed(4)}` : ''}, Required: $${safeCost.toFixed(4)}.`,
        currentUsageUsd: budget.spentUsd,
        reservedUsd: activeReserved,
        remainingUsd,
        capUsd: budget.capUsd,
        utilizationPercent: 100,
        warningTriggered: true
      };
    }

    const warningTriggered = projected >= budget.capUsd * budget.warningThreshold;

    return {
      allowed: true,
      currentUsageUsd: budget.spentUsd,
      reservedUsd: activeReserved,
      remainingUsd,
      capUsd: budget.capUsd,
      utilizationPercent,
      warningTriggered
    };
  }

  /**
   * Pre-flight convenience check taking estimated tokens or cost.
   */
  public checkPreFlight(
    clientId: string,
    tokensOrCost: number | { input: number; output: number },
    model = 'gpt-6-astra',
    provider = 'openai'
  ): BudgetCheckResult {
    let estimatedCost: number;
    if (typeof tokensOrCost === 'number') {
      estimatedCost = tokensOrCost < 1 ? tokensOrCost : this.calculateEstimatedCost(provider, model, { input: tokensOrCost, output: tokensOrCost });
    } else {
      estimatedCost = this.calculateEstimatedCost(provider, model, tokensOrCost);
    }
    return this.checkBudget(clientId, estimatedCost);
  }

  /**
   * Commits an executed operation's cost receipt into the client's financial ledger.
   * Incurred spend is strictly added to spentUsd even if exceeding the cap.
   */
  public recordUsage(params: {
    clientId: string;
    taskId: string;
    role: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    gpuSeconds?: number;
    costUsd?: number;
    reservationId?: string;
  }): CostReceipt {
    const budget = this.getOrCreateClientBudget(params.clientId);
    const computedCost = params.costUsd !== undefined && Number.isFinite(Number(params.costUsd))
      ? Math.max(0, Number(params.costUsd))
      : this.calculateEstimatedCost(
          params.provider,
          params.model,
          { input: params.inputTokens, output: params.outputTokens },
          params.gpuSeconds ?? 0
        );
    const actualCost = Math.max(0, Number(computedCost) || 0);

    // If a reservation was provided for this task, consume/release it so it is not double-counted
    if (params.reservationId) {
      this.releaseReservation(params.reservationId);
    }

    // Determine status relative to cap before commit
    const projected = Number((budget.spentUsd + actualCost).toFixed(6));
    const status = projected <= budget.capUsd ? 'COMMITTED' : 'QUOTA_REJECTED';

    const receipt: CostReceipt = {
      id: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      clientId: params.clientId,
      taskId: params.taskId,
      role: params.role,
      provider: params.provider,
      model: params.model,
      inputTokens: Math.max(0, Number(params.inputTokens) || 0),
      outputTokens: Math.max(0, Number(params.outputTokens) || 0),
      gpuSeconds: Math.max(0, Number(params.gpuSeconds) || 0),
      costUsd: actualCost,
      timestamp: new Date().toISOString(),
      status,
      reservationId: params.reservationId,
    };

    // INVARIANT: Incurred compute costs MUST ALWAYS be debited to spentUsd.
    // External APIs have already consumed real dollars. Discarding actual spend on quota breach
    // causes ledger freeze and allows clients to incur unlimited unrecorded spend.
    budget.spentUsd = Number((budget.spentUsd + actualCost).toFixed(6));
    const ratio = budget.spentUsd / budget.capUsd;
    if (ratio >= 1.0) {
      budget.status = 'EXCEEDED';
    } else if (ratio >= budget.warningThreshold) {
      budget.status = 'WARNING';
    } else {
      budget.status = 'HEALTHY';
    }

    budget.receipts.unshift(receipt);
    if (budget.receipts.length > 100) {
      budget.receipts.pop();
    }

    this.persist();
    return receipt;
  }

  public allocateBudget(clientId: string, newCapUsd: number): ClientBudgetConfig {
    const budget = this.getOrCreateClientBudget(clientId);
    const safeCap = Number.isFinite(newCapUsd) ? Number(Math.max(0.1, newCapUsd).toFixed(2)) : 5.0;
    budget.capUsd = safeCap;
    const ratio = budget.spentUsd / budget.capUsd;
    if (ratio >= 1.0) {
      budget.status = 'EXCEEDED';
    } else if (ratio >= budget.warningThreshold) {
      budget.status = 'WARNING';
    } else {
      budget.status = 'HEALTHY';
    }
    this.persist();
    return budget;
  }

  public getAllSummaries(): ClientBudgetConfig[] {
    return Array.from(this.budgets.values()).map(b => {
      b.reservedUsd = this.getActiveReservationUsd(b.clientId);
      return b;
    });
  }
}

export const globalCostGovernor = new CostGovernor();
