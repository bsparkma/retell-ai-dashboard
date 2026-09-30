# Field confirm — putting the step in the flow

Four defects from the owner working real checks. **Written for: Beau, plus whoever reviews
this PR.**

---

## 0. Item 4 first — the diagnosis, before any fix

The brief asked for the root cause of the "look again" error in the report **before** the fix
commit. Here it is, and the honest answer is not the one I expected.

### There is no server-side error

Prod logs (`ca-carein-prod-backend`, Log Analytics, the whole Sep 30 Central window) contain
**zero 4xx/5xx on any `/api/rcm/*` route**. The last RCM failures were four
`503 POST /api/rcm/eob` at 01:00–01:06 UTC — that is Sep 29 *evening* Central, and it is the
already-fixed pre-stand-up failure, not this.

The one prod RCM session ran clean end to end:

```
02:30:00  POST /api/rcm/eob                       201
02:30:05  [rcm/ocr] read 2 page(s) … prebuilt-read … confidence 0.983
02:30:09  [rcm/eob] upload … extracted with 3313 tokens
02:30:15  GET  /api/rcm/remittances/<batch>       200
02:30:28  GET  /api/rcm/claims/<claim>            200
02:32:33  PUT  /api/rcm/claims/<claim>/lines/<line>  200
02:32:34  (reload)  … and the session stops
```

### Two absences settle it

- **`POST /api/rcm/claims/:id/match` — the "Look again" control — was never called.** Not once,
  in 30 hours.
- **`GET /api/rcm/uploads/:id/document` — "Open the EOB" — was never called either.**

So whatever appeared happened **in the browser, before any request left it**.

I ruled out the obvious candidates in code rather than by assertion:

| Candidate | Ruled out because |
| --- | --- |
| the office picker was on "All Offices" | `runMatch` uses `state.office`, the office resolved by the successful load — not the picker |
| the button was disabled | `mayRerun` is true unless a *confirmed* claim meets a user without `rcm.write`; the owner is super_admin |
| the document link was absent | `eobExtractionWorker` writes `eob_file_key = upload.file_key`, which is exactly what `getProvenance` joins on, so `documentHref` resolves |

### And the flow in this brief is not on prod

Worth stating plainly, because items 1–3 describe screens the owner cannot have been using on
prod: **prod runs `a83039e`** (main, PR #204). The field-confirm slice is on `develop` →
**staging only** (`aea9ca9`). Staging's logs show session 401s and **no `/field-confirm`
traffic at all**.

### The conclusion, and what I did about it

The one control on the path he was walking that can fail **without touching the server** is
the `target="_blank"` document link. A blocked popup, a tab that downloads instead of
rendering, a bare refusal on a white page — from inside this application all three are
indistinguishable, and none of them leaves a trace. That is precisely why the logs are empty.

**I cannot prove which of those it was, and I am not going to claim I can.** What I can do is
remove the class: item 3 already required an in-page viewer, and moving the exchange inside
the app gives the failure a state, a sentence and something to press next. That is the fix at
the source, and §4 below is the error state it now has.

If it was a different control, say so and I will redirect — the diagnosis above is what the
evidence supports, not a guess dressed up.

---

## 1. The confirm step is the tail end of Bring in

**Placement ruling, implemented as stated.** Reading a picture of a document is half of taking
that document in; the other half is a person agreeing that what was read is what is printed.

While any money figure is unchecked:

- the **Bring-in step stays `current`**, reading *"Read from the scan Sep 29, 9:30 PM — 7
  figures not yet checked against the page."*, linking to the confirm screen;
- **Match waits**, and for free — `oneCurrent` already demotes any later `current` step, so a
  biller is never asked to tie a claim to a chart on figures nobody has read;
- **the check page's one primary points at the confirm screen**, also for free, because
  `ctaFor` takes the first live step. One rule decides the rail and the button, so they cannot
  disagree about what comes next.

### The bug inside the fix

`ctaFor` had **no `upload` case at all**. It could never be reached before: the step was
always `done` by the time any screen drew the rail, so the switch fell to `default` and
returned null. Without adding one, the check page would have shown a rail saying "not yet
checked" and offered nothing to press about it.

### The confirm screen is no longer an island

It now carries the same header rail and breadcrumb as every other flow screen. The check
behind the rail is read with `Promise.allSettled`: the figures are the work, the rail is
orientation, and a biller who can see the figures but not the breadcrumb is far better off
than one who can see neither.

### 835 checks are untouched by construction

`GET /api/rcm/remittances/:id` now carries a **summary, never figures**:

```json
"fieldConfirm": { "required": false, "ok": true, "outstanding": 0 }
```

`required` is false for an 835 **and** for a text-layer PDF, and each draws the rail exactly
as it drew before the step existed. An **absent** field means "this server does not say" and is
not read as work outstanding — guessing would put every check into a step it may not need.

Pinned three ways: an 835, a text-layer PDF, and a server that reports `required: false`
alongside a non-zero count (reading `!ok` alone would drag an 835 in).

---

## 2. One scroll per page

**Audited, and the finding is that the RCM screens were already right.** There is no
`overflow-y-auto`, `overflow-y-scroll`, `h-screen` or `max-h-*` anywhere under
`pages/rcm` or `components/rcm`. The shell owns the one scroll:

```
DashboardLayout:  flex h-screen overflow-hidden
  └─ <main className="flex-1 overflow-y-auto">   ← the page's only scrollbar
```

The confirm screen's document panel is `sticky top-4`, not a second scroll box, and the only
internal scroll is the **page image itself** — the exception the rule allows, because a scan
has to be scrollable to be usable, and an `<iframe>`'s own scrollbar sits inside a fixed box
rather than beside the page's.

Two source guards stop the class coming back (a class-attribute scan, so the rule can still be
*explained* in a comment without tripping it), and the screenshots at **1280×800** and
**1280×560** are the visual half. The shooter deliberately does **not** pass
`--hide-scrollbars` — that is the one flag that would erase the evidence.

---

## 3. The EOB opens in place

One component, `components/rcm/EobViewer.tsx`, mounted everywhere the document is offered, so
it behaves identically on the confirm step, the claim page and the workbench.

- **A drawer beside the figures, not a modal over them.** The whole reason to open the document
  is to compare it with a number on the screen; a modal would cover that number and recreate
  the problem the new tab had.
- **Closed until asked.** The document does not take the page by default.
- **The new-tab escape stays, inside the viewer.** A second monitor is a real way to work, and
  taking it away would trade one complaint for another. It is an escape, not the default.
- **Evidence, not a control.** Nothing on the document is clicked to change a figure, and no
  colour is drawn over it — red and amber stay reserved for disagreement.
- **"There is no document" is a real answer**, not an error: an 835 was parsed, not scanned.

The confirm screen's own bare `<iframe>` was replaced by the same component, so there is now
one viewer rather than two that drift.

---

## 4. The error names what to do next

**This is the structural half of §0.** An `<iframe>` that 404s, 401s or is blocked fires **no
error event** — the browser renders the failure inside the frame and tells the page nothing.
In a new tab, even that was invisible.

So the viewer holds a deadline, because **silence is not success**. If the frame has not
loaded in 20s:

> The document did not come up here. Open it in a new tab instead — and if that does not work
> either, check the figures against your own copy and say so in the note.

…with the new-tab button right under it. Two things she can actually do, never a bare failure.

---

## 5. Budget math

Its own commit (`6a480db`), per the brief.

| Screen | Before | Measured after | Budget |
| --- | ---: | ---: | ---: |
| Check the figures against the page | 161 | **173** | 170 → **180** |
| Approve | 239 | 239 | 240 (unchanged) |

**The rail cost +28**: five step titles **and** their sentences — `variant="board"` renders
both; I assumed it put them in a `title` attribute, the screenshot showed otherwise, and the
comment in the sweep file now says the true thing — plus "Back to the check" and the viewer's
caption and new-tab escape.

**24 of those 28 were paid by cutting**, all of it duplication the rail created:

| Cut | Words | Why it was duplication |
| --- | ---: | --- |
| the scan caveat's first half | −17 | the rail's current step now says "Read from the scan … not yet checked against the page" two lines above it |
| "work down the list — each one is either right, or you type what the page says" | −15 | the two buttons on every row already say exactly that; with the rail it was the third telling |
| "still worth checking each figure against the page" | −9 | the outstanding count at the foot already says it |

Net **+12** on a screen that gained a whole navigation rail. The re-pin is **+10**, inside the
Bring-in-step-sentence cap the brief allows, and is 173 rounded up to the next ten per the
sweep file's own rule.

---

## 6. Mutation proofs

13 mutations over `tests/rcm-field-confirm-flow.test.tsx`, `rcm-field-confirm.test.tsx`,
`rcm-smoke.test.tsx` and `rcm-workbench.test.tsx`. **All 13 caught, none skipped.**

| Mutation | |
| --- | --- |
| Bring-in goes straight to done, as before the fix | ✅ |
| an unchecked scan no longer holds Match back | ✅ |
| the check page's primary stops routing to the confirm screen | ✅ |
| an 835 is dragged into the confirm step | ✅ |
| a server that does not say is treated as work outstanding | ✅ |
| the workbench goes back to a new tab | ✅ |
| the in-page drawer never renders | ✅ |
| the viewer shows an empty frame instead of saying there is no document | ✅ |
| the viewer sits on a spinner forever (silence reads as success) | ✅ |
| the failure is bare — it stops saying what to do next | ✅ |
| the new-tab escape is removed from the viewer | ✅ |
| the confirm screen opens its own scroll container | ✅ |
| the confirm screen pins itself to the viewport height | ✅ |

**Three survived the first run, and two were real test gaps rather than test-writing slips:**

1. *an 835 is dragged into the confirm step* — my 835 fixture set `ok: true`, so dropping the
   `required` check changed nothing. The case that breaks is a server reporting
   `required: false` **with** a non-zero count. Test added.
2. *the in-page drawer never renders* — the viewer's own tests covered the component, but
   nothing asserted `ClaimWorkbench` actually wires it. Covered now through the assembled claim
   page in `rcm-workbench.test.tsx`.
3. The third was my own bad anchor string — the mutation never applied, so it proved nothing
   either way. Fixed and re-run.

**A note on how gap 2 was closed.** My first attempt gave *every* claim in the smoke world a
provenance, which put the "See the EOB" button and a provenance line on every claim page render
and pushed that screen 451/430 over budget, cascading into four other walk steps. Reverted —
the guarantee belongs in a focused suite, not in the world every other test shares.

### Touched expectations

- `rcm-field-confirm.test.tsx` ×3 — the viewer swap changed the test ids
  (`rcm-confirm-document` → `…-frame` / `…-none`), and the caveat's wording moved to the rail.
  The "never prints a confidence score" test keeps both negative assertions and now pins the
  half that is this screen's own.
- `rcm-smoke.test.tsx` — the budget re-pin, in its own commit with the arithmetic above.

---

## 7. Gates

| Gate | Result |
| --- | --- |
| `pnpm run check` (tsc --noEmit) | ✅ clean |
| `pnpm run test` (vitest) | ✅ **2035 passed**, 133 skipped, 0 failed |
| `node --check server.js` | ✅ |
| `node scripts/shard-runner.mjs` (what CI runs) | ✅ **2802 tests, 2799 pass, 0 fail**, 3 skipped |

**Constitution.** Machine slugs and routes additive only (`fieldConfirm` on the wire,
`eob-viewer*` test ids; `RCM_STEPS` untouched). One primary per screen. No reason-less greyed
button — the viewer's failure state and the confirm screen's "what is left" row both carry
their reason. Banned-words guard green. W-16/D-17/Q2 and the posting spine byte-untouched.
**No Open Dental writes** — `rcmNoOdWrites` and `eobNoOdImports` both pass; the one new backend
read is a summary over `rcm_eob_field_confirmations` through the existing accessor. Office is
server-side throughout. Every fixture is fictional and the owner's real check appears nowhere.

---

## 8. Screenshots

`docs/screenshots/rcm-field-confirm-flow/` — before/after, at two viewport heights.

| Shot | Shows |
| --- | --- |
| `ff-01-before-island-1280x800-tall` | the confirm screen with no rail and no breadcrumb — an island |
| `ff-01-after-in-the-flow-1280x800-tall` | the same screen with the five-step rail, **Bring in** current and reading "7 figures not yet checked", Match waiting |
| `ff-01-after-…-1280x560-short` | the same, at a short viewport — **one scrollbar** |
| `ff-02-after-in-place-1280x800-tall` | the document panel and the figures side by side, in one scroll |
| `ff-02-after-…-1280x560-short` | the same at a short viewport, one scrollbar |

Light and dark at 800; light only at 560, where what is being shown is the scroll behaviour and
a second theme of the same geometry proves nothing twice. The document frame renders empty in a
static dump — jsdom fetches nothing — so those shots are of the **layout**.

---

## 9. Before merging

- The confirm flow still only reaches **staging** until `develop` promotes. The behaviour in
  §1 will not appear on prod before that.
- Item 4's root cause is a **class of failure removed**, not a specific fault reproduced. If the
  owner pressed something other than the document link, the diagnosis in §0 should be re-run
  against that control — the log queries are in the commit history and take a minute.
