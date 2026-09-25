import type { Generated, ColumnType } from 'kysely';
import type { TaskDbState } from '@hawa/contracts';

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

/** The task_state enum: the one list is packages/contracts task-status.ts (architecture programme 1.2). */
export type TaskState = TaskDbState;

export interface TasksTable {
  id: Generated<string>;
  tenant_id: string;
  request_id: Generated<string | null>;
  client_id: string | null;
  project_id: string | null;
  source_message_id: string | null;
  title: string;
  description: Generated<string>;
  state: TaskState;
  task_type: string | null;
  language: string | null;
  direction: 'ltr' | 'rtl' | 'auto' | null;
  priority: Generated<number>;
  sensitivity: Generated<'normal' | 'sensitive' | 'restricted'>;
  requested_by: string | null;
  assigned_to: string | null;
  due_at: Date | null;
  current_brief_id: string | null;
  current_plan_id: string | null;
  current_design_revision_id: string | null;
  workflow_id: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: Date | null;
  deleted_at: Date | null;
}

export interface TaskEventsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  event_type: string;
  schema_version: Generated<number>;
  aggregate_version: number;
  actor_type: 'user' | 'model' | 'workflow' | 'adapter' | 'system';
  actor_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  trace_id: string | null;
  data: Record<string, unknown>;
  occurred_at: Generated<Date>;
}

export interface InboxEventsTable {
  id: Generated<string>;
  tenant_id: string;
  integration_id?: string | null;
  source_account_id: string;
  source_event_id: string;
  source_sequence?: string | null;
  event_kind: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  verified: boolean;
  occurred_at?: Date | null;
  received_at: Generated<Date>;
  processing_error?: string | null;
}

export interface IntegrationsTable {
  id: Generated<string>;
  tenant_id: string;
  kind: string;
  name: string;
  config_public: Generated<Record<string, unknown>>;
  config_encrypted?: Buffer | null;
  enabled: Generated<boolean>;
  version?: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IntegrationHealthTable {
  integration_id: string;
  tenant_id: string;
  state: Generated<'unknown' | 'healthy' | 'degraded' | 'unavailable' | 'reauth_required'>;
  cursor_value?: string | null;
  last_event_at?: Date | null;
  last_success_at?: Date | null;
  last_checked_at?: Date | null;
  detail: Generated<Record<string, unknown>>;
  updated_at: Generated<Date>;
}

export interface ChannelRoutesTable {
  id: Generated<string>;
  tenant_id: string;
  integration_id: string;
  external_account_id: string;
  external_channel_id: string;
  external_topic_id: Generated<string>;
  client_id?: string | null;
  project_id?: string | null;
  allowed_client_ids: Generated<string[]>;
  promotion_policy: Generated<Record<string, unknown>>;
  valid_from: Generated<Date>;
  valid_until?: Date | null;
  created_by?: string | null;
  created_at: Generated<Date>;
}

export interface MessageEventsTable {
  id: Generated<string>;
  tenant_id: string;
  inbox_event_id?: string | null;
  integration_id?: string | null;
  external_account_id: string;
  external_channel_id: string;
  external_thread_id?: string | null;
  external_message_id: string;
  external_revision_id: Generated<string>;
  sender_external_id?: string | null;
  mapped_user_id?: string | null;
  language?: string | null;
  direction?: 'ltr' | 'rtl' | 'auto' | null;
  text_original: Generated<string>;
  entities: Generated<unknown[]>;
  raw_payload_encrypted?: Buffer | null;
  occurred_at?: Date | null;
  received_at: Generated<Date>;
  deleted_at_source?: Date | null;
}

export interface MessageAttachmentsTable {
  id: Generated<string>;
  tenant_id: string;
  message_event_id: string;
  source_attachment_id?: string | null;
  filename: string;
  mime_type: string;
  byte_size: number | bigint;
  sha256: string;
  storage_key: string;
  scan_state: Generated<'pending' | 'clean' | 'quarantined' | 'rejected'>;
  metadata: Generated<Record<string, unknown>>;
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

export interface OutboxCommandsTable {
  id: Generated<string>;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  command_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  state: Generated<'pending' | 'leased' | 'delivered' | 'failed' | 'dead'>;
  available_at: Generated<Date>;
  leased_until: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<Date>;
  delivered_at: Date | null;
}

export interface RequestsTable {
  request_id: string;
  tenant_id: string;
  root_task_id: string;
  current_task_id: string;
  parent_request_id: string | null;
  owner: 'core' | 'restate';
  stage: 'designing' | 'awaiting_answer' | 'in_review' | 'manual' | 'approved' | 'delivering' | 'delivered' | 'expired' | 'cancelled';
  rev: number;
  chat_id: string | null;
  draft_sent_at: Date | null;
  question_asked_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LifecycleProjectionsTable {
  tenant_id: string;
  request_id: string;
  rev: number;
  idempotency_key: string;
  payload_sha256: string;
  result: Record<string, unknown>;
  applied_at: Generated<Date>;
}

export interface PublicationsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  design_revision_id: string;
  approval_id: string;
  publication_key: string;
  state: 'pending' | 'staging' | 'drive_pending' | 'drive_complete' | 'sheet_pending' | 'complete' | 'failed' | 'cancelled';
  package_manifest: Record<string, unknown>;
  package_sha256: string;
  attempt: Generated<number>;
  error_class: string | null;
  error_detail: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: Date | null;
  /** Who delivers it: Core, or the Restate Delivery workflow (migration 022). */
  executor: Generated<'core' | 'restate'>;
  /** Delivery workflow runs started, and the last one that reported back (migration 022). */
  executor_run: Generated<number>;
  executor_finished_run: Generated<number>;
}

export interface DriveRefsTable {
  id: Generated<string>;
  tenant_id: string;
  publication_id: string;
  artifact_id: string | null;
  shared_drive_id: string;
  folder_id: string;
  file_id: string;
  file_name: string;
  mime_type: string;
  expected_sha256: string | null;
  observed_size: number | null;
  permission_digest: string | null;
  verified_at: Date | null;
  status: 'uploaded' | 'verified' | 'missing' | 'mismatch' | 'deleted';
  created_at: Generated<Date>;
}

export interface DriveUploadReservationsTable {
  id: Generated<string>;
  tenant_id: string;
  publication_id: string;
  artifact_id: string;
  task_id: string;
  package_sha256: string;
  folder_id: string;
  file_name: string;
  mime_type: string;
  expected_sha256: string;
  drive_file_id: string;
  created_at: Generated<Date>;
}

export interface SheetSyncsTable {
  id: Generated<string>;
  tenant_id: string;
  publication_id: string;
  spreadsheet_id: string;
  sheet_id: number;
  task_id: string;
  row_key: string;
  row_number: number | null;
  expected_hash: string;
  observed_hash: string | null;
  status: 'pending' | 'synced' | 'stale' | 'missing' | 'failed';
  attempts: Generated<number>;
  last_error: string | null;
  synced_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface FeedbackEventsTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string;
  project_id: string | null;
  task_id: string | null;
  before_revision_id: string | null;
  after_revision_id: string | null;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  scope: 'one_time' | 'task_type' | 'project' | 'client' | 'office';
  explicitness: 'direct_instruction' | 'manual_edit' | 'approval_signal' | 'inferred_pattern';
  target: unknown;
  original_value: unknown | null;
  corrected_value: unknown | null;
  comment: string | null;
  actor_id: string | null;
  confidence: number | null;
  created_at: Generated<Date>;
}

export interface DesignJobsTable {
  id: Generated<string>;
  task_id: string;
  client_id: string;
  route: 'buzz_template' | 'figma_freeform' | 'human';
  figma_file_key: string | null;
  figma_node_id: string | null;
  template_id: string | null;
  revision: Generated<number>;
  state: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface FigmaLeasesTable {
  id: Generated<string>;
  task_id: string;
  client_id: string;
  figma_file_key: string;
  holder: string;
  expires_at: Date;
  released_at: Date | null;
}

export interface FigmaMutationsTable {
  id: Generated<string>;
  design_job_id: string;
  command_id: string;
  expected_revision: number;
  resulting_revision: number | null;
  operation: string;
  args_hash: string;
  affected_node_ids: string[] | null;
  marker_id: string | null;
  status: string;
  created_at: Generated<Date>;
}

export interface DesignDocumentsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  direction_name: Generated<string>;
  studio: string;
  studio_document_id: string | null;
  created_at: Generated<Date>;
}

export interface DesignRevisionsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  design_document_id: string;
  parent_revision_id: string | null;
  revision: number;
  studio: string;
  studio_version: string;
  studio_schema_version: string;
  source_storage_key: string;
  source_sha256: string;
  neutral_manifest: Record<string, unknown>;
  neutral_manifest_sha256: string;
  semantic_hash: string;
  preview_sha256: string | null;
  author_type: 'user' | 'model' | 'workflow' | 'import';
  author_id: string | null;
  status: Generated<'draft' | 'review' | 'approved' | 'rejected' | 'superseded'>;
  created_at: Generated<Date>;
}

export interface QcProfilesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  version: Generated<number>;
  rules: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  created_at: Generated<Date>;
}

export interface QcRunsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  design_revision_id: string;
  qc_profile_id: string;
  attempt: Generated<number>;
  status: 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
  critical_pass: boolean | null;
  report: Generated<Record<string, unknown>>;
  report_sha256: string | null;
  trace_id: string | null;
  started_at: Generated<Date>;
  completed_at: Date | null;
}

export interface ReviewRequestsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  design_revision_id: string;
  qc_run_id: string | null;
  stage: string;
  assigned_user_id: string | null;
  assigned_role: string | null;
  status: Generated<'open' | 'decided' | 'expired' | 'cancelled' | 'superseded'>;
  expires_at: Date | null;
  created_at: Generated<Date>;
}

export interface ApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  review_request_id: string;
  design_revision_id: string;
  qc_run_id: string | null;
  decision: 'approved' | 'revision_requested' | 'rejected' | 'escalated';
  decided_by: string;
  reason: string | null;
  decision_payload: Generated<Record<string, unknown>>;
  nonce: string;
  created_at: Generated<Date>;
}
export interface CanvaBindingsTable {
  id: Generated<string>;
  tenant_id: string;
  task_id: string;
  client_id: string;
  canva_design_id: string;
  canva_team_id: string | null;
  canva_user_id: string | null;
  edit_url: string;
  view_url: string | null;
  direction_name: Generated<string>;
  status: Generated<'bound' | 'unbound' | 'revoked'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CanvaCaptureSetsTable {
  id: Generated<string>;
  tenant_id: string;
  binding_id: string;
  task_id: string;
  client_id: string;
  parent_revision_id: string | null;
  captured_artifact_set_hash: string;
  artifacts: unknown;
  export_settings: Generated<Record<string, unknown>>;
  semantic_coverage: unknown;
  effect_job_id: string | null;
  auth_actor: unknown;
  version: Generated<number>;
  created_at: Generated<Date>;
}

export type DesignStudioTier = 'standard' | 'premium';

export type DesignStudioStatus =
  | 'briefing'
  | 'conceiving'
  | 'laying_out'
  | 'rendering'
  | 'critiquing'
  | 'revising'
  | 'judging'
  | 'qa'
  | 'awaiting_selection'
  | 'transferring'
  | 'transferred'
  | 'degraded'
  | 'failed'
  | 'abandoned';

export type DesignStudioJudgeStatus = 'PENDING' | 'RELIABLE' | 'UNRELIABLE' | 'SKIPPED';

export interface DesignStudioRunsTable {
  id: string;
  tenant_id: string;
  task_id: string;
  client_id: string;
  actor_id: string;
  request_key: string;
  request_hash: string;
  request: unknown;
  tier: DesignStudioTier;
  status: DesignStudioStatus;
  judge_status: DesignStudioJudgeStatus | null;
  budget: Generated<unknown>;
  stages: Generated<unknown>;
  winner_candidate_id: string | null;
  plan_id: string | null;
  diagnostic: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type DesignStudioCandidateStatus = 'draft' | 'active' | 'eliminated' | 'winner' | 'runner_up';

export interface DesignStudioCandidatesTable {
  id: string;
  run_id: string;
  tenant_id: string;
  ordinal: number;
  concept: unknown;
  layouts: Generated<unknown[]>;
  metrics: unknown | null;
  critiques: Generated<unknown[]>;
  score: number | null;
  rank: number | null;
  status: DesignStudioCandidateStatus;
  preview_png: Buffer | null;
  preview_sha256: string | null;
  composite_png: Buffer | null;
  /** The composite's file in the store (migration 019, ADR-035); preview_sha256 and art_sha256 name theirs. */
  composite_sha256: string | null;
  art_png: Buffer | null;
  art_sha256: string | null;
  art_provenance: unknown | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type DesignStudioJudgmentKind = 'critique' | 'pairwise' | 'canary' | 'parity' | 'art_check';

export interface DesignStudioJudgmentsTable {
  id: string;
  run_id: string;
  tenant_id: string;
  kind: DesignStudioJudgmentKind;
  candidate_a: string | null;
  candidate_b: string | null;
  order_swapped: Generated<boolean>;
  verdict: unknown;
  call_id: string | null;
  created_at: Generated<Date>;
}

export type DesignStudioCallStatus = 'ok' | 'error' | 'uncertain';

export interface DesignStudioCallsTable {
  id: string;
  run_id: string;
  tenant_id: string;
  stage: string;
  provider: string;
  model: string;
  requested_model: string;
  /** Null only for pre-ADR-049 calls and content-keyed parity calls. */
  call_ordinal: number | null;
  /** SHA-256 of the logical call identity; null only on historical rows. */
  logical_call_sha256: string | null;
  response_id: string | null;
  input_tokens: Generated<number>;
  cached_input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  images: Generated<number>;
  usd_estimate: Generated<number | string>;
  status: DesignStudioCallStatus;
  error_code: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

export type DesignFeedbackSource = 'desk' | 'telegram' | 'import';
export type DesignFeedbackVerdict = 'approve' | 'reject' | 'revise' | 'rating';

export interface DesignFeedbackTable {
  id: string;
  tenant_id: string;
  task_id: string;
  run_id: string | null;
  candidate_id: string | null;
  actor_id: string;
  source: DesignFeedbackSource;
  verdict: DesignFeedbackVerdict;
  rating: number | null;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface ClientDnaVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string;
  version: number;
  status: 'draft' | 'active' | 'inactive' | 'superseded' | 'deleted';
  dna: ColumnType<unknown, string | object, string | object>;
  content_hash: string;
  effective_from: Date | null;
  effective_until: Date | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: Generated<Date>;
}

export interface ClientRulesTable {
  id: Generated<string>;
  tenant_id: string;
  client_id: string;
  project_id: string | null;
  dna_version_id: string | null;
  rule_key: string;
  category: string;
  scope: 'one_time' | 'task_type' | 'project' | 'client' | 'office';
  machine_rule: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
  human_rule: string;
  status: 'draft' | 'active' | 'inactive' | 'superseded' | 'deleted';
  priority: Generated<number>;
  effective_from: Date | null;
  effective_until: Date | null;
  supersedes_rule_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: Generated<Date>;
}

export interface RuleEvidenceTable {
  rule_id: string;
  feedback_event_id: string | null;
  source_kind: string;
  source_id: string;
  weight: Generated<number>;
  note: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  client_rules: ClientRulesTable;
  rule_evidence: RuleEvidenceTable;
  users: UsersTable;
  clients: ClientsTable;
  client_dna_versions: ClientDnaVersionsTable;
  projects: ProjectsTable;
  client_channels: ClientChannelsTable;
  tasks: TasksTable;
  requests: RequestsTable;
  lifecycle_projections: LifecycleProjectionsTable;
  task_events: TaskEventsTable;
  inbox_events: InboxEventsTable;
  message_events: MessageEventsTable;
  message_attachments: MessageAttachmentsTable;
  integrations: IntegrationsTable;
  integration_health: IntegrationHealthTable;
  channel_routes: ChannelRoutesTable;
  raw_ingress_events: RawIngressEventsTable;
  outbox_commands: OutboxCommandsTable;
  outbox: OutboxCommandsTable;
  publications: PublicationsTable;
  drive_upload_reservations: DriveUploadReservationsTable;
  drive_refs: DriveRefsTable;
  sheet_syncs: SheetSyncsTable;
  feedback_events: FeedbackEventsTable;
  design_jobs: DesignJobsTable;
  figma_leases: FigmaLeasesTable;
  figma_mutations: FigmaMutationsTable;
  design_documents: DesignDocumentsTable;
  design_revisions: DesignRevisionsTable;
  qc_profiles: QcProfilesTable;
  qc_runs: QcRunsTable;
  review_requests: ReviewRequestsTable;
  approvals: ApprovalsTable;
  canva_bindings: CanvaBindingsTable;
  canva_capture_sets: CanvaCaptureSetsTable;
  design_studio_runs: DesignStudioRunsTable;
  design_studio_candidates: DesignStudioCandidatesTable;
  design_studio_judgments: DesignStudioJudgmentsTable;
  design_studio_calls: DesignStudioCallsTable;
  design_feedback: DesignFeedbackTable;
}
