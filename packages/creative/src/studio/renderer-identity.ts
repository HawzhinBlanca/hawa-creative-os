import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * ADR-123: the rasteriser a retained visual basis was drawn with. ADR-116/118 pinned the fonts and
 * the Pango measurement helper; the SVG itself is drawn by rsvg-convert (librsvg), whose version and
 * the Cairo/Pango/HarfBuzz/Fontconfig it reports decide the pixels too, as does the operating system
 * release those libraries come with. This is recovery evidence, not an attestation of every shared
 * library byte: same-version rebuilds of a library are not seen.
 */
export interface RendererRuntimeIdentity {
  version: 1;
  /** The executable's bytes and what it reports for `--version`. Its install path is not identity. */
  rsvg: { sha256: string; version: string };
  os: {
    platform: string;
    arch: string;
    /** macOS only: its kernel ships with the system libraries. A Linux container shares the host's. */
    kernel?: string;
    /** The distribution's own release files: a readable summary and the hash of their bytes. */
    distribution: { summary: string; sha256: string };
  };
}

export interface RendererIdentityOptions {
  rsvgConvertPath?: string;
  /** The release files that name the operating system; defaults to the platform's own. */
  osIdentityFiles?: string[];
}

const RSVG_CANDIDATES = ['/opt/homebrew/bin/rsvg-convert', '/usr/bin/rsvg-convert', '/usr/local/bin/rsvg-convert'];

/** The rsvg-convert the Studio renderer runs: an explicit path, a known install, or PATH. */
export function resolveRsvgConvert(options?: { rsvgConvertPath?: string }): string {
  if (options?.rsvgConvertPath && fs.existsSync(options.rsvgConvertPath)) return options.rsvgConvertPath;
  for (const candidate of RSVG_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  return 'rsvg-convert';
}

function unavailable(detail: string): Error {
  return new Error(`RENDERER_IDENTITY_UNAVAILABLE: ${detail}`);
}

/** The file a bare command name runs, searched the way the child process would find it. */
function executableOnPath(name: string): string {
  if (name.includes('/')) return name;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw unavailable(`${name} is not on PATH`);
}

const versionMemo = new Map<string, string>();

function defaultOsFiles(): string[] {
  return process.platform === 'darwin'
    ? ['/System/Library/CoreServices/SystemVersion.plist']
    : ['/etc/os-release', '/usr/lib/os-release', '/etc/debian_version'];
}

function distribution(files: string[]): { summary: string; sha256: string } {
  const hash = createHash('sha256');
  const found: Array<{ name: string; text: string }> = [];
  for (const file of files) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(file); } catch { continue; }
    hash.update(`${path.basename(file)}\0${bytes.length}\0`).update(bytes);
    found.push({ name: path.basename(file), text: bytes.toString('utf8') });
  }
  const plist = found.find(f => f.name.endsWith('.plist'))?.text;
  const key = (name: string) => plist ? new RegExp(`<key>${name}</key>\\s*<string>([^<]{1,128})</string>`).exec(plist)?.[1] : undefined;
  const release = found.find(f => /os-release$/.test(f.name))?.text;
  const pretty = release ? /^PRETTY_NAME="?([^"\n]{1,128})"?$/m.exec(release)?.[1] : undefined;
  const debian = found.find(f => f.name === 'debian_version')?.text.trim().slice(0, 32);
  const summary = plist
    ? `${key('ProductName') ?? 'unknown'} ${key('ProductVersion') ?? '?'} (${key('ProductBuildVersion') ?? '?'})`
    : pretty ? `${pretty}${debian ? ` / debian ${debian}` : ''}` : found.length ? 'unrecognized release files' : 'unknown';
  return { summary, sha256: hash.digest('hex') };
}

/**
 * The identity of the renderer that would draw now. Throws when the executable cannot be read or
 * does not answer `--version`: a renderer that cannot be identified is not silently assumed equal.
 */
export function rendererRuntimeIdentity(options: RendererIdentityOptions = {}): RendererRuntimeIdentity {
  const command = resolveRsvgConvert(options);
  let file: string;
  let bytes: Buffer;
  try {
    file = fs.realpathSync(executableOnPath(command));
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RENDERER_IDENTITY_UNAVAILABLE')) throw error;
    throw unavailable(`${command} cannot be read`);
  }
  // Hashed on every call: no metadata shortcut at the recovery boundary (ADR-116).
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let version = versionMemo.get(sha256);
  if (version === undefined) {
    try {
      version = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { throw unavailable(`${command} --version failed`); }
    if (!version || version.length > 2048) throw unavailable(`${command} --version gave no usable answer`);
    // The bytes may have changed while it ran; only a stable read is remembered.
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) throw unavailable(`${command} changed while it was identified`);
    versionMemo.set(sha256, version);
  }
  return {
    version: 1,
    rsvg: { sha256, version },
    os: {
      platform: process.platform,
      arch: process.arch,
      ...(process.platform === 'darwin' ? { kernel: os.release() } : {}),
      distribution: distribution(options.osIdentityFiles ?? defaultOsFiles()),
    },
  };
}
