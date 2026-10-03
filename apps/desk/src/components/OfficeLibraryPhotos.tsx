/**
 * ADR-280: which of the office's own archive photos a run was given, and why. They are the office's,
 * not the requester's; the run recorded them under stages.officePhotoLibrary.
 */
export function OfficeLibraryPhotos({ record }: { record: unknown }) {
  const r = record as {
    provenance?: unknown; status?: unknown; reason?: unknown; inheritedFromParent?: unknown;
    photos?: Array<{ id?: unknown; score?: unknown; reasons?: unknown; description?: unknown; date?: unknown }>;
  } | null | undefined;
  if (!r || r.provenance !== 'office_library') return null;
  const photos = (Array.isArray(r.photos) ? r.photos : []).filter((p) => p && typeof p.id === 'string').slice(0, 3);
  const status = String(r.status);
  return <aside aria-label="Office library photos" className="rule">
    <h5>Office photo library</h5>
    {status === 'attached'
      ? <p>The requester sent no photo, so this design was given {photos.length === 1 ? 'one photo' : `${photos.length} photos`} from the office archive{r.inheritedFromParent === true ? ', kept from the design being revised' : ''}. Check that {photos.length === 1 ? 'it suits' : 'they suit'} this post before approving.</p>
      : <p>{status === 'no_match' ? 'No archive photo was used' : 'The archive photos could not be used'}{typeof r.reason === 'string' ? `: ${r.reason.slice(0, 300)}` : '.'}</p>}
    {photos.length > 0 && <ul>{photos.map((p) => <li key={String(p.id)}>
      <strong>{String(p.id)}</strong>
      {typeof p.description === 'string' && ` — ${p.description.slice(0, 300)}`}
      {typeof p.date === 'string' && ` (${p.date})`}
      {Array.isArray(p.reasons) && <span>: {p.reasons.filter((x) => typeof x === 'string').slice(0, 6).join('; ')}</span>}
    </li>)}</ul>}
  </aside>;
}
