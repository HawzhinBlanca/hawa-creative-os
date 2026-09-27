# ADR-094 — Validate shared gateway schemas before paid work

Date: 2026-09-27
Status: Accepted; local qualification evidence in R21_GATEWAY_SCHEMA_PROOF.json
Requirements: FR-059, FR-062, FR-065, NFR-001

## Evidence and decision

The handwritten ModelGateway validator accepts fractional integers, non-finite
numbers and forbidden additional properties. It ignores many JSON Schema rules.
The gateway also injects provenance into already validated answers, and evaluation
callers supply empty schemas. These violate the bounded typed decision invariant.

Use pinned Ajv 8.20.0 and ajv-formats 3.0.1 in the integrations boundary. The measured
validation failures justify this focused dependency. Support default draft-07 and
explicit draft-2019-09 / draft-2020-12 with their own compiler instances. Compile
before provider selection/transport. Reject malformed schemas, unknown keywords or
formats, unsupported dialects, async validation and unresolved external references.
No remote schema loading, type coercion, property deletion, or default insertion.
Application-owned schemas remain trusted code; model/uploaded schemas are not an
admitted input. Bound schema size/depth and compiled cache retention. Validate
plain finite JSON data and bound its size/depth before schema execution.

Validate every cloud and local result with the frozen compiled schema. Invalid
paid output stops with the original usage/quote evidence and no fallback. Error
messages expose no answer or schema content. Put execution provenance on the
response envelope; preserve the exact schema SHA-256 with success/failure receipts,
and hash and return the unchanged validated answer. Give routing
and visual fixture evaluations explicit schemas for the fields they consume, and
stop a batch when its schema is invalid before dispatch. Historical evaluation
projections retain their original meaning; this does not qualify fixture scores as
independent quality evidence.

## Primary sources (checked 2026-09-27)

- https://ajv.js.org/json-schema.html — dialect support and separate 2020 compiler.
- https://ajv.js.org/options.html — strict schema/numbers, own properties and disabling data mutation.
- https://ajv.js.org/security.html — application-owned schemas, bounded input, no allErrors in production.
- https://github.com/ajv-validator/ajv — pinned validator source/release.

## Required verification

Red-before fractional/infinite/extra-field controls; references, unions, conditions,
arrays, strings, enums and formats; invalid schemas cause zero provider transport;
all three provider responses reject invalid outputs with one paid attempt and
preserved receipt; strict answers return unchanged with matching hashes; local
answers obey the same validation; evaluation receipt replay retains failure without
repeating the paid call. Source/strict-test types and release regression must pass.
