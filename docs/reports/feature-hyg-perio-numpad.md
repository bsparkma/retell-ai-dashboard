# 17 — Bluetooth number pad keys for perio entry

Branch `feature/hyg-perio-numpad`, off `origin/develop` (after #182). Worktree
`C:\Users\beau\carein-wt\hyg-perio-numpad`. No Open Dental reads or writes; no backend change.
Push/PR status is in §6.

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Every key in the table performs its action, per key | `tests/hyg-perio-numpad.test.ts` › *ACCEPTANCE 1*: pad `0`–`9` (depth then advance), Shift+main-row digit still 10–19, pad `Enter` (next, no reading), `/ * - +` one test each (and each toggles off again), `.` skip and un-skip (and `,` on a comma-decimal pad), `(` `)` to the first site of the previous/next tooth including passing over a skipped tooth and stopping at #1, `Tab` and `=` do nothing | ✅ |
| 2 | Flag keys land on the last-entered site, exactly like their letter twins | › *ACCEPTANCE 2*: for each of `/ * - +` against `B S P C`, three scripts (just after a reading, after moving on, before anything was typed) produce **identical** chart, cursor and last-entered state | ✅ |
| 3 | Backspace steps back AND erases; Delete/Esc erase in place | › *ACCEPTANCE 3*: two Backspaces walk back two sites erasing each; Backspace after a move erases the previous site; `Delete` and `Escape` clear the current site and the cursor stays; a pad's own Delete key is not mistaken for Num Lock | ✅ |
| 4 | Num Lock-off input triggers the warning and never writes a reading | › *ACCEPTANCE 4*: all eleven Num Lock-off keys (`Numpad0`–`9` as Insert/End/ArrowDown/…/Clear, `NumpadDecimal` as Delete) are flagged and map to nothing; a whole quadrant typed that way leaves the state **identical**; the main keyboard's own arrows/Home/Delete are not flagged. Page: `hyg-perio-page.test.tsx` › *Num Lock off says so* — an `alert` banner, 0 of 192 charted, cursor unmoved; the next real digit charts and clears it. Screenshot `hyg-perio-numpad-17-numlock-off` | ✅ |
| 5 | Letter keys and touch entry unchanged | › *ACCEPTANCE 5*: 14 letter/arrow/digit keys map to exactly the actions they did before; the existing keyboard suite (`hyg-perio.test.ts`) passes untouched. Page: keypad buttons still chart 4 and 12 and toggle plaque | ✅ |
| 6 | Legend renders, dismisses, returns; screenshots light + dark | `hyg-perio-page.test.tsx` › *the key legend renders, hides, and comes back*: every pad key is listed, Fn and the reserved keys are explained, Hide removes it, it stays hidden on this device after a reload, Show keys brings it back. Screenshots `hyg-perio-numpad-16-legend` (1180×1500, light + dark) | ✅ |

Gates: `node scripts/shard-runner.mjs` **4/4 green** (2516 tests, 2513 pass, 0 fail, 3 skipped);
`pnpm run check` clean; `pnpm run test` 110 files / 1803 tests pass (19 files skipped: screenshot
suites, run separately with `HYG_SHOTS=1`, 18/18). No `any`.

## 2. What changed

- `features/hyg/perio/entry.ts` — still DOM-free. The pad table lives in exported constants
  (`NUMPAD_FLAG_KEYS`, `NUMPAD_SKIP_KEY`, `NUMPAD_PREVIOUS_TOOTH_KEY`, `NUMPAD_NEXT_TOOTH_KEY`,
  `NUMPAD_RESERVED_KEYS`); one new action, `tooth` (±1); `Escape` joins `Delete` as clear;
  `PerioKey` gains an optional `location`; new `perioKeyWarning(e)` returns `"numLockOff"` or null.
- `features/hyg/perio/PerioKeyLegend.tsx` — the legend, built from those constants, so it cannot
  promise a key the reducer does not honour. Says Fn cannot be mapped and Num Lock must be on.
- `pages/hyg/HygPerio.tsx` — the Num Lock banner (`role="alert"`), the legend below the
  keypad/flags/entry-order row, and its hidden/shown preference in `localStorage`
  (`hyg.perio.keyLegendHidden`, wrapped in try/catch — a private window just shows the legend).
  The Flags panel's one-line key hint now points at the legend.

## 3. Decisions worth checking

### 3.1 Num Lock off used to chart silently — by accident, and correctly

The digit rule maps by physical `code` (so Shift+3 is still the 3 key). With Num Lock off a pad's
7 key sends `code: "Numpad7"`, `key: "Home"`, so **before this slice it charted 7**. It happened
to be the right number, but only by accident. The brief asks that a depth never be guessed from a
navigation key, so the Num Lock check now runs first and those keys chart nothing. If a hygienist
preferred the old accidental behaviour, this is the line to argue about.

The signature is a navigation key (`Home End PageUp PageDown Arrow* Insert Delete Clear`) that
came from a numpad digit/decimal `code`, or from the numpad `location` with a `code` different from
its `key`. A pad's own dedicated Delete or arrow keys send `code === key` and are not flagged.

### 3.2 `(` and `)` versus 10 mm and 19 mm — needs checking on the real pad

On the main keyboard `(` and `)` are Shift+9 and Shift+0, which have meant 19 mm and 10 mm since
slice 10 and still do. So `(`/`)` move a tooth **only when the pad sends them** — a `Numpad…` code
or `location === 3`. Extended pads commonly send `NumpadParenLeft`/`NumpadParenRight`. **But some
"calculator" pads synthesise Shift+Digit9 for their `(` key.** If the pad being bought does, its
`(` will enter 19 mm, not move a tooth, and the two cannot be told apart from the browser. Worth one
test press with the real pad before rollout; if it synthesises, the fix is a different key for tooth
moves, not a change to the depth rule.

### 3.3 `-` and `+` on the main keyboard

Mapped by `key`, so the main row's `-` (and Shift+`=` → `+`) also toggle plaque/calculus. They
meant nothing before, so no existing behaviour changes.

### 3.4 Backspace

The existing Backspace already did "step back one site and erase it" (it takes back the reading
just typed, or the one before the cursor), so it was left as it was and is now asserted per the table.

## 4. Screenshots

New: `hyg-perio-numpad-16-legend-1180x1500-{light,dark}.png`,
`hyg-perio-numpad-17-numlock-off-1180x900-{light,dark}.png`. Re-shot: every perio-page shot at
1180×900, because the Flags panel's key hint (visible in all of them) changed wording.

## 5. Not verified

No physical Bluetooth pad was available. Every event shape is the one the DOM specifies for a
numpad (`code`, `key`, `location: 3`), and §3.2 names the one case that depends on the specific
hardware.

## 6. Push / PR

Pushed to `origin/feature/hyg-perio-numpad`. PR into `develop`: see the line appended below. Not merged.

PR: **#184** — https://github.com/bsparkma/retell-ai-dashboard/pull/184 (base `develop`, open, not merged).
