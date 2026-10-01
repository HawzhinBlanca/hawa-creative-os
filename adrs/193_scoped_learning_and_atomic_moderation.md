# ADR193 — Scoped learning reads and atomic human moderation

Date: 2026-10-01. Status: exact engineering qualification passed; product admission open.
Requirements: FR-022, FR-052, FR-053, FR-054, FR-055, NFR-006, NFR-012.
Sources: MASTER_SPEC.md; docs/08_MEMORY_RAG_CLIENT_DNA.md;
docs/18_FEEDBACK_LEARNING.md; docs/14_SECURITY_THREAT_MODEL.md; ADR191/192.

The learning read endpoints trust a supplied client identifier without an RLS
client lookup. UUID resolution in the generic row helper returns an identifier
without establishing access. Explicit proposal fields are only tested for
truthiness. A supplied role can alter promotion attribution. Rollback mutates
local status before commit, composes from DNA read outside its transaction and
races both other rollbacks and promotion/dismissal. The miner also reads a fixed
KAAE file and fabricates director provenance for imported active rules.

Resolve learning scope through actual RLS clients for both UUIDs and aliases.
Use bounded schemas for proposal/moderation input and verified actor roles.
Derive conflicts from current authorized DNA rather than treating caller conflict
arrays as authority. Remove implicit filesystem activation from the pure miner;
active DNA remains the authority and imported files are not human approval.

The lineage report must enumerate actual RLS-scoped active brand_assets, never
hard-coded logos, fonts or alleged vendor internals. Only an explicit stored
client_owned classification permits client generation retrieval. Missing or
unrecognized rights remain excluded; all client/vendor materials stay out of
external fine-tuning and benchmarks. This report is an inventory boundary, not a
retroactive rights approval or a new design-generation gate.

Rejections require an actual authorized task and a UUID action key. Persist an
immutable feedback event before mining; exact retries reconcile and changed
reuse refuses. Keep conservative task-level negative polarity, and preserve
new feedback evidence that commits while a moderation transaction is pending.

Serialize moderation per tenant/client in this process and share the existing
PostgreSQL client lock across promotion, dismissal and rollback. Prepare local
state without mutation; activate only after commit. Read current DNA under the
lock and use expected versions. Store immutable dismissal/rollback receipts in
the same transaction as any DNA change; inspect latest stored moderation state
before action so stale local status cannot override a recorded decision.
Migration075 extends only these scoped audit actions, with hoisted membership
checks and current writer/actor binding. No second active-rule registry is added.

Acceptance: foreign/unknown client reads and writes refuse before lookup/mining;
canonical aliases agree; malformed instructions refuse atomically; supplied role
never impersonates authority; loading a file supplies no invented approval.
Actual isolated PostgreSQL tests cover rollback pending-state visibility,
concurrent removal of different rules without lost updates, promotion/dismissal
ordering, immutable receipts and injected transaction rollback.
Actual commit-time trigger failures cover both rollback and rejection; a paused
activation commit proves later rejection evidence is retained. Stored inventory
tests prove foreign exclusion, unknown-rights refusal and no invented assets.

Candidate queue rebuilding across restart, end-to-end durable action-key handling,
revision-level polarity, real native/Canva/human taste calibration and full product
admission remain obligations. This slice must not be presented as completion of
those broader requirements or as calibrated confidence.

Connected qualification:14files/101pass/0fail/0skip,663 strict test roots and lint pass.
Original five failures, compatibility failures and IPC refusal are retained.
W6_LEARNING_GOVERNANCE_PROOF.json records source hashes, controls and limits.
No provider call or deployment; exact full gate remains pending.

First exact full gate d765b706 retained6491pass/1fail/67skip; R04 used a fake
non-UUID task and expected foreign-candidate disclosure. Explicit instructions
need no invented task; a foreign candidate now returns404 without disclosing
existence. Corrected14files/101pass; malformed/actual scoped controls remain.
The repeated exact full gate remains pending.

Corrected exact seal308873a6 passes all8 mandatory engineering stages:
6492pass/0fail/67skip across656passed files/6skipped,663 current
strict roots, newest production dump in isolation and negative-flag refusal.
W6_LEARNING_GOVERNANCE_GATE_EVIDENCE.json records the exact candidate.
This supersedes pending qualification status above; prior failures remain.
No deployment or provider call; candidate rebuild/taste/native/product open.
