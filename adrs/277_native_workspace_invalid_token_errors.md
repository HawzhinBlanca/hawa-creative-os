# ADR277 — Native workspace invalid-token errors

Date: 2026-10-03. Status: locally qualified; public customer release open.
Requirements: NFR-006/012/024/025, FR-069. Sources: MASTER_SPEC.md;
docs/14_SECURITY_THREAT_MODEL.md; ADR256/259/260; current workspace verifier.

An owned actual Supabase Auth/PostgREST → production `createApp()` → restricted
PostgreSQL run passes19 controls and fails1: a tampered real Auth-issued JWT is
safely refused but Core reports503 WORKSPACE_ACCESS_UNAVAILABLE. A separate
native probe confirms Auth returns403 with `error_code=bad_jwt`. The synthetic
contract tests covered401 but missed this native response.

At the exact `/auth/v1/user` boundary, recognize only a bounded JSON403 containing
the exact machine-readable `error_code=bad_jwt` as401 WORKSPACE_SIGN_IN_REQUIRED.
This is an invalid presented credential, so the caller must sign in again. No
membership request follows. Never infer a refusal from human-readable text,
unknown/malformed/oversized403 bodies, other statuses, or a membership RPC error;
those remain503. Preserve native401 behavior, one shared deadline, pinned issuer,
server-side native verification, current access checks and no office fallback.

Provider contract: [Supabase Auth error codes](https://supabase.com/docs/guides/auth/debugging/error-codes),
read2026-10-03. The native fixture establishes this exact pinned vendor behavior;
the documentation alone is not admission evidence.

The qualification uses real vendor responses and current native Core HTTP, with
a test-only exact-origin network projection to the owned Kong endpoint. It does
not qualify hosted TLS/DNS, browser login/upload, customer generation, the worker
design pipeline, native Canva or human design quality. Direct repository receipt
seeding is only read-isolation evidence. Keep the production factory's ADR260
generation/upload guard closed. No public release or authentication relaxation.

Measured: native baseline19pass/1fail, repaired20pass/0fail on sourcefebe647c;
contract red33pass/1fail then113pass/0fail across workspace/customer contracts.
All757 strict roots and production/script types pass; lint/egress and ratchet
957<=1053 pass. Prior full8,277/0/67 is retained, not rerun here. See
plans/hawzhin-app-integration-2026-10-02/NATIVE_CUSTOMER_CORE_PROOF.json for scope.
