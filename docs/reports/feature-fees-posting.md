# Fee Schedule module — Slice 3: posting, backup and rollback

**Branch** `feature/fees-posting` (off `origin/develop`, carrying merged #192 and #195) ·
**Worktree** `C:\Users\beau\carein-wt\fees-posting`

Slice 1 parsed a payer file. Slice 2 showed it. Slice 3 writes it into a
practice's Open Dental database — behind a human Post click, with a snapshot
taken first and a rollback that tells the truth about what it can and cannot
undo.

---

## 1. STEP 0 — Discovery: what the Open Dental API actually offers

Verified against the published spec on **2026-09-23**, before any code was
written.

| Endpoint | Verbs | Notes |
| --- | --- | --- |
| `/feescheds` | **GET**, **POST**, **PUT** | POST requires `Description` + `FeeSchedType` (`Normal`, `CoPay`, `OutNetwork`, `FixedBenefit`, `ManualBlueBook`). PUT takes `Description`, `IsHidden`, `IsGlobal`. |
| `/feescheds/{n}` | **no DELETE** | **Not documented, not available.** |
| `/fees` | **GET** (`?FeeSched=`, `?CodeNum=`, `?ClinicNum=`, `?ProvNum=`), **POST** | POST requires `Amount`, `FeeSched`, `CodeNum`; `ClinicNum`/`ProvNum` default 0. |
| `/fees/{FeeNum}` | **PUT** (`Amount`), **DELETE** | Both supported. Fees in a `FeeSchedGroup` cannot be created, updated or deleted. |
| `/procedurecodes` | **GET**, POST, PUT | **No `ProcCode` filter.** Only `DateTStamp`. |

Global conventions: pagination is `Limit`/`Offset`, **hard max 100 per request**
on the cloud API; throttle is **1 request/second per CustomerKey** (shared, not
per developer key), with `429` + `Retry-After`; `504` after 60 seconds.

**The API can create a fee schedule and write fees, so this slice proceeded.**
Four consequences shaped everything:

1. **A new schedule cannot be uncreated.** Rollback deletes the fees and then
   `PUT IsHidden: true`. The shell remains. This is stated in the confirm dialog
   *before* the click, in the rollback's result, and in three code headers.
   Not papered over.
2. **`POST /fees` needs a `CodeNum`, not a `ProcCode`**, and the API offers no
   lookup. The job pages the whole `/procedurecodes` table **once per run**
   (~13 requests) instead of once per fee, which would have doubled a 500-fee
   post.
3. **Everything pages at 100.** Every list pages to exhaustion, with a
   `MAX_PAGES` circuit breaker — a sibling RCM spike found Open Dental list
   filters are sometimes *silently ignored* rather than refused, and a server
   ignoring `Offset` would otherwise loop forever.
4. **The `FeeSched` filter is not trusted.** Results are filtered again locally
   on `FeeSched`, and a mismatch is surfaced as `ignoredFilter`. A "backup" that
   quietly contained the whole practice's fees would restore catastrophically.

---

## 2. The one writer file

`backend/services/fees/odFeesWrites.js` is the only file in the module that
touches Open Dental — **reads included**, because putting the reads elsewhere
would mean two files naming the seam, which is the same as no allow-list.

`feesNoOdAccess.test.js` became that one-file allow-list, exactly as RCM's and
hygiene's did. What did **not** change: every other file is still forbidden the
seam, the routes reach Open Dental only through the writer, and **the `mysql2`
ban stays absolute and is explicitly not subject to the allow-list**.

It also grew a test that the module cannot auto-post: the upload route may not
reference the job, and no file may `setInterval`/`cron.schedule`.

### One transport change

`config/openDental.js`'s `apiDeleteRaw` was restricted to `/perioexams/{n}`.
Its own header said *"a second resource that needs a delete is a second,
reviewed edit to this pattern — not a parameter."* This is that edit: it is now
an enumerated `DELETABLE_PATHS` list of two exact patterns, each naming its one
caller. `/feescheds/{n}` is **deliberately not on it** — the endpoint does not
exist, and a guard admitting it would let a rollback attempt something that can
only 404 while looking like it might have worked.

---

## 3. Review-then-send, and the gate

**There is no path from parsing a file to writing a fee that does not pass
through a human pressing Post.** No scheduler, no webhook, no "auto-post when
clean" flag; the upload route cannot reach the job. A guard test asserts it.

**A new schedule is created on the Post click, not when it is named.** Naming a
target is a decision; creating one is a write. `setTarget` stores the name and
`od_feesched_num` stays null until the click — asserted.

**The warned-rows gate is server-side, and checked twice.** The route re-derives
it from the rows, and the job re-checks after claiming the batch, because
minutes pass between the click and the first write. The gate is a predicate —

```
blocking  ⟺  jsonb_array_length(parse_warnings) > 0 AND decision = 'pending'
```

— not a checklist, so a clean batch needs no clicks and a hundred-row file with
two flagged rows needs exactly two. Decisions are `accepted` / `excluded` /
`pending`, each with `decided_by` and `decided_at`; the database refuses to
store a FeeNum on an excluded row.

**The confirm dialog states office, target schedule, row count and total** —
the four facts somebody would want back if it went to the wrong place. Roland
and Riley hold different contracts with the same payers, so naming the office is
not decoration.

---

## 4. `post_failed` can never mean "nothing was written"

`rows_written` is `NOT NULL DEFAULT 0` on every batch — RCM's W-21 lesson built
in from the start rather than retrofitted. A run that dies at row 300 of 500 has
put 299 fees into a live database; a status that only says "failed" is how
somebody concludes nothing happened and posts again.

It is **derived from the rows** (`COUNT(*) WHERE od_fee_num IS NOT NULL`), never
incremented, so it cannot drift from what it counts. The UI shows
`299 of 500 fees were already written` plus what to do about it, and the
preview-only banner disappears in that state — asserted in both suites.

---

## 5. Backup, and the two rollbacks

`fees_od_backup` — office NOT NULL with a CHECK, composite FK to
`(batch_id, office)`, `UNIQUE (batch_id)`, and the `carein_app` GRANT block in
the same migration.

Taken **before write number one**, and idempotent by that UNIQUE, so a resume
finds the first run's snapshot rather than taking a second that would capture
our own partial writes. An empty snapshot is valid and is not the same as no
snapshot: the row's existence is what records that we looked.

| Target | Rollback |
| --- | --- |
| **Existing** schedule | Delete every fee this batch wrote, then restore the snapshot's amounts for codes it overwrote. A code the batch *added* stays deleted, which is correct. |
| **New** schedule | Delete every fee this batch wrote, then **hide** the schedule. **The shell remains** — the API has no DELETE for `/feescheds`. Said in the confirm before the click and in the result after. |

A fee Open Dental refuses (a `FeeSchedGroup` member) is recorded and the run
continues, rather than aborting and leaving the rest in place with no record.

---

## 6. The throttle-aware job

The credential is 1 req/sec **shared across every module**, so a 500-fee post is
~20 minutes during which that office's voice, RCM and hygiene Open Dental work
queues behind it. Hence: a background job, persisted per-row progress, a
progress endpoint the UI polls every 2s, and a UI that states the throttle so a
screen that looks stuck does not get reloaded and re-posted.

Every call passes `minIntervalMs: 1200` and `module: 'fees'` to the existing
transport slot rather than importing RCM's pacer — the slot is already shared
per credential and already handles 429 backoff.

**Concurrency** is a conditional UPDATE (`status IN ('ready','post_failed')`),
not a SELECT-then-UPDATE. The in-process Map is advisory only and documented as
such: a Map cannot be the guard because a Map is per-process.

**Resume verifies by read.** A row with no stored FeeNum is *not* assumed
unwritten — the crash could have landed between Open Dental's commit and ours,
and that is the only window in which a naive resume creates a second fee for a
code that already has one. `writeFee` is create-or-update as well, so a missed
verification degrades to an update rather than a duplicate.

**Every write is read back** and compared **in cents**. A 200 is not proof; the
sibling module has a documented endpoint that returns 200 and changes nothing.

---

## 7. Permissions

`rcm_biller` gains **`fees.read` only** (ratified, Beau 2026-09-22). Slice 2
deferred this; `rcmGuard.test.js`'s pin is **kept**, with the exception stated
at the assertion and `fees.write` explicitly asserted *absent*, rather than the
guard being deleted — a guard removed to permit one change stops guarding the
other twenty. No client `ACTIONS` change was needed.

---

## 8. Tests

```
backend:     node --check server.js → OK
             node --test            → 2640 tests, 0 fail, 3 skipped
dashboard:   pnpm run check         → clean (strict, no `any`)
             pnpm run test          → 1889 passed, 125 skipped, 0 failed
```

New: `feesPosting.test.js` (23, backend) and `fees-posting.test.tsx` (19,
dashboard), plus the rewritten `feesNoOdAccess.test.js` (10) and an extended
`odApiDeleteRaw.test.js` (5).

**Negative-tested, as the brief required.** Disabling the server-side
warned-rows gate *and* the verify-by-read turned exactly three tests red — the
two stars plus the decision-reset test — and nothing else; restoring brought
them back. They fail when the behaviour is removed rather than passing
vacuously.

**One flake, dismissed.** On two of three full backend runs a *different*
file-level failure appeared (`sendToTc.test.js`, then `platform.test.js`) with
no failing assertion inside; both pass in isolation (18/18, 20/20). This is the
known Node 22 runner parent-decode bug already recorded for this repo. CI shards
the backend suite, which is the existing mitigation.

---

## 9. Staging validation — the safety rule, unchanged

Staging talks to **real Roland Open Dental**. Any validation post must go into a
new schedule named exactly **`ZZ CAREIN TEST - DO NOT USE`**, attached to no
insurance plan. An unattached schedule reprices nothing, which is what makes a
mistaken post recoverable; `createFeeSchedule` never attaches one, and v1 writes
fees only — no carrier creation, no plan creation, no plan attachment (ratified).

**Never post into a schedule that exists in real use.** Note the asymmetry
before doing so: rolling back a *new* schedule leaves a hidden empty shell,
which is harmless; rolling back an *existing* one restores from the snapshot,
which is correct but touches a schedule the practice relies on.

`OPENDENTAL_WRITE_DISABLED=true` blocks every write through the transport and is
the recommended setting for a dev box.

---

## 10. Open items for you

1. **The `FeeSchedGroup` refusal is untested against a real practice.** Open
   Dental refuses create/update/delete for fees in a group. It is handled — the
   message is passed through and the rollback continues — but no fixture in the
   corpus exercises it, because it depends on practice configuration. Worth one
   look at whether Roland or Riley uses fee schedule groups before the first
   real post.
2. **Duplicate `ProcCode` rows take the first CodeNum.** Open Dental permits two
   rows with the same `ProcCode` (a hidden legacy one beside a live one). The
   sweep takes the first, which is at least stable across runs; picking the
   later would silently move fees. If a practice has these, the right answer is
   probably to prefer the non-hidden one — but that needs a real example.
3. **Rollback is synchronous**, unlike the post. It is bounded by what the batch
   wrote, so a failed post that stopped at row 12 has twelve fees to remove. A
   *fully* posted 500-fee schedule is the slow case; if that becomes ordinary it
   should become a job too.
4. **Codes the practice does not have are skipped, not failed.** A schedule can
   legitimately list procedures an office never performs. They are counted and
   named in the completion note so the total reconciles, but they do not stop
   the run. Confirm that is the behaviour you want on a real payer file.
