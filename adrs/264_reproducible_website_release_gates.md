# ADR264 — Reproducible website builds and truthful release gates

Date: 2026-10-02. Status: selected; website rebuild qualified locally, complete CI/public admission pending.
Requirements: FR-074 (docs/14_SECURITY_THREAT_MODEL.md), NFR-012/013/024/025 (MASTER_SPEC.md), master build Phase0A (AI_BUILD_PROMPT.md). ADR256/259–263 and the current Canva contract remain binding.

The existing hawzhin.app repository's root npm lock disagreed with26 manifest
declarations. Its qualified populated install hid incompatible calendar/React,
Vite/Vitest, PDF-table/jsPDF and theme/React peers; CI's Node18/20 did not meet
every actual installed test engine. A genuine isolated resolver/install was
required before customer download qualification could be reproducible.

Website ADR0002 selects Node22.23.1/npm10.9.8 and one canonical npm lock, exact
observed root versions plus explicitly qualified compatibility/security repairs.
No force/legacy peers or unrestricted update. All observed Vite peers allow the
selected6.4.3 across the graph. Calendar9.14.0, AutoTable5.0.8, next-themes0.4.6,
Vitest/UI/coverage4.1.11, PostCSS8.5.28 and Router6.30.6 have actual clean source
qualification. Supported jest-dom6.9.1 replaces the incorrectly published6.10.0.
Obsolete Bun locks are removed; workflow runtimes and required scripts agree.
The office engine's runtime, dependencies, schema and request lifecycle remain
as previously tested; no production update is authorized by this source record.

The isolated full run also exposed false-positive RLS evidence: the old website
test accepted every network/credential/server error as anonymous isolation, and
its purported skipped suite still constructed the client. Deterministic unit
tests use synthetic loopback settings, while explicit test:rls requires live
anonymous configuration, key validation and actual SQL permission denial/empty
successful reads. Unexecuted live probes cannot become passing unit security
evidence. Empty-table reads alone do not prove policy definitions or two-user
customer isolation.

Noisy virtual-scroll complexity ratios are replaced with bounded actual source
item reads; full-input scanning now fails deterministically. Production
performance checks require real nonempty resources, observed paint/input and
requested route identity. The nonexistent /batch target becomes /designer.
Screenshot tests cannot label sign-in as a protected page or automatically create
accepted baselines. Existing coverage/budget/screenshot thresholds are preserved.

Website0dbab21 qualifies normal clean npm-ci, valid dependency graph, strict
source/build/test/browser config types, lint0errors/14inherited warnings,
production/PWA build,853 deterministic tests and7 synthetic Chromium Designer
controls. The previous856 total included15 weak live RLS probes; the new total
removes those from unit qualification and adds3 runtime/9 classification tests.
Original resolver, environment, timing and synthetic-scanner failures remain.

Coverage fails at37.27% lines/35.82% statements/31.17% functions/29.14% branches
against80/80/80/75. Actual production performance passes3 and fails3 protected
page fixtures; two checked Auth snapshots fail for missing reviewed baselines.
Audit has0high/critical and6moderate findings (Router6 and Drizzle tools). Linux
GitHub CI/live RLS/native/hosted customer quality are unexecuted. This is rebuild
and test-truthfulness qualification, not a green complete CI or customer launch.

Evidence: plans/hawzhin-app-integration-2026-10-02/WEBSITE_CI_PROOF.json;
website docs/WEBSITE_CI_PROOF.json and docs/adr/0002-reproducible-website-build.md.
Continue independent customer acceptance/current native-version/critical-QA/hash
downloads, inherited release gates, hosting and actual customer/native/recovery
acceptance. No push/deployment/DNS/public generation or launcher switch.
