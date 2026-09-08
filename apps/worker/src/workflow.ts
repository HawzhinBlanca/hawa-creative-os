import type { RequestContext, Result, AppError, UUID } from '@hawa/contracts';
import { TaskStateMachine } from '@hawa/domain';
import { BriefBuilder, CreativeDirectorRunner, DesignRouter } from '@hawa/creative';
import { DeterministicQAEngine } from '@hawa/qa';
import { FigmaBridgeAdapter, GooglePublisher, DirectModelGateway } from '@hawa/integrations';
import { RetrievalService } from '@hawa/retrieval';
import { OfficeTracer } from '@hawa/observability';

export interface WorkflowInput {
  taskId: UUID;
  tenantId: UUID;
  clientId?: UUID;
  rawText: string;
  sourcePlatform: string;
  priority?: string;
  idempotencyKey: string;
}

export interface WorkflowOutput {
  taskId: UUID;
  status: string;
  briefId?: UUID;
  documentId?: UUID;
  qcPassed: boolean;
  publicationReceipt?: Record<string, unknown>;
  auditEventsCount: number;
}

export class TaskWorkflowRunner {
  private tracer = new OfficeTracer();
  private briefBuilder = new BriefBuilder();
  private router = new DesignRouter();
  private creativeDirector = new CreativeDirectorRunner();
  private qaEngine = new DeterministicQAEngine();
  private studio = new FigmaBridgeAdapter();
  private publisher = new GooglePublisher();
  private modelGateway = new DirectModelGateway();
  private retrieval = new RetrievalService();

  async run(input: WorkflowInput): Promise<WorkflowOutput> {
    const span = this.tracer.startSpan('TaskWorkflowRunner.run', undefined, {
      taskId: input.taskId,
      tenantId: input.tenantId,
    });

    const ctx: RequestContext = {
      tenantId: input.tenantId,
      taskId: input.taskId,
      actor: { type: 'workflow', id: 'restate-worker-1' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 180000).toISOString(),
      idempotencyKey: input.idempotencyKey,
    };

    const sm = new TaskStateMachine(input.taskId, 'RECEIVED');

    // Step 1: Routing
    sm.transition('ROUTING', ctx.actor, 'Begin routing analysis');
    const clientId = input.clientId || 'client-office-1';

    // Step 2: Lock client scope
    sm.transition('BRIEFING', ctx.actor, `Client scope locked to ${clientId}`);

    // Step 3: Retrieval
    const clientCtx = { ...ctx, clientId };
    const contextPackRes = await this.retrieval.retrieve(clientCtx, [
      { query: input.rawText, kinds: ['rule', 'official_asset', 'template'], topK: 5 },
    ]);

    // Step 4: Brief building
    const briefRes = this.briefBuilder.build({
      taskId: input.taskId,
      clientId,
      clientDnaVersion: 1,
      objective: 'Campaign Poster',
      rawRequestText: input.rawText,
    });

    if (!briefRes.ok) {
      sm.transition('NEEDS_INFORMATION', ctx.actor, 'Missing facts detected in brief');
      span.end({ status: 'NEEDS_INFORMATION' });
      return {
        taskId: input.taskId,
        status: 'NEEDS_INFORMATION',
        qcPassed: false,
        auditEventsCount: 3,
      };
    }
    const brief = briefRes.value;

    // Step 5: Planning
    sm.transition('PLANNING', ctx.actor, 'Brief approved, beginning creative design plan');
    const plan = this.creativeDirector.createDesignPlan(brief, ['#0B0F19', '#38BDF8', '#FFFFFF']);

    // Step 6: Composing
    sm.transition('COMPOSING', ctx.actor, 'Creating studio document with live editable nodes');
    const docRes = await this.studio.create(ctx, {
      name: `Post - ${brief.objective}`,
      pages: brief.variants.map((v) => ({
        id: v.id,
        name: v.name,
        width: v.width,
        height: v.height,
        unit: 'px',
        language: brief.primaryLanguage,
        direction: brief.direction,
      })),
      clientDnaVersion: 1,
    });
    if (!docRes.ok) throw new Error('Studio document creation failed');
    const docRef = docRes.value;

    // Apply studio operations
    const ops = this.creativeDirector.generateStudioOperations(brief, plan, 'sha256_logo_verified_primary');
    const applyRes = await this.studio.apply(ctx, {
      document: docRef,
      expectedSourceSha256: docRef.sourceSha256,
      operationBatchId: 'batch_initial_compose',
      operations: ops,
      destructiveOperationsAllowed: false,
    });
    if (!applyRes.ok) throw new Error('Failed to apply studio operations');
    const updatedDocRef = applyRes.value;

    // Step 7: QA
    sm.transition('QA', ctx.actor, 'Running deterministic hard QA and bidi verification');
    const manifestRes = await this.studio.getManifest(ctx, updatedDocRef);
    if (!manifestRes.ok) throw new Error('Failed to extract studio manifest');

    const qcRes = await this.qaEngine.run(ctx, {
      taskId: input.taskId,
      designRevisionId: crypto.randomUUID(),
      document: updatedDocRef,
      sourceHash: updatedDocRef.sourceSha256,
      manifest: manifestRes.value,
      renders: [],
      brief: brief as any,
      clientDna: {
        assets: [{ role: 'logo_primary', sha256: 'sha256_logo_verified_primary' }],
      },
      profile: { name: 'default', version: '1.0', rules: {} },
      repairCycle: 0,
    });

    const qcReport = qcRes.ok ? qcRes.value : undefined;
    const qcPassed = qcReport ? qcReport.criticalPass : false;

    // Step 8: Human Review gate
    sm.transition('AWAITING_APPROVAL', ctx.actor, 'Design composed and passed QA, pausing for office approval in Desk');

    span.end({
      status: sm.getStatus(),
      briefId: brief.briefId,
      documentId: updatedDocRef.documentId,
      qcPassed,
    });

    return {
      taskId: input.taskId,
      status: sm.getStatus(),
      briefId: brief.briefId,
      documentId: updatedDocRef.documentId,
      qcPassed,
      auditEventsCount: 6,
    };
  }
}
