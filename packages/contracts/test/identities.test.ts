import { describe, it, expect } from 'vitest';
import {
  ART_DIRECTOR_USER_ID,
  CHANNEL_INGRESS_USER_ID,
  PRIMARY_OPERATOR_USER_ID,
  SEEDED_TENANT_ID,
  SERVICE_USER_IDS,
  SYSTEM_AUTOMATION_USER_ID,
  isServiceUserId,
} from '../src/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('seeded identities', () => {
  it('are well-formed and distinct', () => {
    const all = [SEEDED_TENANT_ID, PRIMARY_OPERATOR_USER_ID, ART_DIRECTOR_USER_ID, CHANNEL_INGRESS_USER_ID, SYSTEM_AUTOMATION_USER_ID];
    for (const id of all) expect(id).toMatch(UUID);
    expect(new Set(all).size).toBe(all.length);
  });
  it('never classify a human as a service identity', () => {
    expect(isServiceUserId(PRIMARY_OPERATOR_USER_ID)).toBe(false);
    expect(isServiceUserId(ART_DIRECTOR_USER_ID)).toBe(false);
    expect(isServiceUserId(null)).toBe(false);
    expect(isServiceUserId(undefined)).toBe(false);
    for (const id of SERVICE_USER_IDS) expect(isServiceUserId(id)).toBe(true);
  });
});
