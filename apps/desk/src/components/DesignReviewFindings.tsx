/** Saved advisory evidence. Findings never rewrite factual copy or stand in for approval. */
export function DesignReviewFindings({ findings }: { findings: unknown }) {
  const rows = (Array.isArray(findings) ? findings : []).filter((entry): entry is {
    code: string; message: string; copyIndex?: number;
  } => Boolean(entry && typeof entry.code === 'string' && typeof entry.message === 'string')).slice(0, 50);
  if (!rows.length) return null;
  return <aside aria-label="Design review findings" className="rule">
    <h5>Check before approving</h5>
    <p>These saved warnings need your review. Original copy is unchanged.</p>
    <ul>{rows.map((finding, index) => <li key={`${finding.code}:${index}`}>
      {Number.isInteger(finding.copyIndex) && finding.copyIndex! >= 0 && <strong>Copy block {finding.copyIndex! + 1}: </strong>}
      {finding.message.slice(0, 1000)}
    </li>)}</ul>
  </aside>;
}
