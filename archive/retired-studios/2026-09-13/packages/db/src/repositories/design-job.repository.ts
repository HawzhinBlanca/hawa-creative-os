import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export interface CreateDesignJobParams {
  taskId: string;
  clientId: string;
  route: 'buzz_template' | 'figma_freeform' | 'human';
  figmaFileKey?: string;
  figmaNodeId?: string;
  templateId?: string;
}

export interface RecordMutationParams {
  designJobId: string;
  commandId: string;
  expectedRevision: number;
  resultingRevision?: number;
  operation: string;
  argsHash: string;
  affectedNodeIds?: string[];
  markerId?: string;
  status: string;
}

export class DesignJobRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string) {
    return await this.db
      .selectFrom('design_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByTaskId(taskId: string) {
    return await this.db
      .selectFrom('design_jobs')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  async create(params: CreateDesignJobParams) {
    return await this.db
      .insertInto('design_jobs')
      .values({
        task_id: params.taskId,
        client_id: params.clientId,
        route: params.route,
        figma_file_key: params.figmaFileKey || null,
        figma_node_id: params.figmaNodeId || null,
        template_id: params.templateId || null,
        revision: 0,
        state: 'staging',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateState(id: string, state: string, figmaNodeId?: string) {
    return await this.db
      .updateTable('design_jobs')
      .set({
        state,
        ...(figmaNodeId ? { figma_node_id: figmaNodeId } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async recordMutation(params: RecordMutationParams) {
    const mutation = await this.db
      .insertInto('figma_mutations')
      .values({
        design_job_id: params.designJobId,
        command_id: params.commandId,
        expected_revision: params.expectedRevision,
        resulting_revision: params.resultingRevision ?? null,
        operation: params.operation,
        args_hash: params.argsHash,
        affected_node_ids: params.affectedNodeIds || null,
        marker_id: params.markerId || null,
        status: params.status,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (params.resultingRevision !== undefined) {
      await this.db
        .updateTable('design_jobs')
        .set({
          revision: params.resultingRevision,
          updated_at: new Date(),
        })
        .where('id', '=', params.designJobId)
        .execute();
    }

    return mutation;
  }
}
