/**
 * Which stored Canva exports an approval pins. Delivery sends exactly the pinned files, byte for
 * byte (Core: services/pinned-deliverables.ts), so the reviewer chooses them here from what Core
 * has stored for the task. Nothing is pinned that Core did not list.
 */

/** A retrieved export as `GET /tasks/:id/canva` lists it (newest first). */
export interface StoredExport {
  id: string;
  format: string;
  sha256: string;
  byte_size: number | string;
}

/** The newest export is preselected: it is the capture the reviewer just looked at. */
export function defaultPins(exports: StoredExport[]): string[] {
  return exports.length > 0 ? [exports[0].id] : [];
}

export function describeExport(e: StoredExport): string {
  const bytes = Number(e.byte_size);
  const size = Number.isFinite(bytes) ? `${bytes.toLocaleString('en-US')} bytes` : 'size not reported';
  return `${String(e.format).toUpperCase()} · ${size} · SHA-256 ${String(e.sha256).slice(0, 12)}…`;
}

/** Why approval cannot be confirmed yet, or null when it can. */
export function approvalBlocker(state: 'loading' | 'known' | 'unknown', exports: StoredExport[], pinned: string[]): string | null {
  if (state === 'loading') return 'Reading the stored exports…';
  if (state === 'unknown') return 'The stored exports could not be read, so there is nothing to pin.';
  if (exports.length === 0) return 'No export is stored for this task. Capture for Review first: delivery sends only a captured file.';
  if (pinned.length === 0) return 'Select at least one export: delivery sends exactly the selected files.';
  return null;
}

export function togglePin(pinned: string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}
