import { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';

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
 * disagreement is shown as a doubt to look at, never as the outcome.
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
            <blockquote className="copy-value-en" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 4px 12px' }}>{r.directive}</blockquote>
          ) : null}
          {r.question ? (
            <div className="copy-value-en">
              ❓ Asked: {r.question.question} ({r.question.options.join(' / ')}){r.question.answered ? ', answered' : ', no answer yet'}
            </div>
          ) : null}
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {r.asks.map((a, i) => {
              const status = STATUS[a.status] || { sign: '•', words: a.status };
              const doubt = a.seen && a.seen.made !== (a.status === 'done');
              return (
                <li key={i} className="copy-value-en">
                  {status.sign} {a.ask} <span style={{ opacity: 0.7 }}>({status.words}{a.op ? `, ${a.op.replace(/_/g, ' ')}` : ''}{a.by === 'rule' ? ', made by rule' : ''})</span>
                  {a.reason ? <div style={{ opacity: 0.8 }}>Why: {a.reason}</div> : null}
                  {a.assumption ? <div style={{ opacity: 0.8 }}>Read as: {a.assumption}</div> : null}
                  {doubt ? <div role="note">🔍 The visual check did not agree: {a.seen!.why || (a.seen!.made ? 'it saw it made' : 'it did not see it made')}</div> : null}
                </li>
              );
            })}
          </ul>
          {r.sideEffects.length ? <div className="copy-value-en">Moved to make room: {r.sideEffects.join(', ')}</div> : null}
        </div>
      ))}
    </details>
  );
}

/** The ledger of the selected task, loaded from Core. Nothing is shown for a design never changed. */
export function AskLedgerPanel({ taskId }: { taskId: string }) {
  const [rounds, setRounds] = useState<LedgerRound[]>([]);
  useEffect(() => {
    let live = true;
    apiClient.tasks
      .asks(taskId)
      .then((res) => {
        if (live) setRounds(Array.isArray(res?.rounds) ? res.rounds : []);
      })
      .catch(() => {
        if (live) setRounds([]);
      });
    return () => {
      live = false;
    };
  }, [taskId]);
  return <AskLedgerView rounds={rounds} />;
}
