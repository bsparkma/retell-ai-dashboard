# 11 — Probe the perio arch strings BEFORE the perio send is designed

Branch `feature/hyg-perio-arch-probe`, off `origin/develop` at `4738e55`.
Worktree `C:\Users\beau\carein-wt\hyg-perio-arch-probe`.

PUSH/PR STATUS is in §6.

> **About PR #177.** Before this queue item existed, the previous item 11 ("the perio send") was built
> as the per-row resumable queue and opened as **PR #177**, stacked on #176. The queue now says
> item 12 must not start until this probe has run. **#177 should not be merged on its own
> authority**: it is the "arch strings do not hold" branch, built before the finding that decides
> between the branches exists. If the probe says the strings hold, most of #177 is the machinery
> item 12 says collapses; if they do not, #177 is item 12 largely done. Either way the decision is
> the probe's, and #177's report says so in its §0.

---

## 1. What was built

`backend/scripts/probe-hyg-perio-arch.js` and `backend/test/probeHygPerioArch.test.js`. No UI, no
send path, no route, nothing under `backend/platform/`.

**What Open Dental's own page adds to H0** (`opendental.com/site/apiperioexams.html`, fetched
2026-09-14): the strings accept *"integers 0-9 for probing measurements and the flags b,s,p,c"*;
*"Other characters are ignored"*; *"Values strings are parsed left to right and will traverse
surfaces in that region from the right side of the mouth to the left side."* `ExamDate`, `ProvNum`
and `Note` are optional on POST since 23.3.27; `DELETE /perioexams` removes *"all associated
periomeasures"*. It says nothing about how a flag binds to a site, how depths above 9 are written,
how a tooth is skipped, or what a malformed string does — which is why the probe exists.

### Safety

| Rule from the brief | How it holds |
|---|---|
| Creates its OWN exams; DELETE is the complete undo | Every experiment is a new `POST /perioexams`. The script never posts `/periomeasures` at all (tested: a fake that throws on any other write path) |
| Fixture guard | roland 12827/12828, valley 7115, checked **per office** — 7115 at roland is refused. 11373 refused (tested) |
| Refuse under OPENDENTAL_WRITE_DISABLED | Before secrets load, for runs and cleanups (tested) |
| `--dry` prints every payload, sends nothing | Prints each experiment's full body; loads no secrets, resolves no office, issues no request (tested) |
| Print the PerioExamNum; `--cleanup <n>` deletes exactly it; refuses others unless `--force-cleanup` | Each created exam is written to a manifest (`backend/scripts/.probe-hyg-perio-arch.json`) **before** its read-back, and printed in a box. `--cleanup` deletes only manifest exams, reads first that the exam belongs to the fixture — **even `--force-cleanup` cannot delete another patient's exam** — then reads again to confirm it is gone (all tested) |
| Never write to an exam with measures it did not create | It never writes to any existing exam, and never writes a measurement |

Extra, not in the brief: every exam is dated **2000-01-01** with the note *"CareIN arch-string probe
(…). Test data - delete with --cleanup."* The perio workspace shows the **newest** exam as "last
charted" (slice 10), so a probe exam dated today would sit under a real chart until cleaned up.
Override with `HYG_PROBE_EXAM_DATE`. `DELETE` goes through the raw client exactly as
`scripts/rcm-s11-unwind.js` does, because `apiWriteRaw` is POST/PUT only by design.

### The experiments

| id | Body | Answers |
|---|---|---|
| `mapping` | all four regions, 48 digits each from a deterministic **non-periodic** sequence | Q1, Q2, Q7 |
| `flags` | `UpperFacial: "3b2s4p5c6bs7pc8bspc"` — one partial arch alone | Q4, Q6 (partial / alone) |
| `deep` | `UpperFacial: "10 11 19 3"` | Q3 |
| `skip` | `UpperFacial: "3x3-3_3 3X3"` | Q5 |
| `malformed` | `UpperFacial: 60 × "4"`, `UpperLingual: "zzz!!"` | Q6 (malformed, atomicity) |

**The mapping derivation** (`deriveMapping`, pure) tests the read-back against eight candidate
walks — tooth order (patient right→left, or left→right) × site rule (continuous sweep, reversed
sweep, always distal-first, always mesial-first) — and reports `UNIQUE` only when exactly one
explains every written digit with no stray readings. `none` and `ambiguous` are printed as such,
never resolved by guessing. The test suite proves the chosen strings single out **each** of the
eight walks in **every** region, so a unique verdict on the real run is evidence rather than luck.

## 2. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Script exists, fixture-guarded, `--dry` proven to send nothing | *only the designated fixtures, per office…*; *--dry prints every payload and contacts Open Dental not at all* | ✅ |
| 2 | `--cleanup <n>` deletes exactly the exam named, refuses others | *--cleanup deletes EXACTLY the exam named…*; *…refuses an exam this script did not create*; *--force-cleanup still refuses an exam that is not the fixture's own*; *--cleanup honours OPENDENTAL_WRITE_DISABLED and --dry* | ✅ |
| 3 | Mapping-derivation function unit-tested against fabricated read-backs | *the mapping strings single out EACH of the eight candidate walks*; *the derived table names the tooth and site of every position*; *a uniform string is AMBIGUOUS*; *a half-landed arch fits no walk*; *an over-long string reports the characters past the region* | ✅ |
| 4 | §Findings with a numbered slot per question, blank, commands above | §4 below | ✅ |
| 5 | Allow-list touched by exactly one added name, with a comment | `backend/routes/rcm/rcmNoOdWrites.test.js`: `'probe-hyg-perio-arch.js'` added, commented in the list's header and at the entry. No other TC/RCM change | ✅ |

## 3. Gates

| Gate | Result |
|---|---|
| `node --check scripts/probe-hyg-perio-arch.js` | clean |
| `test/probeHygPerioArch.test.js` | **17/17** |
| `node scripts/shard-runner.mjs` | **4/4 green** — 638 + 680 + 564 + 551 = **2433 tests, 2430 pass, 0 fail, 3 skipped** (run twice; the first run overlapped a fix to the test's fake, so the recorded result is the second, on the committed code) |
| `pnpm run check` | clean (no dashboard change in this slice) |
| Probe run against staging | **not run** — that is §4, and it is Beau's |

One defect found while writing the tests, in the test's own fake rather than the script: the fake
made a separate Probing row per REGION, so tooth #1's facial and lingual strings landed in two
rows and the derivation (which takes the newest row per tooth) read the facial sites as blank.
Open Dental documents one row per (tooth, SequenceType); the fake now shares one. If the real run
prints `NONE` with every reading `-` on one side of an arch, check for that duplication first.

---

## 4. Findings — for Beau's run to fill

### Commands (from `backend/`, in the STAGING container)

`loadSecrets()` runs inside the script. Use a hygienist's ProvNum from roland's Open Dental.
`OPENDENTAL_WRITE_DISABLED` must be unset on staging for the run and the cleanup.

```bash
# 1. DRY RUN FIRST. Read every payload. Nothing is sent.
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<hygienist ProvNum> \
  node scripts/probe-hyg-perio-arch.js --dry

# 2. The run. Creates up to FIVE exams on 12828, each dated 2000-01-01. Prints each PerioExamNum.
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_PROVNUM=<hygienist ProvNum> \
  node scripts/probe-hyg-perio-arch.js 2>&1 | tee /tmp/perio-arch-probe.txt

#    (a subset:  --only mapping   or   --only flags,deep)

# 3. Look at the exams in Open Dental's perio chart for 12828 (date 2000-01-01) if useful,
#    record the findings below, THEN delete every exam the run created:
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 \
  node scripts/probe-hyg-perio-arch.js --cleanup <n>,<n>,<n>,<n>,<n>
```

> **Beau: run step 3.** The exams are test data on a fixture, but they are real perio exams in
> roland's database until they are deleted. The run's last lines print the exact cleanup command.
> The container's manifest is lost on a redeploy; if that happens first, clean up with
> `--cleanup <n> --force-cleanup`, which still refuses any exam that is not 12828's.

### Q1 — Does the arch-string POST land at all?
_(from `mapping`: "Q1 LANDED", and the row count)_

### Q2 — The mapping (position → tooth, site, direction)
_(paste the four `UNIQUE / AMBIGUOUS / NONE` lines and tables from `mapping`)_

### Q3 — Depths above 9
_(from `deep`: the raw Probing rows for #1–#4 — did `10 11 19 3` land as 1,0,1,1,1,9,3 on seven sites, as runs, or was it refused?)_

### Q4 — The four flags, and several on one site
_(from `flags`: the BleedSupPlaqCalc rows for #1–#4. "Flag follows its depth" predicts 1,2,4,8,3,12,15 on the first seven sites of the mapping; "flag precedes its depth" predicts 0,1,2,4,8,3,12)_

### Q5 — Skipped teeth
_(from `skip`: where the six 3s landed, and whether any SkipTooth row appeared)_

### Q6 — Atomicity, partial arches, malformed strings
_(from `flags`: one partial arch sent alone. From `malformed`: was the exam refused, or created — and how many upper sites got 4s from 60 digits, and what "zzz!!" did)_

### Q7 — ProvNum and ExamDate land as sent
_(from `mapping`: the "Q7 exam header" line)_

### Cleanup
_(the exam numbers created, and the "confirmed gone" lines from step 3)_

## 5. What the findings decide (for item 12)

- **Q1 yes, Q2 UNIQUE, Q4 expressible, Q6 atomic** → item 12's "arch strings hold" branch: one POST
  plus a read-back. Then Q3 and Q5 decide what, if anything, needs per-row `PUT`/`POST`
  (depths ≥10; skipped teeth), as a short named list.
- **Anything else** → the per-row resumable design — which is PR #177.

## 6. Push / PR

PR_PLACEHOLDER
