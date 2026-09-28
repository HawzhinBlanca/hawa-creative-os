/**
 * How often the Canva panel reads its task's Canva state again.
 *
 * It polled every 5 s whatever was happening, so an idle Desk tab on a task made 38 requests a
 * minute (the architecture programme's load test, 2026-09-25). Most of the time nothing on the
 * panel can change without a task event, and the Work screen hands those over (a new `revision`).
 * What does change on its own is an export or a creation Canva is still working on, and a plan
 * being drafted: while one of those runs the panel keeps the 5 s pace, otherwise once a minute.
 */
export const CANVA_PANEL_ACTIVE_POLL_MS = 5_000;
export const CANVA_PANEL_IDLE_POLL_MS = 60_000;

/** Operation statuses Canva is still working on (canva_remote_operations.status). */
const RUNNING_OPERATIONS = new Set(['creating', 'submitted']);
/** Plan statuses the planner is still working on. */
const RUNNING_PLANS = new Set(['planning']);

export function canvaPanelPollMs(view: {
  busy?: boolean;
  operations?: ReadonlyArray<{ status?: string }> | null;
  plans?: ReadonlyArray<{ status?: string }> | null;
  results?: Record<string, { status?: string } | undefined> | null;
}): number {
  const running = view.busy
    || (view.operations ?? []).some((o) => RUNNING_OPERATIONS.has(String(o?.status)))
    || (view.plans ?? []).some((p) => RUNNING_PLANS.has(String(p?.status)))
    || Object.values(view.results ?? {}).some((r) => RUNNING_OPERATIONS.has(String(r?.status)));
  return running ? CANVA_PANEL_ACTIVE_POLL_MS : CANVA_PANEL_IDLE_POLL_MS;
}
