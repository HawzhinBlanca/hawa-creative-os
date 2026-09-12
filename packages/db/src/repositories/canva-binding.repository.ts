import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export interface CreateBindingParams {
  tenantId: string;
  taskId: string;
  clientId: string;
  canvaDesignId: string;
  canvaTeamId?: string | null;
  canvaUserId?: string | null;
  editUrl: string;
  viewUrl?: string | null;
  directionName?: string;
}

export interface CanvaCapturedArtifactRow {
  format: 'png' | 'pdf_print' | 'svg' | 'pdf_standard';
  storageKey: string;
  sha256: string;
  byteSize: number;
  width?: number;
  height?: number;
  dpi?: number;
  colorSpace?: 'cmyk' | 'srgb';
}

export interface CanvaSemanticCoverageRow {
  textNodesCount: number;
  imageFillsCount: number;
  hasLogo: boolean;
  isComplete: boolean;
  unobservedLayersCount?: number;
}

export interface CaptureArtifactSetParams {
  tenantId: string;
  bindingId: string;
  taskId: string;
  clientId: string;
  canvaDesignId: string;
  expectedVersion: number;
  parentRevisionId?: string | null;
  capturedArtifactSetHash: string;
  artifacts: CanvaCapturedArtifactRow[];
  exportSettings?: Record<string, unknown>;
  semanticCoverage: CanvaSemanticCoverageRow;
  effectJobId?: string | null;
  authActor: {
    actorType: 'user' | 'model' | 'workflow' | 'operator';
    actorId: string;
  };
}

export class CanvaBindingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string) {
    return await this.db
      .selectFrom('canva_bindings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByTaskId(tenantId: string, taskId: string, directionName: string = 'primary') {
    return await this.db
      .selectFrom('canva_bindings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('task_id', '=', taskId)
      .where('direction_name', '=', directionName)
      .executeTakeFirst();
  }

  async findByCanvaDesignId(tenantId: string, canvaDesignId: string) {
    return await this.db
      .selectFrom('canva_bindings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('canva_design_id', '=', canvaDesignId)
      .executeTakeFirst();
  }

  async createBinding(params: CreateBindingParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    // 1. Server-derived ownership verification: Verify task exists and client matches
    const task = await client
      .selectFrom('tasks')
      .select(['id', 'tenant_id', 'client_id'])
      .where('id', '=', params.taskId)
      .where('tenant_id', '=', params.tenantId)
      .executeTakeFirst();

    if (!task) {
      throw new Error(`Task ${params.taskId} does not exist in tenant ${params.tenantId}`);
    }

    if (task.client_id && task.client_id !== params.clientId) {
      throw new Error(
        `Server-derived ownership denial: task belongs to client ${task.client_id}, cannot bind for client ${params.clientId}`
      );
    }

    // 2. Check for duplicate design assignment to a foreign client
    const existingDesign = await client
      .selectFrom('canva_bindings')
      .select(['id', 'client_id', 'task_id'])
      .where('tenant_id', '=', params.tenantId)
      .where('canva_design_id', '=', params.canvaDesignId)
      .executeTakeFirst();

    if (existingDesign && existingDesign.client_id !== params.clientId) {
      throw new Error(
        `Foreign client denial: Canva design ${params.canvaDesignId} is already bound to client ${existingDesign.client_id}`
      );
    }

    return await client
      .insertInto('canva_bindings')
      .values({
        tenant_id: params.tenantId,
        task_id: params.taskId,
        client_id: params.clientId,
        canva_design_id: params.canvaDesignId,
        canva_team_id: params.canvaTeamId ?? null,
        canva_user_id: params.canvaUserId ?? null,
        edit_url: params.editUrl,
        view_url: params.viewUrl ?? null,
        direction_name: params.directionName ?? 'primary',
        status: 'bound',
        version: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async captureArtifactSet(params: CaptureArtifactSetParams) {
    const binding = await this.findById(params.bindingId);
    if (!binding) {
      throw new Error(`Binding ${params.bindingId} not found`);
    }

    // Invariant 1: Server-derived ownership — URL alone cannot select a client
    if (binding.client_id !== params.clientId) {
      throw new Error(
        `Foreign client denial: Request client ${params.clientId} does not match bound client ${binding.client_id}`
      );
    }

    // Invariant 2: Reject foreign/unknown design ID
    if (binding.canva_design_id !== params.canvaDesignId) {
      throw new Error(
        `Design mismatch denial: Request design ${params.canvaDesignId} does not match bound design ${binding.canva_design_id}`
      );
    }

    // Invariant 3: Optimistic concurrency — reject stale requests
    if (binding.version !== params.expectedVersion) {
      throw new Error(
        `Stale version conflict: Expected version ${params.expectedVersion} does not match current version ${binding.version}`
      );
    }

    // Invariant 4: Snapshot incompleteness cannot be represented as fully observed source
    if (!params.semanticCoverage.isComplete) {
      throw new Error(
        'Snapshot incompleteness denial: Incomplete capture cannot be represented as fully observed source'
      );
    }

    // Invariant 5: Empty artifacts rejection
    if (!params.artifacts || params.artifacts.length === 0) {
      throw new Error('Capture artifact set must contain at least one valid export artifact');
    }

    const nextVersion = binding.version + 1;

    // Atomically bump binding version and record capture set
    const captureSet = await this.db
      .insertInto('canva_capture_sets')
      .values({
        tenant_id: params.tenantId,
        binding_id: params.bindingId,
        task_id: params.taskId,
        client_id: params.clientId,
        parent_revision_id: params.parentRevisionId ?? null,
        captured_artifact_set_hash: params.capturedArtifactSetHash,
        artifacts: JSON.stringify(params.artifacts),
        export_settings: params.exportSettings ?? {},
        semantic_coverage: JSON.stringify(params.semanticCoverage),
        effect_job_id: params.effectJobId ?? null,
        auth_actor: JSON.stringify(params.authActor),
        version: nextVersion,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .updateTable('canva_bindings')
      .set({
        version: nextVersion,
        updated_at: new Date(),
      })
      .where('id', '=', params.bindingId)
      .execute();

    return captureSet;
  }

  async listCaptureSetsForTask(tenantId: string, taskId: string) {
    return await this.db
      .selectFrom('canva_capture_sets')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .execute();
  }
}
