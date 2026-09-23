import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';
import {
  MAX_PAIR_REQUEST_BYTES,
  PROTOCOL_PREREGISTRATION,
  STATUS_WORDS,
  judgeLinkFor,
  percent,
  readFileAsBase64,
  type JudgeKind,
  type Preregistration,
  type ShareSummary,
  type StudyDetail,
  type StudyResults,
  type StudyStatus,
  type StudySummary,
} from '../services/comparison.js';

/**
 * The blinded comparison with the office designer (PLAN.md, "Blinded comparison with the office
 * designer: protocol"). The art director writes the plan down, adds the pairs and the judges, locks
 * the study, hands each judge their link, closes it, and reads the result here. The judges never see
 * this screen: they see only two unnamed designs on the page their link opens.
 */

const field: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', boxSizing: 'border-box' };
const label: React.CSSProperties = { display: 'block', fontWeight: 650, fontSize: 13, margin: '10px 0 4px' };
const muted: React.CSSProperties = { color: 'var(--muted)', fontSize: 12 };

const statusPill = (status: StudyStatus) => (status === 'judging' ? 'pill blue' : status === 'closed' ? 'pill ok' : 'pill warn');

function ShareLine({ title, share }: { title: string; share: ShareSummary }) {
  return (
    <tr>
      <td>{title}</td>
      <td>{share.judgements}</td>
      <td>{share.decisive}</td>
      <td>{share.hawa} / {share.designer}</td>
      <td>{percent(share.hawaShare)}</td>
      <td>{share.interval ? `${percent(share.interval.low)} to ${percent(share.interval.high)}` : '—'}</td>
      <td>{percent(share.tieRate)}</td>
    </tr>
  );
}

/** The results as the pre-registration defines them: the share, its interval, the tie rate, the splits, and whether the claim holds. */
export function ComparisonResultsView({ results }: { results: StudyResults }) {
  const { primary, claim, position } = results;
  return (
    <div>
      <div className="grid4" style={{ marginBottom: 12 }}>
        <div className="stat">
          <span style={muted}>Hawa preferred</span>
          <b>{percent(primary.hawaShare)}</b>
          <small style={muted}>of {primary.decisive} decisive judgements</small>
        </div>
        <div className="stat">
          <span style={muted}>95% interval</span>
          <b>{primary.interval ? `${percent(primary.interval.low)} to ${percent(primary.interval.high)}` : '—'}</b>
          <small style={muted}>Wilson score interval</small>
        </div>
        <div className="stat">
          <span style={muted}>No preference</span>
          <b>{percent(primary.tieRate)}</b>
          <small style={muted}>{primary.none} of {primary.judgements} judgements</small>
        </div>
        <div className="stat">
          <span style={muted}>Claim holds</span>
          <b>{claim.holds ? 'Yes' : 'No'}</b>
          <small style={muted}>lower bound must be above {percent(claim.threshold)}</small>
        </div>
      </div>
      <p role="status" style={{ fontWeight: 600 }}>{claim.verdict}</p>
      <table className="table">
        <thead>
          <tr>
            <th>Judgements</th>
            <th>All</th>
            <th>Decisive</th>
            <th>Hawa / designer</th>
            <th>Hawa share</th>
            <th>95% interval</th>
            <th>No preference</th>
          </tr>
        </thead>
        <tbody>
          <ShareLine title="All (primary outcome)" share={primary} />
          <ShareLine title="Requesters" share={results.byJudgeKind.requester} />
          <ShareLine title="Outside designers" share={results.byJudgeKind.designer} />
          <ShareLine title="Without designs the judge had received" share={results.excludingSeenBefore} />
          <ShareLine title="Only designs the judge had received" share={results.seenBefore} />
        </tbody>
      </table>
      <p style={muted}>
        Position check: Hawa was on the left in {position.hawaShownLeft} of {position.shown} judgements; the left design was picked in{' '}
        {position.leftChosen} of {position.decisive} decisive ones.
        {results.fromRevokedJudges ? ` ${results.fromRevokedJudges} judgements came through links revoked since; they are counted, as pre-registered.` : ''}
      </p>
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 650, margin: '8px 0' }}>Each pair ({results.perPair.length})</summary>
        <table className="table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Judgements</th>
              <th>Hawa</th>
              <th>Designer</th>
              <th>No preference</th>
              <th>Received before</th>
              <th>Majority</th>
            </tr>
          </thead>
          <tbody>
            {results.perPair.map((p) => (
              <tr key={p.pairId}>
                <td>{p.label}</td>
                <td>{p.judgements}</td>
                <td>{p.hawa}</td>
                <td>{p.designer}</td>
                <td>{p.none}</td>
                <td>{p.seenBefore}</td>
                <td>{p.majority === 'hawa' ? 'Hawa' : p.majority === 'designer' ? 'Designer' : p.majority === 'tie' ? 'Tie' : 'No decisive judgement'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function PreregistrationView({ study }: { study: StudySummary }) {
  const p = study.preregistration;
  return (
    <div className="copy-block-card" style={{ padding: 12 }}>
      <div style={{ fontWeight: 650 }}>Pre-registration {study.status === 'draft' ? '(can still change until the study is locked)' : '(fixed)'}</div>
      <p style={{ whiteSpace: 'pre-wrap' }}><b>Sample.</b> {p.sample}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}><b>Judges.</b> {p.judges}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}><b>Analysis.</b> {p.analysis}</p>
      <p style={muted}>
        Claim threshold: lower bound above {percent(p.threshold)} · at least {p.minDecisive} decisive judgements · at least {p.minJudgesPerPair} judgements per pair · {p.plannedPairs} pairs planned
      </p>
      <p style={muted}>
        Fingerprint of this plan (SHA-256): <code>{study.preregistrationSha256}</code>
        {study.lockedAt ? ` · locked ${study.lockedAt.replace('T', ' ').slice(0, 16)} UTC` : ''}
      </p>
    </div>
  );
}

/** The judge's link, shown once: Hawa keeps only a fingerprint of it. */
export function JudgeLinkNotice({ name, href, localOnly, onDismiss }: { name: string; href: string; localOnly: boolean; onDismiss?: () => void }) {
  return (
    <div className="copy-block-card" role="alert" style={{ padding: 12, marginTop: 10 }}>
      <div style={{ fontWeight: 650 }}>Link for {name}</div>
      <p style={{ margin: '6px 0' }}>Copy it now and send it to the judge yourself. It is shown only this once; Hawa keeps only a fingerprint of it, so a lost link is replaced by revoking it and adding the judge again.</p>
      <input readOnly value={href} style={{ ...field, fontFamily: 'monospace' }} onFocus={(e) => e.currentTarget.select()} aria-label={`Judging link for ${name}`} />
      {localOnly ? (
        <p style={{ ...muted, color: 'var(--warn-text)' }}>
          This address points at this computer. A judge on another device cannot open it until the office makes Hawa's /api/judge/ pages reachable from outside and sets HAWA_JUDGE_BASE_URL.
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(href);
          }}
        >
          Copy link
        </button>
        {onDismiss ? (
          <button className="btn" onClick={onDismiss}>
            I have sent it
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NewStudyForm({ onCreated }: { onCreated: (study: StudySummary) => void }) {
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<Preregistration>(PROTOCOL_PREREGISTRATION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof Preregistration) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setPlan((p) => ({ ...p, [key]: typeof p[key] === 'number' ? Number(e.target.value) : e.target.value }));
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await apiClient.comparisons.create({ name, preregistration: plan }));
      setName('');
    } catch (err) {
      setError(`The study was not created: ${reasonOf(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="panel" style={{ padding: 12, marginTop: 12 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>New study</summary>
      <p style={muted}>Write the plan down before any pair is judged. It can change until the study is locked, and never after.</p>
      <label style={label} htmlFor="cmp-name">Name</label>
      <input id="cmp-name" style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hawa and the office designer, October requests" />
      <label style={label} htmlFor="cmp-sample">Sample</label>
      <textarea id="cmp-sample" style={{ ...field, height: 90 }} value={plan.sample} onChange={set('sample')} />
      <label style={label} htmlFor="cmp-judges">Judges</label>
      <textarea id="cmp-judges" style={{ ...field, height: 90 }} value={plan.judges} onChange={set('judges')} />
      <label style={label} htmlFor="cmp-analysis">Analysis</label>
      <textarea id="cmp-analysis" style={{ ...field, height: 110 }} value={plan.analysis} onChange={set('analysis')} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        <div>
          <label style={label} htmlFor="cmp-threshold">Claim threshold (share)</label>
          <input id="cmp-threshold" type="number" step="0.01" min="0.5" max="0.99" style={field} value={plan.threshold} onChange={set('threshold')} />
        </div>
        <div>
          <label style={label} htmlFor="cmp-decisive">Decisive judgements needed</label>
          <input id="cmp-decisive" type="number" min="1" style={field} value={plan.minDecisive} onChange={set('minDecisive')} />
        </div>
        <div>
          <label style={label} htmlFor="cmp-perpair">Judgements per pair</label>
          <input id="cmp-perpair" type="number" min="1" style={field} value={plan.minJudgesPerPair} onChange={set('minJudgesPerPair')} />
        </div>
        <div>
          <label style={label} htmlFor="cmp-pairs">Pairs planned</label>
          <input id="cmp-pairs" type="number" min="2" style={field} value={plan.plannedPairs} onChange={set('plannedPairs')} />
        </div>
      </div>
      {error ? <p role="alert" style={{ color: 'var(--bad-text)' }}>{error}</p> : null}
      <button className="btn primary" style={{ marginTop: 12 }} disabled={busy || !name.trim()} onClick={create}>
        {busy ? 'Creating…' : 'Create study'}
      </button>
    </details>
  );
}

function AddPairForm({ studyId, onAdded }: { studyId: string; onAdded: () => void }) {
  const [pairLabel, setPairLabel] = useState('');
  const [taskId, setTaskId] = useState('');
  const [fromTask, setFromTask] = useState(true);
  const [hawaFile, setHawaFile] = useState<File | null>(null);
  const [designerFile, setDesignerFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setError(null);
    if (!designerFile) return setError("Choose the designer's PNG.");
    if (fromTask && !taskId.trim()) return setError("Give the task id whose final export is Hawa's design, or upload Hawa's PNG instead.");
    if (!fromTask && !hawaFile) return setError("Choose Hawa's PNG.");
    for (const f of [designerFile, fromTask ? null : hawaFile]) {
      if (f && f.type && f.type !== 'image/png') return setError(`${f.name} is not a PNG. Only PNG is accepted: a JPEG carries details that could tell a judge who made it.`);
    }
    const bytes = designerFile.size + (fromTask || !hawaFile ? 0 : hawaFile.size);
    if ((bytes * 4) / 3 > MAX_PAIR_REQUEST_BYTES - 64 * 1024) {
      return setError('The two images together are too large to send through the office server (25 MB per request as sent). Export them smaller.');
    }
    setBusy(true);
    try {
      await apiClient.comparisons.addPair(studyId, {
        ...(pairLabel.trim() ? { label: pairLabel.trim() } : {}),
        ...(taskId.trim() ? { taskId: taskId.trim() } : {}),
        fromTask,
        ...(fromTask || !hawaFile ? {} : { hawaPngBase64: await readFileAsBase64(hawaFile) }),
        designerPngBase64: await readFileAsBase64(designerFile),
      });
      setPairLabel('');
      setTaskId('');
      setHawaFile(null);
      setDesignerFile(null);
      onAdded();
    } catch (err) {
      setError(`The pair was not added: ${reasonOf(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>Add a pair</summary>
      <p style={muted}>Both designs as PNG, exported at the same size. Metadata is removed before any judge sees them.</p>
      <label style={label} htmlFor="cmp-task">Task id (the request both designs answer)</label>
      <input id="cmp-task" style={field} value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="00000000-0000-4000-…" />
      <label style={{ ...label, fontWeight: 500 }}>
        <input type="checkbox" checked={fromTask} onChange={(e) => setFromTask(e.target.checked)} /> Take Hawa's design from this task's final PNG export
      </label>
      {!fromTask ? (
        <>
          <label style={label} htmlFor="cmp-hawa">Hawa's design (PNG)</label>
          <input id="cmp-hawa" type="file" accept="image/png" onChange={(e) => setHawaFile(e.target.files?.[0] || null)} />
        </>
      ) : null}
      <label style={label} htmlFor="cmp-designer">The designer's design (PNG)</label>
      <input id="cmp-designer" type="file" accept="image/png" onChange={(e) => setDesignerFile(e.target.files?.[0] || null)} />
      <label style={label} htmlFor="cmp-label">Label (optional; a neutral code such as P07, seen only by the office)</label>
      <input id="cmp-label" style={{ ...field, maxWidth: 160 }} value={pairLabel} onChange={(e) => setPairLabel(e.target.value)} />
      {error ? <p role="alert" style={{ color: 'var(--bad-text)' }}>{error}</p> : null}
      <button className="btn primary" style={{ marginTop: 10 }} disabled={busy} onClick={add}>
        {busy ? 'Adding…' : 'Add pair'}
      </button>
    </details>
  );
}

function PairPreview({ studyId, pairId }: { studyId: string; pairId: string }) {
  const [urls, setUrls] = useState<{ hawa?: string; designer?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    Promise.all([apiClient.comparisons.pairImage(studyId, pairId, 'hawa'), apiClient.comparisons.pairImage(studyId, pairId, 'designer')])
      .then(([h, d]) => {
        const hawa = URL.createObjectURL(h);
        const designer = URL.createObjectURL(d);
        made.push(hawa, designer);
        if (live) setUrls({ hawa, designer });
      })
      .catch((err) => live && setUrls({ error: reasonOf(err) }));
    return () => {
      live = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [studyId, pairId]);
  if (urls.error) return <span style={muted}>Could not load the designs: {urls.error}</span>;
  if (!urls.hawa || !urls.designer) return <span style={muted}>Loading…</span>;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <figure style={{ margin: 0 }}>
        <figcaption style={muted}>Hawa</figcaption>
        <img src={urls.hawa} alt="Hawa's design" style={{ maxWidth: 220, maxHeight: 280, border: '1px solid var(--line)' }} />
      </figure>
      <figure style={{ margin: 0 }}>
        <figcaption style={muted}>Designer</figcaption>
        <img src={urls.designer} alt="The designer's design" style={{ maxWidth: 220, maxHeight: 280, border: '1px solid var(--line)' }} />
      </figure>
    </div>
  );
}

/** The study as the office manages it: plan, pairs, judges and the two one-way steps, lock and close. */
export function StudyDetailView({
  study,
  onChanged,
  onJudgeAdded,
}: {
  study: StudyDetail;
  onChanged: () => void;
  onJudgeAdded: (name: string, link: { path: string; url: string | null }) => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [judgeName, setJudgeName] = useState('');
  const [judgeKind, setJudgeKind] = useState<JudgeKind>('requester');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(`${what}: ${reasonOf(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const addJudge = () =>
    act('The judge was not added', async () => {
      const added = await apiClient.comparisons.addJudge(study.id, { name: judgeName, kind: judgeKind });
      setJudgeName('');
      onJudgeAdded(added.judge.name, added.link);
    });
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{study.name}</h2>
        <span className={statusPill(study.status)}>{STATUS_WORDS[study.status]}</span>
      </div>
      <p style={muted}>
        {study.pairs} pairs · {study.activeJudges} active judges · {study.judgements} judgements so far
      </p>
      <PreregistrationView study={study} />

      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Pairs</h3>
      {study.pairList.length === 0 ? <p style={muted}>No pairs yet.</p> : null}
      {study.pairList.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Task</th>
              <th>Size</th>
              <th>Judgements</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {study.pairList.map((p) => (
              <React.Fragment key={p.id}>
                <tr>
                  <td>{p.label}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{p.taskId || '—'}</td>
                  <td>
                    {p.width}×{p.height}
                  </td>
                  <td>{p.judgements}</td>
                  <td>
                    <button className="btn" onClick={() => setShown(shown === p.id ? null : p.id)}>
                      {shown === p.id ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
                {shown === p.id ? (
                  <tr>
                    <td colSpan={5}>
                      <PairPreview studyId={study.id} pairId={p.id} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : null}
      {study.status === 'draft' ? <AddPairForm studyId={study.id} onAdded={onChanged} /> : <p style={muted}>The pairs are fixed: judging has started.</p>}

      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Judges</h3>
      {study.judgeList.length === 0 ? <p style={muted}>No judges yet.</p> : null}
      {study.judgeList.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Judgements</th>
              <th>Link</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {study.judgeList.map((j) => (
              <tr key={j.id}>
                <td>{j.name}</td>
                <td>{j.kind === 'requester' ? 'Requester' : 'Outside designer'}</td>
                <td>
                  {j.judgements} of {study.pairs}
                </td>
                <td>{j.revokedAt ? <span className="pill bad">Revoked</span> : <span className="pill ok">Active</span>}</td>
                <td>
                  {!j.revokedAt && study.status !== 'closed' ? (
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Revoke ${j.name}'s link? It stops working at once. Their judgements so far stay in the study.`)) {
                          void act('The link was not revoked', () => apiClient.comparisons.revokeJudge(study.id, j.id));
                        }
                      }}
                    >
                      Revoke link
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {study.status !== 'closed' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
          <div>
            <label style={label} htmlFor="cmp-judge-name">Judge's name (the office's record only)</label>
            <input id="cmp-judge-name" style={{ ...field, width: 240 }} value={judgeName} onChange={(e) => setJudgeName(e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="cmp-judge-kind">Kind</label>
            <select id="cmp-judge-kind" style={{ ...field, width: 200 }} value={judgeKind} onChange={(e) => setJudgeKind(e.target.value === 'designer' ? 'designer' : 'requester')}>
              <option value="requester">Requester (sent a brief)</option>
              <option value="designer">Designer from outside the office</option>
            </select>
          </div>
          <button className="btn primary" disabled={busy || !judgeName.trim()} onClick={() => void addJudge()}>
            Add judge
          </button>
        </div>
      ) : null}

      {error ? <p role="alert" style={{ color: 'var(--bad-text)' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {study.status === 'draft' ? (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Lock the study and start judging? The plan and the pairs cannot change afterwards; judges can still be added.')) {
                void act('Judging did not start', () => apiClient.comparisons.lock(study.id));
              }
            }}
          >
            Lock and start judging
          </button>
        ) : null}
        {study.status === 'judging' ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Close judging? No judge can add a judgement afterwards, and this cannot be undone.')) {
                void act('The study was not closed', () => apiClient.comparisons.close(study.id));
              }
            }}
          >
            Close judging
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const ComparisonScreen: React.FC = () => {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudyDetail | null>(null);
  const [results, setResults] = useState<StudyResults | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; href: string; localOnly: boolean } | null>(null);

  const loadList = useCallback(() => {
    apiClient.comparisons
      .list()
      .then((res) => setStudies(Array.isArray(res?.studies) ? res.studies : []))
      .catch((err) => setNotice(`Could not read the studies: ${reasonOf(err)}`));
  }, []);

  const loadStudy = useCallback((id: string) => {
    apiClient.comparisons
      .get(id)
      .then(setDetail)
      .catch((err) => setNotice(`Could not read the study: ${reasonOf(err)}`));
    apiClient.comparisons
      .results(id)
      .then(setResults)
      .catch((err) => {
        setResults(null);
        setNotice(`Could not read the results: ${reasonOf(err)}`);
      });
  }, []);

  useEffect(loadList, [loadList]);
  useEffect(() => {
    setDetail(null);
    setResults(null);
    setLink(null);
    if (selected) loadStudy(selected);
  }, [selected, loadStudy]);

  const refresh = () => {
    loadList();
    if (selected) loadStudy(selected);
  };

  return (
    <section id="comparison" className="screen active" style={{ overflowY: 'auto' }}>
      <h1 className="sr-only">Blinded comparison with the office designer</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
        <div>
          <div className="panel" style={{ padding: 12 }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Studies</h2>
            {studies.length === 0 ? <p style={muted}>No studies yet.</p> : null}
            {studies.map((s) => (
              <div
                key={s.id}
                className={`listitem ${selected === s.id ? 'sel' : ''}`}
                style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 6 }}
                onClick={() => setSelected(s.id)}
              >
                <div style={{ fontWeight: selected === s.id ? 700 : 500, fontSize: 13 }}>{s.name}</div>
                <small style={muted}>
                  <span className={statusPill(s.status)} style={{ fontSize: 10 }}>{s.status}</span> {s.pairs} pairs · {s.activeJudges} judges · {s.judgements} judgements
                </small>
              </div>
            ))}
          </div>
          <NewStudyForm
            onCreated={(study) => {
              loadList();
              setSelected(study.id);
            }}
          />
          <p style={{ ...muted, marginTop: 12 }}>
            The claim that Hawa designs better is decided here by people who cannot tell which design is which, never by a model. Judges see two unnamed designs side by side, on sides the server picks, and choose one or neither.
          </p>
        </div>
        <div>
          {notice ? (
            <p role="alert" style={{ color: 'var(--bad-text)' }}>
              {notice}{' '}
              <button className="btn" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          ) : null}
          {link ? <JudgeLinkNotice name={link.name} href={link.href} localOnly={link.localOnly} onDismiss={() => setLink(null)} /> : null}
          {detail ? (
            <div className="panel" style={{ padding: 16 }}>
              <StudyDetailView
                study={detail}
                onChanged={refresh}
                onJudgeAdded={(name, l) => {
                  setLink({ name, ...judgeLinkFor(l, window.location.origin) });
                  refresh();
                }}
              />
            </div>
          ) : (
            <div className="panel" style={{ padding: 16 }}>
              <p style={muted}>Choose a study, or write a new one down.</p>
            </div>
          )}
          {detail && results ? (
            <div className="panel" style={{ padding: 16, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>Results</h2>
                <button className="btn" onClick={refresh}>
                  Refresh
                </button>
              </div>
              <ComparisonResultsView results={results} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
};
