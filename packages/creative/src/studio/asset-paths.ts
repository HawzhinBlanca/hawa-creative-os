import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory holding this module, whether it is the TypeScript source or the compiled output.
 * packages/creative/src/studio and packages/creative/dist/studio sit at the same depth under the
 * package, so one relative path serves the repository and the image.
 */
const moduleDir = import.meta.dirname || dirname(fileURLToPath(import.meta.url));

/** packages/creative/assets, from this module's own location rather than from the process. */
const assetsDir = resolve(moduleDir, '../../assets');

/**
 * An absolute path to a file inside packages/creative/assets.
 *
 * Callers used to build their own candidate lists from process.cwd() and from their own depth
 * under apps/core. In the production image the core process runs with cwd /app/apps/core and the
 * compiled service sits at /app/apps/core/dist/services/design-studio, so those candidates landed
 * under /app/apps/core/packages/... and /app/apps/packages/..., while the files are at
 * /app/packages/creative/assets. The stage context's reference-pack read was wrapped in
 * "if (refPath)" with no else and its only warning sat in a catch that never ran, so 24 hours of
 * production logs carried no occurrence of it: every brief went out with the placeholder rule
 * "Keep title clear and centered..." instead of KAAE's colour rules, and with no exemplars.
 *
 * Resolving from import.meta.dirname removes cwd from the question. The cwd candidates are kept
 * only for a consumer that copies the assets beside itself; the first candidate is the one that
 * holds in both layouts.
 *
 * Throws when the file is absent, naming every path tried, because designing with brand defaults
 * the client never approved is worse than a failed run.
 */
export function creativeAssetPath(relativePath: string): string;
export function creativeAssetPath(relativePath: string, options: { optional: true }): string | undefined;
export function creativeAssetPath(
  relativePath: string,
  options: { optional?: boolean } = {}
): string | undefined {
  const candidates = [
    resolve(assetsDir, relativePath),
    resolve(process.cwd(), 'packages/creative/assets', relativePath),
    resolve(process.cwd(), 'assets', relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  if (options.optional) return undefined;
  throw new Error(
    `Creative asset not found: ${relativePath}. Tried:\n  ${candidates.join('\n  ')}`
  );
}
