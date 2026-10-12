# Item 26 — Perio v2: recession, mobility, furcation, and a CAL that is never written

`feature/hyg-perio-v2` → `develop`. No migration. All Open Dental writes stay
inside `backend/services/hyg/odPerioWriter.js`.

This branch previously stopped at the §0 gate. §0 is now answered, and this is
the slice built on it.

---

## 0. §0 — the sign convention, measured

Open Dental's `GingMargin` surface accepts **two families** of values, `0–19` and
`101–119`, and item 19's probe measured that **both store verbatim**: 101/102 are
not converted, clamped or re-signed in either direction. H0's prose documents
101–119 as "negative (subtract 100)". Which family a **recession** goes in is a
convention of Open Dental's own user interface, and no amount of writing to the
API reveals it.

So a person entered one. Beau hand-entered a perio exam in **Open Dental's own
perio chart** on roland test patient 12828 on **2026-09-29**, with a known
**2 mm recession on #3 buccal**. `backend/scripts/probe-hyg-perio-gm-sign.js`
read it back from staging (revision `--0000211`). The raw row, quoted:

```json
{"PerioExamNum":2268,"SequenceType":"GingMargin","IntTooth":3,
 "ToothValue":-1,"MBvalue":-1,"Bvalue":2, ...}
```

**`Bvalue` is `2` for a 2 mm recession. The recession family is the LOW one,
0–19.** Therefore **`CAL = depth + recession`, by addition**, and CareIN's entry
writes 0–19 and never 101–119.

Encoded as **one named constant**, `PERIO_GM_FAMILIES` in
`new-dashboard/shared/hyg/perio.ts`, with that raw row quoted at its definition
and the reasoning beside it.

### 0.1 The other two findings from the same sitting

- **Open Dental's UI refused a negative.** Overgrowth — a margin coronal to the
  CEJ — could not be typed there at all. So CareIN charts **recession only**, and
  that is **parity with the chart of record, not a feature gap**. There is no key
  sequence that produces a negative, and a literal negative is never sent (the
  API refuses those too, probe §7).
- **A `GingMargin` row can carry all `-1`.** An empty row is a shape Open Dental
  really stores. It is **tolerated on read and never read as a value** — reading
  one as data would put a 0 mm recession on six sites nobody charted — and CareIN
  never writes one (`odPerioWriter` refuses a row that says nothing).

---

## 1. What a digit means now: four modes, one grid, one walk

| mode | key | takes | scope |
| --- | --- | --- | --- |
| Depth | `D` | 0–19 mm | per site (unchanged) |
| Gingival margin | `G` | 0–19 mm recession | per site |
| Mobility | `M` | 0–3 | **per tooth** — the walk advances by tooth |
| Furcation | `F` | 1–3 | per site, multi-rooted teeth only |

Navigation, skip, Backspace and Delete behave identically in all four, because a
hygienist mid-sweep should not have to relearn the keyboard to record a
recession. Backspace and Delete act on the **active mode's** value, so Delete in
Depth mode cannot quietly discard a recession recorded a minute earlier.

The digit action is now `{ type: "number", value }` rather than
`{ type: "depth", depth }`. A key cannot know the mode; the reducer is the one
place that does, and the old name would have been a lie in three modes out of
four.

**Mode is loud**: a chip row with the active mode filled, its range spelled out
beside it (*"Numbers go in as Gingival margin 0-19 mm recession"*), clickable as
well as keyable. The keys live in `PERIO_MODE_KEYS` and **the legend renders from
them** (item 17's doctrine: the legend cannot promise what the reducer does not
honour). A test asserts no letter is in both the mode table and the flag table.

**Flags do nothing outside Depth mode.** A flag rides a probing depth; there is
no bleeding on a mobility grade.

---

## 2. Refused at entry, with a reason

Item 19's probe found the two corruption hazards: Open Dental **accepted and
stored** furcation class `5`, and furcation on **#8, a central incisor**. It does
not know which teeth have roots to fork. So the product enforces it, twice —
in the reducer, where she finds out while the probe is still in her hand, and
again in `odPerioWriter.js` before the transport.

| | refused | because |
| --- | --- | --- |
| Mobility | > 3 | clinical range is 0–3; Open Dental would take 0–19 |
| Furcation | outside 1–3 | there is no class 5 |
| Furcation | single-rooted tooth | a class on one is a corruption of the chart of record |
| Gingival margin | outside 0–19 | the other family is **unenterable**, not merely refused |

`state.refusal` carries the sentence and every other action clears it, so the
screen describes what just happened rather than something stale. The on-screen
number pad **disables** the numbers the mode cannot take — a button she can see
has no excuse for being a trap — while the keyboard still refuses with a
sentence, because a pad cannot be stopped from sending a 7.

`PERIO_FURCATION_TEETH` is the named constant: molars plus **#5 and #12**, the
two-rooted upper first premolars.

---

## 3. CAL — computed on sight, never written

```ts
export function perioCal(site: PerioSite): number | null {
  if (site.depth === null) return null;
  if (!perioGmIsRecession(site.gm)) return null;
  return site.depth + (site.gm as number);
}
```

Three ways to get `null`, all of them honest absences rather than zeros: no
depth, no margin, or **a margin in the other family**. H0 says subtract 100; that
sign has never been observed, and a guess there becomes a clinical number that
reads as plausible. Such a value is shown **raw with an "unrecognized margin"
marker** and gets no CAL.

A site missing an operand shows **nothing** — no 0, no dash that could read as
one.

**It is never typed, never staged and never written.** `odPerioWriter.js` refuses
the SequenceType before the transport, and a test builds a full-mouth v2 chart,
plans it, and asserts no row, no body key, and no byte of the serialised plan
matches `/cal/i`.

---

## 4. The send

v2 rows ride the existing send as per-row `POST /periomeasures`, **after** the v1
arch-string and probing phase, in the exact bodies the probe measured:

| type | ToothValue | surfaces |
| --- | --- | --- |
| GingMargin | `-1` | recession, or `-1` |
| Furcation | `-1` | class, or `-1` |
| Mobility | **the grade** | **every one `-1`** |

**Absence over zero**: an unvisited site is `-1`, a tooth with nothing on it gets
**no row**, and a row of six `-1`s is refused rather than written.

### 4.1 What already worked, and what did not

The send has always **read before every write** and compared what it found, so
the *"already exists"* branch worked for the new rows the moment they were in the
plan — match is success, mismatch is an honest failure naming tooth and type,
never a blind re-POST (which Open Dental **refuses**, measured, turning a
recoverable pause into a dead send).

What did **not** work was the verification. `odPerio.chartFromMeasures` dropped
GingMargin, Furcation and Mobility, so v2 rows would have been posted and then
**never checked** before the chart was called `Written`. It maps all three now.

### 4.2 Three things the tests corrected me on

- **`samePerioReadings` already covers v2.** It compares the normalised `teeth`
  object as JSON, so an edited recession **un-stages** the chart exactly as an
  edited depth does. The first refusal is therefore `NOT_STAGED`;
  **`PREVIEW_CHANGED` is the second line of defence**, for a client holding a
  preview from before the edit. The acceptance-8 tests exercise exactly that: edit,
  re-stage, then confirm with the **old** fingerprint — refused only because the
  fingerprint moved when the recession did. The preview names every v2 value per
  site for that reason.
- **An unanswered row pauses, it does not stop.** "It may have landed" is not "it
  failed", and the next step reads Open Dental and finds out.
- **A failed send does not roll itself back.** The undo is **offered**
  (`canDelete`) and a person takes it, because a rollback CareIN decided on its
  own would delete an exam a hygienist may be looking at. The test takes the undo
  and proves the whole exam goes, rows with it.

### 4.3 Duration honesty

`estimatePerioSendRequests` already counted rows, so it counts v2 rows now. The
confirm dialog adds the **phases in the order they are posted** — *"In order: 5
recession, then 2 furcation, then 2 mobility"* — because "80 rows" tells her
nothing about why she is waiting ninety seconds.

---

## 5. 26b: drift is NOT widened, deliberately

Item 14's drift check is built on the same comparison the send's read-back uses.
Teaching `comparePerioReadback` about v2 — which item 26 must, to verify what it
writes — would therefore have taught drift about it too, and that means widening
`PerioSiteChange.kind`, a closed enum the drift notice and the resend dialog both
render and switch on.

So `perioChartChanges` **filters the three new kinds out** through a named guard
with the reasoning at its definition, and a test asserts both halves: a recession
change produces no drift, and a depth change still does. **That is 26b**, as this
report said before the slice was built — not silent scope growth.

One thing I checked and got the opposite answer to what the row count suggests: a
~130-row v2 exam does **not** truncate on the drift path. `MAX_PAGES` is 25, so
`readExamMeasures` reads both pages and `truncated` stays false. It costs one
extra request, not correctness.

---

## 6. Acceptance

| # | | where |
|---|---|---|
| 1 | §0 recorded verbatim, raw row quoted, encoded as ONE named constant | §0 above; `PERIO_GM_FAMILIES` |
| 2 | Four modes; digits land only in the active mode; mode always visible; legend renders from `entry.ts` | `hyg-perio-v2.test.ts` "ACCEPTANCE 2" (×7), `hyg-perio-page.test.tsx` (×5) |
| 3 | GM stores only the recession family; the other family and negatives unenterable; read-back shows raw + marker, no CAL | "ACCEPTANCE 3 + 5"; page test "a margin in the OTHER family" |
| 4 | CAL correct incl. missing operands; never in any payload | "ACCEPTANCE 4" (×5 unit, ×3 page) |
| 5 | Furcation > 3 and non-eligible teeth refused; mobility > 3 refused | "ACCEPTANCE 3 + 5", `odPerioWriter.test.js` (×4) |
| 6 | Uncharted teeth/sites produce no rows | "ACCEPTANCE 6" (×5) |
| 7 | Read-back before `Written`; "already exists" = read-and-compare, both branches | `hygPerioV2Send.test.js` (×4) |
| 8 | Fingerprint covers v2 — edit then stale confirm = `PREVIEW_CHANGED` | `hygPerioV2Send.test.js` (×2) |
| 9 | Failed mid-send: nothing claimed, whole-exam undo offered and taken | `hygPerioV2Send.test.js` "ACCEPTANCE 9" |
| 10 | Send UI states duration and phases; screenshots light + dark | `hyg-perio-26a/26b/26c`, six PNGs |

**Tests added: 71** — 41 shared/unit, 9 send-route, 5 writer, 4 read-back,
9 page, 3 screenshot dumps.

### 6.1 Existing tests that changed, and why none is a weakening

| test | change |
| --- | --- |
| `odPerio.test.js` "recession is out of v1 scope and draws nothing" | v2 **is** in scope now; replaced with MGJ, which still is not, plus four new read-back tests |
| `odPerioWriter.test.js` `Mobility → SEQUENCE_TYPE_NOT_ALLOWED` | Mobility is an allowed **type** now and that row is refused for its **shape** instead; `CAL`, `Recession` and `MGJ` added to the never-allowed list |
| `hyg-perio-numpad.test.ts` two action-shape assertions | `{type:"depth"}` → `{type:"number"}` |

---

## 7. Gates

| gate | result |
| --- | --- |
| `node scripts/shard-runner.mjs` | 4/4 green, 2969 tests, 2966 pass, 0 fail, 3 skipped |
| `node --check server.js` | clean |
| `pnpm run check` | clean |
| `pnpm run test` | 2186 pass, 0 fail |
| `HYG_SHOTS=1` perio shots | 22/22, photographed light + dark |
| no `any` | none added |
| migrations | none |
| OD writes | `odPerioWriter.js` only (`OD_WRITE_LAYER` unchanged as a list) |

## 8. Push, PR, and the merge tree

**PR #220**, `feature/hyg-perio-v2-build` -> `develop`. Not merged.

PR #218 — this branch stopped at the §0 gate — was MERGED while the build was in
progress, so this is a fresh branch cut off current `develop` with the four build
commits rebased onto it, rather than more commits on a dead branch.

CI builds `refs/pull/N/merge`, not the branch tip, so the trees were compared
rather than assumed:

```
git rev-parse HEAD^{tree}                         3ffb923f236c834ad9b7970de9df34867aa8dae4
git rev-parse refs/pull/220/merge^{tree}          3ffb923f236c834ad9b7970de9df34867aa8dae4
git rev-list --count HEAD..origin/develop         0
```

The §7 gates were re-run on the rebased tree before the push, and again after
this section was added.
