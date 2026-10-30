# CO-1 polish: list beside the workup, Not discussed folded

Branch `fix/tc-checkout-workup-polish` off `origin/develop` (56ca395, which has CO-1 / PR #292 merged).
Covers Beau's staging rulings of 2026-10-29. **Frontend only**: no backend, contract, migration or route changes. No new queries.

## 1. Master-detail on `/tc/checkout/:id`

- **Rail.** The Checkout list stays visible as a narrow column (`lg:w-72`) to the left of the workup.
  - It shows the same rows and the same **Waiting / Done today** filters as the Checkout page, condensed to name, office badge, priority, time and "N of M sections done" (or the status, once answered).
  - The patient on screen is highlighted (`aria-current="page"`).
  - Claim and Dismiss are not on the rail cards. They stay on the Checkout page, and Claim is also inside the workup.
- **One fetch pattern.** The Checkout page's load and replace logic moved, unchanged, into `features/tc/checkout/useCheckoutList.ts`. That hook does the same office-fanned `listCheckout` per tab, and both the Checkout page and the rail use it. A test pins that the rail calls `listCheckout` once and doesn't call it again on a switch.
- **Switching in place.** Choosing another patient calls the existing `checkoutWorkupHref`, so the address updates. Only the workup screen remounts; the rail is not keyed by patient, so it stays put.
  - Every read-back (tick, claim, outcome) also updates that patient's card in the rail.
  - Changing the rail's filter does **not** reload the workup on screen; a test pins this.
- **In-flight save.** The workup's existing one-save-at-a-time guard now reports busy (`onBusyChange`). A switch chosen while a tick is saving waits, and happens once the server's read-back has landed.
- **Narrow screens.** Below `lg` the rail folds behind a **Patients (N)** toggle, closed by default, so the workup keeps the screen. Choosing a patient folds the rail again.
- **Back** still goes to `/tc/checkout`.

## 2. Not discussed collapsed (workup view only)

- `ExistingTreatmentFromHygiene` takes a new optional prop, `collapsedGroups`. Only `CheckoutWorkup` passes it, with `["not_discussed"]`.
  - That group starts folded to **Not discussed (N)** and opens or closes on a tap (`aria-expanded`).
  - Its "Ready to present" box stays visible while the group is folded.
- The open/closed state is component state only, with no storage. It resets on the next patient, because the workup remounts per patient. A test also checks that `localStorage.setItem` is never called.
- **Unchanged:** every other group. Also the quick-look sidebar and the case page, which render the block without the prop; a test pins that Not discussed still renders open there.

## Tests

Added `new-dashboard/tests/tc-checkout-workup-polish.test.tsx`, with 8 tests plus 3 screenshot dumps:

| Test | What it pins |
| --- | --- |
| Rail lists the rows | Uses the same `listCheckout`, called once; current patient highlighted; Back link unchanged |
| Switching patients | Address and workup change; `getCheckoutHandoff` is called for the new patient; the list is not refetched |
| Switch during a save | The switch is held until the save resolves; the saved patient's card then shows the read-back ("1 of 4") |
| Rail filters | Done today tab works; switching it does not reload the workup |
| Narrow toggle | `lg:hidden` toggle, panel `hidden lg:block`, opens and folds again |
| Not discussed in the workup | Folded with a count; opens and folds; the present box stays visible; other groups open with no toggle |
| Per-view memory | The next patient starts folded again; nothing is written to storage |
| Without the prop | Not discussed renders open with no toggle (sidebar and case page) |

Mutation checks:
- Removing the hold, so a switch navigates immediately, turns the "switch during a save" test red.
- Removing `collapsedGroups` from the workup turns both Not discussed workup tests red.

**No existing test expectation changed**, so nothing needed a `RULING (CO-1 polish)` label. The CO-1 fixtures carry no Not discussed items, and the page tests mount `CheckoutWorkupScreen`, whose props were extended but not changed.

Local results: `pnpm run check` is clean, and `pnpm run test` gives 201 files and 3036 tests passing, 0 failing.

## Screenshots (synthetic data, roland fixture 12827)

Before (CO-1 as merged): `docs/screenshots/tc/co1/tccheckout-co1-01-workup-1280x2000-{light,dark}.png`.

After, in `docs/screenshots/tc/co1-polish/`:

| Shot | Shows |
| --- | --- |
| `tccheckout-co1p-01-master-detail-1440x2000-{light,dark}.png` | Rail plus workup, Not discussed folded |
| `tccheckout-co1p-02-not-discussed-open-1440x2000-{light,dark}.png` | Not discussed opened |
| `tccheckout-co1p-03-narrow-600x1600-{light,dark}.png` | Narrow screen, rail behind the Patients toggle |

The narrow shot is 600px wide, not phone width. Headless Chrome won't lay out below roughly 500px, so a 420px capture clipped the page's right edge. That is a limit of the capture, not of the layout.

## Guardrails

- Display only: no new routes, queries or Open Dental access, and no fees.
- No real patient or staff names anywhere. The synthetic names are "Kiwi, Sam", "Fig, Lee" and "Plum, Ash".
- TypeScript strict with no `any`; `tsc` is clean.

## CI

Pending; see the PR.
