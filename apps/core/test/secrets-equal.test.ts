import { describe, it, expect } from 'vitest';
import { secretsEqual } from '../src/app.js';

describe('secretsEqual: webhook secret comparison', () => {
  it('accepts only the exact configured secret', () => {
    expect(secretsEqual('office_secret', 'office_secret')).toBe(true);
    expect(secretsEqual('office_secreT', 'office_secret')).toBe(false);
    expect(secretsEqual('office_secret ', 'office_secret')).toBe(false);
    expect(secretsEqual('office', 'office_secret')).toBe(false);
  });

  it('never matches when either side is missing, so an unset secret cannot be satisfied by an empty header', () => {
    expect(secretsEqual('', '')).toBe(false);
    expect(secretsEqual(undefined, undefined)).toBe(false);
    expect(secretsEqual('x', undefined)).toBe(false);
    expect(secretsEqual(null, 'x')).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });
});
