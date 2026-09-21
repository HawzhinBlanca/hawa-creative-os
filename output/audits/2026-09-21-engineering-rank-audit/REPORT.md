# Hawdesign: engineering rank audit

21 September 2026. Baseline `2d3a930`, re-checked at `6d3c583`. Read-only: no application code changed, nothing deployed, no paid model call, no production query.

Method: 10 dimension auditors, each followed by an adversarial verifier told to refute (100 findings attacked: 69 confirmed, 31 softened, 0 refuted). Then 4 gap investigators and a 3-lens calibration panel. 29 agents, about 6 million tokens. I re-verified every headline claim below by hand. Full ledger: [FINDINGS.md](FINDINGS.md) (183 findings, each with file and line). Measurements: [EVIDENCE.json](EVIDENCE.json).

## Verdict: 4.1 / 10

A prototype that reached production and carries real risk. Three independent lenses (staff engineer, SRE and security lead, applied-AI design lead) each scored 4.1 without seeing each other. Uncertainty is about ±0.4.

It is not a 3. The database schema, the intake transaction, the Canva OAuth integration, pinned delivery and the cost programme are professional work that most funded startups do not have.

It is not a 5, for one reason above all others. **The product's own chain has not completed once on the live path.** I measured this from the newest local production dump, counts and dates only:

| Table | Rows | First | Last |
|---|---|---|---|
| `canva_bindings` | 70 | 09-13 | 09-20 |
| `design_studio_runs` | 47 | 09-14 | 09-20 |
| `design_revisions` | 192 | 09-09 | **09-13** |
| `approvals` | 110 | 09-09 | **09-13** |
| `publications` | 47 | 09-09 | **09-11** |

Since the Canva path went live, production has made 70 Canva designs and recorded zero revisions, zero approvals and zero publications. The code explains it. The approval gate demands a `design_revisions` row and a passing `qc_runs` row. Only the legacy `/generate` and `/revisions` routes write those; the live path writes `design_studio_*` and `canva_*` tables instead. The production task payload also omits the three fields the Desk's Approve and Deliver buttons are gated on (`WorkScreen.tsx:906`, `:918`). `notify.published` has 8 producer sites and no consumer, so a delivery could never tell the requester anyway.

Either the office finishes every job by hand in Canva, or nothing is being delivered. Twenty-four audits, 968 evidence files and 1,584 green tests did not notice for eight days.

Also measured: 1,449 of the 1,589 "production" tasks were created on 09-09 to 09-11 (993 in one day), and 1,402 still sit in `received`. Real volume since is 5 to 31 tasks a day. About 91% of the production data is drill traffic.

## Where it ranks

No published percentile data exists for private codebases. These are estimates.

| Against | Rank |
|---|---|
| Best engineering organisations (Stripe, Cloudflare, Tailscale, SQLite) | Would be stopped at design review. Three components would pass on their own: the Canva OAuth path, the SQL schema, the intake transaction. |
| Funded startups with paying customers | About 15th to 25th percentile. Above the median on schema, tenancy and idempotency thinking. Bottom decile on process: they have CI, review, managed Postgres with point-in-time recovery, per-person login and a core flow that completes. |
| All code that runs a business somewhere | Around the median, 35th to 60th. |
| Solo AI-assisted projects built in weeks | Top 5 to 10% on substance. Typical of the class in its failure modes. |
| AI design products (Canva, Adobe, Figma) | Not comparable on general capability. It rents its models and uses Canva as its editor. |
| The Sorani, Arabic and English office niche | Unserved by anyone, by omission and not difficulty. The claim today is "nobody else has tried", not "best". Zero Arabic designs exist in any proof folder (0 of 258 stored briefs). |

## Measured

| | Baseline `2d3a930` | Shared tree, 09-20 20:15 | Now `6d3c583` |
|---|---|---|---|
| Typecheck | pass | **fail** (2 errors in `scripts/`) | pass |
| Tests | 1,568 pass, 3 timeouts | 1,197 pass, 8 fail, **51 files cannot load** | 1,584 pass, 0 fail |

The middle column is the checkout `deploy.sh` builds from. Another agent wrote an edit to `app.ts` during my run that left it unparseable for at least four minutes. Nothing would have stopped a deploy.

Coverage has never been measured: the config exists, the provider was never installed. There is no CI, no linter and no formatter. CI scripts exist under `infra/ci` and were never switched on.

## Scorecard (panel median)

| Dimension | Score | Why |
|---|---|---|
| Data layer | 5.0 | Schema near 8. Access layer treats Postgres as a best-effort mirror of RAM. |
| Security | 4.8 | RLS enforced under a non-owner role, no SQL injection surface. Three shared static keys are the whole identity model. |
| Performance and cost | 4.7 | Cost per design measured honestly ($0.63 to about $0.37). Every rasterisation is a `spawnSync` on the event loop. |
| Test quality | 4.6 | Well-crafted tests of a different program: in-memory branch, auth off by default, project-written simulators. |
| Durability and integrations | 4.5 | Intake is a correct transactional outbox. Drive idempotency lives in a process `Map`. Only 3 of 14 hops survive `kill -9`; 3 lose work, 3 duplicate an effect, 5 leave the requester uninformed. |
| Creative engine | 4.5 | Real fontkit shaping. Six font lists that disagree, three contrast implementations, no bidi algorithm, no overflow check. |
| Design output | 4.5 | See below. |
| LLM engineering and evals | 4.4 | The model holds no authority, which is right. The evals grade their own test doubles. Zero human labels. |
| Maintainability | 4.0 | 942 `any`. `Task` is `any`. Eight generation paths, six QA systems, five approval paths. Nothing is ever deleted. |
| Desk frontend | 3.8 | 1,800-line screens, zero interaction tests, token in `localStorage` and in URLs, no CSP. |
| DevOps, release, observability | 3.8 | Production is a developer Mac at 92% disk. Observability is a 145-line stub. |
| Core architecture | 3.5 | `createApp` is one 9,100-line closure over 16 `Map`s. 70 handlers read a body, 2 validate it. |
| End-to-end integrity | 3.4 | The chain does not close. |
| Privacy and licensing | 3.0 | See hard truth 3. |

**Design output.** I looked at the designs. The 20 winners of the last qualification run average 4.5 on a scale where 5 is a competent template user and 7 a solid professional. 17 of 20 use one centred skeleton. None has imagery. The date, venue and URL are always the smallest text. One winner (`brief_13`) shipped with a yellow slab where a thin rule should be, and passed every gate. This is one AI reviewer, not blind, and not a ranking.

What is genuinely strong in the output: copy fidelity was 100 of 100 blocks exact, and Sorani shaping and bidi order were correct in 10 of 10. Generic generators fail exactly there.

## Hard truths

1. **Documents have replaced gates.** Hours after this audit began, commit `6d3c583` recorded a "clean-host" recovery drill: RPO 15 s, RTO 10 s, verdict `QUALIFIED`. The clean host is a container named `hawa-clean-host-dr-postgres` on the same Mac. The "off-host replica" is `~/.hawa/offhost_snapshots` on the same disk. RTO timed a database restore, not a usable service.
2. **Findings get patched by name, not by class.** Within three hours of my eight hand-verified claims being written down, commit `73a3b6b` (80 files, 4,442 lines, no review) fixed seven of them. All 15 structural items I re-checked are unchanged. The unauthenticated kill switch is closed. The reason it existed is not: nine routes still bypass the deny-by-default registrar, and no test enumerates routes.
3. **You are holding a client's data where you cannot fully take it back.** `config/clients/kaae.dna.json` and `data/kaae-graphics` carry a staff directory (12 emails, 28 phone-like numbers) and internal documents, committed and pushed. The GitHub repository is private, which I confirmed, so this is high and not critical. Four proprietary Microsoft Verdana files are committed and baked into images. A database password literal sits in git history; confirm it was rotated.
4. **Nothing stands between an agent's keystroke and production.** Several agents commit to the default branch of the one checkout that deploys. While I was writing this, another agent's commit `6cbbde8` ("seal security, state invariants…") swept this audit's `FINDINGS.md` and `EVIDENCE.json` into itself. I committed nothing.
5. **About a third of the 139k lines is liability.** Roughly 40% of routes have no caller and 41% of tables are unused. The tests mostly exercise the paths production never runs.
6. **The quality gates cannot see what ships.** QA judges an SVG preview, not the Canva export. The vision critique inspected a different candidate from the winner in 3 of 20 briefs.

## Root causes

1. Many writers, one checkout, no merge gate.
2. Proof by document. Agents are asked for an artefact named PASS, so they produce one.
3. Acceptance-test scaffolding fused into production code, so the tested program and the running program differ.
4. Additive-only development. Every pivot added a path and deleted nothing, and nobody owns "a brief becomes a delivered file and the requester is told".
5. No ground truth for quality: one client, synthetic briefs, zero human labels.

## Route to a true 10

Ordered by dependency and by risk retired per unit of effort. Every proof is a command or a measurement, never a document. Score is the panel's estimate once that step and all earlier ones are truly done.

| # | Step | Proof | Effort | Score |
|---|---|---|---|---|
| 1 | **Contain the exposure.** Strip client data, Verdana and secrets from tree and history. Rotate every credential that touched git. Re-clone all agent worktrees. | Fresh clone: `git log --all -- data/kaae-graphics 'packages/creative/assets/fonts/Verdana*'` is empty. `gitleaks detect --log-opts=--all` exits 0. | days | 4.3 |
| 2 | **One gate.** Switch on CI: frozen install, `tsc -b` including tests, vitest on a Postgres service, fail when the skip count changes. Protect `studio-v2`. One worktree and branch per agent, merge by PR. `deploy.sh` builds a tagged clean clone only. | A branch with a type error shows a red check and cannot merge. `touch apps/core/src/app.ts && deploy.sh` exits non-zero. | days | 4.6 |
| 3 | **Executable evidence or none.** Every gate field computed by CI at a clean SHA. No literal `PASS`. Name what was measured ("same-host container restore"). Stop committing `output/`. | For each gate field, a negative control flips it and the gate exits non-zero. | days | 4.8 |
| 4 | **Close the chain.** The Canva path writes a revision and a QC run made from the real Canva export. Task payloads carry revision, QA and approval from Postgres. Add the `notify.published` consumer. Alert when any funnel stage is zero for 48 hours. | One CI test on the production persistence branch: Telegram update in, then exactly one Drive file, one Sheet row and one "delivered" message. In production: approval and publication rows dated after the fix. | 1 to 2 weeks | 5.2 |
| 5 | **Every hop kill-safe and loud.** Intent before effect. Drive idempotency by provider lookup. Terminal errors mapped for Restate. Outbox backoff in hours with jitter and a dead-letter alert. Inbound Telegram never dropped. | Crash matrix: `kill -9` after each of the 14 hops, and a 5xx from each provider. Exactly one of each effect, and the requester is told. | 2 to 4 weeks | 5.6 |
| 6 | **Delete the second system.** The 16 `Map`s, the in-memory branch, the in-class emulator, the 13 `NODE_ENV`/`VITEST` branches, fixture DNAs, the legacy workflow, duplicate paths, dead routes, dead tables, 50 one-off scripts. Fakes injected at the HTTP boundary. | `grep -rE "NODE_ENV|VITEST" apps/*/src packages/*/src` finds config only. `knip` reports nothing unused. Lines down 30% or more. Suite green on real Postgres only. | 3 to 6 weeks | 6.0 |
| 7 | **Typed contracts and decomposition.** `app.ts` becomes a composition root under 300 lines. Every route declares zod params, body, response and roles in one table. `Task` is a closed union. Desk client generated from contracts. `typescript-eslint` strict plus `noUncheckedIndexedAccess`. | A test enumerates every registered route and asserts 401 and 403. Lint in CI. `any` count 942 to 0 by ratchet. | 3 to 6 weeks | 6.5 |
| 8 | **Real host, real recovery, real eyes.** Off the Mac. WAL archiving and point-in-time recovery to object-locked off-site storage, Restate volume included. Structured logs with one trace id from intake to provider call. SLOs from production data. Alerts from outside the failure domain. | Timed drill by a second person from the runbook: destroy the host, service usable again within 4 hours having lost under 15 minutes. A synthetic outage pages. | 3 to 6 weeks | 7.0 |
| 9 | **Identity and privacy.** Per-person login with MFA. Tokens out of URLs, CSP on. Single-use expiring action links. Narrow grants in the repo bootstrap and a `TRUNCATE` guard. Retention, deletion and export. One model gateway that enforces egress policy. `LICENSE` and font licences. | One test per applicable OWASP ASVS 5.0 Level 2 requirement. A purge test. A lint rule banning provider hostnames outside the gateway. | 3 to 6 weeks | 7.4 |
| 10 | **Tests with teeth.** Install the coverage provider. Mutation testing on domain, QA and geometry. Property tests for wrapping, bidi and contrast. Contract tests against recorded provider responses. Playwright and axe on approve and deliver. Delete tautological and saved-evidence tests. | Coverage 90% on the pure core and the money path. Mutation score 70%. Flake rate under 0.5% over 50 runs. | 2 to 4 weeks | 7.8 |
| 11 | **Renderer correctness, and QA on what ships.** Line-shape bug, widow control, medium-aware type scale, story safe zones, overflow detection, UAX#9 bidi, one font policy, one contrast implementation. Judge the winner's Canva export. A brand-kit abstraction, a second and third client, and Arabic. | The `brief_13` slab fails QA. Round-trip: every delivered file opens in Canva with live text, correct direction and brand fonts. | 3 to 6 weeks | 8.2 |
| 12 | **Human ground truth.** A sealed hold-out you author, at least 50 briefs across three languages. At least 200 blind pairwise labels from three raters, two of them Sorani-reading designers. Calibrate the judge against them. | Judge true-positive and true-negative rates reported. Blind head-to-head against Canva AI, Adobe Express and a human designer, with confidence intervals. | months | 8.8 |
| 13 | **Earn it.** At least 100 consecutive real jobs, three clients, three languages. A quarter inside SLO with the error budget honoured. External penetration test and external staff-level code review. | The job ledger: first-pass approval rate, revisions per design, turnaround, cost. Both external reports. | months | 9.5+ |

Steps 1 to 4 are under three weeks and are the whole difference between a demo and a product. The curve flattens after step 8: from there the score is bought with humans and time, not code.

## What a true 10 means here

Not a bigger platform. A small system whose every claim is cheap to falsify and has survived the attempt. A brief in Sorani, Arabic or English becomes a brand-correct, natively editable design that a working designer rates professional. The bytes a human approved are the bytes delivered. The requester is always told the truth. Any crash, outage or deploy produces exactly one of each side effect. A second engineer can hold the code in their head.

Code alone cannot buy: human ratings, a comparative study, a quarter in production, an external review, client consent and provider data terms, a second human who can deploy and restore, a real host, and a change in how you accept work. Stop accepting a document named PASS. Require a failing check that turns green.

## Limits

No penetration test, exploit attempt, production query or live provider call. The four gap investigations had one investigator each and no adversarial verifier; I re-checked their load-bearing claims myself. Another agent edited and deployed from this checkout throughout, so line numbers drift. Competitor facts come from web research on 20 September 2026 and were not independently checked.
