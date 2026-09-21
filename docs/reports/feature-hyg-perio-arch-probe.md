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

> **Recorded 2026-09-15 by item 12**, from the run's own console output (roland staging, fixture
> 12828, ProvNum 15). That output was saved as `backend/probe-output.txt` in the probe worktree and
> was never committed; the findings below are copied from it, and the full per-position mapping
> read-back is committed as `new-dashboard/tests/fixtures/perio-arch-probe-staging.json`, which
> item 12's tests are pinned to. The run created exams **2249** (mapping), **2250** (flags),
> **2251** (deep) and **2252** (skip); `malformed` was refused and created nothing.

### Q1 — Does the arch-string POST land at all?
**Yes.** `POST /perioexams` answered 201, and `mapping` read back **32 measurement rows** — one
Probing row per tooth. No BleedSupPlaqCalc rows were created for strings with no flag letters.

### Q2 — The mapping (position → tooth, site, direction)
**UNIQUE on all four arches, 48/48 positions matched, 0 unexpected readings, 0 characters past the
region.** Best fit every time: *patient-right-to-left, sweep*.

| positions | UpperFacial | UpperLingual | LowerLingual | LowerFacial |
|---|---|---|---|---|
| 1–3 | #1 DB B MB | #1 DL L ML | #32 DL L ML | #32 DB B MB |
| 4–6 | #2 DB B MB | #2 DL L ML | #31 DL L ML | #31 DB B MB |
| 7–9 | #3 DB B MB | #3 DL L ML | #30 DL L ML | #30 DB B MB |
| 10–12 | #4 DB B MB | #4 DL L ML | #29 DL L ML | #29 DB B MB |
| 13–15 | #5 DB B MB | #5 DL L ML | #28 DL L ML | #28 DB B MB |
| 16–18 | #6 DB B MB | #6 DL L ML | #27 DL L ML | #27 DB B MB |
| 19–21 | #7 DB B MB | #7 DL L ML | #26 DL L ML | #26 DB B MB |
| 22–24 | #8 DB B MB | #8 DL L ML | #25 DL L ML | #25 DB B MB |
| 25–27 | #9 MB B DB | #9 ML L DL | #24 ML L DL | #24 MB B DB |
| 28–30 | #10 MB B DB | #10 ML L DL | #23 ML L DL | #23 MB B DB |
| 31–33 | #11 MB B DB | #11 ML L DL | #22 ML L DL | #22 MB B DB |
| 34–36 | #12 MB B DB | #12 ML L DL | #21 ML L DL | #21 MB B DB |
| 37–39 | #13 MB B DB | #13 ML L DL | #20 ML L DL | #20 MB B DB |
| 40–42 | #14 MB B DB | #14 ML L DL | #19 ML L DL | #19 MB B DB |
| 43–45 | #15 MB B DB | #15 ML L DL | #18 ML L DL | #18 MB B DB |
| 46–48 | #16 MB B DB | #16 ML L DL | #17 ML L DL | #17 MB B DB |

Upper strings run #1 → #16 and lower strings #32 → #17. **Site order reverses at the midline**: one
physical sweep around the arch, distal-first on the patient's right, mesial-first on the left.

### Q3 — Depths above 9
**They cannot be written, and they fail silently.** `"10 11 19 3"` read back as Probing
`#1 DB 1, B 0, MB 1` · `#2 DB 1, B 1, MB 9` · `#3 DB 3`: the space was ignored and every digit took
its own site (1,0,1,1,1,9,3). No error, and every later site shifted.

### Q4 — The four flags, and several on one site
**A flag follows its depth, and flags stack.** `"3b2s4p5c6bs7pc8bspc"` read back as Probing
`#1 3,2,4` · `#2 5,6,7` · `#3 8` (DB, B, MB) and BleedSupPlaqCalc `#1 1,2,4` · `#2 8,3,12` ·
`#3 15` — exactly the "follows" prediction, 1,2,4,8,3,12,15. Unflagged, uncharted sites on those
rows read -1.

### Q5 — Skipped teeth
**No character holds a place, and none means skip.** `"3x3-3_3 3X3"` put its six 3s on `#1 DB B MB`
and `#2 DB B MB`, and no SkipTooth row appeared (2 rows, both Probing). A shorter string simply
stops early.

### Q6 — Atomicity, partial arches, malformed strings
**A partial arch sent alone lands** (`flags`: one 19-character UpperFacial, 6 rows). **A malformed
body is refused before anything is created**: `malformed` answered 400 *"UpperLingual must start
with a number from 0-9."* and the exam list afterwards held no new exam. The 60-digit UpperFacial in
the same body was therefore never adjudicated on its own; item 12 treats an over-long string as
forbidden by construction.

### Q7 — ProvNum and ExamDate land as sent
**Yes.** `ExamDate=2000-01-01 (sent 2000-01-01), ProvNum=15 (sent 15)`, and the Note as sent.

### Cleanup
The run printed `--cleanup 2249,2250,2251,2252`. The console output of that cleanup was not saved,
but the manifest it maintains (`backend/scripts/.probe-hyg-perio-arch.json` in the probe worktree)
is now `{"exams": []}` — and `--cleanup` removes an exam from the manifest only after reading the
patient's exam list back and confirming it gone. **Worth one look in Open Dental's perio chart for
12828 (exams dated 2000-01-01) to confirm by eye.**

## 5. What the findings decide (for item 12)

- **Q1 yes, Q2 UNIQUE, Q4 expressible, Q6 atomic** → item 12's "arch strings hold" branch: one POST
  plus a read-back. Then Q3 and Q5 decide what, if anything, needs per-row `PUT`/`POST`
  (depths ≥10; skipped teeth), as a short named list.
- **Anything else** → the per-row resumable design — which is PR #177.

**Outcome:** Q1 yes, Q2 UNIQUE, Q4 expressible, Q6 atomic — the strings hold. Q3 (no depth ≥10) and
Q5 (no place-holder) became item 12's expressibility rule: an arch goes as a string only when it can
say every reading truthfully, and row by row otherwise. See
`docs/reports/feature-hyg-perio-send-v2.md`.

## 6. Push / PR

Pushed. **PR #178** — `feature/hyg-perio-arch-probe` → `develop`:
https://github.com/bsparkma/retell-ai-dashboard/pull/178

Independent of #176 and #177: it touches only `backend/scripts/`, one new test file and one
allow-list entry. It can merge first, and the run in §4 needs it deployed to staging.

**Queue item 12 (the perio send) is not started, by its own instruction:** *"DO NOT START THIS
UNTIL ITEM 11'S PROBE HAS BEEN RUN AND ITS FINDINGS ARE RECORDED."*
