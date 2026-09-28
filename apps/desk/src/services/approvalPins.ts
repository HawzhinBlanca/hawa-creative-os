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
  capture_version?: string | null;
}

/**
 * Preselect the reviewed image and the exact deck used by QA when Core supplies its artifact ID.
 * Both files are delivered; the deck is the editable evidence behind the approval.
 */
export function defaultPins(exports: StoredExport[], checkedId?: string | null, captureVersion?: string | null): string[] {
  const kind = (e: StoredExport) => String(e.format).toLowerCase();
  const sameCapture = (e: StoredExport) => !captureVersion || e.capture_version === captureVersion;
  const pick = exports.find((e) => kind(e) === 'png' && sameCapture(e)) || exports.find((e) => kind(e).startsWith('pdf') && sameCapture(e));
  const checked = checkedId ? exports.find((e) => e.id === checkedId && kind(e) === 'pptx') : undefined;
  return [...(pick ? [pick.id] : []), ...(checked ? [checked.id] : [])];
}

export function describeExport(e: StoredExport): string {
  const bytes = Number(e.byte_size);
  const size = Number.isFinite(bytes) ? `${bytes.toLocaleString('en-US')} bytes` : 'size not reported';
  return `${String(e.format).toUpperCase()} · ${size} · SHA-256 ${String(e.sha256).slice(0, 12)}…`;
}

/** Why approval cannot be confirmed yet, or null when it can. */
export function approvalBlocker(state: 'loading' | 'known' | 'unknown', exports: StoredExport[], pinned: string[], checkedId?: string | null, captureVersion?: string | null): string | null {
  if (state === 'loading') return 'Reading the stored exports…';
  if (state === 'unknown') return 'The stored exports could not be read, so there is nothing to pin.';
  if (exports.length === 0) return 'No export is stored for this task. Capture for Review first: delivery sends only a captured file.';
  if (pinned.length === 0) return 'Select at least one export: delivery sends exactly the selected files.';
  if (checkedId === null) return 'The latest QA run has no linked Canva capture. Capture and check this design again before approval.';
  if (checkedId && !exports.some((e) => e.id === checkedId && e.format.toLowerCase() === 'pptx')) return 'The deck checked by QA is missing from stored exports. Capture and check this design again.';
  if (checkedId && !pinned.includes(checkedId)) return 'Select the editable PPTX checked by QA; it must accompany the files you approve.';
  if (checkedId && captureVersion === null) return 'The latest QA run has no Canva design version. Capture and check this design again.';
  if (checkedId && captureVersion && pinned.some((id) => exports.find((e) => e.id === id)?.capture_version !== captureVersion)) return 'Every selected file must come from the Canva version checked by QA.';
  return null;
}

export function togglePin(pinned: string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}
