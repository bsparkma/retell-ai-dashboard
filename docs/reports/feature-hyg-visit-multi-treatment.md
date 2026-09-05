# Hyg — same tooth, several procedures; and the path to Send

Branch `feature/hyg-visit-multi-treatment`, off `origin/develop` (`50262c7`).
Beau's two findings from walking the real workspace on staging with 12828.
Display-layer only: no migration, no contract change, no backend change at all.

---

## Acceptance criteria

| # | | Evidence |
| --- | --- | --- |
| 1 | #30 → Build-up → Crown → RC = three items on #30, no re-picking | `hyg-multi-treatment.test.tsx` — "#30 → Build-up → Crown → RC is THREE items on #30, in three taps" |
| 2 | Same code + same tooth → a confirm, not a silent duplicate and not a block | "asks, rather than silently duplicating or refusing outright" + "but a deliberate second one is possible — retreats exist" |
| 3 | Items grouped by tooth; each keeps its own priority/dx/status | "groups by tooth so one tooth's procedures read as one story" + the pure `groupByTooth` test |
| 4 | End-of-form points at the tray; zero-item handoff states its condition and will not stage | "points at the tray instead of stopping"; "the zero-item handoff card states its own condition and will not stage" |
| 5 | `tsc --noEmit` clean, no `any`; green on 4 shards | below |

### 5 — gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2328 tests · 2325 pass · 0 fail · 3 skipped** (unchanged from develop — this slice touches no backend file)
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1351 passed, 82 skipped, 0 failed** (develop: 1340)

---

## 1. The sticky selection

**What clears it, and my reasoning for each:**

| | Clears? | Why |
| --- | --- | --- |
| adding an item | **no** | this is the change — #30 → Build-up → Crown → RC is three taps |
| tapping a tooth | yes | she is choosing a different set; that IS the gesture for changing it |
| the explicit **Clear** button | yes | there has to be a way that is obviously a way |
| switching dentition | yes | the numbers mean different teeth, so a carried selection would be a selection of different teeth |
| leaving the section / saving the slip | **no** | nothing about scrolling or typing elsewhere says "I am done with this tooth" |

**Nothing clears it silently.** A selection that vanished on its own leaves the
next tap adding a whole-mouth item, or nothing at all, with no way to tell which
happened — and the copy under the picker now says out loud that it stays
selected, so the behaviour is discoverable rather than something to notice.

**Still three items, not one item with three codes.** The contract is untouched:
each procedure keeps its own dx, its own priority (a crown can be urgent while a
veneer on the same tooth is cosmetic) and its own status. The model was right;
the picker was wrong.

### The duplicate confirm

Same code AND the same tooth set → a dialog naming both ("Crown is already on
the list for #30"), with **Cancel** and **Add it again**. Not a block: two root
canals on one tooth is a retreat, and only the person holding the mirror knows
whether this one is a slip. Not silent either: a second identical row that
appeared without comment is the thing that gets sent to a treatment coordinator
twice.

The same code on a DIFFERENT tooth is not a duplicate and does not ask.

### Grouped by tooth

By the tooth SET, exactly — so a bridge spanning #3 and #14 is one group rather
than appearing under both. Groups are in **first-appearance order**, not
tooth-number order: she adds #30's three procedures together, and re-sorting her
work into an order she never chose is its own small insult.

`groupByTooth` is exported and tested as a pure function, so the ordering rule is
stated without a render.

---

## 2. The bottom of the form

Beau, verbatim: *"I am at the bottom of the page and do not know where to go or
what to do next."*

**Both mechanisms, because they cover different screens:**

- On iPad landscape the tray is now **sticky** beside the form
  (`lg:sticky lg:top-6 lg:self-start`), so it is in view the whole time rather
  than a scroll away at the bottom.
- The form **ends with "Review & send"**, which scrolls the tray into view. That
  is what a narrower screen needs, and it is the affordance the acceptance test
  asserts: the end of the form points somewhere.

### The zero-item handoff card

It used to say *"It will go in as Other"* — `deriveCategory`'s answer for an
empty list, doing quiet double duty as the only tell that there was nothing to
hand off. Somebody reading that learns two wrong things: that a category exists,
and that Stage would do something.

Now the card says **"No treatment items yet — add them above and this becomes
stageable"** and its Stage button is disabled. The server refuses this anyway
with `NOTHING_TO_STAGE`; this is the screen saying the same thing before the
round trip, which is the difference between a button that explains itself and one
that fails.

Add an item and the card goes back to naming its derived category, with Stage
live. Tested both ways.

---

## Screenshots

`docs/screenshots/hyg/hyg-multi-*`, light and dark, at the iPad's 1180 width.
Three name a taller frame because their subject is below the fold — the same
page, scrolled.

| | Frame | |
| --- | --- | --- |
| `01-sticky` | 1180×2800 | **the one that matters** — #30 still selected after two adds, with the "#30 — it stays selected" line and the Clear button |
| `02-duplicate` | 1180×1400 | the confirm, naming the code and the tooth |
| `03-grouped` | 1180×3400 | #30's two procedures as one group, #3's one as another |
| `04-end` | 1180×3400 | the end of the form, with "Review & send" |
| `05-no-items` | 1180×1200 | the zero-item handoff card and its disabled Stage |

---

## What changed elsewhere, and why

**One existing test was rewritten.** `hyg-visit.test.tsx`'s "shows a refusal to
stage beside the thing that was refused" used the zero-item handoff to provoke a
422 — which is now disabled client-side, so the button cannot be pressed. It
provokes the refusal on the router instead; the property it tests (a content
refusal renders beside its own row and does not become a page error) is
unchanged, and the zero-item case gained its own test.

**Nothing else.** No backend file, no migration, no contract change — the sticky
selection is component state and `TreatmentItem` is untouched, as the brief
required. `hygNoOdWrites.test.js` is byte-identical:

```
$ git diff --numstat origin/develop -- backend/
(empty)
```

TC and RCM untouched; `backend/platform/` untouched.

---

## What I deliberately did not do

- **No multi-tooth "apply to each" mode.** Selecting #3 and #14 and tapping
  Crown makes ONE item naming both teeth, as it did before. Splitting it into
  two items is a different feature with a different answer for the shared dx,
  and nobody has asked for it.
- **No reordering of items within a group**, and no drag. First-appearance order
  is hers already.
- **No "duplicate" badge on the item card.** The confirm is at the moment of the
  decision, which is where it is useful; a permanent badge would be a second
  place to notice the same thing.
