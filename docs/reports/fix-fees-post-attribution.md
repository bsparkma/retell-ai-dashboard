# Fees posting: the attribution fix, and the guard that makes it stay fixed

**Branch** `fix/fees-post-attribution` (off `origin/develop`, 2a93610) ·
**Worktree** `C:\Users\beau\carein-wt\fees-postfix`

Root cause was established in
[`fees-post-failure-recon.md`](fees-post-failure-recon.md) and is not re-argued here. That
report is carried on this branch too: five source files cite it, and a comment pointing at
a document that is not in the tree is a comment nobody can follow.
In one line: `claimBatchForPosting` wrote `posted_by` while `posted_at` was still NULL,
which `fees_import_batch_posted_pair_check` forbids, so the job threw at its first
database write on the first post of every batch. **Fee posting had never written a fee.**

Four changes. The first fixes the bug; the other three are why it could ship.

---

## 1. The bug — a column, not a looser constraint

The constraint is right and is **untouched**. Half an attribution is worse than none,
because it looks like a whole one.

What was wrong is that two different facts shared one column:

| | |
| --- | --- |
| `post_requested_by` | who pressed Post. Known at claim time. **Not half of any pair**, so writing it early is safe by construction. |
| `posted_by` | who the completed post is attributed to. Meaningless before there is a `posted_at` to pair with — which is exactly what the CHECK says. |

`backend/migrations-tenant/1789300000000_fees_post_requested_by.js` adds the column.
No grant block: a grant follows the table, not its columns, and `fees_import_batch` was
granted by the slice-1 migration.

The claim now stamps the new column with the same first-claim-wins `COALESCE` and the
same `WHERE` shape:

```sql
UPDATE fees_import_batch
    SET post_requested_by = COALESCE(post_requested_by, $3)
  WHERE office = $1 AND batch_id = $2 AND posted_at IS NULL
```

and `markPosted` lands the pair together, taking the name from it:

```sql
SET status = 'posted',
    posted_at = now(),
    posted_by = COALESCE(post_requested_by, 'unknown'),
```

So a run that was resumed, or taken over after a SIGKILL, is **still attributed to
whoever pressed Post** rather than to whichever container picked it up. `'unknown'` is
reachable only for a batch posted before the column existed.

**The column is not backfilled.** Inventing a requester from `created_by` would put a
name against an act that person may not have performed. NULL is the honest answer to a
question that was never recorded.

### Where it surfaces

`getProgress` now returns `requestedBy`, and the `post_failed` panel says *"Started by
…"*. That state is precisely where `postedBy` is necessarily null — so before this, a
failed post named nobody, in the one situation where somebody needs to know who to ask.

---

## 2. The latent lie — a post that writes nothing is not a post

The recon found this while ruling out the wrong hypothesis. A batch whose codes matched
nothing walked the whole loop skipping every row, reached `markPosted`, and ended at
`status = 'posted'` with `rows_written = 0` — while the preview page told the office
their fees were in Open Dental. Nothing was.

That is the same lie as a failed post claiming nothing was written, pointed the other
way, and **worse for being the cheerful direction: nobody investigates a success.**

After the code map and before the first write, a run whose best possible outcome is an
empty schedule now fails with a reason that names the count:

> None of the 580 codes in this import exist in this practice's procedure list, so there
> is nothing that could be written. Check that this schedule is for the right office.

Two things it deliberately does **not** do:

- **One unmatched code is still not fatal.** A payer schedule can legitimately list
  procedures an office never performs; those are counted and named in the completion
  note. It is only *all* of them that says the two sides do not describe the same
  practice.
- **A row that is already written counts as landable.** A resume finishing off a partial
  run legitimately issues no new writes, and calling that "nothing could be written"
  would turn a successful post into a failure on its last step. Both cases are pinned.

---

## 3. Fakes refuse what Postgres refuses

`FakeFeesDb` enforced the batch table's CHECKs **only at INSERT**, and only the ones
slice 1 declared. Every UPDATE went through unchecked — which is precisely the gap the
defect walked through, since the offending statement was an UPDATE.

There is now one list, `BATCH_CHECKS`, carrying all fourteen constraints on
`fees_import_batch` with their real names, drawn from migrations `1788700000000` +
`1788900000000` (which *replaces* two of slice 1's) + `1789300000000`. It is applied by
`assertBatchChecks` after **every** mutation, insert and update alike, and raises the
message Postgres raises. Adding the next CHECK is one line in one place.

The bespoke inline checks in `insertBatch` were deleted in favour of it — an insert and
an update must be held to the same constraints, and the way to guarantee that is for
there to be only one description of them.

### The negative test the brief asked for

Reverting change 1 — restoring the old `SET posted_by = COALESCE(posted_by, $3)` —
turned **18 tests red**, across every suite that posts:

```
feesEditedRows.test.js   2  (the effective-fee pin, the resume comparison)
feesPosting.test.js     12  (both stars, the backup, both rollbacks, progress, …)
feesStalePost.test.js    4  (the takeover, the resume, the ready claim, the race)
```

each with the verbatim production error:

```
new row for relation "fees_import_batch" violates check constraint
"fees_import_batch_posted_pair_check"
```

**Before this change, that same revert produced zero failures.** Restored → 133/133.

The fake still *recognises* the old statement and executes it faithfully, on purpose: a
fake that refuses to parse a statement proves only that it has not been taught it, while
one that executes it and is then refused by the constraint proves the row is unstorable.
Deleting that branch would quietly weaken the guard this change is about.

### The fixture that encoded the bug

`feesStalePost.test.js`'s `seedBatch` was seeding `posted_by: 'manager@carein.ai'`
beside `posted_at: null` — the exact row the constraint forbids. The fixture encoded the
defect the tests were standing guard over, which is part of why they could not see it.
It now seeds a complete, valid row, and the takeover test asserts `post_requested_by`
survives while both halves of the posted pair stay empty.

---

## 4. The class — `backend/scripts/fees-verify-queries.js`

`rcm-verify-queries.js` is the sibling of this script and **would not have caught this
bug.** It proves statements *parse*, with parameters that match nothing. A CHECK is only
evaluated when a row is actually written, so a parse sweep is blind to the entire class.

So this one seeds and mutates. It walks a synthetic batch through the whole lifecycle —
insert (parsed **and** failed), the row-decision statements including both `edited` pair
directions, target, promote, **claim fresh**, **stale takeover**, backup (and its
idempotent second call), `recordWritten`, `getProgress`, `markFailed`, `markPosted`, the
rollback transitions, and a final coherence sweep — by calling **the real functions**, so
what is verified is the code the job runs rather than a copy of its SQL that could drift.

Three deliberate properties:

- **No Open Dental.** `ensureBackup`'s one outbound read is stubbed on the writer
  module's namespace — the same seam the unit tests use, and the reason `odFeesWrites` is
  required as a namespace rather than destructured. Nothing reaches a practice.
- **One transaction, always rolled back.** Unlike the RCM sibling this really does write.
  `importStore.insertBatch` runs its own `BEGIN`/`COMMIT`, which passed through verbatim
  would have committed the *outer* transaction and left synthetic batches in whatever
  database it was pointed at. Nested transaction control is translated to savepoints, so
  the inner atomicity is preserved exactly and the outer `ROLLBACK` is the only thing
  that decides what is kept: nothing. **Verified — the database held 0 rows afterwards.**
- **No savepoint per step.** The steps are a sequence; letting later ones run against a
  state an earlier one failed to produce turns one real failure into a page of misleading
  ones. The first failure stops the walk.

`postJob` now exports `recordWritten`, `markFailed` and `markPosted` for it, with a note
saying why they are not part of the module's interface for anything else.

Wired into `build-test.yml` immediately after `rcm-verify-queries`.

### It was run for real, not left to CI

Against an ephemeral **Postgres 16** matching the CI service, with the control and tenant
migrations applied as CI applies them:

```
18 lifecycle step(s) accepted by the migrated schema     exit 0
```

And with change 1 reverted:

```
FAIL postJob.claimBatchForPosting (fresh, from ready):
  new row for relation "fees_import_batch" violates check constraint
  "fees_import_batch_posted_pair_check"                 exit 1
```

**That is the whole point of the script**, demonstrated rather than asserted: it stops
at the exact statement, with the exact message staging produced, and exits non-zero so
CI fails.

---

## Tests

```
backend:     node --check server.js → OK
             node --test            → 2709 tests, 0 fail, 3 skipped
dashboard:   pnpm run check         → clean (strict, no `any`)
             pnpm run test          → 1965 passed, 126 skipped, 0 failed
verifier:    18/18 against a real migrated Postgres 16, 0 rows left behind
```

New: `backend/routes/fees/feesPostAttribution.test.js` (6) —
the claim leaves the pair empty; a completed post names the requester; a **second
claimant does not become the author** (driven through `claimBatchForPosting` directly,
because the HTTP harness binds one identity for the life of the app and an HTTP resume
would re-run the `COALESCE` with the same email and prove nothing); the zero-match
failure; one unmatched code still posting; and a resume of an already-written batch
completing rather than failing as empty.

---

## What this does not do

1. **No backfill, and no repair of the stuck staging batch.** Batch
   `6fc7f407-…` is still `post_failed` with `rows_written = 0` and no snapshot.
   Nothing was written to Open Dental, so there is nothing to undo — but the batch cannot
   be rolled back (correctly: `NO_BACKUP`) and will need to be posted again once this
   ships. Re-posting is safe: it is `post_failed`, which the claim accepts.
2. **The route's own statements are covered by the verifier but are still copies.** The
   three row-decision statements and the target/promote pair live inline in
   `routes/fees/posting.js`, and the script holds its own copies of the text. That is
   weaker than the postJob steps, which call the real functions, and a route change could
   drift from the copy without CI noticing. Exporting them as constants the handler uses
   would close it; it was out of this change's scope.
3. **`fees_import_row`'s CHECKs are enforced in the fake only where slice 3 and 4 added
   them.** The batch table is now complete; the row table is not held to the same
   one-list treatment. Same argument applies to it, and it is the obvious next tidy.
4. **The procedure-code mapping is still unverified against a real practice** — it has
   never run. That was true before this change and remains true; the new zero-match
   failure means a broken mapping now reports itself loudly instead of posting nothing
   and calling it success.
