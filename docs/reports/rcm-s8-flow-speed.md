# RCM S8 — flow speed

Three fixes from the owner working a real EOB, and one measurement that turned the
complaint into a number.

The bar stays what it has been since S7: a new team member finds the work cold, **and**
an experienced biller flies. The first of those is about words; this slice is almost
entirely about the second, which is why it spends so few.

---

## 1. The measurement

Every RCM screen was rendered at **1280×800** with the app's own built CSS, inside a
scroll box the height of the viewport — `DashboardLayout` scrolls the page in
`<main class="flex-1 overflow-y-auto">`, so that element and not the document is what a
fold means here. Every control's offset was read out of the live layout.

The owner's complaint was that the button was hard to find. It was:

| Screen | The screen's one primary | Before | After |
| --- | --- | ---: | ---: |
| Claim page — linked | *Mark checked over* | **2190px** | 643px |
| Claim page — decided | *Approve for posting* | **1566px** | 627px |
| Approve | *Yes — this check is right* | **1122px** | **1122px** (kept — §4) |
| Check page — to match | *Check over so-and-so* | 60px | 643px |
| Check page — to approve | *Approve 1 claim for posting* | 60px | 643px |

On an 800px screen, a button at 2190px is not a button anybody finds. It is a button
they scroll past three panels of evidence to reach, having already decided — the slowest
possible ordering of read-then-press.

The check page's primary was never below the fold. What it gained is the *same slot* the
other flow screens now use: the bar is in reach at every scroll depth of a 1,100px page,
not only at the top of it.

---

## 2. Action audit — every RCM screen at 1280×800

"Below the fold" is measured, not estimated: page height and control offsets from the
live layout described above. Controls behind a closed disclosure are counted separately,
because a fold is a deliberate choice rather than an accident of length.

| Screen | Page | Controls below the fold, before | Verdict |
| --- | ---: | --- | --- |
| Today | 1010px | 6 — the five queue tiles and *posted this week* | **Kept.** They are a summary of the day, read after the two things above them (*Start*, *Pick up where you left off*). Neither is the next press. |
| Checks list | 702px | 0 | **Kept.** Nothing to do. |
| Check page — to match | 1122px | 7 — per-claim *Open* / *Match this claim again* / line toggles | **Kept**, primary **raised** to the bar. The per-claim controls belong to the rows they name; a row three screens down is not reachable by moving a button. |
| Check page — to approve | 1035px | 3 — the same per-row controls on one claim | **Kept**, primary **raised**. |
| Check page — to post | 1349px | 6 — the shadow comparison pair, *Review and approve*, per-row | **Kept.** The live primary (*Post to Open Dental*) is at 545px, above the fold, and the bar deliberately draws nothing on this step — the act is on this page and two solid buttons reading *Post to Open Dental* is the duplication W-11 deleted. |
| Claim page — candidates | 1974px | 8 — incl. the per-line *Bill the patient* / *Write it off* pair | **Raised**: the pager and *Save for tomorrow* to the bar. The panel's own *Yes, that's the one* is at 673px and stays where the evidence for it is. The per-line decisions belong to their lines. |
| Claim page — linked | 2266px | 7 — **including `rcm-cta` at 2190px** | **Raised.** The worst case in the module. |
| Claim page — ambiguous | 2083px | 8 | **Raised** (pager, *Save for tomorrow*). The app has deliberately not chosen here, so there is no primary to raise — that refusal is `MatchGuidance`'s unsure branch and is unchanged. |
| Claim page — decided | 1658px | 4 — **including `rcm-cta` at 1566px** | **Raised.** |
| Approve | 1310px | 4 — incl. `approve-button` at 1122px | **Kept, with a reason.** See §4. |
| Posted / Done | 1597px | 6 — *Back to Today*, *Open the Posting screen*, per-row | **Kept.** A finished check has no next press; these are exits, and an exit below a page of proof is the right order. |
| Stuck / Failed | 1742px | 6 — *Check it again* and the exits | **Kept.** The live primary (*Post to Open Dental*) is at 529px. *Check it again* sits with the measured evidence it is about. |
| Shadow worksheet | 1615px | 7 — *Print this*, the comparison pair, exits | **Kept.** The comparison question belongs under the worksheet it is asking about. |
| Activity / History | 702px | 0 | **Kept.** |

### Faint controls

No control on any RCM screen renders below full opacity. The `opacity-*` classes in this
module are all `disabled:`-prefixed, so they apply only where a control is refused — and
a refused control always carries its reason beside it (`DisabledReason`), which the smoke
sweep enforces.

The controls that render in `text-muted-foreground` are secondary by design and were left
alone: the Checks list's filter tabs, the claim page's *Fold this away*, the breadcrumbs,
and the Posting screen's *retire it*. Each is a quieter choice next to a louder one, which
is the distinction the colour is carrying.

---

## 3. What changed

### Item 1 — actions always in reach

`RcmActionBar` is a slim sticky strip (73–89px) at the foot of the check and claim
screens. It carries:

- **right** — the screen's ONE primary. Not a copy: each page stopped drawing its primary
  where it was and hands the same node over, so `tests/rcm-smoke.test.tsx`'s
  one-primary-per-screen sweep is the guard rather than a comment.
- **left** — the quiet actions, in the same slot on both screens: which check this is, and
  on the claim screen the pager and *Save for tomorrow*.

**Stage C §8 is untouched.** *Save for tomorrow* and *Set aside* on the **check** page
open anchored panels in normal flow that push the claim list down rather than covering it,
because deciding to set a check aside is deciding about the claims underneath. That ruling
is pinned structurally by `tests/rcm-stage-c.test.tsx` and it is the reason those two
triggers did **not** move: a bottom bar whose panel opens upward would cover exactly the
evidence §8 protects. The bar carries only controls that open nothing. The claim page's
*Save for tomorrow* opens no panel, so it did move.

So "one consistent position for the secondary actions" holds with one named exception,
recorded here rather than quietly dropped: the check page's two panel-openers keep §8's
position.

### Keyboard

On the check and claim screens:

| Key | Does |
| --- | --- |
| `Enter` | the button the bar is drawing |
| `[` or `k` | previous claim |
| `]` or `j` | next claim |
| `?` | the legend |
| `Escape` | closes it |

`Enter` **clicks the rendered control** rather than calling a copy of its handler. A page
that changed its CTA and forgot a callback would otherwise give the keyboard a different
act from the mouse, silently, on a screen that writes to charts. It also inherits every
refusal for free: a disabled primary is not matched by the selector, so `Enter` does
nothing to it, and a link is followed exactly as a click would follow it.

The handler stands down entirely when the caret is in a field, a modifier is held, a
control already has the focus, or either in-flow confirm (Q2's *Match anyway*, D-17's
typed takeback) is open. Each of those is pinned with a mutation proof.

**The approve page gets no keys.** The other two screens' primaries navigate or run a
read-only match; that one is the module's approval, and a page where a stray Return
approves a check is not a page this module should ship.

### Item 2 — what Open Dental has

`OdAccountFold` — *In the patient's account* — on the confirmed pane and on every
candidate card. It shows the chart claim's **procedures with their billed fee, insurance
estimate and what has been paid**, its claim standing, and whether it already carries
money.

Every figure was already in hand: the match fetches claimprocs to score a candidate and
`MatchCandidate.od.lines` has carried them since Slice 6a. The screen printed four summary
rows and threw the lines away. **No new endpoint, no new read.**

It is a real `<details>`, so it costs its four-word face on arrival and the whole account
when somebody asks.

**Colour.** A chart claim that has not been received is the normal state of a claim this
check is about to pay, so it renders in the neutral panel style labelled *Pending in Open
Dental* and says so in words. The one thing in the region that colours is a line whose
billed fee differs from the carrier's, and it colours off the match's own
`billedDeltaCents` — nothing here re-compares two amounts, which is how an amber row ends
up beside a green verdict.

**Claim status.** This repo can prove exactly one Open Dental `ClaimStatus` value:
`services/rcm/claimMatch.js` raises `CLAIM_ALREADY_RECEIVED` on `'R'`, and the posting
write is `PUT /claims/{n} {ClaimStatus:"R", DateReceived}`. So `R` is *Received*, and —
the useful half — every other letter provably is **not**, whatever else it means. The fold
says that and prints the raw code beside it rather than inventing wording. See §5.

**The agreement summary** now leads with what the team verifies — patient, service date,
billed total, lines — and the carrier's claim number drops to one muted line beneath it.
Payers routinely echo an id of their own, so a mismatch there alone no longer hedges the
heading: it reads *"Found it — everything the app compared agrees"*, which is exactly what
the sentence under it says. The ceremony that fact earns is still the press — ruling Q2's
interstitial fires on it, byte-untouched.

### Item 3 — after approve, stay in flow

Approving is the middle of the job. The screen ended it with one solid *Back to the
check*, which is a direction rather than a next step: it dropped a biller at the **top** of
a 1,300px page with nothing said about what to do there, and the Post step some 500px down
it.

The result decides the destination:

| Result | Goes to | Says |
| --- | --- | --- |
| Nothing held back | `/rcm/remittances/:id?next=post` | "Next: the Post step on this check." |
| A claim held back | that claim, named | "Next: N claims on this check still needs you." |

`?next=post` is a **scroll hint**, not a route: the check page reads it and takes the
reader to the post panel instead of the top of the page, using the same `goToPostPanel`
the rail's own Post CTA uses. Without it — a bookmark, a typed URL — the page renders
exactly as it always has. No path, slug, column or state machine changed, and no endpoint
was added.

W-1's *Take me to the check to post it* (a check whose every claim was already approved)
now lands on the Post step too. The label has said "to post it" since W-1; the link now
agrees with the label.

**No top-level Posting nav item was added.** Today's *Ready to post* tile still opens the
filtered Checks list, which is a queue rather than a check; the rows in it open the check,
whose stepper already shows the live step.

---

## 4. What was not done, and why

**The approve page's primary stays at 1122px.** Moving it collides with two pinned rulings
that are both worth more than the 322px:

- **W-8** — `approve-decide` must carry exactly one state sentence from a closed
  vocabulary, and on a finished check that sentence *is* the refusal beside the greyed
  button (`standingLine`). Moving the button out of the card takes the sentence with it
  and the card is left saying nothing about its own state.
- **The reason-adjacency rule** — "every button that can't be pressed says why, next to
  it" — is asserted **structurally**: smoke 1.16 reads the refusal out of the button's own
  `parentElement`. The reason cannot be both inside the card (for W-8) and beside the
  button (in the bar).

Satisfying both needs the approve card restructured so the state sentence and the
refusal are one node in two places, or the greyed button retired on a finished check
(which W-12's own logic arguably wants — a button beside "already done" is how the walk's
biller pressed it three times). Either is a design decision, not a layout change, and it
is the first thing I would put in the next slice.

The approve page did get item 3 in full.

---

## 5. Data wants

1. **A complete `ClaimStatus` → plain-language map.** Only `R` is provable from this
   repo. `S`, `W`, `H`, `U` and the rest are rendered as *Pending in Open Dental* with
   the raw code beside them, which is honest and less useful than it could be. The map
   belongs on the server beside `OD_BLOCKERS`, so one place owns it.
2. **The claimproc status letter, in words.** `OdLineFacts.status` is printed verbatim in
   the fold for the same reason.
3. **The patient's ledger.** The chart panel already says this is not shown and why —
   reading it needs an Open Dental request this screen does not make. The fold inherits
   the same gap: it can say what is on the *claim*, not what is on the *account*, which is
   what its own label promises. Worth closing, and it needs a backend read.
4. **`batchId` on `GET /claims/:id`.** Long-standing (§15.2 finding 1): without it the
   claim screen cannot know which check it came from, so the pager — and now the bar's
   left-hand side — is dropped rather than guessed when `?from=` is absent.

---

## 6. Budget math

Chrome words per screen, against the ceilings pinned in `tests/rcm-smoke.test.tsx`:

| Screen | Budget | Before | After | Headroom |
| --- | ---: | ---: | ---: | ---: |
| Today | 90 | 89 | 89 | 1 |
| Checks list | 100 | 100 | **100** | 0 — untouched, and no word was added to it |
| Check page | 480 | 464 | 465 | 15 |
| Claim page | 430 | 422 | **430** | 0 |
| Approve | 230 | 220 | 220 | 10 |
| Approve → takeback | 130 | 127 | 127 | 3 |
| Posted | 270 | 256 | 256 | 14 |
| Stuck | 510 | 494 | 494 | 16 |
| Shadow worksheet | 350 | 340 | 340 | 10 |
| Activity | 80 | 51 | 51 | 29 |

**No re-pin was used.** All three pre-authorised ones were available and none was needed:

- **The keyboard overlay** cost **0**. It renders only when open, and its trigger is a
  glyph — the name a screen reader speaks is on `aria-label`, which the budget
  deliberately does not count and the banned-word and office-key scans still do.
- **The "In the patient's account" label set** cost **8** on the claim page: two
  `<summary>` faces of four words each on the unsure pane. The fold *bodies* cost nothing,
  because the sweep skips a closed `<details>` — which is the whole reason that mechanism
  exists rather than a way around the counter.
- **The post-approve arrival sentence** cost **0** on the approve screen: it replaced
  *Back to the check*, and the screen measures the same 220 it did before.

The claim page's remaining 8 words were paid for by cutting, as instructed: the
claim-number small print lost its clause explaining *why* payers echo their own ids and
kept the fact and the one thing a reader must not conclude from it.

The claim page now sits **exactly on** its ceiling. That is the mechanism working — the
next word added to that screen fails the suite and raising the ceiling becomes a
deliberate, reviewable line in a diff — but it is worth knowing before the next slice
starts.

`Checks list` sits at 100/100 and **nothing in this slice touched it**.

---

## 7. Touched expectations, and the proof for each

Three, all deliberate. Each was mutated and watched fail.

| Expectation | Was | Is | Mutation proof |
| --- | --- | --- | --- |
| `rcm-ui-s3` · the CTA sits above the rail | asserted `rcm-cta` precedes `rcm-stepper` | replaced by *draws the next verb once, in the sticky bar at the foot* — one copy, inside the bar, after the rail, and `sticky` | removed `sticky` from the bar → fails |
| `rcm-smoke` 1.16 · `approve-onward-post` href | `/rcm/remittances/A` | `/rcm/remittances/A?next=post` | reverted the href → fails |
| `rcm-ui-s4` · same | `/rcm/remittances/b-1` | `/rcm/remittances/b-1?next=post` | reverted the href → fails |

New coverage carries its own proofs: the pager keys (disable the handler → fails), the
stand-downs for a text field and for a focused control (remove either guard → fails), the
post-approve branch (force one branch → fails), the arrival scroll (short-circuit the
effect → fails), and the colour rule — a **paired and equal** line must not colour, which
is what separates "compared and they differ" from "compared at all" (colour any paired
line → fails).

`tests/rcm-stage-c3-shots.test.tsx`'s candidate fixture gained real `od.lines`. It carried
`[]`, which was harmless while nothing drew them and is not any more: the fold *is* that
list, and a shot fixture with none photographs an empty region.

---

## 8. Constitution

- One primary per screen — the bar is a **move**, and the sweep is what proves it.
- Chip + phrase ≤ 8 — untouched.
- Banned-words guard, machine office keys — green.
- No reason-less greyed button — the approve page's refusals stayed with their button,
  which is why that button stayed too (§4).
- **W-16 / D-17 / Q2 / the proof block — byte-untouched.**
- Verdict module untouched. `ClaimWorkbench`'s verdict band still renders the verdict
  sentence in the same place and the same order; only the control that acts on it moved.
- Machine slugs and routes frozen. `?next=post` is a query hint on an existing route.
- Office keys never render.
- Fictional identities only — every name, code and figure in the screenshots is synthetic.
- Teaching empty states still produce.

## 9. Done

- `pnpm run check` — clean.
- `pnpm run test` — **119 files, 1,965 passing**, 126 skipped.
- Screenshots: `docs/screenshots/rcm-s8-flow-speed/`, before and after, 1280×800, in the
  app's own scroll box.

| Pair | Shows |
| --- | --- |
| `*-check-top` / `*-check-scrolled` | the check page on arrival and 420px down |
| `*-claim-top` / `*-claim-scrolled` | the claim page 900px down — before, no button on screen at all |
| `*-match-account-open` | the confirmed pane with the account expanded |
| `*-match-account-candidates` | the same fold on a candidate card |
| `*-approve-onward-claim` | approved with a claim held back |
| `after-approve-onward-post` | approved clean — the Post step is next (no before: the branch did not exist) |
