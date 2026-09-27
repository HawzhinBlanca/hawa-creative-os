export interface EvaluationAction { actionId: string; name: string }
const KEY = 'hawa.pending-fixture-evaluation';
export function pendingEvaluation(): EvaluationAction | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return value && /^[0-9a-f-]{36}$/i.test(value.actionId) && typeof value.name === 'string' ? value : null;
  } catch { return null; }
}
/** A storage failure must stop before dispatch; otherwise refresh could manufacture a new action. */
export function retainEvaluation(action: EvaluationAction) { sessionStorage.setItem(KEY, JSON.stringify(action)); }
export function clearEvaluation(actionId: string) { if (pendingEvaluation()?.actionId === actionId) sessionStorage.removeItem(KEY); }
