import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inspectVoiceAudio } from '@hawa/domain';
import { sniffBlobMediaType } from '@hawa/contracts';
import { MediaConversionError, audioAsOggOpus, heifAsJpeg, isHeif, sniffAudioContainer } from '../src/services/media-conversion.js';

/**
 * ADR-145: a phone's HEIC photo and M4A/MP3/WAV recordings are converted, by their bytes, into the
 * formats the lifecycle admits. These run the real converters (ffmpeg; heif-convert, or sips on a
 * Mac); the Core image carries both (infra/docker/Dockerfile.core), and the image proof is in ADR-145.
 */
const fixture = (name: string) => readFile(new URL(`../../../packages/testkit/fixtures/${name}`, import.meta.url));
const has = (command: string, args: string[]) => { try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const ffmpeg = has('ffmpeg', ['-hide_banner', '-version']);
const heif = has('heif-convert', ['--version']) || process.platform === 'darwin';

describe('media conversion', () => {
  it('reads the container from the bytes, never the name', async () => {
    expect(sniffAudioContainer(await fixture('voice/silence-one-second.ogg'))).toBe('ogg');
    expect(sniffAudioContainer(await fixture('media/tone-one-second.m4a'))).toBe('mp4');
    expect(sniffAudioContainer(await fixture('media/tone-one-second.mp3'))).toBe('mp3');
    expect(sniffAudioContainer(await fixture('media/tone-one-second.wav'))).toBe('wav');
    expect(sniffAudioContainer(await fixture('media/photo-96x64.heic'))).toBeNull();
    expect(sniffAudioContainer(Buffer.from('%PDF-1.7 not audio at all'))).toBeNull();
    expect(isHeif(await fixture('media/photo-96x64.heic'))).toBe(true);
    expect(isHeif(await fixture('media/tone-one-second.m4a'))).toBe(false);
  });

  it('returns Ogg as it is and refuses what is not audio', async () => {
    const ogg = await fixture('voice/silence-one-second.ogg');
    expect((await audioAsOggOpus(ogg)).bytes.equals(ogg)).toBe(true);
    await expect(audioAsOggOpus(Buffer.from('not audio, just some words here'))).rejects.toBeInstanceOf(MediaConversionError);
    await expect(heifAsJpeg(Buffer.from('not a picture, just some words'))).rejects.toMatchObject({ code: 'MEDIA_UNREADABLE' });
  });

  it.runIf(ffmpeg).each(['m4a', 'mp3', 'wav'])('converts a one-second %s recording into Ogg Opus the voice path admits', async (ext) => {
    const converted = await audioAsOggOpus(await fixture(`media/tone-one-second.${ext}`));
    expect(converted.from).toBe(ext === 'm4a' ? 'mp4' : ext);
    const audio = inspectVoiceAudio(converted.bytes);
    expect(audio.mediaType).toBe('audio/ogg');
    expect(audio.channels).toBe(1);
    expect(audio.durationSeconds).toBeGreaterThan(0.9);
    expect(audio.durationSeconds).toBeLessThan(1.2);
  });

  it.runIf(ffmpeg)('a file that only looks like audio is refused in words, not converted', async () => {
    const fake = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 7)]);
    await expect(audioAsOggOpus(fake)).rejects.toMatchObject({ code: 'MEDIA_UNREADABLE' });
  });

  it('says when the converter is missing', async () => {
    await expect(audioAsOggOpus(await fixture('media/tone-one-second.m4a'), { HAWA_FFMPEG_PATH: '/nonexistent/ffmpeg' }))
      .rejects.toMatchObject({ code: 'CONVERTER_UNAVAILABLE' });
  });

  it.runIf(heif)('turns a HEIC photo into a JPEG', async () => {
    const jpeg = await heifAsJpeg(await fixture('media/photo-96x64.heic'));
    expect(sniffBlobMediaType(jpeg)).toBe('image/jpeg');
  });
});
