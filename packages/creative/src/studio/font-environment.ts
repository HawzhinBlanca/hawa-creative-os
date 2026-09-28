import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';

const fk = (fontkit as unknown as { default?: typeof fontkit }).default || fontkit;

/** The part of a fontkit font the family check reads. */
interface NamedFont {
  familyName: string;
  getName(key: string): string | null;
  hasGlyphForCodePoint(codePoint: number): boolean;
}

/**
 * The fonts the rasteriser is allowed to see, and the environment every rsvg-convert call runs in.
 *
 * Measurement (fontkit) opens the files in packages/creative/assets/fonts; drawing (rsvg-convert,
 * through pango) used to resolve family names from whatever the host had installed. On the Macs pango
 * draws through CoreText, which ignores FONTCONFIG_FILE and found a different Noto Sans Arabic in
 * ~/Library/Fonts (9.4% narrower than the pinned file), Helvetica for Cinzel, and a variable Inter.
 * In the image the committed fonts.conf also listed the system folders, a second copy of every face
 * under /usr/local/share/fonts, and the web subsets (*.woff2) that carry the same family names.
 *
 * So every rasterisation now gets a generated fonts.conf that lists only the repo's font folder and
 * the few system files the registry names (Verdana, which may not be redistributed), with the web
 * subsets rejected, and runs pango on its fontconfig backend so the Macs read that file too. The
 * symbols the image used to take from fonts-dejavu-core come from the committed HawaSymbols faces.
 */

/** Forces pango's fontconfig backend; on macOS the default (CoreText) never reads FONTCONFIG_FILE. */
export const PANGO_FONTCONFIG_BACKEND = 'fc';

/**
 * The face a Latin family falls back to first for a symbol it lacks. The copy gate admits arrows,
 * maths, geometric shapes, symbols and dingbats (☎ ✉ ➤ ✔ …). In the core image such a symbol came from
 * the first system font in fontconfig's order that had it: DejaVu Sans for most, Vazirmatn or Arial
 * (which cannot be committed) for some. HawaSymbols-*.ttf are DejaVu Sans's glyphs for the gate's
 * ranges and nothing else (scripts/generate_symbol_fallback_faces.py), and the Latin families fall
 * back to them first, so every admitted symbol a Latin face lacks has one source. By fc-match order in
 * the image, over the five Latin families, 4396 family-symbol pairs keep the face they had and 342
 * change (173 were Vazirmatn's, 169 Arial's); left to fontconfig's order, Inter would have taken 445
 * of DejaVu's.
 * Arabic-script families keep fontconfig's order: the "•" of a stored Kurdish footer, which Noto Sans
 * Arabic lacks, is drawn by the face it was before, and only what no face draws (☎ ✉) comes from
 * here. The faces carry no letters, digits or ordinary space, so text is still drawn by the
 * requested face or, for a family that does not exist, by the same fallback face as before.
 */
export const SYMBOL_FALLBACK_FAMILY = 'Hawa Symbols';

/** Bumped whenever the generated file's shape changes, so an old generated folder is never reused. */
const GENERATED_CONFIG_VERSION = 4;

function registryPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, 'render-fonts.json'),
    path.resolve(here, '../../src/studio/render-fonts.json'),
    path.resolve(process.cwd(), 'packages/creative/src/studio/render-fonts.json'),
  ].find((candidate) => fs.existsSync(candidate));
}

type RegistryFamily = { systemPaths?: string[] };

function registryFamilies(): Record<string, RegistryFamily> {
  const file = registryPath();
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).families || {};
  } catch {
    return {};
  }
}

/**
 * The system font files the registry lets the renderer use (`systemPaths`), those present on this
 * host. Only files that cannot be committed belong there: today the four Verdana faces.
 */
export function pinnedSystemFontFiles(): string[] {
  const out: string[] = [];
  for (const family of Object.values(registryFamilies())) {
    for (const p of family.systemPaths || []) {
      if (!out.includes(p) && fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

export interface FontFileIdentity { name: string; sha256: string }

/** Actual bytes the pinned rasterizer can see; web subsets are deliberately excluded. */
export function fontFileInventory(fontsDir: string = defaultFontsDir(), systemFiles: string[] = pinnedSystemFontFiles()): FontFileIdentity[] {
  const files: FontFileIdentity[] = [];
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const visit = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.(?:ttf|otf|ttc)$/i.test(item.name)) files.push({ name: `package/${path.relative(fontsDir,file).split(path.sep).join('/')}`, sha256: digest(file) });
    }
  };
  visit(fontsDir);
  for (const file of [...new Set(systemFiles)].sort()) files.push({ name: `system/${file}`, sha256: digest(file) });
  return files.sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const latinFamiliesMemo = new Map<string, string[]>();

/**
 * The Latin families among the faces the rasteriser sees: a symbol one of them lacks comes from the
 * symbol faces first. Read from the files (a face with Latin letters and no Arabic ones), not the
 * registry, because Inter is drawn (operation templates, the admitted list) without a registry entry.
 * The typographic family is what pango asks for ("Inter" at weight 500, not "Inter Medium").
 */
export function symbolFirstFamilies(fontsDir: string = defaultFontsDir(), systemFiles: string[] = pinnedSystemFontFiles()): string[] {
  return symbolFirstFamiliesForInventory(fontsDir, systemFiles, fontFileInventory(fontsDir, systemFiles));
}

function symbolFirstFamiliesForInventory(fontsDir: string, systemFiles: string[], inventory: FontFileIdentity[]): string[] {
  const memoKey = JSON.stringify([path.resolve(fontsDir), inventory]);
  const memo = latinFamiliesMemo.get(memoKey);
  if (memo) return memo;
  const files = [
    ...(fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir) : [])
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => path.join(fontsDir, f)),
    ...systemFiles,
  ];
  const out = new Set<string>();
  for (const file of files) {
    try {
      const font = fk.openSync(file) as unknown as NamedFont;
      const family: string = font.getName('preferredFamily') || font.familyName;
      if (family === SYMBOL_FALLBACK_FAMILY) continue;
      if (font.hasGlyphForCodePoint(0x41) && !font.hasGlyphForCodePoint(0x627)) out.add(family);
    } catch {
      // an unreadable file adds no family
    }
  }
  const families = [...out].sort();
  latinFamiliesMemo.set(memoKey, families);
  return families;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const generated = new Map<string, string>();

/**
 * The folder the generated configs live in: one per user under the temp folder, created private.
 *
 * On a shared /tmp another user could create this folder first and fill it with a fonts.conf listing
 * other folders or <include>s. So the folder is only used when it is a real folder (not a link) owned
 * by this user and writable by nobody else; otherwise this process gets a private folder of its own
 * (mkdtemp creates it 0700), which costs only the reuse across processes.
 */
function generatedRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const shared = path.join(tmpdir(), uid === undefined ? 'hawa-fontconfig' : `hawa-fontconfig-${uid}`);
  try {
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(shared);
    if (st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0) return shared;
  } catch {
    // fall through to a private folder
  }
  return fs.mkdtempSync(path.join(tmpdir(), 'hawa-fontconfig-private-'));
}

/**
 * A fonts.conf that lists only `fontsDir` and the registry's system files, generated once per host
 * under the temp folder and reused (its name is a hash of what it lists).
 *
 * Folders, not files, are what fontconfig scans, so the system files are linked into a folder of
 * their own, each under a numbered name so two registry paths with the same file name cannot
 * collide. Built in a scratch folder and renamed into place, so two processes starting at once both
 * end up reading one complete file. A folder left without its fonts.conf (a temp cleaner that removed
 * some files and not others) is moved aside and rebuilt rather than failing every later render.
 * `symbolFirst` are the families whose missing symbols come from the symbol faces first (read from
 * the font files once per process).
 */
export function pinnedFontconfigFile(
  fontsDir: string,
  systemFiles: string[] = pinnedSystemFontFiles(),
  symbolFirst?: string[]
): string {
  const dir = path.resolve(fontsDir);
  const fonts = fontFileInventory(fontsDir, systemFiles);
  const families = symbolFirst ?? symbolFirstFamiliesForInventory(fontsDir, systemFiles, fonts);
  const key = JSON.stringify({ v: GENERATED_CONFIG_VERSION, dir, systemFiles, symbolFirst: families, fonts });
  const cached = generated.get(key);
  if (cached && fs.existsSync(cached)) return cached;

  const root = generatedRoot();
  const final = path.join(root, createHash('sha256').update(key).digest('hex').slice(0, 16));
  const conf = path.join(final, 'fonts.conf');
  if (!fs.existsSync(conf)) {
    const scratch = fs.mkdtempSync(path.join(root, 'tmp-'));
    try {
      fs.mkdirSync(path.join(scratch, 'system'));
      systemFiles.forEach((file, i) => {
        fs.symlinkSync(file, path.join(scratch, 'system', `${i}-${path.basename(file)}`));
      });
      fs.writeFileSync(
        path.join(scratch, 'fonts.conf'),
        [
          '<?xml version="1.0"?>',
          '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
          '<!-- Generated by packages/creative/src/studio/font-environment.ts. Do not edit. -->',
          '<fontconfig>',
          `  <dir>${xml(dir)}</dir>`,
          `  <dir>${xml(path.join(final, 'system'))}</dir>`,
          `  <cachedir>${xml(path.join(final, 'cache'))}</cachedir>`,
          '  <!-- Web subsets carry the same family names with fewer glyphs; fontkit never measures them. -->',
          '  <selectfont><rejectfont><glob>*.woff2</glob><glob>*.woff</glob></rejectfont></selectfont>',
          '  <!-- A symbol a Latin face lacks comes from the symbol faces first (SYMBOL_FALLBACK_FAMILY). -->',
          ...families.flatMap((family) => [
            '  <match target="pattern">',
            `    <test name="family" compare="eq"><string>${xml(family)}</string></test>`,
            `    <edit name="family" mode="append_last" binding="strong"><string>${SYMBOL_FALLBACK_FAMILY}</string></edit>`,
            '  </match>',
          ]),
          '</fontconfig>',
          '',
        ].join('\n'),
        { mode: 0o644 }
      );
      if (fs.existsSync(final) && !fs.existsSync(conf)) {
        const stale = `${final}.stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(final, stale);
          fs.rmSync(stale, { recursive: true, force: true });
        } catch {
          // another process moved it first
        }
      }
      fs.renameSync(scratch, final);
    } catch (err) {
      fs.rmSync(scratch, { recursive: true, force: true });
      // Another process renamed its copy into place first; that one is as good as ours.
      if (!fs.existsSync(conf)) throw err;
    }
  }
  generated.set(key, conf);
  return conf;
}

/** The environment for an rsvg-convert (or fc-*) child: the pinned fonts, on fontconfig. */
export function rasteriserEnv(fontconfigFile: string): NodeJS.ProcessEnv {
  return { ...process.env, FONTCONFIG_FILE: fontconfigFile, PANGOCAIRO_BACKEND: PANGO_FONTCONFIG_BACKEND };
}

/** The repo's font folder, for callers outside the studio renderer. */
export function defaultFontsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../assets/fonts'),
    path.resolve(process.cwd(), 'packages/creative/assets/fonts'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
