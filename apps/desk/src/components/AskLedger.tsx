import { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
import { read, type Reading } from '../services/statusReport.js';

/** One ask of a round, as Core's ask ledger returns it (apps/core/src/services/ask-ledger.ts). */
export interface LedgerAsk {
  ask: string;
  status: string;
  op?: string;
  by?: 'rule' | 'model';
  reason?: string;
  assumption?: string;
  seen?: { made: boolean; why: string };
}

export interface LedgerRound {
  taskId: string;
  title: string | null;
  round: number;
  directive?: string;
  reformat?: string;
  question?: { question: string; options: string[]; answered: boolean };
  asks: LedgerAsk[];
  sideEffects: string[];
  frustrated: boolean;
  runStatus?: string;
  taskState: string;
}

const STATUS: Record<string, { sign: string; words: string }> = {
  done: { sign: '✅', words: 'done' },
  not_done: { sign: '⚠️', words: 'not done' },
  not_possible: { sign: '❌', words: 'not possible automatically' },
  asked: { sign: '❓', words: 'waiting for the answer to a question' },
};

/**
 * What the requester asked of this design, round by round, and what became of each ask: what the
 * art director reads before approving a design or taking it over (ADR-032 §2.3). The visual check's
 * disagreement is shown as a doubt to look at, never as the outcome. Each line sets its direction
 * from its own text (dir="auto"): Sorani asks were laid out left to right (2026-09-24).
 */
export function AskLedgerView({ rounds }: { rounds: LedgerRound[] }) {
  const changes = rounds.filter((r) => r.directive || r.asks.length || r.question);
  if (!changes.length) return null;
  return (
    <details className="copy-block-card ask-ledger" open>
      <summary className="copy-label">What the requester asked ({changes.length} {changes.length === 1 ? 'round' : 'rounds'})</summary>
      {changes.map((r) => (
        <div key={r.taskId} className="ask-ledger-round" style={{ marginTop: 8 }}>
          <div className="copy-value-en">
            <strong>{r.reformat ? `Other size: ${r.reformat}` : `Round ${r.round}`}</strong>
            {r.frustrated ? ' · the requester sounded frustrated' : ''}
          </div>
          {r.directive && !r.reformat ? (
            <blockquote className="copy-value-en" dir="auto" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 4px 12px' }}>{r.directive}</blockquote>
          ) : null}
          {r.question ? (
            <div className="copy-value-en" dir="auto">
              ❓ Asked: {r.question.question} ({r.question.options.join(' / ')}){r.question.answered ? ', answered' : ', no answer yet'}
            </div>
          ) : null}
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {r.asks.map((a, i) => {
              const status = STATUS[a.status] || { sign: '•', words: a.status };
              const doubt = a.seen && a.seen.made !== (a.status === 'done');
              return (
                <li key={i} className="copy-value-en" dir="auto">
                  {status.sign} {a.ask} <span style={{ opacity: 0.7 }}>({status.words}{a.op ? `, ${a.op.replace(/_/g, ' ')}` : ''}{a.by === 'rule' ? ', made by rule' : ''})</span>
                  {a.reason ? <div dir="auto" style={{ opacity: 0.8 }}>Why: {a.reason}</div> : null}
                  {a.assumption ? <div dir="auto" style={{ opacity: 0.8 }}>Read as: {a.assumption}</div> : null}
                  {doubt ? <div dir="auto" role="note">🔍 The visual check did not agree: {a.seen!.why || (a.seen!.made ? 'it saw it made' : 'it did not see it made')}</div> : null}
                </li>
              );
            })}
          </ul>
          {r.sideEffects.length ? <div className="copy-value-en" dir="auto">Moved to make room: {r.sideEffects.join(', ')}</div> : null}
        </div>
      ))}
    </details>
  );
}

/**
 * The ledger of the selected task, loaded from Core. Nothing is shown for a design never changed.
 * A failed read is said to have failed (2026-09-24): it rendered nothing, exactly like a design
 * never changed, so an approver could not tell that the asks, and which were not done, went unread.
 * A 401 also reaches the Work screen's sign-in prompt through the API client.
 */
export function AskLedgerPanel({ taskId }: { taskId: string }) {
  const [ledger, setLedger] = useState<Reading<LedgerRound[]>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void read(async () => {
      const res = await apiClient.tasks.asks(taskId);
      return Array.isArray(res?.rounds) ? res.rounds : [];
    }).then((reading) => {
      if (live) setLedger(reading);
    });
    return () => {
      live = false;
    };
  }, [taskId]);
  if (ledger.state === 'unknown') {
    return (
      <div className="copy-block-card ask-ledger" role="alert">
        <div className="copy-label">What the requester asked could not be read</div>
        <div className="copy-value-en">
          {ledger.reason.replace(/[.\s]+$/, '')}. This does not mean nothing was asked: check the asks before approving.
        </div>
      </div>
    );
  }
  return <AskLedgerView rounds={ledger.state === 'known' ? ledger.value : []} />;
}
