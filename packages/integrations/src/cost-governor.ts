/**
 * Real-Time AI Generation Budget & Token/GPU Cost Controller (B-082, FR-079)
 * Inspired by Langfuse, Helicone, and AWS Cost Allocation tags.
 * Provides deterministic pre-flight budget checks and multi-provider token/GPU accounting.
 */

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
}

export interface ClientBudgetConfig {
  clientId: string;
  clientName: string;
  month: string;
  capUsd: number;
  spentUsd: number;
  warningThreshold: number; // 0.8 = 80%
  status: 'HEALTHY' | 'WARNING' | 'EXCEEDED';
  receipts: CostReceipt[];
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentUsageUsd: number;
  remainingUsd: number;
  capUsd: number;
  utilizationPercent: number;
  warningTriggered: boolean;
}

export class CostGovernor {
  private budgets = new Map<string, ClientBudgetConfig>();

  public readonly pricingRates: Record<string, { inputPer1M: number; outputPer1M: number; gpuPerSec?: number }> = {
    'google:gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
    'google:gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
    'anthropic:claude-3-5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'openai:gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'openai:gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'comfyui:sdxl-turbo': { inputPer1M: 0.0, outputPer1M: 0.0, gpuPerSec: 0.0003 },
    'comfyui:sdxl-lightning': { inputPer1M: 0.0, outputPer1M: 0.0, gpuPerSec: 0.0003 }
  };

  constructor() {
    this.seedDefaultClients();
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

  public getOrCreateClientBudget(clientId: string, clientName?: string): ClientBudgetConfig {
    const currentMonth = this.getCurrentMonth();
    let config = this.budgets.get(clientId);

    if (!config || config.month !== currentMonth) {
      config = {
        clientId,
        clientName: clientName || clientId,
        month: currentMonth,
        capUsd: config?.capUsd ?? 5.0,
        spentUsd: 0.0,
        warningThreshold: 0.8,
        status: 'HEALTHY',
        receipts: []
      };
      this.budgets.set(clientId, config);
    }

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

    const tokenCost = (tokens.input * rates.inputPer1M + tokens.output * rates.outputPer1M) / 1_000_000;
    const gpuCost = gpuSeconds * (rates.gpuPerSec || 0.0003);

    return Number((tokenCost + gpuCost).toFixed(6));
  }

  /**
   * Pre-flight gate check: verify whether the estimated operation cost fits within client monthly budget.
   */
  public checkBudget(clientId: string, estimatedCostUsd: number): BudgetCheckResult {
    const budget = this.getOrCreateClientBudget(clientId);
    const projected = Number((budget.spentUsd + estimatedCostUsd).toFixed(6));
    const remainingUsd = Number(Math.max(0, budget.capUsd - budget.spentUsd).toFixed(6));
    const utilizationPercent = Math.min(100, Math.round((budget.spentUsd / budget.capUsd) * 100));

    if (projected > budget.capUsd) {
      return {
        allowed: false,
        reason: `Monthly AI budget exceeded for client ${clientId}. Cap: $${budget.capUsd.toFixed(2)}, Current: $${budget.spentUsd.toFixed(2)}, Required: $${estimatedCostUsd.toFixed(4)}.`,
        currentUsageUsd: budget.spentUsd,
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
      remainingUsd,
      capUsd: budget.capUsd,
      utilizationPercent,
      warningTriggered
    };
  }

  /**
   * Commits an executed operation's cost receipt into the client's financial ledger.
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
  }): CostReceipt {
    const budget = this.getOrCreateClientBudget(params.clientId);
    const actualCost = params.costUsd ?? this.calculateEstimatedCost(
      params.provider,
      params.model,
      { input: params.inputTokens, output: params.outputTokens },
      params.gpuSeconds ?? 0
    );

    const check = this.checkBudget(params.clientId, actualCost);
    const status = check.allowed ? 'COMMITTED' : 'QUOTA_REJECTED';

    const receipt: CostReceipt = {
      id: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      clientId: params.clientId,
      taskId: params.taskId,
      role: params.role,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      gpuSeconds: params.gpuSeconds ?? 0,
      costUsd: actualCost,
      timestamp: new Date().toISOString(),
      status
    };

    if (status === 'COMMITTED') {
      budget.spentUsd = Number((budget.spentUsd + actualCost).toFixed(6));
      const ratio = budget.spentUsd / budget.capUsd;
      if (ratio >= 1.0) {
        budget.status = 'EXCEEDED';
      } else if (ratio >= budget.warningThreshold) {
        budget.status = 'WARNING';
      } else {
        budget.status = 'HEALTHY';
      }
    }

    budget.receipts.unshift(receipt);
    if (budget.receipts.length > 100) {
      budget.receipts.pop();
    }

    return receipt;
  }

  public allocateBudget(clientId: string, newCapUsd: number): ClientBudgetConfig {
    const budget = this.getOrCreateClientBudget(clientId);
    budget.capUsd = Number(Math.max(0.1, newCapUsd).toFixed(2));
    const ratio = budget.spentUsd / budget.capUsd;
    if (ratio >= 1.0) {
      budget.status = 'EXCEEDED';
    } else if (ratio >= budget.warningThreshold) {
      budget.status = 'WARNING';
    } else {
      budget.status = 'HEALTHY';
    }
    return budget;
  }

  public getAllSummaries(): ClientBudgetConfig[] {
    return Array.from(this.budgets.values());
  }
}

export const globalCostGovernor = new CostGovernor();
