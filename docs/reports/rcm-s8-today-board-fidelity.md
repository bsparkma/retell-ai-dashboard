# RCM S8 — Today, to the board

**Branch** `feature/rcm-s8-today-board-fidelity`, cut from `origin/develop` at `190e0ff`.
**Scope** `new-dashboard/` only. No backend file is touched, no route, slug, column, office
key or state machine changes, and no endpoint is added or called that Today did not already
call. Everything below is layout, type, spacing and chip styling over the data the screen
already loads.

---

## Pre-flight

S7 (PR #174, *Give every screen one next step, and name the stages the owner's way*,
merged as `1bd9756`) is on `origin/develop`:

| Check | Result |
| --- | --- |
| `RCM_STEP_TITLES` exists | `new-dashboard/client/src/features/rcm/flow.ts:197`, read by Today's legend |
| `tests/rcm-smoke.test.tsx` green locally | 103 passed, before a line was changed |
| Today's prose near 89/90 | measured **89** against a budget of **90** on the untouched branch |

The slice went ahead.

---

## What changed, section by section

| Artboard section | What it was | What it is now |
| --- | --- | --- |
| App bar | wordmark · Today / Checks / Set aside · shadow pill · user · office | **unchanged — it already matched** (see "the app bar" below) |
| Greeting header | `text-2xl` bold, date stacked underneath | `text-3xl` **light**, date right-aligned on the same baseline |
| Where you left off | a bordered box holding a stacked list of rows | a **row of cards**, 3 across at `lg`; card 1 emphasised (heavier border) and carrying the page's one filled button — a black pill reading *Pick up where you left off* |
| Parked cards | a blue "Saved" pill beside the payer; *Bring it back to tonight* as a second outlined button | overline **SAVED FOR TOMORROW**, then payer · check number, then amount · claims · state, then the note in quotes, then an **underlined text link** *Bring it back to tonight* |
| What came in | heading alone; 5 columns | heading with a right-aligned **See every check** link; **6 columns** — a new **STATE** column of dot + phrase chips |
| Get work in | two bare columns inside the fold | two **wide dashed-border drop-zone cards** side by side |
| Stats | an all-caps *How it stands* heading over six bordered boxes in two rows | a **footer stat strip** — small-caps label over value, ruled off, no boxes and no icons |

### The app bar needed nothing

The artboard's app bar is already what ships. `DashboardLayout.tsx` renders the CareIN
wordmark, the Today / Checks / Set aside items (`:148-159`), the identity pair
`Dana · Roland` (`rcm-header-identity`, `:746`) and the quiet pill reading exactly
*"Shadow mode — nothing is sent to Open Dental yet"* (`rcm-shadow-pill`, `:770`). No shell
file was edited, which is also what keeps this slice Today-only.

**Ruling 1 — Activity is kept, demoted.** *Posting history* (`/rcm/posting`) is still a
first-class route. It is appended to the end of the Revenue Cycle nav group after the
permission filter and gated on `admin.all` (`DashboardLayout.tsx:254, :409`) — last in the
list, hidden from people who cannot act on it, reachable by URL for everybody. That is the
demotion the artboard implies, and it was already in place; nothing was done to it.

**Ruling 2 — D-16, one upload surface.** The two dashed cards are the *existing* ERA and
EOB panels given the artboard's border and padding. They are **not** a second dropzone and
they do **not** navigate: `/rcm/bring-in` redirects back to this very section (D-18), so a
card that navigated to "Bring in" would navigate to itself. `tests/rcm-shell.test.tsx`
still reads the source of every RCM page and fails if a second one imports a panel; it is
green.

**Ruling 3 — shadow mode** keeps the shipped semantics end to end: the header pill, the
per-office badge and hint on Today, and `waitingFor`'s *"Held while shadow mode is on."*
The `shadowMode` flag is now also threaded into the *Where you left off* cards, so a check
approved into a shadowed queue reads the same state there as it does in the table below.

**Ruling 4 — frozen.** No slug, route, column or office key changed. Office keys still
never render (the sweep that checks this is green). Every name in every fixture and
screenshot is synthetic — `SYNTHETIC DENTAL`, `SYNTHETIC HEALTH PLAN`, and the module's
designated test patients.

---

## The one primary button, and where it moved

The constitution pins Today to one primary, *"the resume card's"*. Before this slice the
one primary was `StartHere`'s **Start**; the artboard gives it to the resume card.

Both cards are kept. What changed is which one is painted solid:

- `leftOffRows(today)` is now a single shared function (`RcmToday.tsx`), read by **both**
  `LeftOff` and `StartHere`. It is the only place the list is decided.
- When it returns rows, card 1 gets `bg-foreground` and **Start** falls back to an outline.
- When it returns nothing, **Start** takes the fill back, exactly as it did before.

Deleting Start whenever a resume card exists would have removed the only route to the
*oldest waiting* check from the screen whose promise is that it names the next thing. A
weight change keeps both affordances and still leaves exactly one "press this one".

---

## Budget: what the artboard asked for, and what it cost

Today's whole-screen prose budget is pinned at **90** in `tests/rcm-smoke.test.tsx`
(`SCREENS.today`). The refreshed screen measures **89** and **passes the pinned budget.
The number was not raised.**

The artboard added four prose words and they had to be paid for:

| Change | Words |
| --- | --- |
| `STATE` column header | **+1** |
| *See every check* link | **+3** |
| *How it stands* heading, removed | **−3** |
| **Net** | **+1**, landing at 89 against 90 |

### Budget conflicts, and the shorter shipped copy that was kept

Three of the artboard's lines were **not** written, because the shipped copy is shorter and
the budget has one word of headroom. Each is tabled here rather than argued in the diff:

1. **"Drop the EOB PDF here" / "Drop the electronic payment file here" as always-visible
   card headlines.** *Get work in* is a `<details>` fold, closed on arrival (S7, Phase 2.4),
   and only its summary counts against the budget. Rendering the two zone headlines, their
   one-line subs and their buttons unfolded would cost roughly thirty prose words on every
   visit to a screen most visits do not upload from — and would blow the budget by a factor
   nothing in this brief authorises. The zones are drawn exactly as the artboard draws them;
   they are one click, or one `?add=1`, away. The shipped labels *An 835 file from the
   carrier* and *A scanned EOB or a payer portal download* are kept, unchanged.
2. **A time on the date line.** The artboard's header line is "date/time". `todayLongDate()`
   is kept and no clock was added: a rendered time would be a value that changes on every
   paint (and in every screenshot) for information the greeting itself already carries —
   *Good evening* is the time of day, in office-local Central, from `greetingFor()`.
3. **"you checked over M of them"** on the lead card — see *data wants* below; there is no
   reviewed-claim count on the row, so the card says the amount, the claim count and the
   state instead.

---

## Stat tiles we did not draw

The artboard's footer strip names three tiles. Two of them have no data source, so they are
**absent rather than approximated**. No number on this screen is hardcoded or inferred.

| Tile | Status | Why |
| --- | --- | --- |
| CHECKED OVER THIS WEEK | **not drawn as named**; the nearest real stat, *posted this week*, is drawn | "Checked over" is review, "posted" is posting. `listPostingQueue` serves `finishedAt`/`postedTotalCents` — posting. There is no per-week review count anywhere in the API, and labelling a posting count "checked over" would put a number a biller might quote beside a word it does not mean. |
| WRITTEN OFF BY THE OFFICE | **not drawn** | It lives on `PostingQueueLine.intendedWriteOffCents` — per LINE. The posting rows Today reads carry no lines. This is the same refusal `summariseTonight` already documents for the finished-evening card. |
| AVERAGE EVENING | **not drawn** | Nothing records a session start, and nothing aggregates evenings. The earliest posting that finished tonight is a different fact wearing the same sentence, and it is wrong on the commonest evening of all — one where she worked for an hour and posted nothing. |

Five tiles **are** drawn, all from real sources and all keeping their existing destinations:
*Waiting to be matched*, *Waiting for your review*, *Ready to post*, *Stuck — needs you*,
*Set aside*, plus *posted this week* on its own rule below them.

---

## Data wants for the backend

Each of these is a sentence the artboard asks for that the screen cannot honestly say today.

1. **A reviewed-claim count on the remittance row.** `Remittance` carries `claimCount`,
   `unmatchedClaimCount` and `queuedClaimCount`. None of them is "how many have been checked
   over": `queuedClaimCount` is how many were *approved into a posting plan*, which is a
   later step. Without a `reviewedClaimCount`, the lead card cannot say *"$480 · 2 claims ·
   you checked over 1 of them"*, and it says the state instead. **Ask:** add
   `reviewedClaimCount` to `BATCH_COLUMNS` in `routes/rcm/remittances.js`.
2. **A per-week review count per office**, for the *CHECKED OVER THIS WEEK* tile.
3. **A write-off total per check**, or per office per week, for *WRITTEN OFF BY THE
   OFFICE* — the figure exists per line and is not rolled up anywhere a list read can see.
4. **A per-user "last opened" stamp on a check.** Standing want, restated: *Where you left
   off* still infers from *parked* and *last decided/approved*, which is honest and is not
   the same thing as "the check you were reading when the phone rang". Noted in the page
   header since Stage C.
5. **A note on the park flow — NOT needed.** The artboard hedges this one; checking it: the
   park flow **does** capture a note (`Remittance.parkedNote`, rendered in quotation marks
   at `rcm-left-off-note-<id>`, pinned by `rcm-shell.test.tsx` and the smoke walk). The
   quote line is therefore drawn, as specified, and there is no follow-up.

---

## Sweeps and expectations

**No sweep or smoke expectation was changed.** The whole frontend suite passes against the
S7 budgets, families and rules exactly as they shipped. There is therefore no expectation
edit to mutation-prove.

Two mutations were run anyway, to show the sweeps this slice leans on really bite rather
than passing vacuously:

| Mutation | Applied to | Sweep | Result |
| --- | --- | --- | --- |
| `const resuming = false` — so `StartHere` keeps its fill while a resume card renders | `RcmToday.tsx` | (f) at most one primary-styled control | **RED**: *"more than one primary-styled control (S7 f): a[rcm-start-here-go-roland] "Start" + a[rcm-pick-up-chk-900102] "Pick up where you left off""* — 1 failed / 102 passed |
| a 37-word probe sentence added to the greeting | `RcmToday.tsx` | (g) a screen says no more than its budget | **RED**: *"Today says 126 prose words; its budget is 90."* (and 123, and 100, on the other renders) |

Both were reverted; `pnpm run check` and the full suite are green afterwards.

The two teaching empty states both still produce and pass sweep (h): the first-run panel
(`rcm-arrivals-none-ever-roland`, *"This is where a carrier's payments land…"* + *Bring one
in*) and the finished-evening panel (`rcm-arrivals-all-done-roland`, with the evening's
numbers). Both are photographed below.

### One test file touched, and it is a screenshot dump

`tests/rcm-stage-c-shots.test.tsx` — the `stagec-02-get-work-in` case now sets `open` on the
`<details>` before dumping. This is **not an expectation**; the case asserts nothing that
changed, and the whole file is skipped unless `RCM_SHOTS=1`.

It was a real defect in the picture: S7 made *Get work in* a fold that opens off
`window.location.search`, and `memoryLocation` routes wouter without touching
`window.location`. Under jsdom the search string is empty, so the dump whose entire subject
is the two drop zones had been a photograph of a closed summary ever since. The panels were
always in the DOM — a `<details>` renders its children either way — so both `waitFor`s
passed and nothing said the shot was of a door nobody had opened.

---

## Verification

| Gate | Result |
| --- | --- |
| `pnpm run check` (`tsc --noEmit`) | clean |
| `pnpm run test` — full frontend suite | **108 files passed, 19 skipped · 1734 tests passed, 116 skipped, 0 failed** |
| `tests/rcm-smoke.test.tsx` alone | 103 passed |
| Today's measured chrome prose | **89** (budget 90) — `docs/rcm-s7-inventory-measured.md` |
| Today's measured primary buttons | **1**, labelled *Pick up where you left off* or *Start* depending on the state |

---

## Screenshots

Light, 1280 wide, shot from the Stage C jsdom dumps through the app's real built CSS.
`new-dashboard/scripts/shoot-s8-today.mjs` writes only these three, so running it does not
rewrite the Stage C gallery.

```
pnpm exec vite build
RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c-shots.test.tsx
node scripts/shoot-s8-today.mjs before|after
```

| State | Before | After |
| --- | --- | --- |
| Today, populated | [before-today-populated.png](../screenshots/rcm-s8-today/before-today-populated.png) | [after-today-populated.png](../screenshots/rcm-s8-today/after-today-populated.png) |
| Today, finished evening (empty) | [before-today-empty.png](../screenshots/rcm-s8-today/before-today-empty.png) | [after-today-empty.png](../screenshots/rcm-s8-today/after-today-empty.png) |
| Today, first run + *Get work in* open | [before-today-get-work-in.png](../screenshots/rcm-s8-today/before-today-get-work-in.png) | [after-today-get-work-in.png](../screenshots/rcm-s8-today/after-today-get-work-in.png) |

No real patient data appears in any of them: every payer, check number, amount and person is
synthetic, and the only patients are the module's designated fixtures.

---

## What a reviewer should look at first

1. `leftOffRows` and the two call sites — the shared predicate is the whole of the
   one-primary guarantee.
2. The STATE column: the chip and the sentence beside it come from **one** `waitingFor()`
   call, which is why a check cannot be chipped one thing and described as another. Four
   states carry no chip on purpose (`CHECK_CHIPS`) and the cell is empty rather than
   invented; the takeback row in the populated screenshot is one of them.
3. `STATE_DOT` is a total `Record<WaitingState, …>`, so a state added to `waitingOn.ts` is a
   type error here until somebody picks its colour.
4. The chip testid is `rcm-state-chip-<id>`, deliberately **not** `rcm-arrival-…`: the
   smoke sweep's W-8 family matches every `rcm-arrival-*` testid as a card of its own, and a
   chip registering as a card would be a card with no state sentence in it.
