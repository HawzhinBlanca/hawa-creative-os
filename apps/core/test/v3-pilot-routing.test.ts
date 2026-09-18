import { describe, it, expect, afterEach } from 'vitest';
import { isV3PilotChat, runsPipelineV3 } from '../src/services/chat-intake.js';
import { isPipelineV3Run } from '../src/services/design-studio/design-studio-service.js';

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

// Enrolment has to reach the pipeline, not just the studio. Before this, a pilot chat was routed
// into the studio whose v3 branches read only the global flag, so the pilot silently ran v2.
describe('which pipeline a chat runs', () => {
  it('runs a pilot chat on v3 while the global flag is off, and nobody else', () => {
    const env = { DESIGN_PIPELINE_V3: 'off', DESIGN_PIPELINE_V3_CHATS: '450405554' };
    expect(runsPipelineV3('450405554', env)).toBe(true);
    expect(runsPipelineV3('999000111', env)).toBe(false);
    expect(runsPipelineV3(undefined, env)).toBe(false);
  });

  it('runs every chat on v3 when the global flag is on', () => {
    const env = { DESIGN_PIPELINE_V3: 'on' };
    expect(runsPipelineV3('999000111', env)).toBe(true);
    expect(runsPipelineV3(undefined, env)).toBe(true);
  });

  it('runs nothing on v3 when neither is set', () => {
    expect(runsPipelineV3('450405554', {})).toBe(false);
  });
});

describe('a run keeps the pipeline it was created with', () => {
  const original = process.env.DESIGN_PIPELINE_V3;
  afterEach(() => {
    if (original === undefined) delete process.env.DESIGN_PIPELINE_V3;
    else process.env.DESIGN_PIPELINE_V3 = original;
  });

  it('reads the decision recorded on the run, as stored or as a JSON string', () => {
    process.env.DESIGN_PIPELINE_V3 = 'off';
    expect(isPipelineV3Run({ request: { pipelineV3: true } })).toBe(true);
    expect(isPipelineV3Run({ request: JSON.stringify({ pipelineV3: true }) })).toBe(true);
    expect(isPipelineV3Run({ request: { width: 1080 } })).toBe(false);
  });

  it('honours the global flag for runs created before the decision was recorded', () => {
    process.env.DESIGN_PIPELINE_V3 = 'on';
    expect(isPipelineV3Run({ request: { width: 1080 } })).toBe(true);
  });
});
