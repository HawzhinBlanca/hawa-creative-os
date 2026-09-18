import { describe, it, expect } from 'vitest';
import { isV3PilotChat } from '../src/services/chat-intake.js';

// T7 is blocked on one environment value only the owner can write. This proves the code that
// consumes it behaves, so setting it is a one-line change with a known outcome rather than a hope.
describe('DESIGN_PIPELINE_V3_CHATS routing', () => {
  it('enrols a listed chat and leaves others alone', () => {
    expect(isV3PilotChat('450405554', '450405554')).toBe(true);
    expect(isV3PilotChat('999000111', '450405554')).toBe(false);
  });

  it('accepts a comma-separated list with untidy spacing', () => {
    const raw = ' 450405554 , 123456789,987654321 ';
    expect(isV3PilotChat('450405554', raw)).toBe(true);
    expect(isV3PilotChat('123456789', raw)).toBe(true);
    expect(isV3PilotChat('987654321', raw)).toBe(true);
    expect(isV3PilotChat('555', raw)).toBe(false);
  });

  it('enrols nobody when unset, empty, or only separators', () => {
    expect(isV3PilotChat('450405554', undefined)).toBe(false);
    expect(isV3PilotChat('450405554', '')).toBe(false);
    expect(isV3PilotChat('450405554', ' , , ')).toBe(false);
  });

  it('never enrols a chat with no usable channel id', () => {
    expect(isV3PilotChat(undefined, '450405554')).toBe(false);
    expect(isV3PilotChat('', '450405554')).toBe(false);
  });
});
