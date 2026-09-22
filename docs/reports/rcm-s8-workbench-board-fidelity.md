# RCM S8 — the match step and the workbench, to the board

**Branch** `feature/rcm-s8-workbench-board-fidelity`, cut from `origin/develop` at `587d8fa`.
**Scope** `new-dashboard/` only. No backend file, route, slug, column, office key or
state machine changes. No endpoint is added or called that the claim page did not already
call. Light theme only; the dark-mode artboard is out of scope.

**No word budget was re-pinned.** The claim page (Match and the workbench are one screen,
`ClaimMatch`) measures **422** against its pinned **430**, down from 426. It still renders
exactly **one** primary. The pre-authorised capped re-pin was not needed and not used.

---

## Pre-flight

| Check | Result |
| --- | --- |
| S8 slice A (PR #186) on `origin/develop` | merged as `587d8fa` |
| `STATE_DOT` exported from `features/rcm/worklist.ts` | present |
| The check-page stepper with per-step sentences (`variant="board"`) | present in `RcmStepper.tsx` |
| `tsc --noEmit`, `rcm-smoke` | clean, 103 passed, before a line was changed |

---

## What changed

### Match (`MatchGuidance.tsx`, `matchWords.ts`)

| Artboard element | Shipped |
| --- | --- |
| "Match it up" + context + "Claim 1 of 2 that needs you" | **Built.** A title row on the guidance block for an unlinked claim: "Match it up · 1 of 2 claims matched · 1 needs you", and opposite it "Claim 1 of 1 that needs you". It's counted off the check's own claim list, from the read the pager already makes, and dropped when that list isn't loaded. Payer and check number are on the page's new header rail. The wording is **"matched", not "found on their own"** (see refusals). |
| Confident: "Found it — one claim in Open Dental fits this one perfectly." | **Built, and only when true:** the carrier's claim number agrees (the scorer's `CLAIM_NUMBER_MATCH` tag) **and** nothing compared differs. A clear leader with an amber field keeps the shipped "This looks like the one". |
| EOB card beside a green-accented OD card, same fields | **Built.** Patient · Born · Subscriber · Service date · Lines · Billed on both. The OD card is green-edged and titled "Open Dental claim N", with a ✓ on the title when the claim number agrees. |
| Agreement sentence | unchanged (`agreement()`) |
| Confirm + "Show me other claims" | unchanged: one solid, one outline |
| Unsure: "Not sure about this one — N claims could be it." | **Built**, counted from the snapshot |
| EOB summary line | **Built:** "The carrier sent: name · date · billed · N lines" |
| Candidate cards: field rows, ✓ or amber difference | **Built.** Patient / Service date / Billed / Lines, each the value with a ✓, or the `differences()` phrase in its place ("Jul 21, 2026 — 6 weeks earlier", "$156.00 — $54.00 less billed") |
| "Neither of these?" with patient search | the panel and its sentence are unchanged; **no search** (see refusals) |
| Footer teaching line | unchanged, word for word |

### Workbench (`ClaimWorkbench.tsx`, `ClaimMatch.tsx`)

| Artboard element | Shipped |
| --- | --- |
| Header rail: payer · check · amount · received · Claim N of M · Save for tomorrow | **Built.** The way back names the check it goes to. The pager and Save for tomorrow moved up from a strip between the verdict and the panels. "Claim 2 of 2 on this check" is now "Claim 2 of 2". |
| Patient line: name · DOB · subscriber; CARRIER PAID THIS CLAIM / EOB SAYS PATIENT OWES | **Built.** DOB and subscriber are the detail read's `patientDob` / `subscriberId`, each dropped when absent. The owes figure is the same expression the old fact strip used: the verdict's `eobPatientCents`, or the claim's patient balance before there is a verdict. |
| Left panel "What the carrier said, and what you decide", one row per line | **Built** as a table: code + name / BILLED / ALLOWED / PAID / CONTRACT W/O / PATIENT OWES / YOUR DECISION, plus a **claim-total** row from the claim's own totals. Nothing is summed in the browser: the contract total is the verdict's `contractualWriteOffCents`, and a dash before there is a verdict. |
| "Nothing to decide — the carrier paid it in full." | unchanged |
| The decision, no amount inputs | unchanged: the same two buttons with computed amounts, now stacked in their column |
| Footnote: contract w/o is Billed − Allowed, not a choice | **Built**, once under the table. It replaces the per-line sentence "Contract write-off $X — the carrier's, already accepted." |
| Reason picker IN PLACE under its row | **Built** as the line's own sub-row: the five canned reasons, then the audit sentence |
| Audit sentence "Written off whole — $X. The patient is never billed for this line. Decided by <name>, <time>" | **Built**, with the reason kept in it: "Written off whole — $30.00 (X-rays — bitewings). The patient is never billed for this line. Decided by Billing User, Aug 30, 9:20 AM." |
| Right panel "What Open Dental has": SAME PATIENT? + per-field agreement mark | **Built.** One heading over the identity compare and the chart claim, "Same patient?" on both identity states, and a ✓ on every field the identity compare marks `agrees`. The identity evidence stays on this screen. |
| OD claim card, per-code fee billed / ins est / **pt est** | fee billed and ins est unchanged; **no pt est** (see wants) |
| Freshness "Read from Open Dental <n> ago" | **Built** via a new zone-free `readAgo()` in `time.ts`. The rest of the sentence ("re-checked again before anything is written") is unchanged. |
| Disagreeing OD fee highlighted, with its explanation | unchanged (already shipped) |
| Verdict band across the bottom, verdict module verbatim | **Built.** The same `VerdictLine`, moved from the top to a band under both panels. Its strings, registers, figures and arithmetic have **no diff**. |
| Band holds the primary; "Next: claim N+1 of M — <name>" under it | **Built.** The next step's one control is drawn by `RcmPrimaryAction` (the check header's component, same testids) inside the band; the rail draws none. "Next: …" prints only under an **enabled** control. |
| RED: the greyed control with its reason printed beside it | **Built.** On red it's the greyed "Approve for posting" with the verdict's reason beside it. **Not** a greyed "This claim is checked over" (see refusals). |
| RED: "Read the claim again" | **not built** (see refusals) |
| "See the EOB image" one click away | unchanged ("Open the EOB", still one click) |

The stepper on this page takes the `board` variant the check page uses: five columns, each
step's name once.

### Rider (one string)

`waitingFor()`'s takeback **waiting-on** sentence, the Checks list's register:
"A takeback — money the carrier is reclaiming" → **"You — a takeback, money the carrier is
reclaiming"**. That's eight prose words, at the row-face limit. Today's `next` register
("The carrier is reclaiming money.") and the shadow-mode sentence are unchanged. Nothing
else in `waitingOn.ts` moved.

---

## Budget math

The claim page's budget is pinned at **430** in `tests/rcm-smoke.test.tsx` `SCREENS.claim`.
It's measured as chrome prose words, the maximum over every render of the page in the walk.

| Stage | Claim page | Budget |
| --- | ---: | ---: |
| Before (develop `587d8fa`) | **426** | 430 |
| After the workbench layout | 401 | 430 |
| After the match layout | 418 | 430 |
| **Final** (the Lines-row and "needs" fixes) | **422** | 430 |

The Checks list stays at **100 / 100**: the rider sits in list rows, which the budget
excludes. The check page and Today are unchanged.

### Where the words went, from a diff of the measured chrome before and after

| Change | Effect |
| --- | --- |
| Stepper board variant: each step's name printed once instead of twice | −8 |
| "Back to the remittance — Approve is there" → the check's own payer · check · amount · received | −5 |
| "Claim 2 of 2 on this check" → "Claim 2 of 2" | −3 |
| **The carrier's lines are table rows now.** Per-line labels, the per-line contract sentence, "Nothing to decide…", "Bill the patient / Write it off" are data in `<tbody>` rows | the largest cut; see the note below |
| Unlinked caution: once over the table instead of once per line | − one copy per extra line |
| Table header + claim-total label + contract footnote | + |
| "What the carrier said" → "What the carrier said, and what you decide" | +4 |
| CARRIER PAID THIS CLAIM / EOB SAYS PATIENT OWES | +8 |
| "Is this the right patient?" → "Same patient?" | −2 |
| "Match it up" row: title, progress, "that needs you" | + |
| Unsure heading, counted; "The carrier sent:" summary line | + |
| Card field rows (Patient, Service date, Billed, Lines) replacing "Nothing this app can compare differs from what the carrier sent." | ± per card |

> **Read this before approving the number.** The smoke budget governs *chrome*: it removes
> `tbody tr` and list-row testids before counting, and says so in its own header ("the
> repeating row/card faces are governed separately"). Putting the carrier's lines in a
> real `<table>` makes each line's labels, contract sentence and decision buttons per-row
> data. That is a large part of the 426 → 401 drop. It follows the budget's own
> definition, and it's the same rule the Checks and Today tables have always had. But it
> is a structural reclassification, not a word diet, and a reviewer should see it named
> rather than find it.

---

## Differences: derived from the scorer's data, and wants

The match cards mark only what the matcher already compares. `fieldReadings()` in
`matchWords.ts` is the per-field form of the existing `differences()` and `agreement()`,
built only from them and the scorer's `CLAIM_NUMBER_MATCH` evidence tag. A new suite,
`tests/rcm-match-fields.test.ts`, pins that a ✓ appears only where the agreement sentence
would name the field.

| Field | ✓ from | Amber sentence from | Status |
| --- | --- | --- | --- |
| Claim number | `CLAIM_NUMBER_MATCH` evidence tag (server's own) | — (the Q2 named-difference confirm says it) | **derived** |
| Patient name | both sides carry it, no `name` difference | "a different patient's name" | **derived** |
| Service date | both sides carry it, no `date` difference | "Jul 21, 2026 — 6 weeks earlier" | **derived** |
| Billed | both sides carry it, no `amount` difference | "$156.00 — $54.00 less billed" | **derived** |
| Lines | every carrier line paired to a chart line (`linePairs`) | "N lines with nothing to match in the chart" | **derived**. Printed as "2 of 2" (paired of sent), the compared fact itself |
| Date of birth | — | — | **want.** The scorer doesn't compare a birthday at the match step. Both sides print it, and neither gets a mark. |
| Subscriber id | — | — | **want.** The scorer doesn't compare a member number at the match step. Printed, not marked. |

### Other data wants

| Want | Why it isn't here |
| --- | --- |
| **A read-only re-read of the linked chart claim** (refresh `chart` without releasing the link) | "Read the claim again". The claim detail (`GET /claims/:id`) reads only CareIN's own tables; the only path that reads Open Dental for a claim is the match, and on a linked claim that **un-links** it (`force: true` nulls `od_claim_num`). The shipped red reason already says "…and read the claim again", so the want has a sentence waiting for it. |
| **A patient-estimate column** for each chart line | The OD claim card's "pt est". `ClaimChart.lines` carries fee billed, insurance estimate, insurance paid and write-off, and no patient estimate. Deriving one (fee − estimate − write-off) would be arithmetic this screen doesn't do. |
| **A patient/claim search on the RCM lane** | "Neither of these?" with the existing patient search. `/api/rcm` has no search (Stage C §15.1c), and the searches that exist live in other modules behind their own entitlement gates. |

---

## What the artboard asked for that a pinned rule refused

| Artboard | Shipped instead | The rule |
| --- | --- | --- |
| **Three solid buttons** on the match artboard | one solid on the whole screen: the current claim's best action. On the confident block that's "Yes, that's the one"; every "This is the one" card stays outline. On the **unsure** block **none** is solid. | One primary per screen, which the brief itself says wins. The unsure case is the S7 ruling: painting a recommendation over a candidate list the app deliberately didn't rank would assert something the match never said. |
| RED: a **greyed "This claim is checked over"** | On red, checking over stays **enabled**. What greys is **Approve**, with the verdict's reason printed beside it. | Greying the review act on red would change what a person may do on a red claim. That's a state-machine change the brief rules out, and it contradicts S4: a red verdict blocks *approving*, not *reading*, and reading the claim that doesn't line up is exactly the work. |
| **"Read the claim again"** on red | not drawn; the existing "Match it up again" stays in the Open Dental panel with its un-link warning | No read path exists that re-reads without releasing the link; see wants. Drawing the button over the match call would put a write to our own state (un-linking) behind a label promising a read. |
| **Patient search** in "Neither of these?" | the shipped sentence and the "save the check for tomorrow" link | No search endpoint on this lane; see wants. `rcm-ui-s3` and the smoke walk both pin that this panel has **no input**. |
| "4 of 6 claims **found on their own**" | "4 of 6 claims **matched**" | Review-then-send: nothing in this module confirms a match without a person pressing a button, so no claim is ever "found on its own". |
| Dark-mode artboard | light only | Out of scope; its own theming slice later. |

---

## Expectations changed, and their mutation proofs

Every change below keeps what the test guarded. Each was proved by breaking the guarded
thing, watching it go red, and restoring (a byte-compare of the file afterwards).

| Test | Pinned before | Pins now | Mutation → result |
| --- | --- | --- | --- |
| `rcm-waiting-on`, `rcm-shell` ×2, `rcm-smoke` 2.1, `rcm-stage-c` (the rider) | "A takeback — money the carrier is reclaiming" | "You — a takeback, money the carrier is reclaiming" | source reverted to the old sentence → **5 failed / 182 passed** across the four files |
| `rcm-stage-c3` › cautioned in plain words, and still allowed | `decision-unlinked-pl-1` | `decision-unlinked`, exactly **once**, and before the first write-off button | (a) caution never shown → **red**; (b) caution printed twice → **red** ("Found multiple elements") |
| `rcm-stage-c3` › says nothing once linked | `queryByTestId("decision-unlinked-pl-1")` null — **which had become vacuous**: the per-line testid no longer existed, so it could not fail | `queryByTestId("decision-unlinked")` null | caution shown even when linked → **red** |
| `rcm-verdict` › contractual write-off is the carrier's, no control | "Contract write-off $50.00" + "the carrier's, already accepted" | cell is exactly "$50.00" with no control in it; footnote says "The contract requires it" and "not a choice" | (a) footnote drops "not" → **red**; (b) a button put in the cell → **red** |
| `rcm-verdict` › a decided line says what, by whom | "The office is absorbing $20.00" (+ reason, name) | "Written off whole — $20.00" + "The patient is never billed for this line." (+ reason, name unchanged) | stamp reverted to the old wording → **red** |
| *new* `rcm-match-fields` (6 tests) | — | a ✓ only where both sides were compared and agreed; DOB/subscriber have no key | "agrees" whenever nothing differs, compared or not → **2 red** |

Each mutation turned red **only** the test it guards.

### Test files touched with no expectation change

- `rcm-stage-c3-shots.test.tsx` adds `s8-match-ambiguous`, and `rcm-ux-shots.test.tsx` adds
  `s8-bench-amber-picker`: the two screenshot states no suite dumped. Both are skipped
  unless `RCM_SHOTS=1`, and each asserts only that its state rendered.

---

## Three honesty fixes found while building, all in the diff

1. **A snapshot without the chart's lines crashed the claim page.** Reading
   `od.lines.length` threw, and the whole evidence screen went blank (caught by
   `rcm-disabled-reasons`). The Lines row no longer reads that field.
2. **"0 ✓".** The first draft printed the chart claim's own line count beside a ✓ earned by
   line *pairing*, so an older snapshot read "0 ✓", a value contradicting its own mark. The
   row now prints the compared fact: paired of sent, "2 of 2".
3. **"0 of 0".** With no pairing on the snapshot at all, that read as a claim with no lines.
   It now reads "not recorded", which is also exactly when no ✓ is drawn. This was found by
   diffing the claim page's measured prose before and after.

---

## Protected, untouched

`MatchAnywayConfirm.tsx` (Q2 named-difference confirm), `PermanentPathConfirm.tsx` and
`RecoupmentPanel.tsx` (D-17 typed takeback), `PostedOutcome.tsx` and `PostThisCheck.tsx`
(W-16, the proof block), `verdictBlock.ts`, `posting.ts`, and everything under `backend/`:
**no diff** against `587d8fa`. `VerdictLine` moved position; its body has no diff.

---

## Verification

| Gate | Result |
| --- | --- |
| `pnpm run check` (`tsc --noEmit`) | clean |
| `pnpm run test`, full frontend suite | **110 files passed, 19 skipped · 1755 tests passed, 123 skipped, 0 failed** |
| `tests/rcm-smoke.test.tsx` | 103 passed |
| Claim page, measured | **422** prose words / 430 · **1** primary |

---

## Screenshots

Light, 1280 wide, from the C-3 and UX jsdom dumps through the app's real built CSS.
`new-dashboard/scripts/shoot-s8-workbench.mjs` writes only these ten. The **before**
pictures were shot before any screen file changed. Every patient in them is a designated
test fixture.

```
pnpm exec vite build
RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c3-shots.test.tsx tests/rcm-ux-shots.test.tsx
node scripts/shoot-s8-workbench.mjs before|after
```

| State | Before | After |
| --- | --- | --- |
| Match, confident | [before-match-confident.png](../screenshots/rcm-s8-workbench/before-match-confident.png) | [after-match-confident.png](../screenshots/rcm-s8-workbench/after-match-confident.png) |
| Match, unsure | [before-match-ambiguous.png](../screenshots/rcm-s8-workbench/before-match-ambiguous.png) | [after-match-ambiguous.png](../screenshots/rcm-s8-workbench/after-match-ambiguous.png) |
| Workbench, green | [before-workbench-green.png](../screenshots/rcm-s8-workbench/before-workbench-green.png) | [after-workbench-green.png](../screenshots/rcm-s8-workbench/after-workbench-green.png) |
| Workbench, amber, picker open | [before-workbench-amber-picker.png](../screenshots/rcm-s8-workbench/before-workbench-amber-picker.png) | [after-workbench-amber-picker.png](../screenshots/rcm-s8-workbench/after-workbench-amber-picker.png) |
| Workbench, red | [before-workbench-red.png](../screenshots/rcm-s8-workbench/before-workbench-red.png) | [after-workbench-red.png](../screenshots/rcm-s8-workbench/after-workbench-red.png) |

The C-3 fixture's check is from a real carrier (the payer name only, which is not patient
data), and it carries a green verdict on a claim that isn't linked yet; both are fixture
choices from Stage C-3, left as they were.
