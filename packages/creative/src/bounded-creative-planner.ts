import crypto from 'node:crypto';
import type { Result, AppError, UUID, ISODateTime } from '@hawa/contracts';
import {
  type DesignBrief,
  type DesignPlan,
  type AssetTopology,
  type VisualIngredient,
  type LayoutZone,
  type ArtDirectionReference,
  type ClientDNA,
  TaskStateMachine,
} from '@hawa/domain';
import { BriefBuilder, type RawTaskBriefInput } from './brief-builder.js';
import { DesignRouter, type RouteResolution } from './design-router.js';
import {
  CreativeDirectorRunner,
  CANONICAL_FORMATS,
  type CanonicalFormat,
  type CanonicalFormatSpec,
} from './creative-director.js';
import { HoldoutCopyAuditor } from './holdout-copy-auditor.js';
import {
  CostGovernor,
  globalCostGovernor,
  type CostReceipt,
} from '@hawa/integrations';

export interface BoundedPlannerConfig {
  maxRepairCycles?: number;
  costGovernor?: CostGovernor;
  maxTaskBudgetUsd?: number;
}

export interface CandidateLayoutPackage {
  taskId: UUID;
  brief: DesignBrief;
  routeResolution: RouteResolution;
  plan: DesignPlan;
  operations: Array<{ op: string; text?: string; role?: string; [key: string]: any }>;
  formatSpec: CanonicalFormatSpec;
  costReceipt: CostReceipt;
  repairCycle: number;
  status: 'READY' | 'REPAIR_REQUIRED' | 'OPERATOR_REQUIRED' | 'BLOCKED';
  holdoutAudited: boolean;
  preservedWorkSummary: {
    checkpointsCount: number;
    lastCheckpointId: string;
    preservedTokensCount: number;
  };
}

export class BoundedCreativePlanner {
  private readonly briefBuilder: BriefBuilder;
  private readonly router: DesignRouter;
  private readonly director: CreativeDirectorRunner;
  private readonly holdoutAuditor: HoldoutCopyAuditor;
  private readonly costGovernor: CostGovernor;
  private readonly maxRepairCycles: number;
  private readonly maxTaskBudgetUsd: number;

  constructor(config: BoundedPlannerConfig = {}) {
    this.briefBuilder = new BriefBuilder();
    this.router = new DesignRouter();
    this.director = new CreativeDirectorRunner();
    this.holdoutAuditor = new HoldoutCopyAuditor();
    this.costGovernor = config.costGovernor || globalCostGovernor;
    this.maxRepairCycles = config.maxRepairCycles ?? 2;
    this.maxTaskBudgetUsd = config.maxTaskBudgetUsd ?? 0.50; // $0.50 task budget ceiling
  }

  /**
   * Builds and validates a schema-valid Design Brief (FR-013).
   * Stops immediately if indispensable inputs or blocking facts are missing (FR-014).
   */
  createBrief(input: RawTaskBriefInput): Result<DesignBrief, AppError> {
    return this.briefBuilder.build(input);
  }

  /**
   * Evaluates task route selection (FR-016).
   * Separates routine template duplication/fill from novel composition and multi-format omnichannel (NFR-018).
   */
  resolveTaskRoute(
    brief: DesignBrief,
    availableTemplates: Array<{ id: string; category: string; matchScore: number }> = []
  ): RouteResolution {
    return this.router.resolveRoute(brief, availableTemplates);
  }

  /**
   * Selects asset architecture topology and layout zones (FR-025, FR-015).
   * Separates exact factual copy blocks from layout geometry choices.
   */
  createBoundedPlan(
    brief: DesignBrief,
    clientDna?: ClientDNA,
    targetFormat?: CanonicalFormat
  ): Result<DesignPlan, AppError> {
    // Check required official brand logo asset presence (Invariant: official logos never invented via diffusion)
    const officialLogo = clientDna?.assets.find((a) => a.role === 'logo_primary' || a.role === 'logo_symbol');
    if (clientDna && !officialLogo) {
      return {
        ok: false,
        error: {
          code: 'MISSING_BRAND_ASSET',
          message: `Cannot generate design plan: Client ${clientDna.name} has no verified vector/raster primary logo asset. Diffusion logo invention is strictly prohibited (FR-026).`,
          retryable: false,
          safeAction: 'Upload official client vector logo to Client DNA repository',
        },
      };
    }

    const clientColors = clientDna?.colors?.map((c) => c.hex) || [];
    const plan = this.director.createDesignPlan(brief, clientColors, targetFormat);

    // Enforce FR-026: Validate all visual ingredients
    for (const ingredient of plan.ingredients) {
      if (ingredient.role === 'official_logo' && ingredient.sourceType !== 'official_asset') {
        return {
          ok: false,
          error: {
            code: 'PROHIBITED_DIFFUSION_LETTERING_OR_LOGO',
            message: 'Official logos cannot be generated or simulated via diffusion models; must be sourced from official_asset (FR-026).',
            retryable: false,
            safeAction: 'Bind ingredient to verified client vector asset SHA-256',
          },
        };
      }
    }

    // Enforce FR-024: Private composition reference pixels NEVER ship in artifact
    if (plan.artDirectionReference) {
      if (plan.artDirectionReference.shippedInArtifact !== false) {
        return {
          ok: false,
          error: {
            code: 'REFERENCE_PIXEL_SHIPPING_BLOCKED',
            message: 'Private art direction reference cannot be shipped in export artifact (FR-024, Invariant #4).',
            retryable: false,
            safeAction: 'Set shippedInArtifact to false',
          },
        };
      }
    }

    return { ok: true, value: plan };
  }

  /**
   * Plans and executes a candidate layout package with cost checks, holdout controls, and bounded repair tracking.
   */
  planCandidatePackage(params: {
    brief: DesignBrief;
    clientDna?: ClientDNA;
    targetFormat?: CanonicalFormat;
    availableTemplates?: Array<{ id: string; category: string; matchScore: number }>;
    modelSnapshotOverride?: string;
  }): Result<CandidateLayoutPackage, AppError> {
    const { brief, clientDna, targetFormat } = params;

    // 1. Resolve Route (FR-016)
    const route = this.resolveTaskRoute(brief, params.availableTemplates || []);

    // 2. Budget Pre-flight Gate (FR-062, FR-079, NFR-018)
    const isTemplateRoutine = route.route === 'template_fill';
    const estimatedCostUsd = isTemplateRoutine ? 0.000000 : 0.002500; // Template fill has zero deep-model cost (NFR-018)

    const clientId = brief.clientId || 'client-office-1';
    const budgetCheck = this.costGovernor.checkBudget(clientId, estimatedCostUsd);
    if (!budgetCheck.allowed) {
      return {
        ok: false,
        error: {
          code: 'BUDGET_EXCEEDED',
          message: budgetCheck.reason || `Client ${clientId} exceeded monthly AI budget cap`,
          retryable: false,
          safeAction: 'Request human authorization for additional AI generation credits',
          detail: { budgetCheck },
        },
      };
    }

    // 3. Create Plan with Visual Ingredient Bounding (FR-025, FR-026, FR-024)
    const planRes = this.createBoundedPlan(brief, clientDna, targetFormat);
    if (!planRes.ok) {
      return planRes;
    }
    const plan = planRes.value;

    // 4. Generate Studio Operations
    const primaryLogoSha256 = clientDna?.assets.find((a) => a.role === 'logo_primary')?.sha256 || 'kaae_primary_logo_sha256_mock';
    const operations = this.director.generateStudioOperations(brief, plan, primaryLogoSha256, targetFormat);

    // 5. Holdout Copy Audit (FR-014, FR-015)
    const holdoutRes = this.holdoutAuditor.auditCandidateCopy(brief, { operations });
    if (!holdoutRes.ok) {
      return {
        ok: false,
        error: holdoutRes.error,
      };
    }

    // 6. Record Cost Receipt in Ledger
    const receipt = this.costGovernor.recordUsage({
      clientId,
      taskId: brief.taskId,
      role: 'creative_director',
      provider: isTemplateRoutine ? 'local' : 'openai',
      model: isTemplateRoutine ? 'deterministic-template-v1' : (params.modelSnapshotOverride || 'gpt-5.6-sol'),
      inputTokens: isTemplateRoutine ? 0 : 520,
      outputTokens: isTemplateRoutine ? 0 : 140,
      costUsd: estimatedCostUsd,
    });

    const formatSpec = this.director.resolveCanonicalFormat(brief, targetFormat);

    return {
      ok: true,
      value: {
        taskId: brief.taskId,
        brief,
        routeResolution: route,
        plan,
        operations,
        formatSpec,
        costReceipt: receipt,
        repairCycle: 0,
        status: 'READY',
        holdoutAudited: true,
        preservedWorkSummary: {
          checkpointsCount: 1,
          lastCheckpointId: `chk_${brief.taskId.substring(0, 8)}_0`,
          preservedTokensCount: holdoutRes.value.auditedTokensCount,
        },
      },
    };
  }

  /**
   * Executes bounded automatic repair (FR-040).
   * Strictly limits repair cycles to max 2 attempts. Escalates to OPERATOR_REQUIRED on cycle 3 without losing work.
   */
  attemptAutonomousRepair(
    candidate: CandidateLayoutPackage,
    defectReason: string
  ): Result<CandidateLayoutPackage, AppError> {
    const nextCycle = candidate.repairCycle + 1;

    // Check repair budget invariant: Maximum 2 repair cycles (FR-040)
    if (nextCycle > this.maxRepairCycles) {
      candidate.status = 'OPERATOR_REQUIRED';
      return {
        ok: false,
        error: {
          code: 'MAX_REPAIR_BUDGET_EXCEEDED',
          message: `Automatic repair budget exhausted (${this.maxRepairCycles} cycles reached). Escalating to human operator review without losing candidate work.`,
          retryable: false,
          safeAction: 'Open Hawa Desk for human designer review and manual Canva touch-up',
          detail: {
            taskId: candidate.taskId,
            repairCycle: candidate.repairCycle,
            maxAllowed: this.maxRepairCycles,
            defectReason,
            preservedCheckpoints: candidate.preservedWorkSummary.checkpointsCount,
            lastCheckpointId: candidate.preservedWorkSummary.lastCheckpointId,
          },
        },
      };
    }

    // Apply bounded repair adjustments
    const updatedOperations = [...candidate.operations];
    // Example repair: recalculate safe text line height or adjust padding
    for (const op of updatedOperations) {
      if (op.op === 'addText' && op.style) {
        op.style.lineHeight = Math.max(op.style.lineHeight || 1.38, 1.42); // Adjust diacritic safe height
      }
    }

    // Verify holdout integrity post-repair (repair cycle must never drop factual tokens)
    const holdoutRes = this.holdoutAuditor.auditCandidateCopy(candidate.brief, { operations: updatedOperations });
    if (!holdoutRes.ok) {
      candidate.status = 'OPERATOR_REQUIRED';
      return {
        ok: false,
        error: {
          code: 'REPAIR_MUTATED_FACTUAL_COPY',
          message: `Automated repair attempt corrupted factual copy: ${holdoutRes.error.message}`,
          retryable: false,
          safeAction: 'Escalate to operator review',
          detail: holdoutRes.error.detail,
        },
      };
    }

    candidate.repairCycle = nextCycle;
    candidate.operations = updatedOperations;
    candidate.preservedWorkSummary.checkpointsCount += 1;
    candidate.preservedWorkSummary.lastCheckpointId = `chk_${candidate.taskId.substring(0, 8)}_${nextCycle}`;
    candidate.status = 'REPAIR_REQUIRED';

    return {
      ok: true,
      value: candidate,
    };
  }

  /**
   * Validates that an export package contains zero private composition reference pixels (FR-024).
   */
  validateExportPackageSafety(plan: DesignPlan): Result<void, AppError> {
    if (plan.artDirectionReference) {
      if ((plan.artDirectionReference.shippedInArtifact as boolean) === true) {
        return {
          ok: false,
          error: {
            code: 'REFERENCE_PIXEL_SHIPPING_BLOCKED',
            message: 'Invariant #4 violation: Private composition reference pixels must never enter the shipped artifact.',
            retryable: false,
            safeAction: 'Strip art direction reference from exported deliverable manifest',
          },
        };
      }
    }
    return { ok: true, value: undefined };
  }
}
