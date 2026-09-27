# Stored receipt audit operation and recovery

ADR-103; FR-050 (stored-receipt subset), FR-064, NFR-006.

## Read the scope first

Operations reads PostgreSQL for your active office membership and authorized client
set. The latest report and paginated history are restricted to your identity and
that exact scope. A changed client set starts a different history view. Prior rows
are retained but cannot be used as the latest report for a different scope. A lost
client membership prevents reading its old report immediately at the database
boundary. Missing data is unavailable, never a clean audit.

## Record or recover an audit

1. Reload receipt audits and review the stated scope.
2. Enter a reason and run the receipt audit. The browser saves an action UUID and
   exact scope/predecessor before sending. Idempotency-Key equals that UUID.
3. A lost response leaves **Retry saved audit** available after reload. Use it:
   an already committed action returns its original report without another audit.
4. A changed scope, predecessor or action body is refused. Reload and inspect the
   current history before clearing the saved browser action and starting another.
   Clearing browser state never deletes a stored report.
5. If browser storage is unavailable, no new request is sent. Restore storage first.

Reports remain after a Core restart. Their hashes cover normalized stored inputs
and the deterministic report; they are integrity identifiers, not external provider
attestations. Database timestamps are represented at millisecond precision.

## Interpret findings

- Work that has not reached publication is **Not yet due**, not a missing delivery
  or a verified consistent delivery.
- Only receipts belonging to the selected current-revision publication count.
  A previous design's Drive or Sheet receipt cannot cover its replacement.
- Every current manifest artifact needs its own verified receipt with matching
  hash and size, with no surplus copies. Filenames are labels: the archive may use
  a client display name where the intent uses its stable ID. A missing/unsupported
  manifest stays incomplete evidence.
- A stored Sheet row needs a matching observed row hash. An expected hash alone
  does not confirm what Sheets returned.
- Unconfirmed archive outcomes remain explicit; a missing local receipt never
  proves that an external file is absent.
- No audit repairs, uploads or sends messages. No audit-result event broadcasts
  report identifiers or counts beyond the authorized read response.

## Qualification boundary

This audit reads one serializable PostgreSQL snapshot. It does not read current
Google Drive/Sheets state. Scheduled external divergence checks and staffed repair
remain open under FR-050, as do live provider, native Canva, human language/design,
independent availability and independent-host recovery admission.
