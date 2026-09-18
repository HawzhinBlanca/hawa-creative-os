export interface SubmittedCopyProps {
  headlineEn?: string | null;
  copyEn?: string | null;
  headlineCkb?: string | null;
  copyCkb?: string | null;
}

/** The copy fields a task carries. A task with none says so instead of showing an empty panel. */
export function SubmittedCopy({ headlineEn, copyEn, headlineCkb, copyCkb }: SubmittedCopyProps) {
  const blocks = [
    { label: 'English headline', text: headlineEn, sorani: false },
    { label: 'English body copy', text: copyEn, sorani: false },
    { label: 'Sorani headline', text: headlineCkb, sorani: true },
    { label: 'Sorani body copy', text: copyCkb, sorani: true },
  ].filter((block) => block.text && block.text.trim());

  if (!blocks.length) {
    return (
      <div className="copy-block-card">
        <div className="copy-label">No copy was sent with this request</div>
        <div className="copy-value-en">The client's exact text is needed before this can be designed.</div>
      </div>
    );
  }
  return (
    <>
      {blocks.map((block) => (
        <div className="copy-block-card" key={block.label}>
          <div className="copy-label">{block.label}</div>
          {block.sorani
            ? <div className="copy-value-ckb kurdish-typeset bidi-isolated" dir="rtl" style={{whiteSpace:'pre-wrap'}}>{block.text}</div>
            : <div className="copy-value-en" style={{whiteSpace:'pre-wrap'}}>{block.text}</div>}
        </div>
      ))}
    </>
  );
}
