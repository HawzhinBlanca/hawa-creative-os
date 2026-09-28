# Inspect the current design's amendment prerequisites

In Desk, open the linked task, expand **Evidence and operation history**, and use
**Inspect automatic-edit support**. This performs native reads on your app OAuth
connection; ordinary connection refresh can update its token record. It does not
edit the design and is not part of automatic polling.

- An observed capability is an account advertisement, not operation qualification.
- `unknown` on account inspection may mean the app lacks `profile:read`. Check the
  integration's registered scopes and grant before reconnecting; reconnecting the
  unchanged default scope set cannot add that permission.
- An empty observed dataset means this design exposes no named autofill fields.
  Fields must be prepared through a supported Canva editing surface on an
  authorized disposable copy before testing autofill. Do not guess field names:
  the provider may silently ignore unknown names.
- Dataset `forbidden` requires checking design access and `design:content:read`.
- A stale response is refused. Inspect the current link again after changes settle.
- A rate limit means wait before retrying. The account endpoint allows ten reads
  per minute per user/app; do not turn this action into frequent polling.

The result always says automatic amendments are unqualified. Admission requires a
separate real operation: exact intended change, protected text/assets/crop/position,
reopen/export, conflict handling and duplicate/uncertain-result recovery. The
existing human revision handoff remains available under its own authority.

## 2026-09-28 actual backend probe

The existing synthetic multilingual fixture was readable and unchanged across
inspection. It exposed no fields; capabilities returned HTTP 403. This leaves
account entitlement unknown and provides no native amendment qualification.
See `plans/lean-design-implementation-2026-09-28/NATIVE_OBSERVATION_PROOF.json`.
