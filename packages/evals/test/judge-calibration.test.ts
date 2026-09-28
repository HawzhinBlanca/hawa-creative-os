import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  analyzeBlindJudgeCalibration, prepareBlindJudgePacket, prepareBriefBoundCalibrationPacket, validateBlindJudgeVerdict,
  type BlindJudgeVerdict, type CalibrationObservation,
} from '../src/judge-calibration.js';
import { BRIEF_BOUND_JUDGE_PROMPT_VERSION, type BriefBoundVerdict } from '@hawa/creative';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
function png(value: number, width = 16, metadata = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = (value + x * 31 + y * 17) & 255;
      raw[offset + 1] = (value + x * y * 13) & 255;
      raw[offset + 2] = (value + x * 7 + y * y * 11) & 255;
      raw[offset + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    ...(metadata ? [chunk('tEXt', Buffer.from('arm\0candidate'))] : []),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const finding = (candidate: 'A' | 'B', severity: 'minor' | 'major' | 'critical' = 'major') => ({
  candidate, dimension: 'legibility' as const, severity,
  region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 }, explanation: 'The headline is clipped in this region.',
});
const verdict = (winner: BlindJudgeVerdict['winner'], findings: BlindJudgeVerdict['findings'] = []): BlindJudgeVerdict =>
  ({ winner, reason: 'The visible hierarchy supports this choice.', findings });

function observation(caseId: string, truth: CalibrationObservation['truth']): CalibrationObservation {
  const imageA = png(32), imageB = png(224);
  const imageASha256 = sha(imageA);
  const imageBSha256 = sha(imageB);
  const brief = 'A Sorani event poster.';
  const packetAB = prepareBlindJudgePacket({ brief, imageA, imageB, imageASha256, imageBSha256 });
  const packetBA = prepareBlindJudgePacket({ brief, imageA: imageB, imageB: imageA,
    imageASha256: imageBSha256, imageBSha256: imageASha256 });
  return { caseId, lineageId: `lineage-${caseId}`, language: 'ckb', format: 'square',
    imageASha256, imageBSha256,
    humanVotes: [
      { judgeId: 'independent-1', vote: 'B' }, { judgeId: 'independent-2', vote: 'B' },
      { judgeId: 'independent-3', vote: 'A' },
    ], truth,
    orderAB: { leftHash: imageASha256, rightHash: imageBSha256,
      promptVersion: packetAB.version, packetSha256: packetAB.packetSha256, judgeModelId: 'offline-fixture-model',
      verdict: verdict('B', [finding('A')]), costUsd: 0.01, latencyMs: 500 },
    orderBA: { leftHash: imageBSha256, rightHash: imageASha256,
      promptVersion: packetBA.version, packetSha256: packetBA.packetSha256, judgeModelId: 'offline-fixture-model',
      verdict: verdict('A', [finding('B')]), costUsd: null, latencyMs: null },
  };
}

describe('R06 offline visual judge calibration', () => {
  it('binds a metric-blind generic rubric to exact matching PNG exports', () => {
    const imageA = png(32), imageB = png(224);
    const packet = prepareBlindJudgePacket({ brief: 'Create a clear Sorani event poster.',
      imageA, imageB, imageASha256: sha(imageA), imageBSha256: sha(imageB) });
    expect(packet.advisoryOnly).toBe(true);
    expect(packet.packetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(`${packet.systemText}\n${packet.userText}`).not.toMatch(/KAAE|composite score|rank score/i);
    expect(packet.systemText).toMatch(/tie, or abstain/);
    expect(() => prepareBlindJudgePacket({ brief: 'x', imageA, imageB,
      imageASha256: sha(imageB), imageBSha256: sha(imageB) })).toThrow(/matching SHA-256/);
    const tagged = png(224, 16, true);
    expect(() => prepareBlindJudgePacket({ brief: 'x', imageA, imageB: tagged,
      imageASha256: sha(imageA), imageBSha256: sha(tagged) })).toThrow(/metadata removed/);
    const wide = png(224, 18);
    expect(() => prepareBlindJudgePacket({ brief: 'x', imageA, imageB: wide,
      imageASha256: sha(imageA), imageBSha256: sha(wide) })).toThrow(/equal dimensions/);
    const corrupted = Buffer.from(imageB);
    corrupted[corrupted.length - 5] ^= 1;
    expect(() => prepareBlindJudgePacket({ brief: 'x', imageA, imageB: corrupted,
      imageASha256: sha(imageA), imageBSha256: sha(corrupted) })).toThrow();
  });

  it('accepts ties and abstentions but refuses malformed or empty evidence regions', () => {
    expect(validateBlindJudgeVerdict(verdict('tie')).winner).toBe('tie');
    expect(validateBlindJudgeVerdict(verdict('abstain')).winner).toBe('abstain');
    expect(validateBlindJudgeVerdict(verdict('B', [finding('A')])).findings).toHaveLength(1);
    expect(() => validateBlindJudgeVerdict({ winner: 'A', reason: 'x' })).toThrow();
    expect(() => validateBlindJudgeVerdict({ ...verdict('A'), hiddenMetric: 99 })).toThrow();
    expect(() => validateBlindJudgeVerdict(verdict('A', [{ ...finding('B'),
      region: { x: 0.8, y: 0, width: 0.4, height: 0.1 } }]))).toThrow();
    expect(() => validateBlindJudgeVerdict(verdict('A', [{ ...finding('B'),
      region: { x: 0, y: 0, width: 0, height: 0 } }]))).toThrow();
  });

  it('reports human, swap, seeded-defect and clean-control denominators without admission', () => {
    const seeded = observation('seeded', { kind: 'seeded_defect', badCandidate: 'A', severity: 'major' });
    const clean = observation('clean', { kind: 'clean_control' });
    clean.language = 'ar';
    clean.format = 'story';
    clean.orderAB.verdict = verdict('tie', [finding('A', 'critical')]);
    clean.orderBA.verdict = verdict('abstain');
    const report = analyzeBlindJudgeCalibration([seeded, clean]);
    expect(report.admissionQualified).toBe(false);
    expect(report.lineageCount).toBe(2);
    expect(report.all).toMatchObject({ cases: 2, humanQualified: 2, orderStable: 1,
      orderDisagreements: 1, modelAbstentions: 1, humanComparable: 1, humanAgreement: 1,
      seededDefects: 1, detectedDefects: 1, cleanControls: 1, falseBlocks: 1 });
    expect(report.byLanguage.ckb.detectedDefects).toBe(1);
    expect(report.byLanguage.ckb.knownCostUsd).toBe(0.01);
    expect(report.byFormat.story.falseBlocks).toBe(1);
    expect(report.byDefectSeverity.major.detectedDefects).toBe(1);
    expect(report.receipts).toMatchObject({ knownCostUsd: 0.02, unknownCostCalls: 2,
      knownLatencyCalls: 2, unknownLatencyCalls: 2 });
    expect(() => analyzeBlindJudgeCalibration([seeded, seeded])).toThrow(/repeated calibration case/);
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded,
      humanVotes: [seeded.humanVotes[0], seeded.humanVotes[0]] }])).toThrow(/distinct/);
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded,
      orderBA: { ...seeded.orderBA, rightHash: seeded.imageBSha256 } }])).toThrow(/same exported images/);
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded,
      orderBA: { ...seeded.orderBA, judgeModelId: 'another-model' } }])).toThrow(/same model/);
  });
});

describe('ADR-124 brief-bound challenger on the same calibration interface', () => {
  const brief = {
    instructions: 'Sorani event poster; the date must be easy to find.',
    copy: [{ copyIndex: 0, text: 'کۆنفرانسی جۆری ٢٠٢٦', role: 'title' }, { copyIndex: 1, text: 'Erbil • 24 October 2026', role: 'date' }],
  };
  const dims = (c: string, m: string, a: string): BriefBoundVerdict['dimensions'] => ({
    correctness: { choice: c as any, reason: 'Readable in the export.' },
    communication: { choice: m as any, reason: 'The date is found quickly.' },
    aesthetic: { choice: a as any, reason: 'Balanced composition.' },
  });
  const copyFinding = (candidate: 'A' | 'B') => ({ candidate, dimension: 'correctness' as const, severity: 'critical' as const,
    region: { x: 0.1, y: 0.7, width: 0.6, height: 0.1 }, copyIndex: 1, explanation: 'The date shows 25 October.' });

  function briefBound(caseId: string, truth: CalibrationObservation['truth']): CalibrationObservation {
    const imageA = png(40), imageB = png(200);
    const imageASha256 = sha(imageA), imageBSha256 = sha(imageB);
    const ab = prepareBriefBoundCalibrationPacket({ brief, imageA, imageB, imageASha256, imageBSha256 });
    const ba = prepareBriefBoundCalibrationPacket({ brief, imageA: imageB, imageB: imageA, imageASha256: imageBSha256, imageBSha256: imageASha256 });
    return { caseId, lineageId: `lineage-${caseId}`, language: 'ckb', format: 'square', imageASha256, imageBSha256,
      humanVotes: [{ judgeId: 'h1', vote: 'B' }, { judgeId: 'h2', vote: 'B' }, { judgeId: 'h3', vote: 'B' }],
      humanDimensionVotes: [
        { judgeId: 'h1', dimension: 'correctness', vote: 'B' }, { judgeId: 'h2', dimension: 'correctness', vote: 'B' },
        { judgeId: 'h3', dimension: 'correctness', vote: 'B' },
        { judgeId: 'h1', dimension: 'aesthetic', vote: 'tie' }, { judgeId: 'h2', dimension: 'aesthetic', vote: 'tie' },
        { judgeId: 'h3', dimension: 'aesthetic', vote: 'A' },
      ],
      truth,
      orderAB: { leftHash: imageASha256, rightHash: imageBSha256, promptVersion: ab.version, packetSha256: ab.packetSha256,
        judgeModelId: 'offline-fixture-model', verdict: { dimensions: dims('B', 'B', 'tie'), findings: [copyFinding('A')] }, costUsd: 0.05, latencyMs: 900 },
      orderBA: { leftHash: imageBSha256, rightHash: imageASha256, promptVersion: ba.version, packetSha256: ba.packetSha256,
        judgeModelId: 'offline-fixture-model', verdict: { dimensions: dims('A', 'A', 'tie'), findings: [copyFinding('B')] }, costUsd: 0.05, latencyMs: 950 },
    };
  }

  it('prepares a brief-bound packet for the same pinned, metadata-free, equal exports', () => {
    const imageA = png(40), imageB = png(200);
    const packet = prepareBriefBoundCalibrationPacket({ brief, imageA, imageB, imageASha256: sha(imageA), imageBSha256: sha(imageB) });
    expect(packet.version).toBe(BRIEF_BOUND_JUDGE_PROMPT_VERSION);
    expect(packet.advisoryOnly).toBe(true);
    expect(packet.userText).toContain('کۆنفرانسی جۆری ٢٠٢٦');
    expect(`${packet.systemText}${packet.userText}`).not.toMatch(/composite|prestige|academic/i);
    const tagged = png(200, 16, true);
    expect(() => prepareBriefBoundCalibrationPacket({ brief, imageA, imageB: tagged, imageASha256: sha(imageA), imageBSha256: sha(tagged) }))
      .toThrow(/metadata removed/);
    expect(() => prepareBriefBoundCalibrationPacket({ brief: { copy: [] } as any, imageA, imageB, imageASha256: sha(imageA), imageBSha256: sha(imageB) }))
      .toThrow(/exact copy/);
  });

  it('reports the challenger overall and per dimension against human labels, without admission', () => {
    const seeded = briefBound('copy-defect', { kind: 'seeded_defect', badCandidate: 'A', severity: 'critical' });
    const report = analyzeBlindJudgeCalibration([seeded]);
    expect(report.admissionQualified).toBe(false);
    expect(report.protocols).toEqual({ [BRIEF_BOUND_JUDGE_PROMPT_VERSION]: 1 });
    expect(report.all).toMatchObject({ cases: 1, orderStable: 1, humanComparable: 1, humanAgreement: 1, seededDefects: 1, detectedDefects: 1 });
    expect(report.dimensions.correctness).toMatchObject({ humanQualified: 1, comparable: 1, agreement: 1 });
    // Humans tied on aesthetics 2-1; the judge tied too, and a tie is an answer, not a missing vote.
    expect(report.dimensions.aesthetic).toMatchObject({ humanQualified: 1, comparable: 1, agreement: 1 });
    expect(report.dimensions.communication).toMatchObject({ humanQualified: 0, missingHuman: 1 });
  });

  it('refuses mixed protocols in one case and invalid dimension labels', () => {
    const seeded = briefBound('mixed', { kind: 'ordinary' });
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded, orderBA: { ...seeded.orderBA, promptVersion: 'visual-blind-pair-v1' } }]))
      .toThrow(/pinned prompt/);
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded, humanDimensionVotes: [{ judgeId: 'h1', dimension: 'brand_fit' as any, vote: 'A' }] }]))
      .toThrow(/dimension/);
    expect(() => analyzeBlindJudgeCalibration([{ ...seeded, orderAB: { ...seeded.orderAB, verdict: { winner: 'A', reason: 'x', findings: [] } as any } }]))
      .toThrow();
  });
});
