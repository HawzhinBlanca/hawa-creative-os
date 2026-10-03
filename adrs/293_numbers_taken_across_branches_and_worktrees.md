# ADR-293: ADR and Migration Numbers Are Taken Across Every Branch and Worktree

**Date:** 2026-10-03
**Owner:** claude
**Status:** Accepted (branch `claude/numbering` from `claude/release-3` b56020bf; developer tooling only, nothing deployed)
**Requirements:** NFR-012 (core logic covered by tests). No product requirement changes.
**Related:** ADR-281 (CI gives the same verdict as a clean checkout). Procedure: [docs/NUMBERING.md](../docs/NUMBERING.md).

## Context

Claude and Codex work on separate branches and worktrees of one repository. Each took "the highest number
I can see, plus one" from its own checkout, so both took the same number whenever the other's branch had
not been merged yet. A scan of every ref and worktree on 2026-10-03 found these numbers carried by two
different files: ADR 038, 148, 200, 256, 261, 262 and 263, and migrations 023 and 069. ADR 140 and 285
were claimed twice as well and renumbered before the second file was committed anywhere (285 by two
Claude branches; the later one became 286), so the scan no longer shows them. A block of ADR numbers per agent was agreed
on 2026-10-02 (Claude 270–299), but it lived only in agent memory: Codex then took 276–279 and 292 inside
it. The same scan found 292 on `codex/hawzhin-app-integration`, so a Claude ADR written today as "292"
would have collided again.

Migration numbers matter more than ADR numbers. `discoverMigrations` refuses a gap, and production
records each applied migration's name and checksum (`hawa.schema_upgrades`), so two branches that both
add migration 090 cannot both be deployed, and a renumbered applied migration is a checksum failure.

## Decision

1. **A number is free only if nothing anywhere carries it.** `scripts/next_number.ts` lists the numbered
   files in `adrs/` and `packages/db/migrations/` in the working tree, on every ref (`git for-each-ref`:
   local and remote branches, tags, stash, an agent's checkpoint refs), at every worktree's HEAD, and on
   disk in every worktree (`git worktree list --porcelain`), untracked files included. It resolves each
   ref's two directories to tree ids in one `git cat-file --batch-check` and reads each distinct tree once
   with `git cat-file --batch`: 258 refs and 77 worktrees take under two seconds.
2. **ADR numbers come from owner blocks** in `adrs/NUMBER_BLOCKS.json`, a committed file both agents read.
   The next ADR for an owner is one past the highest number used anywhere in its first unfinished block.
   A hole is never refilled: it may be a number someone used and dropped from every ref.
3. **Migrations are one shared sequence**, starting past `appliedInProductionThrough` (89: 083–089 are
   applied in production) and past every migration number seen anywhere.
4. **A reservation is a committed stub.** `--reserve next|<n> --title <slug>` writes `adrs/NNN_slug.md`
   (with `**Owner:**`) or `packages/db/migrations/NNN_slug.sql`. Committing it is what makes the number
   visible to the other agent's next scan. A migration stub raises an exception when run, so a deploy that
   reaches an unfilled reservation stops before recording a checksum for it.
5. **`scripts/check_numbers.ts` checks the checkout's own files** and fails on: two files with one ADR
   number; two forward migrations with one number; a gap in the migration sequence (the rule is
   `discoverMigrations`', now `packages/db/src/migration-files.ts`, so `_down.sql` files never count); a
   `.sql` name the runner would skip; an ADR from 270 on that lies in no block, or declares an owner other
   than its block's, or (from 293 on) declares no owner. Historical exceptions are listed in the registry
   and printed as warnings: the ADR 200 and 148 pairs, and Codex's 276–279 and 292 in Claude's block.
   It reads only files on disk (about 0.5 s), so it runs in `pnpm lint` (and so in CI) and in the
   pre-commit hook when the checkout has `node_modules`.

The blocks registered now: Claude 270–299 (active), Codex 300–399 and Claude 400–499 (proposed). Codex's
history, inferred from commit trailers, is recorded in the registry and must be confirmed with Codex.

## Consequences

- The next Claude ADR is 293 (this one), not 292; the next Codex ADR is 300; the next migration is 090.
- A new ADR from 293 on needs an `**Owner:** claude|codex` line, or lint fails. Codex has to adopt this:
  the lead tells Codex about docs/NUMBERING.md, since AGENTS.md is shared space this branch does not edit.
- The scan sees only what the local repository knows. Run `git fetch` first; a branch the other agent has
  neither pushed nor checked out in a worktree of this repository is invisible until it is.
- `check_numbers` cannot see a collision with another branch; the merge that brings the two files together
  can, and fails lint there.

## Verification

`scripts/test/numbering.test.ts` (temporary git repositories): a number committed only on another branch
or a remote-tracking branch is skipped; an untracked file in another worktree holds its number in both
directions; a reservation is seen by the next scan and the check, and refuses a taken number, another
owner's block and a migration gap; a migration gap, a duplicate migration and a misnamed `.sql` fail;
`_down.sql` files are ignored; grandfathered duplicates and out-of-block files pass while new ones fail;
this checkout passes.
