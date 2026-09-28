import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rendererRuntimeIdentity, resolveRsvgConvert } from '../src/studio/renderer-identity.js';
import { captureRenderFontInputs } from '../src/studio/render-layout-v2.js';

// ADR-123: the retained basis names the renderer that draws, not only its fonts. These tests use
// real temporary executables and files, as the font-basis tests do.
const dirs: string[] = [];
function folder() { const dir = mkdtempSync(join(tmpdir(), 'hawa-renderer-identity-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** No rasteriser anywhere the renderer looks: no explicit file, no known install, nothing on PATH. */
function noRasteriser() {
  const real = fs.existsSync.bind(fs);
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => !/rsvg-convert$|absent$/.test(String(file)) && real(file));
  vi.stubEnv('PATH', '');
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fakeRsvg(dir: string, version: string, exitCode = 0): string {
  const file = join(dir, 'rsvg-convert');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' "${version}"; exit ${exitCode}; fi\nexit 3\n`);
  chmodSync(file, 0o755);
  return file;
}
function osFile(dir: string, text: string): string { const file = join(dir, 'os-release'); writeFileSync(file, text); return file; }

describe('renderer runtime identity', () => {
  it('binds the executable bytes and its reported version, and follows same-path replacement', () => {
    const dir = folder(); const rsvg = fakeRsvg(dir, 'rsvg-convert version 9.1.0'); const os = osFile(dir, 'PRETTY_NAME="Synthetic 1"\n');
    const first = rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] });
    expect(first).toMatchObject({ version: 1, rsvg: { sha256: sha(readFileSync(rsvg)), version: 'rsvg-convert version 9.1.0' } });
    const stamp = statSync(rsvg);
    fakeRsvg(dir, 'rsvg-convert version 9.2.0');
    utimesSync(rsvg, stamp.atime, stamp.mtime);
    const replaced = rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] });
    expect(replaced.rsvg.version).toBe('rsvg-convert version 9.2.0');
    expect(replaced.rsvg.sha256).not.toBe(first.rsvg.sha256);
    fakeRsvg(dir, 'rsvg-convert version 9.1.0');
    expect(rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] })).toEqual(first);
  });

  it('refuses a missing or failing renderer instead of reusing an earlier identity', () => {
    const dir = folder(); const rsvg = fakeRsvg(dir, 'rsvg-convert version 9.1.0'); const os = osFile(dir, 'PRETTY_NAME="Synthetic 1"\n');
    const first = rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] });
    unlinkSync(rsvg);
    // The renderer then runs another installed rsvg-convert, and the identity names that one.
    expect(rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] }).rsvg.sha256).not.toBe(first.rsvg.sha256);
    noRasteriser();
    expect(() => rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] })).toThrow(/RENDERER_IDENTITY_UNAVAILABLE/);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    fakeRsvg(dir, 'rsvg-convert version 9.1.0', 4);
    expect(() => rendererRuntimeIdentity({ rsvgConvertPath: rsvg, osIdentityFiles: [os] })).toThrow(/RENDERER_IDENTITY_UNAVAILABLE/);
  });

  it('changes when the operating-system identity changes and ignores the install path of equal bytes', () => {
    const a = folder(), b = folder();
    const rsvgA = fakeRsvg(a, 'rsvg-convert version 9.1.0'), rsvgB = fakeRsvg(b, 'rsvg-convert version 9.1.0');
    const os = osFile(a, 'PRETTY_NAME="Synthetic 1"\nVERSION_ID="1"\n');
    const first = rendererRuntimeIdentity({ rsvgConvertPath: rsvgA, osIdentityFiles: [os] });
    expect(rendererRuntimeIdentity({ rsvgConvertPath: rsvgB, osIdentityFiles: [os] })).toEqual(first);
    writeFileSync(os, 'PRETTY_NAME="Synthetic 1"\nVERSION_ID="1.1"\n');
    const updated = rendererRuntimeIdentity({ rsvgConvertPath: rsvgA, osIdentityFiles: [os] });
    expect(updated.os.distribution.sha256).not.toBe(first.os.distribution.sha256);
    expect(updated.os).toMatchObject({ platform: process.platform, arch: process.arch });
  });

  it('identifies the actual rasteriser the Studio renderer resolves', () => {
    const resolved = resolveRsvgConvert();
    const identity = rendererRuntimeIdentity();
    const path = resolved.includes('/') ? resolved : execFileSync('/bin/sh', ['-c', `command -v ${resolved}`], { encoding: 'utf8' }).trim();
    expect(identity.rsvg.sha256).toBe(sha(readFileSync(realpathSync(path))));
    expect(identity.rsvg.version).toBe(execFileSync(path, ['--version'], { encoding: 'utf8' }).trim());
    expect(identity.rsvg.version).toMatch(/rsvg-convert version \d+\.\d+/);
  });

  it('makes the retained font basis change with the renderer and restore with it', () => {
    const dir = folder(); const rsvg = fakeRsvg(dir, 'rsvg-convert version 9.1.0'); const os = osFile(dir, 'PRETTY_NAME="Synthetic 1"\n');
    const read = () => captureRenderFontInputs({ rsvgConvertPath: rsvg, osIdentityFiles: [os] });
    const first = read();
    expect(first).toMatchObject({ version: 2, renderer: { version: 1, rsvg: { version: 'rsvg-convert version 9.1.0' } } });
    fakeRsvg(dir, 'rsvg-convert version 9.2.0');
    expect(read().sha256).not.toBe(first.sha256);
    fakeRsvg(dir, 'rsvg-convert version 9.1.0');
    expect(read()).toEqual(first);
    noRasteriser();
    const missing = captureRenderFontInputs({ rsvgConvertPath: join(dir, 'absent'), osIdentityFiles: [os], systemFiles: [] });
    expect(missing.renderer).toEqual({ unavailable: true });
    expect(missing.sha256).not.toBe(first.sha256);
  });
});
