import type { Generated } from 'kysely';

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  timezone: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  external_subject: string | null;
  disabled_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ClientsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  aliases: string[];
  default_language: string;
  retention_policy: Record<string, unknown>;
  model_egress_policy: Record<string, unknown>;
  status: 'draft' | 'active' | 'inactive' | 'superseded' | 'deleted';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProjectsTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string;
  code: string;
  name: string;
  aliases: string[];
  status: 'draft' | 'active' | 'inactive' | 'superseded' | 'deleted';
  due_policy: Record<string, unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ClientChannelsTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string;
  project_id: string | null;
  adapter_kind: string;
  account_id: string;
  channel_id: string;
  topic_id: string | null;
  routing_confidence: number;
  active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TasksTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string | null;
  project_id: string | null;
  status: string;
  priority: string;
  source_platform: string;
  source_event_id: string;
  source_channel_id: string;
  idempotency_key: string;
  client_scope_locked: boolean;
  brief: Record<string, unknown> | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TaskEventsTable {
  id: Generated<string>;
  task_id: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  actor_type: string;
  reason: string;
  payload: Record<string, unknown> | null;
  created_at: Generated<Date>;
}

export interface RawIngressEventsTable {
  id: Generated<string>;
  adapter_kind: string;
  source_event_id: string;
  payload_hash: string;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
  verified: boolean;
  received_at: Generated<Date>;
}

export interface OutboxTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string | null;
  destination: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'leased' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  last_error: string | null;
  created_at: Generated<Date>;
  delivered_at: Date | null;
}

export interface PublicationsTable {
  id: Generated<string>;
  task_id: string;
  client_id: string;
  revision_id: string;
  shared_drive_id: string;
  drive_folder_id: string;
  sheet_row_id: string | null;
  state: 'pending' | 'staging' | 'drive_pending' | 'drive_complete' | 'sheet_pending' | 'complete' | 'failed' | 'cancelled';
  manifest_hash: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface FeedbackEventsTable {
  id: Generated<string>;
  task_id: string;
  client_id: string;
  revision_id: string;
  node_id: string | null;
  polarity: 'positive' | 'negative' | 'neutral';
  category: string;
  raw_feedback_text: string;
  attributed_user_id: string;
  governance_status: string;
  created_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  clients: ClientsTable;
  projects: ProjectsTable;
  client_channels: ClientChannelsTable;
  tasks: TasksTable;
  task_events: TaskEventsTable;
  raw_ingress_events: RawIngressEventsTable;
  outbox: OutboxTable;
  publications: PublicationsTable;
  feedback_events: FeedbackEventsTable;
}
