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

    if (!task.client_id || task.client_id !== params.clientId) {
      throw new Error(
        `Server-derived ownership denial: task belongs to client ${task.client_id}, cannot bind for client ${params.clientId}`
      );
    }

    // A retry of the identical task binding is safe; changing its document is not.
    const existing = await client.selectFrom('canva_bindings').selectAll()
      .where('tenant_id', '=', params.tenantId).where('task_id', '=', params.taskId)
      .where('direction_name', '=', params.directionName ?? 'primary').executeTakeFirst();
    if (existing) {
      if (existing.client_id !== params.clientId || existing.canva_design_id !== params.canvaDesignId ||
          existing.edit_url !== params.editUrl || existing.status !== 'bound') throw new Error('Canva binding conflict');
      return existing;
    }
    // The global unique design index enforces ownership even across concurrent
    // tenants hidden by RLS. Application-side checks alone cannot do that.
    const inserted = await client
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
      .onConflict(oc => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    const replay = await client.selectFrom('canva_bindings').selectAll()
      .where('tenant_id', '=', params.tenantId).where('task_id', '=', params.taskId)
      .where('direction_name', '=', params.directionName ?? 'primary').executeTakeFirst();
    if (replay && replay.client_id === params.clientId && replay.canva_design_id === params.canvaDesignId &&
        replay.edit_url === params.editUrl && replay.status === 'bound') return replay;
    throw new Error('Canva binding conflict');
  }

  async captureArtifactSet(params: CaptureArtifactSetParams) {
    const capture = async (trx: Kysely<Database>) => {
      const binding = await trx.selectFrom('canva_bindings').selectAll()
        .where('id', '=', params.bindingId).where('tenant_id', '=', params.tenantId)
        .forUpdate().executeTakeFirst();
      if (!binding || binding.status !== 'bound' || binding.task_id !== params.taskId ||
          binding.client_id !== params.clientId || binding.canva_design_id !== params.canvaDesignId) {
        if (binding && binding.client_id !== params.clientId) {
          throw new Error(`Foreign client denial: Capture binding scope mismatch for foreign client ${params.clientId}`);
        }
        throw new Error('Capture binding scope mismatch');
      }
      if (binding.version !== params.expectedVersion) throw new Error('Stale version conflict');
      if (!params.semanticCoverage.isComplete || (params.semanticCoverage.unobservedLayersCount ?? 0) > 0) {
        throw new Error('Snapshot incompleteness denial: Incomplete semantic capture (unobserved layers or incomplete coverage flag)');
      }
      if (!/^[a-f0-9]{64}$/.test(params.capturedArtifactSetHash) || !params.artifacts.length ||
          params.artifacts.some(a => !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.byteSize) || a.byteSize <= 0)) {
        throw new Error('Capture requires valid artifact hashes and nonempty bytes');
      }
      if (params.parentRevisionId) {
        const parent = await trx.selectFrom('design_revisions').select('id')
          .where('id', '=', params.parentRevisionId).where('tenant_id', '=', params.tenantId)
          .where('task_id', '=', params.taskId).executeTakeFirst();
        if (!parent) throw new Error('Parent revision scope mismatch');
      }
      const version = binding.version + 1;
      const row = await trx.insertInto('canva_capture_sets').values({
        tenant_id: params.tenantId, binding_id: params.bindingId, task_id: params.taskId,
        client_id: params.clientId, parent_revision_id: params.parentRevisionId ?? null,
        captured_artifact_set_hash: params.capturedArtifactSetHash,
        artifacts: JSON.stringify(params.artifacts), export_settings: params.exportSettings ?? {},
        semantic_coverage: JSON.stringify(params.semanticCoverage), effect_job_id: params.effectJobId ?? null,
        auth_actor: JSON.stringify(params.authActor), version,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable('canva_bindings').set({ version, updated_at: new Date() })
        .where('id', '=', binding.id).where('tenant_id', '=', params.tenantId).execute();
      return row;
    };
    // Keep the caller's RLS transaction if present; otherwise own the transaction.
    return this.db.isTransaction ? capture(this.db) : this.db.transaction().execute(capture);
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
