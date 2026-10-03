# ADR and Migration Numbering

Two agents (Claude and Codex) add ADRs and migrations on separate branches and worktrees of one
repository. Numbers are taken with a tool, never by looking at your own checkout. Decision and reasons:
[ADR-293](../adrs/293_numbers_taken_across_branches_and_worktrees.md).

## Taking a number

```bash
git fetch                                         # see the other agent's pushed branches
pnpm next-number adr --owner claude               # or --owner codex; prints e.g. 293
pnpm next-number migration                        # prints e.g. 090

# hold it at once, then commit the stub so the other agent's next scan sees it
pnpm next-number adr --owner codex --reserve next --title "customer story constraints"
pnpm next-number migration --reserve next --title "customer acceptance downloads" --owner codex
git add adrs/300_customer_story_constraints.md && git commit -m "docs(adr): reserve ADR-300"
```

(`pnpm next-number` is `tsx scripts/next_number.ts`.) A number counts as taken if any file carries it in
this working tree, on any ref (local or remote branch, tag, stash, checkpoint ref), or on disk in any
worktree of the repository, committed or not. Only the number goes to stdout; how it was found goes to
stderr.

## Rules

- **ADRs** come from your own block in [adrs/NUMBER_BLOCKS.json](../adrs/NUMBER_BLOCKS.json):
  Claude 270–299 then 400–499, Codex 300–399 (the Codex block and Claude's second block are proposals to
  confirm with Codex). The tool gives one past the highest number used in your first unfinished block. When
  a block is used up the tool says so; add the next block to the registry by commit.
- **Every ADR from 293 on declares its owner** in its header: `**Owner:** codex` (or `claude`), matching
  the block.
- **Migrations** are one shared, gap-free sequence for both agents. 083–089 are applied in production;
  the next is 090. Never renumber or edit a migration once applied anywhere: production stores its name and
  checksum.
- **A reservation stub is temporary.** An ADR stub is replaced by the decision. A migration stub raises
  when run, so it cannot be deployed by accident; write the migration before merging.
- **On a collision** (two files with one number after a merge), renumber the one that was not yet
  merged into the release line, with a new number from the tool, and update its references.

## What is checked

`scripts/check_numbers.ts` runs in `pnpm lint` (and so in CI) and in the pre-commit hook (when the checkout
has `node_modules`). It reads only this checkout's files and fails on:

- two ADR files with one number, or two forward migrations with one number;
- a gap in the migration sequence, or a `.sql` file the migration runner would skip (`_down.sql`
  rollbacks are not part of the sequence);
- an ADR numbered 270 or above that lies in no block, declares another owner than its block's, or, from
  293, declares no owner.

Historical exceptions are listed under `grandfathered` in the registry and printed as warnings: the ADR 200
pair (and the 148 pair on stale branches), and Codex's 276–279 and 292 inside Claude's block. Reservation
stubs still in the tree are printed as notes.

The scan is only as complete as the local repository: a branch the other agent has neither pushed nor
checked out in a worktree here is invisible to it. That is why a number is reserved and committed before
the work that uses it, not after.

## Codex confirmation —2026-10-03

Codex accepted the proposed owner blocks during live5f3aec67 integration; the
registry is confirmed. Its unreleased handoff ADR293 is now ADR300; runtime
behaviour is unchanged and original source559fda76 evidence is preserved. No
applied migration was renumbered or changed.
