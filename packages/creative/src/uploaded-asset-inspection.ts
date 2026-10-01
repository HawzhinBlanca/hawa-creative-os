/** Bounded parsing with existing office decoders; uploads never install fonts or activate brand policy. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
// Fontkit is synchronous: parse untrusted fonts in a disposable process so its
// decompressor cannot block Core's event loop or retain allocations after refusal.
const fontDecoder = `
import * as module from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('fontkit')).href)};
const fk = module.default || module;
const parts = []; let size = 0;
for await (const part of process.stdin) {
  size += part.length; if (size > 10 * 1024 * 1024) throw new Error('Input limit');
  parts.push(part);
}
const font = fk.create(Buffer.concat(parts));
const tables = Object.values(font.directory?.tables || {});
if (tables.length < 1 || tables.length > 256) throw new Error('Table count limit');
let expanded = 0;
for (const table of tables) {
  const length = table.transformLength ?? table.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid table length');
  expanded += length;
  if (expanded > 50 * 1024 * 1024) throw new Error('Decompression limit');
}
if (!Number.isInteger(font.numGlyphs) || font.numGlyphs < 1 || !font.familyName)
  throw new Error('A decodable named font is required');
// Decode an outline as well as directory/name metadata. This is admission
// inspection, not a guarantee that every glyph will render in a native editor.
if (!font.getGlyph(0).path.commands) throw new Error('Unreadable outline');
process.stdout.write('ok');
`;
async function decode(command: string, args: string[], bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe','pipe','pipe'], timeout: 5000, killSignal: 'SIGKILL',
      // Native parsers do not need office/provider credentials or database URLs.
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    });
    const output: Buffer[] = []; let size = 0, hasErrors = false;
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 64 * 1024) child.kill('SIGKILL'); else output.push(part);
    });
    child.stderr.on('data', (part: Buffer) => { if (part.toString('utf8').trim()) hasErrors = true; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0 || hasErrors || size < 1 || size > 64 * 1024) reject(new Error('Asset decoding refused'));
      else resolve(Buffer.concat(output));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
  });
}
export async function inspectUploadedAssetBytes(bytes: Uint8Array, mimeType: string): Promise<void> {
  const data = Buffer.from(bytes);
  if (mimeType === 'image/svg+xml') {
    const png = await decode('rsvg-convert', ['-w','16','-h','16','-f','png'], data);
    PNG.sync.read(png);
  } else if (mimeType.startsWith('image/')) {
    const codec = { 'image/png':'png', 'image/jpeg':'mjpeg', 'image/webp':'webp' }[mimeType];
    if (!codec) throw new Error('Unsupported image');
    if (mimeType === 'image/webp') {
      for (let at = 12; at + 8 <= data.length;) {
        const kind = data.toString('ascii', at, at + 4), length = data.readUInt32LE(at + 4);
        if (kind === 'ANIM' || kind === 'ANMF') throw new Error('Animated assets require an explicit media workflow');
        if (at + 8 + length > data.length) throw new Error('Truncated WebP');
        at += 8 + length + (length % 2);
      }
    }
    if (mimeType === 'image/png') {
      for (let at = 8; at + 12 <= data.length;) {
        const length = data.readUInt32BE(at), kind = data.toString('ascii', at + 4, at + 8);
        if (kind === 'acTL') throw new Error('Animated assets require an explicit media workflow');
        if (at + 12 + length > data.length) throw new Error('Truncated PNG');
        at += 12 + length;
      }
    }
    const rgba = await decode('ffmpeg', ['-v','error','-nostdin','-xerror','-err_detect','explode','-max_alloc','167772160',
      '-protocol_whitelist','pipe','-f','image2pipe','-c:v',codec,'-max_pixels','40000000','-i','pipe:0',
      '-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'], data);
    if (rgba.length !== 4) throw new Error('Unreadable image');
  } else {
    if (mimeType === 'font/woff2' && (data.length < 48 || data.readUInt32BE(16) > 50 * 1024 * 1024))
      throw new Error('Font decompression limit exceeded');
    const result = await decode(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', fontDecoder], data);
    if (result.toString('ascii') !== 'ok') throw new Error('Unreadable font');
  }
}
