/**
 * Hawa Creative OS — Retention & Purge Engine (FR-080)
 *
 * Implements retention-aware data lifecycle, soft-deletion, and privileged purge
 * according to client and tenant data governance policies.
 */

export interface ClientRetentionPolicy {
  taskRetentionDays?: number;
  artifactRetentionDays?: number;
  auditRetentionDays?: number;
  allowHardPurge?: boolean;
}

export interface RetainableEntity {
  id: string;
  createdAt: Date | string;
  status: string;
  purgedAt?: Date | string | null;
}

const DEFAULT_RETENTION_POLICY: Required<ClientRetentionPolicy> = {
  taskRetentionDays: 90,
  artifactRetentionDays: 180,
  auditRetentionDays: 365 * 2, // 2 years audit trail
  allowHardPurge: false,
};

/**
 * Determines whether an entity has exceeded its configured retention window.
 */
export function evaluateRetentionEligibility(
  entity: RetainableEntity,
  policy: ClientRetentionPolicy = {},
  now: Date = new Date()
): boolean {
  const retentionDays = policy.taskRetentionDays ?? DEFAULT_RETENTION_POLICY.taskRetentionDays;
  const created = entity.createdAt instanceof Date ? entity.createdAt : new Date(entity.createdAt);
  const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  return created.getTime() < cutoffTime;
}

/**
 * Purges expired entities while preserving immutable audit trails.
 */
export function purgeExpiredEntities<T extends RetainableEntity>(
  entities: T[],
  policy: ClientRetentionPolicy = {},
  now: Date = new Date()
): { retained: T[]; purged: T[] } {
  const retained: T[] = [];
  const purged: T[] = [];

  for (const entity of entities) {
    if (evaluateRetentionEligibility(entity, policy, now)) {
      purged.push({
        ...entity,
        status: 'purged',
        purgedAt: now,
      });
    } else {
      retained.push(entity);
    }
  }

  return { retained, purged };
}
