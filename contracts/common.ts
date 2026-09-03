export type UUID = string;
export type SHA256 = string;
export type ISODateTime = string;
export type JsonObject = Record<string, unknown>;

export type Result<T, E extends AppError = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  safeAction: string;
  detail?: JsonObject;
  cause?: unknown;
}

export interface RequestContext {
  tenantId: UUID;
  clientId?: UUID;
  projectId?: UUID;
  taskId?: UUID;
  actor: { type: 'user' | 'workflow' | 'model' | 'adapter' | 'system'; id: string };
  correlationId: UUID;
  traceId?: string;
  deadline: ISODateTime;
  idempotencyKey: string;
  abortSignal?: AbortSignal;
}

export interface CapabilityReport {
  name: string;
  version: string;
  healthy: boolean;
  capabilities: Record<string, boolean | string | number>;
  limits: JsonObject;
  checkedAt: ISODateTime;
}
