import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectVoiceAudio, VoiceAudioError } from '../src/voice-audio.js';
import { telegramVoiceSource } from '../src/telegram-source-review.js';
const audio = await readFile(new URL('../../testkit/fixtures/voice/silence-one-second.ogg', import.meta.url));
function pages(bytes: Buffer) {
  const found: number[] = []; let offset = 0;
  while (offset < bytes.length) {
    found.push(offset); const n = bytes[offset + 26];
    offset += 27 + n + bytes.subarray(offset + 27, offset + 27 + n).reduce((a, b) => a + b, 0);
  }
  return found;
}
function crc(bytes: Buffer, offset: number) {
  const n = bytes[offset + 26], end = offset + 27 + n + bytes.subarray(offset + 27, offset + 27 + n).reduce((a,b) => a+b,0);
  bytes.fill(0, offset + 22, offset + 26); let c = 0;
  for (const byte of bytes.subarray(offset, end)) {
    c ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) c = (c << 1) ^ ((c & 0x80000000) ? 0x04c11db7 : 0);
  }
  bytes.writeUInt32LE(c >>> 0, offset + 22);
}
describe('bounded original Opus timing', () => {
  it('reads a real FFmpeg-produced one-second fixture without trusting Telegram metadata', () => {
    expect(inspectVoiceAudio(audio)).toEqual({ version: 'ogg-opus-v1', mediaType: 'audio/ogg',
      durationSeconds: 1, encodedSamples: 48_960, sampleRate: 48_000, channels: 1 });
  });
  it.each(['truncated','corrupt','trailing','oversize'])('refuses %s bytes', kind => {
    const bytes = kind === 'truncated' ? audio.subarray(0, -1) : kind === 'trailing' ? Buffer.concat([audio, Buffer.from([0])])
      : kind === 'oversize' ? Buffer.alloc(20 * 1024 * 1024 + 1) : Buffer.from(audio);
    if (kind === 'corrupt') bytes[bytes.length - 1] ^= 1;
    expect(() => inspectVoiceAudio(bytes)).toThrow(VoiceAudioError);
  });
  it.each(['granule','sequence','codec','mapping','end'])('rejects a valid-checksum %s lie', kind => {
    const bytes = Buffer.from(audio), starts = pages(bytes); let offset = starts.at(-1)!;
    if (kind === 'granule') bytes.writeBigUInt64LE(10_000_000n, offset + 6);
    if (kind === 'sequence') bytes.writeUInt32LE(17, offset + 18);
    if (kind === 'end') bytes[offset + 5] &= ~4;
    if (kind === 'codec') { offset = 0; bytes[28] = 88; }
    if (kind === 'mapping') { offset = 0; bytes[46] = 1; }
    crc(bytes, offset); expect(() => inspectVoiceAudio(bytes)).toThrow(VoiceAudioError);
  });
  it('refuses chained logical streams instead of undercounting their duration', () => {
    expect(() => inspectVoiceAudio(Buffer.concat([audio, audio]))).toThrow(VoiceAudioError);
  });
  it('limits encoded packet duration even when file size and claimed duration are small', () => {
    const starts = pages(audio), firstAudio = starts[2], originalPage = audio.subarray(firstAudio, starts[3]);
    const recording = (seconds: number) => {
      const chunks = [audio.subarray(0, firstAudio)];
      for (let i = 0; i < seconds; i++) {
        const page = Buffer.from(originalPage); page[5] = i === seconds - 1 ? 4 : 0;
        page.writeUInt32LE(i + 2, 18); page.writeBigUInt64LE(BigInt((i + 1) * 48_000), 6); crc(page, 0); chunks.push(page);
      }
      return Buffer.concat(chunks);
    };
    expect(inspectVoiceAudio(recording(600)).encodedSamples).toBe(600 * 48_000);
    expect(() => inspectVoiceAudio(recording(601))).toThrow('ten minutes');
  });
  it('accepts voice/audio envelopes but not mixed media or misleading MIME types', () => {
    const base = { update_id: 1, message: { message_id: 2, from: { id: 3 }, chat: { id: 4, type: 'private' },
      voice: { file_id: 'voice', mime_type: 'audio/ogg', duration: 999999 } } };
    expect(telegramVoiceSource(base)?.kind).toBe('voice');
    expect(telegramVoiceSource({ ...base, message: { ...base.message, audio: base.message.voice } })).toBeNull();
    expect(telegramVoiceSource({ ...base, message: { ...base.message, voice: { file_id: 'voice', mime_type: 'audio/mpeg' } } })).toBeNull();
  });
});
