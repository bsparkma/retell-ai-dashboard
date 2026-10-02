# Item 26 — Perio v2: STOPPED AT THE §0 GATE

`feature/hyg-perio-v2` → `develop`. **No product code was written.** That is the
instruction, not a shortfall: §0 gates the slice, and §0 could not be answered
from here.

Nothing in this branch changes the running product. It adds one read-only probe
script and this report.

---

## 1. §0 — attempted, and not answered

### 1.1 The question

`POST /periomeasures` with `SequenceType: GingMargin` accepts **two families** of
values — `0–19` and `101–119` — and item 19's probe measured that both store
**verbatim**: 101/102 are not converted, clamped or re-signed in either
direction (`docs/reports/feature-hyg-perio-v2-probe.md` §2). H0's prose documents
101–119 as "negative (subtract 100)".

Neither the API nor the documentation says **which family means recession**. That
is a convention of Open Dental's own user interface, and the probe could not
observe it: it wrote both families itself and read both back unchanged. The probe
report says so in terms, and draws the same line this slice stops at:

> **Sign convention: the API does not say which is recession.** … **One check by
> a person closes it:** enter a known 2 mm recession on a fixture in Open
> Dental's perio chart, then read that row through the API and see whether it is
> `2` or `102`. **Product code must not be written before that answer.**

It is load-bearing twice:

1. CareIN's gingival-margin entry must write the family Open Dental's own chart
   writes, or **every recession CareIN sends is recorded as its opposite** in the
   chart of record.
2. CAL is `depth + recession` or `depth − recession` depending on it. A CAL wrong
   by twice the recession is a clinical number that still looks plausible.
   Computing CAL for display only (Part 2) limits the blast radius to what she
   sees on screen; it does not make a wrong number acceptable.

### 1.2 What I could not do

The read itself is two GETs and is trivially safe. Reaching Open Dental from here
is the problem, and all three lanes are closed — the same three item 18 hit, in
the same state:

| lane | result |
| --- | --- |
| **Workstation** | `OdOfficeError: office 'roland' cannot reach Open Dental: OFFICE_OD_KEY_MISSING`, after `[secrets] non-production: using .env / process.env (Key Vault not contacted)`. **No permission fixes this**: `config/secrets.js` only contacts Key Vault when `NODE_ENV=production`, and the OD customer key lives nowhere else. `loadSecrets()` cannot use the az CLI token. |
| **Staging container** | the correct lane, where managed identity supplies the key. `az containerapp exec` is denied to me by the sandbox classifier, as it has been on every prior slice. It is also not yet possible for this script: staging runs `develop`, and the script below is on a branch. |
| **Mining the app's own logs** | **cannot answer this question even in principle.** The app does call `/perioexams` and `/periomeasures`, so there are log lines — but `[hygperio]` is built to carry **counts and milliseconds only, never a reading**. The one thing §0 needs is the value in a row. |

### 1.3 "Cannot find the exam" vs "cannot read at all"

The brief says to stop if the exam cannot be found on 12828. **I cannot
distinguish the two cases**, and I am not going to present an access failure as
an absent exam. A `[hygperio] … prior=found` line proves *some* exam exists for
*some* appointment, not that the 2026-09-29 exam is there, because the log line
carries neither an exam number nor a date. So the honest statement is: the
read-back was never performed.

### 1.4 The finding that IS recorded

Beau established, in Open Dental's own perio chart on roland test patient 12828
on 2026-09-29:

> **Open Dental's UI refused a negative.** Overgrowth — a gingival margin coronal
> to the CEJ — **could not be typed at all**.

That is recorded here as a finding, and it already settles a design question
independently of which family is which: **CareIN charts recession only, and there
is no overgrowth entry.** That is parity with Open Dental's own chart, not a
feature gap, and it is why Part 1 was specified with no negative entry and no
literal negative ever sent (the API refuses those too — probe §7).

What it does **not** settle is the §0 question. "The UI refuses negatives" is
consistent with either family being the recession one.

---

## 2. What this branch contains

`backend/scripts/probe-hyg-perio-gm-sign.js` — **new, read-only, UNRUN.**

- `apiGetRaw` is the only client call in the file. There is no write path.
- Fixture-gated: it refuses any PatNum that is not a designated test patient,
  and `require`-safe, so importing it reaches Open Dental for nothing.
- Lists every exam for the fixture with its raw row, **calls out the
  2026-09-29 date** rather than filtering to it, then reads that exam's measures
  and prints every `GingMargin` row raw, per surface, with the family each value
  falls in — and states the §0 answer in one line.
- 🔴 It uses **`GET /periomeasures?PerioExamNum=` only**. Probe §6 measured that
  `GET /periomeasures/{id}` **ignores the id and returns the whole practice's
  perio table**. It additionally drops any row whose own `PerioExamNum` is not
  the exam asked about, and any exam row whose `PatNum` is not the patient asked
  about — the filters were honoured when measured; this is for the day one is not.
- If no `GingMargin` row for #3 is found, it says so explicitly rather than
  printing nothing.

One command answers §0:

```
cd backend && env HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUMS=12828 \
  node scripts/probe-hyg-perio-gm-sign.js
```

It must run where the customer key is reachable — the staging container, or any
environment with the roland key in its process environment.

---

## 3. The scope question the brief asked me to rule on

> *"If item 14's drift comparison is in by now, v2 rows join the same
> site-by-site comparison; if that is material extra scope, SAY SO in the report
> and stop — it becomes 26b, not silent scope growth."*

Item 14 **is** in (`#207`, merged). **Extending drift to v2 rows is material
extra scope. It should be 26b.** The specifics, read off the code rather than
guessed:

1. `odPerio.chartFromMeasures` maps **Probing, BleedSupPlaqCalc and SkipTooth
   only** — `odPerio.js:181` reads GingMargin / Mobility / Furcation / MGJ off
   the same pages and deliberately drops them. Drift compares
   `perioChartChanges(baseline, odChart)` against that mapper's output, so v2
   rows are invisible to it today.
2. `PerioSiteChangeSchema.kind` is a **closed** `z.enum(["depth","flags","skipped"])`
   (`shared/hyg/perio.ts:720`). Adding kinds is a compile error at every switch —
   which is the schema working as designed, and is also the work: the drift
   notice and the resend dialog both render these.
3. A full v2 exam is **~130 rows, spanning two of `pagedList`'s 100-row pages**
   (probe §5). I checked whether that would make every full v2 chart report
   `unknown`, since the drift path treats a truncated read that way — **it would
   not**: `MAX_PAGES` is 25 (`odDay.js:100`), so `readExamMeasures` reads both
   pages and `truncated` stays false. The cost is one extra request on the drift
   path, not a correctness problem. Recorded because it was worth checking, and
   because the answer is the opposite of what the row count suggests.
4. `PerioMismatchKindSchema` (`perioSend.ts:506`) is a **separate** closed enum
   for the send's read-back. Extending that one *is* inside item 26 Part 4; it is
   worth not confusing the two.

None of that is hard, and none of it is "v2 rows join the same comparison" either.
It is a second slice with its own tests and its own UI surface.

---

## 4. What is already measured, so 26 is short once §0 lands

Everything else this slice needs is in the probe report and does **not** depend on
§0. Recorded here so the build does not re-litigate it:

| | measured |
| --- | --- |
| GingMargin | per site, six surface columns, `ToothValue` must be `-1` |
| Furcation | per site, `ToothValue` must be `-1`; **OD accepted class 5, and furcation on a central incisor** — the product must enforce classes 1–3 and the multi-rooted tooth list itself |
| Mobility | per tooth in `ToothValue`; **every** surface column must be `-1`; `25` refused |
| one read-back | all types come back in one `?PerioExamNum=` answer, distinguishable by `SequenceType`; the filter was honoured |
| retry | a second POST for the same (tooth, type) is **refused, not overwritten** — so "already exists" means read, compare, and be honest |
| no `Recession` type | `SequenceType: "Recession"` → `400 SequenceType is invalid.` GingMargin is the only surface for it |
| arithmetic | typical v2 send ≈ 50 requests, full ≈ 80 |

---

## 5. Acceptance

**All ten items are unmet, and deliberately so.** Item 1 cannot be met without
the read-back; items 2–10 are product code, which item 1 gates. Encoding the
named constant now would mean choosing a family — the one thing the brief, the
probe report and plain sense all forbid.

## 6. Gates

No product code changed, so the gates say only that nothing was broken:

| gate | result |
| --- | --- |
| `node --check` on the new script | clean |
| `node scripts/shard-runner.mjs` | 4/4 green (unchanged tree) |
| `pnpm run check` | clean |
| `pnpm run test` | pass |
| `odPerioWriter.js` | untouched |
| migrations | none |

## 7. Push, PR, and the merge tree

Filled in at push time.

---

## 8. What I need

**The output of one read-only command**, run where the roland customer key is
reachable:

```
cd backend && env HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUMS=12828 \
  node scripts/probe-hyg-perio-gm-sign.js
```

Paste it into §1 and item 26 proceeds: the family becomes one named constant with
that read-back quoted beside it, and Parts 1–4 are built to it.

If the 2026-09-29 exam turns out not to be on 12828 after all, the same two GETs
on 12827 or valley 7115 would do — or the hand entry repeated. What cannot happen
is the constant being chosen without it.
