# 14 — Perio: the chart in Open Dental is no longer what CareIN wrote

Branch `feature/hyg-perio-drift`, off `origin/develop` at `4fedf49` (after #203 merged).
Worktree `C:\Users\beau\carein-wt\hyg-perio-drift`. PUSH/PR STATUS is in §8.

---

## 0. The amendment came first: what Open Dental answers for a patient with no perio exams

The brief's 2026-09-21 amendment says to capture this **before** writing the code that depends on it,
because item 21 measured the same question for GroupNotes and got an HTTP 404 with a sentence rather
than `[]`. If `/perioexams?PatNum=` answered the same way, the one case this slice exists for — a
`Written` chart whose *only* exam was deleted — would silently never fire.

**Measured verdict: `GET /perioexams?PatNum=` for a patient with zero perio exams answers HTTP 200
with an EMPTY ARRAY.** It is not like `/procedurelogs/GroupNotes?PatNum=`. The capture is
`new-dashboard/tests/fixtures/od-perioexams-none-measured.json`.

### How it was measured, and why that method is stronger than a probe

Not with a probe script. The application **already makes exactly this read** on every open of a perio
chart, and already reports its own outcome in a log line that carries counts only. In
`services/hyg/odPerio.js`, `readPriorPerio` can only reach `prior: 'none'` when `pagedList` returned
`error: null` — which `pagedList` only does after `res.ok === true` on a short page — *and* zero exams
survived the PatNum filter. A 404 would have set `error`, taken the `!latest.ok` branch, and logged
`prior=unavailable`.

So a logged `prior=none` **is** the measurement. One request, in full, from today:

```
2026-09-29T21:58:53.2249749Z  [OD API] GET /perioexams
2026-09-29T21:58:54.1993509Z  [OD API] Response: 200 /perioexams
2026-09-29T21:58:54.1993509Z  [hygperio] office=roland apt=106142 prior=none od_perio_reads=1 ms=646
```

| Observation | Count | Window |
|---|---|---|
| `prior=none` (a successful 200 carrying no exams) | **10** — 8 staging, 2 **production** | 2026-09-21 → 2026-09-29 |
| `prior=unavailable` | **0** | 120 days, both environments |
| `404` on `/perioexams` | **0** | 90 days, both environments — every logged response was 200 or 201 |

Ten independent observations against the live Roland database, on two environments, beat one probe
run. The KQL that reproduces it is in the fixture; `az monitor log-analytics query` drops the query
body, so it goes through `az rest` with a JSON body.

### The contrast that DOES bite, and what was done about it

`GET /periomeasures?PerioExamNum=<a DELETED exam>` **does** answer a 404 with a sentence:
`[OD API] Response Error: PerioExamNum not found.` (staging, 2026-09-21T14:33:03Z and 14:33:06Z).

That sentence echoes **neither** the exam number nor the PatNum, so it cannot be narrowly matched the
way `isNoGroupNotesAnswer` matches its own — and a recogniser that fired on any 404 from that path
would be the "any 404 is an absence" rule item 21 explicitly refused to write. So the slice never
treats it as an absence: **the exam LIST is the only authority on whether an exam is present**, and a
measures read that refuses is `unknown` (say nothing).

### Consequences for the code

- **No `isNoPerioExamsAnswer` recogniser exists, and none should be added.** There is no refusal to
  recognise on this path, and inventing one would be a rule with no measurement behind it.
- `hygTestUtils`' `perioOd()` fake already answered `[]` for a patient with no exams. That is now
  **known to be faithful** rather than assumed — which is why the brief's "the fake must model the
  real 404 answer, not `[]`" instruction correctly resolves to: leave it as it is.
- A `/perioexams` read that genuinely fails stays a failure. Tested (§1, acceptance 4).

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Opening a `Written` chart whose exam is gone from OD shows it and offers Send again | `hygPerioDrift.test.js` › *ACCEPTANCE 1*: `drift.status = 'missing'` with the exam number, the contract validates it, and the resend leaves the chart `Staged` with `writtenRef` cleared, `live` null, and the written chart still on the send row | ✅ |
| 2 | Opening a `Written` chart whose exam MATCHES offers nothing and adds no request beyond the prior read | › *ACCEPTANCE 2*: `drift.status = 'matches'`, and the perio requests made are exactly `['/perioexams', '/periomeasures']` — the two the prior panel already needed. Asking for a resend anyway is refused `PERIO_EXAM_PRESENT` and the chart stays `Written` | ✅ |
| 3 | A `Written` chart whose sites DIFFER names the sites and offers NO resend | › *ACCEPTANCE 3*: `drift.status = 'changed'`, `#8 MB` named, no `sameDateExams` key at all, a direct resend refused, and Open Dental left holding the human's correction with no second exam beside it. On screen: `hyg-perio-page.test.tsx` › *the sites DIFFER* — no resend button, no dialog, no request | ✅ |
| 4 | An unreadable Open Dental leaves the `Written` line unqualified and offers nothing | › *ACCEPTANCE 4*: a 503 on the exam list → `unknown`; a truncated list → `unknown`; the resend refuses `OD_READ_FAILED` and stamps nothing. On screen: *Open Dental could not be read* — no notice of any kind, and the Written line unchanged | ✅ |
| 5 | The resend confirm lists every same-date exam for that patient, including ones CareIN did not write | › *ACCEPTANCE 5*: the hand-charted exam on the visit's date is listed and flagged `careinWrote: false`; an exam on another date is not. On screen: *the exam is GONE* — both exams by number, one "written by CareIN", one "not written by CareIN", plus the two-exams-for-one-day warning | ✅ |
| 6 | The resend creates a NEW exam number and reads back every site before `Written` | › *ACCEPTANCE 6*: the re-run send lands a different exam number, `supersedesExamNum` is null (a FIRST send, not an amendment), `comparePerioReadback(chart, writtenChart)` is empty, `writtenRef` says "read back and match", nothing was deleted, and a later open says `matches` | ✅ |
| 7 | The drift check fires on open only — no timer, no poll, asserted by test | › *ACCEPTANCE 7*: source assertions that `perioDrift.js`, `perioSendStore.js` and `visit.js` contain no `setInterval`/`setTimeout`/`cron`/`.schedule(`; plus three repeated reads that change no state and post nothing | ✅ |
| 8 | The disclosure audits; the re-read alone does not | › *ACCEPTANCE 8*: `matches` and `unknown` write no row; `missing` and `changed` each write one `hyg_perio_drift` READ row carrying the actor, the appointment, `source_ref: perio_exam:N` and `prior_state` = which answer it was — and no reading anywhere in it | ✅ |

Also tested: the resend refuses a number that is not this chart's exam and refuses a second press;
an unsent and a `Staged` chart are never drift-checked and never audited for it; the drift check reads
the live exam directly (one extra request, only there) when a NEWER exam exists in Open Dental; and a
truncated measures read on the live exam is `unknown`, never `changed`.

## 2. The design

### 2.1 What item 13 already built, and was not rebuilt

`perioSend.startPerioSend` already re-reads `/perioexams` and refuses `AMEND_BASE_MISSING` /
`AMEND_BASE_CHANGED`; `removeExam()` already treats an already-deleted exam as `alreadyGone`;
`hyg_perio_send.chart` already holds what CareIN wrote. None of that was duplicated:
`contract.perioChartChanges` is the same diff, `hyg_perio_send.chart` is the same baseline, and
`odPerio.readExams` / `readExamMeasures` are the same readers. What this slice adds is *when* the
check happens, and the one thing #180 had no answer for.

### 2.2 The three-way answer (five, counting the two that say nothing)

`PerioDriftSchema`, a discriminated union in `shared/hyg/perio.ts`:

| `status` | Meaning | Screen says | Resend |
|---|---|---|---|
| `not_applicable` | the chart is not `Written` — no claim to check | nothing | no |
| `matches` | present, every site still agrees | nothing (the `Written` line already says it) | no |
| `missing` | not in `/perioexams` at all | "Exam N is no longer in Open Dental." | **yes** |
| `changed` | present, sites DIFFER | "Exam N was changed in Open Dental after CareIN wrote it", naming the sites | **no** |
| `unknown` | Open Dental could not be read | nothing, unqualified | no |

**`changed` offering no resend is the whole design.** A reading that differs is a human who corrected
the chart in Open Dental; resending would post a second exam and bury their correction under CareIN's
stale numbers. The union makes it unrepresentable on both sides: the `changed` variant carries no
`sameDateExams`, `PerioDriftNotice` takes no resend handler on that branch, the dialog is only
rendered for `missing`, and the server's resend refuses anything whose exam is present.

**`unknown` saying nothing is also the design** — the `NOTE_PRECHECK_UNAVAILABLE` doctrine. A failed
read is not evidence the exam is gone. Saying "we could not check" beside a chart note would invite a
hygienist to hunt for a problem nobody has found.

### 2.3 One request, folded into the read that was already happening

`odPerio.readPriorPerio` now returns `exams` (the filtered list it read, with whether that read was
WHOLE) and `latest` (the newest exam's chart, withheld when truncated) alongside `prior`.
`perioDrift.checkDrift` is handed both. On every ordinary open of a chart CareIN wrote, CareIN's exam
*is* the newest one, so the drift check costs **zero** extra requests — pinned by acceptance 2, which
asserts the exact request list.

It reaches Open Dental in exactly one situation: the live exam is not the newest, i.e. somebody
charted a newer exam by hand. One `/periomeasures`, asserted by test.

`exams.ok` is the LIST read's own verdict, deliberately stricter than the prior panel's: a newest exam
read off half a list is still a real exam, but **presence** does not tolerate a partial list, because
an exam missing from half a list is not missing from the chart.

### 2.4 The resend: the existing send path, re-armed

`POST /:aptNum/perio/resend` writes **nothing** to Open Dental. It does two things:

1. `markExamGone` on the live send — `exam_gone_at` / `exam_gone_by`.
2. `restagePerioForResend` — `Written → Staged`, `written_ref` cleared.

Then the *ordinary* `POST /perio/send` and its steps run from the page, with their own confirmation
and their own site-by-site read-back. New exam number; the old one is never resurrected.

`getLiveSend` gained `AND exam_gone_at IS NULL`, and **that one clause is the resend**: with no live
send the next send is a FIRST send, so it posts a new exam instead of refusing `AMEND_BASE_MISSING`
over an exam nobody can correct.

**Why two columns and not a seventh send state.** `deleted` already means something specific —
CareIN's own undo removed the exam, and `deleted_by` is the person who pressed it. Reusing it would
put the name of whoever opened the chart against a deletion they did not perform. And `written` is not
wrong: that send *did* write the exam and *did* read every site back. What changed is a later fact
about Open Dental, not the history of the send. So the state machine is untouched and `chart` stays on
the row — nothing about what was written is lost.

**It re-reads before it believes the notice.** The drift answer came from the read made when the chart
was opened, which may be minutes old. Re-arming on a stale `missing` would arm a send that creates a
second exam beside one that is still there. So `/perioexams` is read again in the POST, an exam that
turns out to be present refuses `PERIO_EXAM_PRESENT`, and a read that fails refuses `OD_READ_FAILED`.
Two different sentences on purpose: one says the exam is there, the other says CareIN cannot tell.

### 2.5 The same-date list

`missing` carries every exam the patient has on the visit's date, each flagged `careinWrote`. The flag
is answered from **this chart's own send rows** (`getSendExamNums`), which is all the module can
honestly know. An exam CareIN wrote on a different visit of the same date reads as not-CareIN's — the
safe direction, since the list exists so a hygienist sees exams she might be duplicating, and
over-listing costs her a glance while under-listing costs a duplicate exam.

An empty list gets its own sentence ("This visit has no perio exam in Open Dental at all") rather than
an empty box. The page re-reads the prior endpoint when the dialog opens, so the list is current, and
the server re-checks at confirm.

### 2.6 Audit

The re-read is a fetch and does not audit. The moment the page **tells** her the exam is missing or
changed, that is a disclosure about what a chart of record does and does not contain, and it audits —
fail-closed, like every other audit on this path.

```
action READ · resource_type hyg_perio_drift · resource_id <aptNum>
source_ref perio_exam:<N> · prior_state missing | changed
```

`prior_state` is which of the answers it was, which is what the brief asked for. `audit_log` carries
identifiers only — never a reading. `action` is `READ` because `audit_log.action` is CHECKed to
`READ | CREATE | UPDATE | DELETE`, and a disclosure is a read. The resend writes its own `UPDATE ·
hyg_perio_resend · prior_state exam_gone` row.

## 3. What was deliberately not built

- No polling, no timer, no background watcher, no notification. Asserted by test (acceptance 7).
- No attempt to re-create the old exam under its old number.
- No auto-resend under any condition, and no resend at all for `changed`.
- `PUT /periomeasures` untouched. `perioDrift.js` names no write transport at all, so
  `hygNoOdWrites.test.js` passes it without an allow-list entry.
- TC, RCM and `backend/platform/` untouched.

## 4. One test was reformulated, and why

`services/hyg/visitSchema.test.js` › *the hyg migrations sort after everything that came before them*
went red: it asserted that no non-hygiene migration sorts **inside** the hygiene block, and this
slice's `1789700000000_hyg_perio_exam_gone.js` sits above the fees block.

That assertion has now been wrong twice, in opposite directions. v1 said `min(hyg) > max(others)` and
went false when fees added one after the block. v2 said nothing sorts inside the block and went false
the first time hygiene added one after fees. **Both were proxies for something they did not measure.**
Interleaving between modules is harmless: `node-pg-migrate`'s `checkOrder` refuses a migration that
sorts BEHIND one already applied, and says nothing about who authored what.

It now asserts the two properties that are real and that no unrelated slice can falsify:

1. **Every timestamp is the same width, and the sorted file list is in numeric order.** `checkOrder`
   compares the sorted FILE LIST against what is applied, so a timestamp of a different width sorts by
   string where everyone reads it as a number — and it fails at deploy time, on the one environment
   that already has rows in `pgmigrations`. This is the failure the test was always reaching for.
2. Hygiene's own are in slice order, so a later hygiene slice cannot land behind an earlier deployed
   one.

This slice's migration is the **highest in the repo** (1789700000000; see §4a for why it is not
1789500000000 any more), so `checkOrder` cannot refuse it.

`PerioSiteChangeSchema` also moved from `shared/hyg/perioSend.ts` to `shared/hyg/perio.ts`: the drift
union needs the shape, and `perio.ts` cannot import from `perioSend.ts` — the import runs one way
only. The comparison that produces one and the two formatters that read one stayed put. Only
`PerioSendConfirm.tsx` imported the type and was updated; the bundle re-exports both files, so
`contract.PerioSiteChangeSchema` is unchanged for every consumer.

## 4a. The CI red on PR #207, and what it actually was

**Reported as:** shard 3/4, one failing test —
`backend/routes/rcm/shadowComparison.test.js` › *"the prior state is a SLUG — her sentence never
reaches the audit row"* — a file this branch does not touch. Local runs were green, which pointed at
a cross-test leak from this branch's new test files.

**It was none of those things.** The failing assertion is this branch's own:

```
not ok 295 - the hyg migrations sort after everything that came before them
  location: backend/services/hyg/visitSchema.test.js:142:1
  error: two migrations share a timestamp

    31 !== 32

  expected: 32   actual: 31   operator: 'strictEqual'
  stack: visitSchema.test.js:152:10
```

**Root cause: a timestamp collision between this branch and `develop`.** PR #206 (the RCM EOB
field-confirm slice) merged to develop at 2026-09-30T17:06Z carrying
`1789500000000_rcm_eob_field_confirm.js`. This branch, cut before that, had independently chosen
**the same timestamp** for `1789500000000_hyg_perio_exam_gone.js`. Thirty-two migration files, thirty-one
distinct timestamps. Two files with one timestamp make the apply order depend on the rest of the
FILENAME, which nobody chose — so `node-pg-migrate` would apply them in an order no author decided.

Renumbered to **`1789700000000_hyg_perio_exam_gone.js`**, above develop's newest. The RCM one is left
alone: `services/rcm/rcmVocabulary.test.js` pins its filename in three places.

### Why it did not reproduce, and why the report named the wrong test

Two separate reasons, and both are worth writing down.

1. **CI tests the MERGE, not the branch.** `actions/checkout@v4` on a `pull_request` event checks out
   `refs/pull/207/merge`; the log says `HEAD is now at a23ef82 Merge 518dd83 into aea9ca9`. That tree
   carries develop's **six** newer backend test files, which this branch's working tree did not — and
   `--test-shard` partitions by the discovered file list, so every shard's contents differ. Merging
   develop in locally reproduced it on the first run; `git rev-parse HEAD^{tree}` then matched CI's
   `2305ff2209d05c578a7ab5ce5ca2aae89499874e` exactly. **Check the tree hash against the merge ref
   before concluding a CI-only failure is environmental.**

2. **The shard number and the test name in the report were artifacts of a truncated log.** GitHub
   dropped most of the step's output: `═══ shard 1/4 ═══` is the only shard header in it, no
   `# tests` / `# pass` / `# fail` counters survive, and `[shard-runner] FAILED` (stderr) is printed
   *before* a stray `# Subtest: the prior state ` fragment (stdout, cut mid-name) that belongs to an
   earlier shard. Reading the two adjacent lines as one event named a shard and a test that had
   nothing to do with it. The real failure was in shard **4**.

### It was not the Node 22 IPC flake either, and here is how that was ruled out

`backend/scripts/shard-runner.mjs` documents a Node 22 bug that produces "a failure with no assertion
in it, blaming a file that did nothing wrong". The absent assertion in the log made that the first
hypothesis. Three things ruled it out:

- `gh run rerun --failed` on the same commit came back red. The run is on **attempt 4**, all failing.
  A flake that survives four runs is not a flake.
- The test COUNT did not drop, which is that bug's signature.
- Once the merge was reproduced locally, there was a real `ERR_ASSERTION` with an `expected` and an
  `actual`.

Re-running first was still the right first move — one re-run is minutes, and a deterministic red
rules the flake out just as fast as a green rules it in.

### Nothing was leaked, and nothing could have been

The leak hypothesis is not merely unsupported, it is unavailable in this runner: `node --test` runs
every test FILE in its own child process (`--experimental-test-isolation=none` is not used and is
documented as unusable here), so env vars, module-level caches and shared fakes cannot cross files.
Measured rather than cited — two throwaway files under `--test-concurrency=1`, one setting an env var
and one reading it:

```
A pid=25968 LEAK_PROBE=set-by-a
B pid=50108 LEAK_PROBE=undefined
```
The only genuine cross-file channels are the filesystem, a bound port, and the parent's IPC stream.
This branch's new test file writes no files (it only `readFileSync`s sources) and closes every
ephemeral server it starts, in `finally`. **No test was weakened and no RCM file was touched.**

## 5. Files

| File | What |
|---|---|
| `new-dashboard/shared/hyg/perio.ts` | `PerioDriftSchema`, `PerioSameDateExamSchema`, `PerioResendRequestSchema`, `drift` on the prior response; `PerioSiteChangeSchema` moved in |
| `new-dashboard/shared/hyg/perioSend.ts` | imports the moved schema; the diff and formatters unchanged |
| `backend/hyg/contract.gen.cjs` | regenerated with the pinned esbuild from `new-dashboard/`, `--alias:zod` |
| `backend/services/hyg/odPerio.js` | `readPriorPerio` hands back `exams` and `latest`; `readLatestExam` returns the filtered list and `truncated`; the measured zero-exam answer recorded in the header |
| `backend/services/hyg/perioDrift.js` | **new** — `readDriftContext`, `checkDrift`, `resendVanishedChart` |
| `backend/services/hyg/perioSendStore.js` | `getLiveSend` excludes a gone exam; `markExamGone`, `getSendExamNums` |
| `backend/services/hyg/visitStore.js` | `restagePerioForResend` (`Written → Staged`) |
| `backend/migrations-tenant/1789700000000_hyg_perio_exam_gone.js` | **new** — `exam_gone_at`, `exam_gone_by`, two CHECKs |
| `backend/routes/hyg/visit.js` | the drift folded into `GET /perio/prior` + its disclosure audit; `POST /perio/resend` |
| `backend/routes/hyg/hygTestUtils.js` | the fake learns four statements; `perioOd()` exposes `publish` |
| `backend/routes/hyg/hygPerioDrift.test.js` | **new** — 12 tests, acceptance 1–8 |
| `backend/services/hyg/visitSchema.test.js` | the migration-order assertion reformulated (§4) |
| `new-dashboard/client/src/features/hyg/perio/PerioDriftNotice.tsx` | **new** — the notice and the resend confirmation |
| `new-dashboard/client/src/features/hyg/api.ts` | `resendPerioChart` |
| `new-dashboard/client/src/pages/hyg/HygPerio.tsx` | the notice, the dialog, `onResend` |
| `new-dashboard/client/src/features/hyg/perio/PerioSendConfirm.tsx` | the moved type's import |
| `new-dashboard/tests/hyg-perio-page.test.tsx` | `drift` on the fixture, the resend mock, 7 new tests |
| `new-dashboard/tests/fixtures/od-perioexams-none-measured.json` | **new** — §0's capture |

## 6. Gates

Run on the MERGED tree — `origin/develop` merged in at `aea9ca9`, so the working tree is the one CI
builds (`git rev-parse HEAD^{tree}` = `2305ff2209d05c578a7ab5ce5ca2aae89499874e`, CI's exactly). The
pre-merge numbers, on 78 fewer tests, are not quoted: they were green and they were also green with
the collision in place, which is the whole lesson of §4a.

| Gate | Result |
|---|---|
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` | **4/4 green** — 2810 tests, 2807 pass, 0 fail, 3 skipped |
| `pnpm run check` (`tsc --noEmit`) | clean |
| `pnpm run test` (vitest) | 121 files, **2020 pass, 0 fail**, 130 skipped |
| `hyg-contract-bundle.test.ts` | green on a `--frozen-lockfile` install with the pinned esbuild |
| `hygNoOdWrites.test.js` | 15/15 — `perioDrift.js` reaches no write transport |
| `visitSchema.test.js` | 7/7 — including the uniqueness clause that caught §4a's collision |
| No `any` in the changed TypeScript | verified |

## 7. Not yet done, and what it needs

**Not rehearsed on staging.** Every claim above is proven against the fake Open Dental and the real
routes, plus the log-derived measurement in §0 from the live Roland database. The end-to-end
rehearsal — write a chart on roland 12827, delete the exam in Open Dental's own perio chart, reopen
the page, press Send again — needs this branch deployed, and it will run under the #189 fixture gate
on designated test patients only. It is a staging step for after the merge, not a code gap.

**The migration has not been run against a real Postgres.** `backend/scripts/rehearse-hyg-visit.js`
is the instrument for that; CI runs the migrations against an ephemeral Postgres on the way to
staging, which is where the two new CHECKs are first exercised by the real DDL.

## 8. PUSH / PR STATUS

Pushed to `origin/feature/hyg-perio-drift`; PR **#207** against `develop`, with `origin/develop`
merged in (`aea9ca9`) and the §4a collision fixed. **Not merged** — as
instructed.
