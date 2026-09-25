# Fees post failure — recon

**Read-only.** No code changed, no migration written, no Open Dental call made, no
staging UI touched. Branch `recon/fees-post-failure` off `origin/develop` (2a93610,
carrying #197 and #199), worktree `C:\Users\beau\carein-wt\fees-recon`.

**Incident.** Staging, roland. Batch `6fc7f407-6ff0-4aed-ac92-bd071b92bdd0`
(`file-1761616583120-28132044.pdf`, 580 rows, 5 edited, no unresolved warnings) posted
into **existing** schedule `Test-PaylessDental`, FeeSchedNum 103. Result `post_failed`,
`rows_written` 0 of 580, and:

```
post_error = 'Unexpected failure: new row for relation "fees_import_batch"
              violates check constraint "fees_import_batch_posted_pair_check"'
```

Roll back refuses with `NO_BACKUP`.

---

## Summary

**The hypothesis in the brief is not what happened, and the logs rule it out
independently.** The run never reached the write loop, the procedure-code sweep, or even
the backup. It died on the **second statement of the claim**, which is the first database
write the job makes.

`claimBatchForPosting` stamps attribution with

```sql
UPDATE fees_import_batch
    SET posted_by = COALESCE(posted_by, $3)
  WHERE office = $1 AND batch_id = $2 AND posted_at IS NULL
```

Its own `WHERE` guarantees `posted_at IS NULL`, and its `SET` makes `posted_by` non-null.
That is precisely the row `fees_import_batch_posted_pair_check` forbids.

**This fires on every first post of every batch.** It is not intermittent, not
data-dependent, and has nothing to do with this file, this schedule, or the edited rows.
Fourteen days of staging logs contain no fee write of any kind, which is consistent with
this being the first real post attempt the module has ever made — and with it having no
chance of succeeding.

**Open Dental is untouched.** Evidence in §4.

---

## 1. The predicate, and which statement violates it

`backend/migrations-tenant/1788900000000_fees_posting.js:176-179`:

```js
// Half an attribution is worse than none: it looks like a whole one.
pgm.addConstraint('fees_import_batch', 'fees_import_batch_posted_pair_check', {
  check: '(posted_by IS NULL) = (posted_at IS NULL)',
});
```

**`1789100000000_fees_edited_rows.js` does not touch it, or `fees_import_batch` at all** —
that migration only alters `fees_import_row` (the `edited` decision and
`edited_fee_cents`). The review-UX slice is not implicated.

### Every UPDATE to `fees_import_batch` in `services/fees/postJob.js`

| # | line | statement | touches the pair? | verdict |
| --- | --- | --- | --- | --- |
| 1 | 291 | the claim: `status='posting'`, `posting_started_at`, `post_error` CASE | no | safe |
| 2 | **343** | **`SET posted_by = COALESCE(posted_by, $3) WHERE … posted_at IS NULL`** | **sets `posted_by` only** | **VIOLATES** |
| 3 | 558 | `recordWritten`: derived `rows_written` | no | safe |
| 4 | 571 | `markFailed`: `status='post_failed'`, `post_error` | no | safe |
| 5 | 584 | `markPosted`: `posted_at=now()`, `posted_by=COALESCE(posted_by,'unknown')` | **both, one statement** | safe |
| 6 | 786 | rollback: `rolled_back_at` + `rolled_back_by` | both, one statement | safe (different pair) |

Statement 2 is the only one that can produce a violating row, and it does so
unconditionally:

```
posted_by IS NULL  →  FALSE      (the SET just made it non-null)
posted_at IS NULL  →  TRUE       (the WHERE selected only such rows)
FALSE = TRUE       →  false      →  constraint violation
```

`markPosted` is the mirror image and is why the design reads as intended elsewhere: it
sets **both** halves in one statement, so the pair is never momentarily half-written. The
attribution stamp was split out of that pattern to make a resume or takeover preserve the
original author — correct intent (`postJob.js:339-341`), wrong mechanism, because it
writes one half of a pair the schema requires whole.

### Why the failure looks the way it does

`runPost`'s numbered steps are: **1** claim (line 409) → **2** back up (434) → **3** the
procedure-code map (445) → **4** the write loop (456) → **5** `markPosted` (529).

The throw happens inside step 1. It propagates to the catch at line 538, which writes
`post_failed` with the message prefixed `Unexpected failure: ` — matching the reported
`post_error` exactly. `rows_written` was never touched, so it is still its column default
of 0. Steps 2–5 never ran.

### Why no test caught it

`FakeFeesDb` models this statement as `b.posted_by = b.posted_by || params[2]`
(`backend/routes/fees/feesTestUtils.js:461`) and enforces no pair rule. Nothing in the
backend suite references `posted_pair_check` — `grep -rn "posted_pair" backend/
--include=*.test.js` returns nothing. The fake enforces the row table's CHECKs (office,
proc code, fee cents, excluded-unwritten, and the `edited` pair) but none of the batch
table's pair CHECKs, so every posting test passed against a fake that permits exactly the
row Postgres refuses. This is a gap in the harness, not bad luck.

---

## 2. The "all 580 rows were skipped" hypothesis: refuted, twice

**The code cannot produce the observed row from that path.** If the code map matched
nothing, all 580 rows take the `skipped.push(row.proc_code); continue;` branch, the loop
issues no write, and `markPosted` runs. `markPosted` sets `posted_at` and `posted_by` in
one statement, so the pair stays intact; `rows_written >= 0 AND rows_written <= row_count`
holds at 0; `target_check` holds. **The UPDATE would succeed.**

What that path produces instead is arguably worse and is a **separate latent defect**: a
batch at `status='posted'`, `rows_written = 0`, a completion note reading "580 codes not in
this practice's procedure list", and a preview page whose banner says the fees have been
written to Open Dental. Nothing in the job or the route treats "wrote nothing at all" as a
failure. That did not happen here, but it can, and it is in the proposed fix list.

**The logs refute it independently.** That path requires a paged `GET /procedurecodes`
sweep (~13 requests) and, before it, the backup's `GET /fees?FeeSched=103`. Neither
appears — see §4. It also requires step 2 to have completed, which would have left a
`fees_od_backup` row, and rollback would then not say `NO_BACKUP`. The `NO_BACKUP` symptom
alone is enough to place the failure before step 2.

---

## 3. `NO_BACKUP` on an existing schedule — the empty-schedule theory is also wrong

`ensureBackup` (`postJob.js:360-384`):

```js
let rows = [];
if (!isNew) {
  const read = await od.listFeesInSchedule(office, feeSchedNum);
  if (!read.ok) return read;
  rows = read.fees;
}
await pool.query(
  `INSERT INTO fees_od_backup
     (office, batch_id, od_feesched_num, is_new_schedule, rows, row_count, taken_by)
   VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
  [office, batchId, feeSchedNum, isNew, JSON.stringify(rows), rows.length, actor]
);
```

**The INSERT is unconditional.** An existing schedule that holds zero fees stores an
explicit empty snapshot — `rows = []`, `row_count = 0` — and the row's existence is what
records that we looked. That is deliberate and documented in the migration: *"EMPTY IS A
VALID SNAPSHOT and is not the same as no snapshot… The row's existence is what says we
looked."* The old empty test schedule is a red herring; had the backup step run, schedule
103 being empty would have been fine.

`NO_BACKUP` here means exactly one thing: **`ensureBackup` never executed**, because the
claim threw first. The rollback's refusal is correct and honest — there genuinely is no
snapshot, because nothing was ever written to need one.

---

## 4. Staging logs

Read-only, `az account set --subscription "Azure subscription 1"`, workspace
`log-carein-staging` (`8474c8cc-8a77-4da3-aac2-4e06636e07ee`), via
`az rest POST /v1/workspaces/{id}/query`. App `ca-carein-backend`, `rg-carein-staging`.

### The run

```
2026-09-24T15:19:41.220Z  [OD API] GET /feescheds
2026-09-24T15:19:42.147Z  [OD API] Response: 200 /feescheds
2026-09-24T15:19:53.206Z  "POST /api/fees/imports/6fc7f407-…/post HTTP/1.1" 202
                          ── nothing at all ──
2026-09-24T15:20:05.259Z  "POST /api/fees/imports/6fc7f407-…/rollback HTTP/1.1" 409
```

**Between the 202 and the next console line at 15:26:22 there is no output whatsoever** —
no `[OD API]` request, no error, no stack. The 15:26:22 line is a container restart
(`[secrets] credential: …`, `Server running on port 5403`), unrelated and ~6.5 minutes
later.

The silence is expected and is not missing evidence: `runPost` catches its own throw,
`await`s `markFailed`, and **returns** a `fail` object rather than re-throwing, so the
route's `.catch(err => console.error('[fees] post job crashed:', …))` never fires. The
failure was recorded in the database and nowhere else. That is why there are no `[fees]`
lines to quote — there were none to write.

**Rollback 12 seconds after the post.** A 580-fee run is ~23 minutes at two throttled
requests per fee. Twelve seconds is consistent only with an immediate failure.

### No fee traffic in fourteen days

```
ContainerAppConsoleLogs_CL | where TimeGenerated > ago(14d)
| where ContainerAppName_s == 'ca-carein-backend'
| where Log_s contains '[OD API]'
| where Log_s contains 'fees' or Log_s contains 'procedurecode'
```

16 rows, **all of them `GET /feescheds` and its 200** (8 request/response pairs on Sep 23
and Sep 24 — the target picker refreshing). In fourteen days there is:

- no `GET /fees?FeeSched=…` → the backup read has never run
- no `GET /procedurecodes` → the code-map sweep has never run
- no `POST /fees`, no `PUT /fees`, no `DELETE /fees` → **no fee has ever been created,
  updated or deleted by this module**

`[OD API]` is emitted by the shared transport's request interceptor
(`backend/config/openDental.js:297`), which every `odFeesWrites` call passes through — the
`GET /feescheds` lines above prove the writer's own calls log this way. Their absence is
therefore evidence, not a logging gap.

**There is no procedure-code mapping defect visible here, because the mapping never ran.**
Nothing in the logs speaks to `ProcCode` vs `procCode`, paging arithmetic, or code counts.
Whether that lookup works remains **unknown and untested against this practice** — it is
the next thing that will be exercised once the claim is fixed, and it should be watched on
the first successful run.

### Open Dental state: untouched

Stated from the record, **not** by calling Open Dental:

- `rows_written = 0` — and it is derived (`COUNT(*) WHERE od_fee_num IS NOT NULL`), never
  incremented, so it cannot under-report writes that happened.
- No write verb reached Open Dental in fourteen days of logs.
- The job failed before step 2, so it never even read schedule 103, let alone wrote to it.

**Schedule 103 `Test-PaylessDental` holds exactly what it held before the click.** No fee
was created, none was updated, and the schedule itself was not created by this run (it
pre-existed). Nothing needs undoing, which is also why `NO_BACKUP` is the right answer
rather than a problem to work around.

---

## 5. Proposed minimal fix list — NOT IMPLEMENTED

None of this is written. Each item wants a reviewed follow-up prompt.

### (a) The root cause — write the pair whole, or not at all

`claimBatchForPosting`'s attribution stamp must stop writing half a pair. Two shapes worth
weighing:

1. **Fold the attribution into the claim's own UPDATE** as `posted_by = COALESCE(posted_by,
   $n)` — one statement, and `posted_at` stays NULL, so the pair is still half-written.
   *This does not work.* Noting it because it is the obvious first move and it is wrong.
2. **Do not stamp `posted_by` at claim time at all.** Record who authorised the post in a
   separate column that is not half of a pair — `post_requested_by`, say — and let
   `markPosted` continue to set the `posted_*` pair together at the end. This keeps the
   constraint's promise ("half an attribution is worse than none") intact and still
   preserves the original author across a resume or takeover, which is what the current
   code was reaching for.
3. **Or relax the constraint** to `posted_at IS NULL OR posted_by IS NOT NULL`. Cheaper,
   but it gives up the guarantee the constraint was added for, and the migration's comment
   argues that guarantee well. Prefer 2 unless there is a reason not to.

Whichever shape: **a test must assert the pair**, and `FakeFeesDb` must enforce both batch
pair CHECKs the way it already enforces the row ones. The defect is not that the code was
wrong — it is that nothing could tell.

### (b) Zero writable rows must never become `posted`

Today a run that writes nothing lands at `status='posted'`, `rows_written = 0`, and the
preview banner says the fees are in the practice. Either:

- refuse **before** the job starts, when the gate already knows the count (the route
  already refuses `NOTHING_TO_POST` when every row is *excluded* — this is the same
  argument for the case where every row is *unmatched*); or
- give it a distinct terminal state, so "we wrote nothing and here is why" is not spelled
  the same way as "we wrote all 580".

The skipped-codes note already carries the explanation; what it lacks is a status that
stops somebody reading the banner as success.

### (c) An existing-but-empty schedule — no change needed

Already correct: the empty snapshot is stored explicitly and rollback stays possible. §3.
Listed only to close it out.

### (d) The code-matching path is unverified, not broken

No evidence either way — it has never run against this practice. Worth watching the first
successful post for the `/procedurecodes` page count and the skipped total, and worth a
deliberate look at the `ProcCode` field name and the `Limit`/`Offset` arithmetic before
that run rather than after it. The sweep is documented as ~13 requests for ~1300 codes;
if the first real run reports a skipped count anywhere near 580, that is the next bug and
it will be visible immediately.

### (e) Consider surfacing an internal failure differently

`post_error` currently shows an office manager a Postgres constraint name. It is the right
information to have kept — it is what made this recon quick — but "Unexpected failure: new
row for relation … violates check constraint …" is not a sentence anybody at the front
desk can act on. Keeping the raw text in the record while showing something plainer on
the panel would cost little. Lowest priority of the five.

---

## What was not checked

- **The batch row was not read from the staging database.** The state in the brief is
  taken as given; the source and the logs are what this report reasons from.
- **Open Dental was not called** to confirm schedule 103's contents, by instruction. The
  claim that it is untouched rests on `rows_written`, on the absence of any write verb in
  fourteen days of transport logs, and on the failure landing before the job's first read.
- **Nothing was fixed**, by instruction.
