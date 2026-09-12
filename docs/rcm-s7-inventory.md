# RCM S7 — the clarity inventory (Phase 0)

The owner walked the rebuilt posting screens on staging on **2026-09-11** and ruled:
*better than before, but a new team member could not figure it out untrained — too many
words, unclear where to go.*

This file is the measurement that ruling asked for, taken **before** any S7 change, so
the slice has a before/after rather than an opinion. Every figure below is produced by
the smoke walk itself:

```bash
cd new-dashboard && RCM_INVENTORY=1 pnpm exec vitest run tests/rcm-smoke.test.tsx
# writes docs/rcm-s7-inventory-measured.md
```

It is a side effect of `tests/rcm-smoke.test.tsx` on purpose. A screen measured in a
state nobody walked to is a screen measured in a state that does not exist.

---

## 1. How the words are counted, and what the count cannot see

**jsdom has no layout, so there is no fold.** The brief asks for words *above the fold*.
Nothing in this test stack can see a viewport, so the measure is defined to be a strict
**superset** of above-the-fold prose — a screen inside its budget here is inside it up
there too — and split into two figures rather than one:

| Figure | What it counts | Why it exists |
| --- | --- | --- |
| **Chrome words** | Every visible word on the screen **except** the repeating rows and card faces | A list's word count otherwise grows with the DAY, not the design: twelve checks say the *Waiting on* sentence twelve times. This is the prose a designer chose once. It is what the budget governs. |
| **Whole-render words** | Every visible word, rows included | The honest total. The gap between the two is how much of a screen is data. |

Struck out of both, because they are the **work** and no word diet can remove them:

- amounts, counts, percentages — `$570.00`, `24`, `100%`
- check, claim and payment numbers, and machine ids — `900700101`, `clm-900201`
- procedure codes — `D2740`
- dates and times — `Sep 8, 2026`, `7:10 PM`
- the proper nouns this world holds — the payer, the practice, the two test patients, the
  person who decided

Also **out**, and this one matters:

- `title` and `aria-label`. The banned-word and office-key scans read them, because a
  screen reader speaks them. A word *budget* must not, or the Checks page pays for four
  tab tooltips nobody sees — and moving a sentence into a tooltip would score as a word
  diet when it is nothing of the kind.
- anything behind a closed disclosure, `hidden`, or `aria-hidden`. That is the mechanism
  the word diet uses; if the count included collapsed text, collapsing would buy nothing.

**Every figure is the worst case seen**, not an average: the largest render of that screen
across the whole walk. A budget that only holds on a quiet day is not a budget.

---

## 2. The measurement

Regenerated as `docs/rcm-s7-inventory-measured.md`. Copied here as the **before** column;
the PR description carries before and after side by side.

| Screen | Kind | Chrome words | Whole-render words | Clickable actions | Primary buttons |
| --- | --- | ---: | ---: | ---: | ---: |
| Today | list | **253** | 299 | 16 | **0** |
| Checks list | list | **72** | 90 | 8 | **0** |
| Check page | flow | **527** | 527 | 18 | **3** |
| Claim page (Match + Workbench) | flow | **487** | 522 | 18 | **4** |
| Approve | flow | **362** | 364 | 5 | 1 |
| Approve → takeback route | flow | **152** | 163 | 2 | 1 |
| Posted / Done | terminal | **407** | 407 | 17 | 1 |
| Stuck / Failed | terminal | **627** | 627 | 19 | **2** |
| Shadow worksheet | terminal | **498** | 498 | 21 | **2** |
| Activity / History | list | **109** | 1819 | 44 | 1 |

Two screens on the brief's list are not in the table, and the reason is the same in both
cases — **the walk never reaches them, because they are not screens**:

- **Bring in.** Ruling D-18 moved the two upload panels back onto Today, below the work.
  `/rcm/bring-in` still answers, by redirecting to `/rcm?add=1`. There is no Bring in
  screen to budget; its words are inside Today's 253.
- **Match and Workbench are one screen.** `ClaimMatch` renders `MatchGuidance` and
  `ClaimWorkbench` together, always, one above the other. The brief counts them as two
  screens with two budgets; the code has only ever had one page. Measured as one.

---

## 3. The four questions, per screen

### Today — 253 chrome words · 16 actions · **no primary action at all**

3. **Is there exactly one visually primary action?** **No — there are none.** The only
   solid button on this page (`Bring one in`) renders in the *empty* state, when the
   practice has never taken a check in. On the ordinary day the owner walked, a reader
   meets sixteen equal-weight links and nothing that says *start here*.
4. **Is the next step one obvious click?** **No.** *Where you left off* carries
   `Pick up where you left off`, which is the right act — but it is a plain link
   competing with fifteen others, and it only appears when something was parked or
   started. A new hire with a fresh queue has no button to press.

Where the 253 words go: two upload-panel explainers (~55), three stat captions each with
a full sentence (~45), the *proposals* paragraph (~25), the five-step legend (~12), the
shadow pill (~12).

### Checks list — 72 chrome words · 8 actions · **no primary action**

3. **No.** The solid style on this page is spent on the *selected tab* — a "where you
   are" signal, not a "press this" one — and on the empty state's `Add a check`.
4. **Partly.** Every row's *Waiting on* names who, which is the slice's best idea; but
   opening a check is a click on its payer name, and nothing marks which check to open
   first.

At 72 it is the only screen already inside the brief's budget.

### Check page — 527 chrome words · 18 actions · **3 primary buttons**

3. **No — three.** `Match it up`, `Review and approve` and `Post to Open Dental` can all
   render solid at once, and on the takeback check a fourth (`Keep the adjustment`) joins
   them from the embedded panel.
4. **Yes, in principle** — `RcmPrimaryAction` hoists `flow.cta` into the header and it is
   the right verb. It is just not the only solid thing on the screen.

Of the 527, the D-17 takeback explanation and its typed-confirmation copy are **exempt**
safety text and are a large share of the worst case. The reducible part is the five-step
rail printing a label row *and* an evidence line each (~50), `Deposit — coming soon` on
every render (~10), the balance-check block (~12), and the payer name rendered twice.

### Claim page (Match + Workbench) — 487 chrome words · 18 actions · **4 primary buttons**

3. **No — four.** `Match it up` (header CTA), `This is the one` (per candidate),
   `Mark checked over`, and `Bill the patient $…` all render solid.
4. **Yes** — `Next` / the pager moves between claims, and the header CTA names the step.

### Approve — 362 chrome words · 5 actions · 1 primary

3. **Yes.** `Yes — this check is right` is the only solid button, with
   `Go back and change something` beside it as a ghost. This screen is the model the
   others should follow.
4. **Yes** — and afterwards it offers `Take me to the check to post it`.

The Q2 named-difference confirm and the *last moment anything can be changed* copy are
exempt safety text.

### Approve → takeback route — 152 chrome words · 2 actions · 1 primary

3. **Yes** — `Take me to the takeback`.
4. **Yes.**

### Posted / Done — 407 chrome words · 17 actions · 1 primary

3. **Technically yes**, but the one solid button is `Review and approve` — a verb for a
   check that is already **finished**. The screen's real next step is *the next check*,
   and there is no such control anywhere in the module.
4. **No.** A finished check is a dead end: the only ways on are the breadcrumb and the
   nav.

### Stuck / Failed — 627 chrome words · 19 actions · **2 primary buttons**

3. **No — two:** `Post to Open Dental` and `Review and approve`.
4. **Partly** — the stuck panel says where it stopped and offers `Post again`, but it
   sits below a full repeat of the five-step rail and the balance-check block.

The W-16 measured-screen copy is **exempt** and is much of the worst case.

### Shadow worksheet — 498 chrome words · 21 actions · **2 primary buttons**

3. **No — two**, the same pair as Stuck.
4. **No.** After answering *Did the app get this check right?* there is nowhere to go.

Reducible: the shadow explainer paragraph (~45) duplicates what the header pill and the
greyed Post button's reason already say, three times on one screen.

### Activity / History — 109 chrome words · 44 actions · 1 primary

3. **Yes** — `Post 24 to Open Dental`, which is also the most dangerous button in the
   module.
4. **Not applicable** — this is the monitor, not a step in the day's work.

**Seventy-five of its 109 chrome words are two intro paragraphs**, one of which exists to
tell the reader they did not need to come here.

---

## 4. What the inventory found that the brief did not name

1. **Today has no primary action.** The brief's Phase 1.1 asks for one; the measurement
   says the count today is zero, not one-of-several.
2. **The ERA history chip prints the raw status.** `StatusChip` in `EraUploadPanel.tsx`
   renders the word `ready` for `ready` and *the status string itself* for everything
   else, so a reader meets `open` or `failed` in lowercase where a phrase belongs.
   (Checked and **not** a finding: the `claim_reversal` chip and the `needs_review`
   status visible in the raw dump are smoke-fixture inventions, not server values.
   `rcm-labels.test.ts:83` already fails if a real `REMITTANCE_FLAGS` member has no
   entry in `FLAG_LABELS`, and `:101` pins the raw-key fallback as intended.)
3. **Match and Workbench are one screen** (see §2).
4. **A finished check is a dead end.** Nothing in the module says *next check*, on any
   screen, in any state — which is exactly the "could not figure out where to go" the
   owner reported.
5. **The five-step rail is the single largest repeated cost**: a label row plus five
   evidence lines on every check-flow screen, including `Deposit — coming soon`, which is
   about a feature that does not exist.

---

## 5. After (regenerated at the end of the slice)

Same command, same walk, same counter.

| Screen | Chrome words before → after | Actions | Primary buttons before → after | Budget now |
| --- | --- | ---: | --- | ---: |
| Today | **253 → 89** | 16 → 17 | **0 → 1** (“Start”) | 90 |
| Checks list | 72 → 72 populated · **98 empty** | 8 | 0 → 0 | 100 |
| Check page | **527 → 472** | 18 → 16 | **3 → 1** | 480 |
| Claim page (Match + Workbench) | **487 → 426** | 18 → 17 | **4 → 1** | 430 |
| Approve | **362 → 220** | 5 | 1 → 1 | 230 |
| Approve → takeback route | 152 → 127 | 2 | 1 → 1 | 130 |
| Posted / Done | **407 → 264** | 17 → 16 | 1 → 0 | 270 |
| Stuck / Failed | **627 → 502** | 19 → 17 | **2 → 1** | 510 |
| Shadow worksheet | **498 → 348** | 21 → 19 | **2 → 0** | 350 |
| Activity / History | **109 → 39** | 44 | 1 → 1 | 80 |

Whole-module chrome: **3,494 → 2,559 prose words, a 27% cut**, with nothing honest
deleted — every folded sentence is still rendered, behind a summary or on the page it
is about, and every one that was pinned by a test keeps its test id.

### Why three screens now read zero primary buttons, and that is correct

- **Checks list** is a lookup screen of co-equal rows. A reader arrives at it to find one
  specific check; nothing on it is "the next step in the day's work", and the solid style
  is spent on the selected tab, which says *where you are*.
- **Posted** and **Shadow worksheet** DO have a primary — `Next check` — and the counter
  photographs them while its read is still in flight, when the panel honestly reads
  *Looking for the next check…* rather than drawing a button that may be about to become
  a different button. The walk asserts the button itself separately (smoke 1.17).

### Where a budget is not the brief's number, and why

The brief asks for above-the-fold budgets — 80 · 130 · 100. jsdom has no fold, so the
budget is enforced against the **whole screen's chrome**, which is strictly harder.
Two screens meet the brief's own figure against that harder measure: **Activity (39/80)**
and **the takeback route (127/130)**.

**A correction, found by the PM's negative-check requirement.** This section previously
also claimed Checks at 72/80. That figure is the POPULATED screen, and until the review
pass nothing in the suite rendered an empty one. Walked to, the empty Checks page measures
**98** — because Phase 4 requires an empty panel to say what will land in it and how, and
that costs about twenty words the screen does not spend when it has rows to show. Its
budget is the empty state's, 100, since the empty state is the worst case. **Phase 4 and
Phase 2.3 pull against each other on exactly one screen, and Phase 4 wins**: a new hire
meeting an empty queue is the person this whole slice is for.

The rest are over it, every one of them because of text the brief itself exempts, and the
brief's own remedy is the one taken — *"if a budget can't be met because of an exempt
block, raise the budget for that screen in the sweep and note it in the PR."*

| Screen | Budget | The exempt block that sets the floor |
| --- | ---: | --- |
| Today | 90 | Nine words over 80: the shadow pill and its one-line hint, which are a *state*, not prose |
| Checks list | 100 | Not an exemption — Phase 4. The empty panel has to teach, and teaching costs ~20 words. Populated, this screen is 72 |
| Check page | 480 | The D-17 takeback explanation, its two written-form descriptions and its typed-confirmation copy — roughly 200 words of the 472, verbatim and untouched |
| Claim page | 430 | The Q2 named-difference confirm, plus the per-candidate evidence a match decision is made from |
| Approve | 230 | The W-4 confirm-to-switch copy and "This is the last moment anything can be changed" |
| Posted | 270 | The proof block, and the measured register's provenance lines |
| Stuck | 510 | The **W-16 measured screen copy** — the promised-vs-measured pair, the proof block and the per-patient remediation steps. It is most of the 502 and not a word of it moved |
| Shadow worksheet | 350 | The would-have-done worksheet's figures and the shadow refusal |

Each budget is the measured figure rounded up to the next ten. A budget is not there to
hit a number; it is there to stop the words coming back. Adding a paragraph to any of
these screens now fails `tests/rcm-smoke.test.tsx`, and raising a ceiling is a deliberate,
reviewable line in a diff.

---

## 6. The negative checks, and what they found (PM review, 2026-09-11)

The review required every new pin to be **shown failing with its fix undone**, then passing
restored. Four fixes were reverted in the working tree one at a time and the suite re-run.
Three sweeps caught their own regression immediately. One did not, and that is the useful
result:

| Sweep | Fix undone | Result |
| --- | --- | --- |
| **(f)** one primary | `approve-open-page` painted solid again | **FAILED**, 3 cases — *"button[rcm-cta] "Match it up" + a[approve-open-page] "Review and approve""* |
| **(a2)** chip + phrase | the takeback clause put back on the row face | **FAILED**, 3 cases — *"rcm-arrival-next-x says 11 prose words"* |
| **(g)** word budget | Today's three queue-card definitions restored | **FAILED**, many cases — *"Today says 127 prose words; its budget is 90."* |
| **(h)** empty states | the *what lands here* line deleted | **PASSED — the guard never ran** |

**(h) was vacuous.** No case in the suite rendered an empty list, so a rule about empty
panels was judging markup nobody produced. Two walk cases now go somewhere with nothing in
it — the real `RemittanceList` with one set-aside check, and the real `PostingQueue` with
nothing waiting — and with those in place the same mutation fails.

Two defects in the sweep itself fell out of writing them, both of which would have shipped
a guard that could not catch what it was for:

1. **It judged the buttons inside the panel as panels.** A prefix match on
   `remittances-empty-` caught `remittances-empty-see-all-roland` and reported *"See all of
   them" is a bare negation*. Anchored on the office key now.
2. **An exit counted as an answer.** The first rule accepted *any* control as "the how", so
   a panel reading "Nothing needs attention." beside **See all of them** and **Back to
   Today** passed — two ways out of an empty queue and not one word about what would fill
   it. The rule now reads the arrival verb only; a button counts by saying one
   (*Add a check*, *Bring one in*), never by merely existing.
