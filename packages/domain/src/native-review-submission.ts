export interface NativeRecoveryScope { requestId: string; rev: number }
export interface NativeReviewSubmission {
  v: 1; kind: 'native_review'; eventId: string; actionId: string;
  requestId: string; taskId: string; expectedRev: number; expectedTaskVersion: number;
  artifactId: string; confirmationEventId: string;
  actor: { userId: string; role: string };
}
export type NativeReviewReply =
  | { accepted: true; requestId: string; taskId: string; actionId: string;
      revisionId: string; rev: number; stage: 'in_review'; qaPassed: boolean }
  | { accepted: false; code: 'WRONG_STAGE' };

export const NATIVE_RECOVERY_ROLES = ['administrator', 'art_director', 'creative_director', 'operator', 'designer'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strict wire contract shared by public admission, signed gateway and durable owner. */
export function parseNativeReviewSubmission(value: unknown): NativeReviewSubmission | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>, actor = v.actor as Record<string, unknown> | undefined;
  const keys = ['v','kind','eventId','actionId','requestId','taskId','expectedRev','expectedTaskVersion','artifactId','confirmationEventId','actor'];
  if (Object.keys(v).some(k => !keys.includes(k)) || v.v !== 1 || v.kind !== 'native_review' ||
      ['actionId','requestId','taskId','artifactId','confirmationEventId'].some(k => typeof v[k] !== 'string' || !UUID.test(v[k] as string)) ||
      v.eventId !== `desk:${v.actionId}` || !Number.isSafeInteger(v.expectedRev) || Number(v.expectedRev) < 1 ||
      !Number.isSafeInteger(v.expectedTaskVersion) || Number(v.expectedTaskVersion) < 1 ||
      !actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).some(k => !['userId','role'].includes(k)) ||
      typeof actor.userId !== 'string' || !UUID.test(actor.userId) ||
      !NATIVE_RECOVERY_ROLES.some(role => role === actor.role)) return;
  return value as NativeReviewSubmission;
}
