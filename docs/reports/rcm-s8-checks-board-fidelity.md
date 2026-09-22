# RCM S8 — the Checks list and the check page, to the board

**Branch** `feature/rcm-s8-checks-board-fidelity`, cut from `origin/develop` at `afb0650`.
**Scope** `new-dashboard/` only. No backend file, route, slug, column, office key or state
machine changes. No endpoint is added or called that these two screens did not already call.

**No word budget was re-pinned.** Both screens pass their pinned budgets as shipped:
the Checks list at **100 / 100**, the check page at **464 / 480** (it went *down* 8).

---

## Pre-flight

| Check | Result |
| --- | --- |
| S8-Today (PR #181) on `origin/develop` | merged as `b66927e`; `function leftOffRows` present in `RcmToday.tsx` |
| `tests/rcm-smoke.test.tsx` green locally | 103 passed, before a line was changed |
| `tsc --noEmit` | clean on the fresh worktree |

---

## What changed

### Checks list (`RemittanceList.tsx`)

| Artboard element | Before | After |
| --- | --- | --- |
| Title "Checks" | present | unchanged |
| Top-right secondary button | "Add a check →", sharing a column with the tabs; under the long lede that column wrapped and landed mid-page | **"Add a check on Today →"**, top-right across from the title; still `/rcm?add=1` — Today stays the single upload home |
| Tabs with counts | Needs attention · Saved for tomorrow · Set aside · All, each with a whole-office count | **unchanged in content**; moved to a row of their own directly over the hint that describes the selected tab |
| Table | PAYER / CHECK (stacked) · DATE · AMOUNT · CLAIMS · STATUS (filled pill) · WAITING ON | **PAYER · CHECK NUMBER · AMOUNT with RECEIVED under it · CLAIMS · STATE (dot + phrase) · WAITING ON** |
| Footer teaching line | present, word for word | unchanged |
| Per-tab teaching empty states | present | unchanged; sweep (h) still judges them |

The received date is `depositDate`: the carrier's own payment date. That's the same value the
check page's header already calls "received", and it's dropped rather than faked when the
carrier sent none. It's a separate element under the amount, not the artboard's squashed
`$1,284.60Aug 28`.

**No tab was dropped.** All four map to existing views: `attention` and `all` are server
views, and `parked` and `set_aside` are served by the same route's whole-office counts
(`needsAttentionCount`, `parkedCount`, `setAsideCount`, `total`).

### Check page (`RemittanceDetail.tsx`, `RcmStepper.tsx`, `flow.ts`)

| Artboard element | Before | After |
| --- | --- | --- |
| Breadcrumb Checks / payer | Today › Checks › payer | unchanged |
| Title | payer, with "Check 830200001" on a line of its own below the money line | **payer · check number** in one title; the separate line goes. An EFT keeps a small "EFT" marker, because that one is a different fact rather than a repeat |
| Subtitle | amount · received date · N claims | unchanged |
| Header actions | one primary (the next step) top-right; Save for tomorrow · Set aside directly under the header | unchanged — see "what a pinned rule refused" |
| The stepper | a compact strip of five marks, then the five status lines as a list with each step's name printed again | **a board**: five columns, each with its mark, its name once, and its status line. **Filled with a tick = done, a ring = you are here, dashed = not yet** |
| Claims table state | filled pill | **dot + phrase**, same words |
| Where the patient stands | verdict sentence verbatim; "Not judged yet — match it up and check it over" for an unjudged claim | verdict sentence verbatim (untouched); **"EOB says $X"** for an unjudged claim |

The stepper's board is a `variant` prop used only by the check page. The claim page and
Posting keep the compact rail. The `step-<name>` and `step-note-<name>` testids and the
`flow` object are the same in both variants.

**The posted terminal layout is byte-untouched.** `PostThisCheck.tsx`, `PostedOutcome.tsx`,
`RecoupmentPanel.tsx`, `PermanentPathConfirm.tsx`, `posting.ts` and `verdictBlock.ts` have
no diff on this branch. That covers the W-16 family, the proof block, the D-17 typed
takeback and the Q2 confirm. What a posted check does get is the new header and the board
stepper above those panels, which are page chrome shared by every state of the check.

---

## The five step status sentences

Every sentence is from data the page already had. Two changed and three are the shipped
sentences, kept.

| Step | Sentence on the board | Source | Changed? |
| --- | --- | --- | --- |
| Bring in (done) | "The carrier's 835 file read Mar 5, 8:00 AM." / "EOB PDF read …" | `remittance.createdAt` via `officeStamp` — office-zone date **and time** | **yes** — was date only (`officeDay`). Zero prose-word cost: times and month abbreviations are not prose |
| Match (done) | "All 3 claims found in Open Dental." | claim match statuses | no |
| Decide (current) | **"2 of 3 claims checked over · not finished until you approve."** | `claims.length − unreviewed`, over `claims.length` | **yes** — was "1 claim still needs a note and a Mark checked over." It now states progress **and** the gate, as the artboard asks. The how (a note, then *Mark checked over*) is on each claim's own page, where it is done |
| Post (todo / current) | "Approve the check first." · when shadowed: "Switched off while shadow mode is on. Approved checks wait here." | posting queue state + the shadow flag | no — the shadow wording was already the artboard's, plus its shipped second sentence |
| Deposit | "Coming soon." | fixed | no — the shipped coming-soon wording |

Stage names are the shipped `RCM_STEP_TITLES` (Bring in · Match · Decide · Post to Open
Dental · Deposit), **not** the artboard's names.

---

## Budget math

Pinned budgets in `tests/rcm-smoke.test.tsx` `SCREENS`, counted as chrome prose words (rows
and identifiers excluded). Measured with
`RCM_INVENTORY=1 npx vitest run tests/rcm-smoke.test.tsx`; the inventory row is committed
in `docs/rcm-s7-inventory-measured.md`.

| Screen | Before | After | Budget | Re-pinned? |
| --- | ---: | ---: | ---: | --- |
| Checks list | 98 | **100** | 100 | **no** |
| Check page | 472 | **464** | 480 | **no** |
| Posted / Done (the check page, posted) | 264 | 256 | 270 | no |
| Stuck / Failed (the check page, stuck) | 502 | 494 | 510 | no |
| Shadow worksheet (the check page, shadowed) | 348 | 340 | 350 | no |

### Where each word went

**Checks list, +2.** The button's "on Today". The tabs, the footer line and the WAITING ON
header were already on the screen before this slice, and table headers sit in an
`md:grid` row the budget never counts, so the column changes cost nothing. The list
therefore fit inside its pinned 100 **without a cut and without the pre-authorised
re-pin**. It now has **zero headroom**: the next word on this screen must be paid for
by deleting one.

**Check page, −10 on the takeback render, −8 on the worst-case render.** Word by word, from a
diff of the rendered chrome before and after:

| Change | Prose words |
| --- | ---: |
| The board names each step once; the rail printed all five names twice | −8 |
| "Check" prefix on the old check-number line (the number moved into the title) | −1 |
| Decide: "claim still needs a note and a Mark checked over" (10) → "of claim checked over · not finished until you approve" (9) | −1 |
| Bring in: date → date and time | 0 |
| **Net on the takeback render** | **−10** |

The inventory's 472 → 464 is the maximum across all 47 renders of the page in the walk.
The render that is worst-case after the change dropped 8, not 10.

---

## Sentences derived, and data wants

| Element | What it says now | Derived from | Want |
| --- | --- | --- | --- |
| WAITING ON — work owed | "You — 4 claims to check over", "You — it is ready to approve" | `waitingFor()` (shipped) | — |
| WAITING ON — another office | "Nobody — belongs to another office" | `waitingFor()` (shipped) | — |
| WAITING ON — **finished** | "Nobody — nothing outstanding" (the artboard: "Nothing — finished at 6:58 pm") | the list row carries **no posted or finished stamp**; `waitingFor` reaches its `posted` state only when the screen passes `confirmedAt`, and the list has none to pass | **add a `postedAt` (or `confirmedAt`) to the remittance list row**, and the shipped `posted` sentence ("Nobody — it is posted", with the time) becomes reachable from the list |
| Where the patient stands — unjudged | "EOB says $450.00" | `claim.patientBalanceCents` — the EOB's own claim-level patient-responsibility figure, read straight off the row; nothing is computed in the cell | **carry `eobPatientCents` for unjudged claims** too. The verdict's figure is the sum of line remainders, and the claim-level figure normally agrees but is a separate field. Carrying the verdict module's own number would make the column literally one arithmetic in both registers |
| Bring in (done) | "…read Mar 5, 8:00 AM." | `createdAt` via `officeStamp` | none — note `officeStamp` omits the year, as every other stamp on the rail already does |

---

## What the artboard asked for that a pinned rule or ruling refused

| Artboard | What shipped instead | The rule |
| --- | --- | --- |
| Save for tomorrow · Set aside · primary **in one header row** | The primary stays top-right in the header; the two quiet actions stay on their own row directly beneath it, unchanged | Stage C §8: their panels open **anchored to their own buttons, in normal flow, pushing the page down** — never covering the claim list. In a right-hand header column those panels would open a third of the page wide. `CheckWorklistActions.tsx` is untouched |
| "Nothing — finished at 6:58 pm" | "Nobody — nothing outstanding" | No invented data: the row has no stamp to put in the sentence (see data wants) |
| Stage names as drawn on the artboard | the shipped `RCM_STEP_TITLES` | The brief's own ruling: keep the shipped names |
| WAITING ON strictly "WHO — WHAT" | Two shipped sentences name a thing rather than a person: "A takeback — money the carrier is reclaiming", "Shadow mode — posting is switched off" | Not a copy rewrite beyond what the brief names. Both are true, and both are the takeback and shadow states the rest of the module words the same way. Listed so the owner can rule on them separately |

---

## Expectations changed, and their mutation proofs

Five expectations changed, all because the words they pinned changed. Each still guards the
same property. Each was proved by breaking that property, watching it go red, and
reverting (`git checkout -- <file>` to the committed state; the diff was empty afterwards).

| Test | Pinned before | Pins now | Mutation | Result |
| --- | --- | --- | --- | --- |
| `rcm-flow.test.ts` › lights exactly one step | review note contains "note and a Mark checked over" | contains "0 of 1 claim checked over · not finished until you approve." — **the reading sentence survives demotion** | unreviewed branch returns `detail: null` | **RED** (with the next test): 2 failed / 44 passed |
| `rcm-flow.test.ts` › names the READING before the imbalance | contains "Mark checked over" | contains "checked over · not finished until you approve." **and not** "does not balance" | (a) `if (f.unreviewed > 0 && f.balanced)` — imbalance outranks reading | **RED** on the state line: *expected 'blocked' to be 'current'* — 1 failed / 45 passed |
| | | | (b) keep `current`, append " This check does not balance." — so the NEW negative line is proved on its own | **RED**: *expected '0 of 1 claim checked over · not finis…' not to contain 'does not balance'* — 1 failed / 45 passed |
| `rcm-smoke.test.tsx` › 1.4 the check's page | stands cell contains "Not judged yet" | stands cell **is** "EOB says $450.00"; muted tone, no verdict colours (unchanged lines) | the unjudged cell guesses a verdict: "Will owe $X — matches the EOB." | **RED** |
| `rcm-stage-c.test.tsx` › …when the gate has nothing | contains "Not judged yet" | is "EOB says $450.00" | same mutation | **RED** |
| `rcm-ui-s3.test.tsx` › …a claim the gate skipped | contains "Not judged yet" | is "EOB says $0.00" | same mutation | **RED** — all three together: 3 failed / 152 passed |

Each pinned amount is the fixture's own `patientBalanceCents` (45000, 45000, 0), which is
the evidence that the cell reads the field and computes nothing.

**One more mutation, for a budget that is now full.** The Checks list sits at exactly 100 of
100, so one extra word ("Add a check on Today **now**") was added to show the sweep
bites at the ceiling: **RED** — *"Checks list says 101 prose words; its budget is 100."*
Reverted.

### Other test-file changes (no expectation)

- `rcm-stage-c-shots.test.tsx` gains a `stagec-03b-checks-empty-tab` dump for the
  screenshots. It's skipped unless `RCM_SHOTS=1` and asserts only that the empty panel
  rendered.

---

## One refactor outside the two screens

`STATE_DOT` (the state → dot colour map S8-Today added privately in `RcmToday.tsx`) moved
to `features/rcm/worklist.ts`, beside `CHECK_CHIPS`, and both Today and the Checks list now
import it. The reason: the Checks list draws the same dots, and two copies of the map would
let one state be amber on one screen and grey on the other. `RcmToday.tsx`'s only change is
that import. For the claims table, `MATCH_STATUS_DOT` joins `MATCH_STATUS_TONE` in
`format.ts` for the same reason.

---

## Constitution check

| Rule | Status |
| --- | --- |
| One primary per screen | Checks list: 0 (unchanged; its one solid control is in the no-checks-ever empty state). Check page: 1, the header's next step |
| Chip + phrase ≤ 8 | unchanged — no card face gained words |
| Banned words · reason-less greyed button · match summaries account for every claim · office keys never render | sweeps green on every screen visit in the walk |
| Machine slugs, routes, columns | frozen — no route, `?view=` value, testid prefix or API field changed |
| Fictional names only | every screenshot and fixture is synthetic |
| Teaching empty states | both still produce and pass sweep (h); the list's empty tab is photographed |

---

## Verification

| Gate | Result |
| --- | --- |
| `pnpm run check` (`tsc --noEmit`) | clean |
| `pnpm run test` — full frontend suite | **109 files passed, 19 skipped · 1749 tests passed, 122 skipped, 0 failed** |
| `tests/rcm-smoke.test.tsx` | 103 passed |

---

## Screenshots

Light, 1280 wide, from the Stage C jsdom dumps through the app's real built CSS.
`new-dashboard/scripts/shoot-s8-checks.mjs` writes only these six. The **before** pictures
were shot from develop's own versions of the screen files, which were then restored.

```
pnpm exec vite build
RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c-shots.test.tsx
node scripts/shoot-s8-checks.mjs before|after
```

| Screen | Before | After |
| --- | --- | --- |
| Checks list, populated | [before-checks-populated.png](../screenshots/rcm-s8-checks/before-checks-populated.png) | [after-checks-populated.png](../screenshots/rcm-s8-checks/after-checks-populated.png) |
| Checks list, empty tab | [before-checks-empty-tab.png](../screenshots/rcm-s8-checks/before-checks-empty-tab.png) | [after-checks-empty-tab.png](../screenshots/rcm-s8-checks/after-checks-empty-tab.png) |
| Check page | [before-check-page.png](../screenshots/rcm-s8-checks/before-check-page.png) | [after-check-page.png](../screenshots/rcm-s8-checks/after-check-page.png) |

The frame heights were sized to the *after* markup, and the old check page is taller, so
its *before* picture is cropped below the first claims. The header and stepper — the
comparison that matters — are fully in frame. The check-page fixture has every claim judged,
so "EOB says $X" appears in the tests rather than in these pictures.
