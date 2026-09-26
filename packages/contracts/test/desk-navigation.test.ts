import { describe, expect, it } from 'vitest';
import { deskReviewPath, deskReviewTarget, deskReviewUrl, parseDeskReviewParams } from '../src/desk-navigation.js';
const taskId = 'aa000000-0000-4000-8000-000000000001';
const revisionId = 'aa000000-0000-4000-8000-000000000002';
describe('Desk review navigation, without an authority grant', () => {
  it('round trips the exact task and revision, including old task-only notifications', () => {
    const path = deskReviewPath({ taskId, revisionId });
    expect(deskReviewTarget(path.slice(1))).toEqual({ taskId, revisionId });
    expect(deskReviewTarget(`#task-${taskId}`)).toEqual({ taskId });
    expect(deskReviewTarget(`#task-${taskId.toUpperCase()}`)).toEqual({ taskId });
  });
  it('rejects unknown, duplicate, malformed and external destinations', () => {
    for (const query of [`task=${taskId}&task=${taskId}`, `task=${taskId}&revision=${revisionId}&revision=${revisionId}`,
      `task=${taskId}&revision=`, `revision=${revisionId}`, 'task=https://outside.test',
      `task=${taskId}&returnTo=https://outside.test`, '']) {
      expect(parseDeskReviewParams(new URLSearchParams(query)), query).toBeUndefined();
    }
    expect(deskReviewTarget(`#/settings?task=${taskId}`)).toBeUndefined();
    expect(deskReviewTarget(`#task-${taskId}?returnTo=https://outside.test`)).toBeUndefined();
    expect(() => deskReviewPath({ taskId: '//outside.test' })).toThrow();
  });
  it('uses only a configured HTTPS origin for notification links', () => {
    expect(deskReviewUrl('https://desk.example.test/', { taskId, revisionId }))
      .toBe(`https://desk.example.test/#/work?task=${taskId}&revision=${revisionId}`);
    for (const base of [undefined, 'http://localhost:8080', 'javascript:alert(1)', '//outside.test',
      'https://user:password@desk.test', 'https://desk.test/path', 'https://desk.test/?redirect=elsewhere', 'https://desk.test/#work']) {
      expect(deskReviewUrl(base, { taskId }), base).toBeUndefined();
    }
  });
});
