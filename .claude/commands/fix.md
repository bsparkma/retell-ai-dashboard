---
description: Build loop — fix what Beau (or the PM review) found in a shipped slice, then stop.
---

Beau / the PM found: $ARGUMENTS

Read `CLAUDE.md` first — §8 (the build loop) governs this command.

1. Identify the slice being fixed (its queue number and short name) from the message or
   the most recent loop report. Branch **`fix/<slice>-<short>`** off fresh
   `origin/develop` in its own worktree:
   ```bash
   git -C "C:/Users/beau/carein cursor dashboard" fetch origin
   git -C "C:/Users/beau/carein cursor dashboard" worktree add "C:/Users/beau/carein-wt/fix-<slice>-<short>" -b fix/<slice>-<short> origin/develop
   ```
   Never commit onto the original slice branch — a merged branch is dead.
2. Fix **only** what is listed. Anything else is a follow-up line in the report.
3. **Same gates** on the merge tree (CLAUDE.md §8.4, the real commands; flakes re-run in
   isolation and stated; never edit a test to pass).
4. Report at `docs/reports/fix-<slice>-<short>.md`: what was wrong, what changed, the
   evidence, click-by-click re-test steps. Commit it.
5. **Same lane rules:** run `node .claude/scripts/classify-lane.mjs`, apply §8.3 by
   judgment; then the **same `reviewer` agent** (give it this message as the acceptance
   list) — max 2 fix rounds, then `BLOCKED slice <n>: <reason>` alert and stop. Lanes
   must agree or it is RED. **A fix that changes an EXISTING test's assertions is RED.**
6. **Same two-lane `shipper`.** STOP after its alert.

Never: merge yourself, touch `main`, run `az`, flip an env var or entitlement, or put
patient data anywhere.
