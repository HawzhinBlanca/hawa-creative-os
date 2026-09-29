/**
 * Turns the files a phone produces into the two formats the lifecycle admits (ADR-145):
 *
 *  - an iPhone photo sent "as a file" is HEIC; it becomes a JPEG (`heif-convert`, from Debian's
 *    libheif-examples, in the Core image; `sips` on a Mac for local work);
 *  - a recording sent as a file is M4A, MP3, WAV, AAC or WebM; it becomes Ogg Opus, the one audio
 *    format the voice path inspects, prices and transcribes (`ffmpeg`, Debian's ffmpeg package).
 *
 * The safety gates stay what they were: the bytes are sniffed (never the file name or the declared
 * type), sizes are limited before and after, the converter runs with a time limit on private
 * temporary files, reads one forced container format and no network protocol, and its output is
 * sniffed again. A file the converter cannot read is refused in words, never parked.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class MediaConversionError extends Error {
  constructor(readonly code: 'MEDIA_UNREADABLE' | 'CONVERTER_UNAVAILABLE' | 'MEDIA_TOO_LARGE', message: string) {
    super(message);
  }
}

const MAX_BYTES = 20 * 1024 * 1024;
const TIME_LIMIT_MS = 60_000;

export type AudioContainer = 'ogg' | 'mp4' | 'mp3' | 'wav' | 'aac' | 'webm';

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  bytes.length >= to ? String.fromCharCode(...bytes.subarray(from, to)) : '';

/** ISO base media "ftyp" brands of HEIF still images (HEIC from a phone, and the generic HEIF brands). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
/** ftyp brands of MPEG-4 audio (an .m4a from a phone's recorder, or a 3GP voice memo). */
const MP4_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'mp41', 'mp42', 'isom', 'iso2', 'iso5', 'iso6', 'dash', '3gp4', '3gp5', '3gp6', '3g2a', 'MSNV', 'f4a ']);

/** Whether the bytes are a HEIF still image (HEIC), by its container, whatever the file was called. */
export function isHeif(bytes: Uint8Array): boolean {
  return ascii(bytes, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 12));
}

/** The audio container the bytes are in, or null when they are none this office admits. */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 4, 8) === 'ftyp') return MP4_AUDIO_BRANDS.has(ascii(bytes, 8, 12)) ? 'mp4' : null;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'wav';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 3;
    // MPEG audio frame sync: layer bits 01 is Layer III (MP3); 00 with a 12-bit sync is AAC in ADTS.
    if (layer === 1) return 'mp3';
    if (layer === 0 && (bytes[1] & 0xf0) === 0xf0) return 'aac';
  }
  return null;
}

/** ffmpeg's demuxer for each admitted container: forced, so a file cannot choose another parser. */
const DEMUXER: Record<Exclude<AudioContainer, 'ogg'>, string> = { mp4: 'mov', mp3: 'mp3', wav: 'wav', aac: 'aac', webm: 'matroska' };

interface RunResult { code: number | null; stderr: string }
function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIME_LIMIT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? -2 : (typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code : -1)) : 0;
        resolve({ code, stderr: String(stderr || '').slice(0, 2000) });
      });
  });
}

async function withScratch<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hawa-media-'));
  try { return await action(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/**
 * Re-encodes an admitted recording as mono Ogg Opus (48 kHz, 32 kbit/s), at most ten minutes of it.
 * Ogg input is returned as it is: the voice path inspects it itself.
 */
export async function audioAsOggOpus(bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env): Promise<{ bytes: Buffer; from: AudioContainer }> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new MediaConversionError('MEDIA_TOO_LARGE', 'The recording is empty or larger than 20 MiB');
  const container = sniffAudioContainer(bytes);
  if (!container) throw new MediaConversionError('MEDIA_UNREADABLE', 'The recording is in no admitted audio container');
  if (container === 'ogg') return { bytes: Buffer.from(bytes), from: 'ogg' };
  const ffmpeg = env.HAWA_FFMPEG_PATH || 'ffmpeg';
  return withScratch(async (dir) => {
    const input = join(dir, 'input'), output = join(dir, 'output.ogg');
    await writeFile(input, bytes, { mode: 0o600 });
    const result = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file', '-f', DEMUXER[container], '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-t', '600',
      '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', output]);
    if (result.code === -2) throw new MediaConversionError('CONVERTER_UNAVAILABLE', 'ffmpeg is not installed');
    if (result.code !== 0) throw new MediaConversionError('MEDIA_UNREADABLE', 'The recording could not be decoded');
    const converted = await readFile(output).catch(() => null);
    if (!converted?.length || sniffAudioContainer(converted) !== 'ogg') throw new MediaConversionError('MEDIA_UNREADABLE', 'The recording produced no audio');
    if (converted.length > MAX_BYTES) throw new MediaConversionError('MEDIA_TOO_LARGE', 'The converted recording is larger than 20 MiB');
    return { bytes: converted, from: container };
  });
}

const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** A HEIF still image (HEIC) as a JPEG: its primary image, upright as the phone saved it. */
export async function heifAsJpeg(bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new MediaConversionError('MEDIA_TOO_LARGE', 'The picture is empty or larger than 20 MiB');
  if (!isHeif(bytes)) throw new MediaConversionError('MEDIA_UNREADABLE', 'The picture is not a HEIF image');
  return withScratch(async (dir) => {
    const input = join(dir, 'input.heic'), output = join(dir, 'output.jpg');
    await writeFile(input, bytes, { mode: 0o600 });
    const converter = env.HAWA_HEIF_CONVERT_PATH || 'heif-convert';
    let result = await run(converter, ['-q', '92', input, output]);
    // A Mac has no heif-convert by default but converts HEIC with sips; production runs Debian.
    if (result.code !== 0 && process.platform === 'darwin' && !env.HAWA_HEIF_CONVERT_PATH) {
      result = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output]);
    }
    if (result.code === -2) throw new MediaConversionError('CONVERTER_UNAVAILABLE', 'heif-convert is not installed');
    // With several top-level images heif-convert numbers its outputs (output-1.jpg, …): the first is the primary.
    let converted = await readFile(output).catch(() => null);
    if (!converted) {
      const numbered = (await readdir(dir)).filter((name) => /^output-\d+\.jpg$/.test(name)).sort();
      if (numbered.length) converted = await readFile(join(dir, numbered[0])).catch(() => null);
    }
    if (result.code !== 0 && !converted) throw new MediaConversionError('MEDIA_UNREADABLE', 'The picture could not be decoded');
    if (!converted?.length || !isJpeg(converted)) throw new MediaConversionError('MEDIA_UNREADABLE', 'The picture produced no image');
    if (converted.length > MAX_BYTES) throw new MediaConversionError('MEDIA_TOO_LARGE', 'The converted picture is larger than 20 MiB');
    return converted;
  });
}
