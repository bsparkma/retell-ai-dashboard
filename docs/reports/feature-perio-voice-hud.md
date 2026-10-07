# Item 36 — Perio voice HUD

Branch `feature/hyg-perio-voice-hud` off `origin/develop` (2ce0ccf, the #225 merge), worktree
`C:\Users\beau\carein-wt\hyg-perio-voice-hud`. PR → `develop`. **Not merged.**

Precondition checked first: PR #225 (`feature/hyg-perio-voice`) is merged into `origin/develop`
as 2ce0ccf (2026-10-07 16:35 UTC).

## What shipped

When voice ARMS on the hyg perio sheet, a large HUD covers the sheet. It follows the approved
"Perio Voice HUD Mockup" (Main board). It is **pure presentation**. It renders state that #225
already keeps:

- the sheet's entry state: chart, cursor, last-entered site
- the parse of the last final
- the token's mint time

There is no backend change, no new route, no request from the HUD, no grammar or parser change,
and no change to the token or budget flow. `git diff 2ce0ccf -- backend` is empty.

| Piece | File |
|---|---|
| Model (pure) | `new-dashboard/client/src/features/hyg/perio/voiceHud.ts` |
| HUD | `features/hyg/perio/PerioVoiceHud.tsx` |
| Wiring | `features/hyg/perio/PerioVoiceEntry.tsx`. It renders the HUD only while `armed`, records `heard` and `endsAt`, and takes a read-only `entry` prop. |
| Sheet | `pages/hyg/HygPerio.tsx` — one line: passes `entry={entry}` |

### How it is built
- **Every disarm path closes it, by construction.** The HUD is mounted inside `PerioVoiceEntry`
  only while `armed`. The HUD Disarm, the banner Disarm, navigation, a hidden tab, 9.5 minutes, a
  recognition error and the chart locking for a send all go through #225's existing `disarm`. The
  sheet underneath is the same component, still holding every reading, so closing the HUD
  reveals the sheet as charted.
- **The ribbon cannot disagree with the sheet.** `voiceOutcome(before, commands)` runs the sheet's
  own `reducePerioEntry` on a copy:
  - If the sheet would refuse the phrase (skipped tooth, end of chart, not Depth mode, nothing to
    undo), the ribbon shows the sheet's own sentence, amber, with "nothing charted".
  - Otherwise the ribbon steps the commands one at a time and names what they did, for example
    `charted to tooth 1 · bleeding on 1 MB · moved to tooth 2`.
  - The heard text is the commands echoed back (`3, 2, 3, bleeding`), never the raw transcript.
    This is #225's rule.
- **A locked chart is never painted green.** The sheet's `onVoice` drops a final once the chart is
  locked for a send. A final can land after the lock commits but before the disarm effect runs.
  In that gap the HUD records nothing. A race test reproduces the gap, and it fails without the
  guard.
- **The HUD does not take focus.** The grid keeps the keyboard, so a key still charts while the HUD
  is up, through the same reducer.
- **Countdown:** `endsAt = mintedAt + VOICE_AUTO_DISARM_MS`. That is the same base #225's
  auto-disarm timer uses, so the HUD reads 0:00 when voice disarms itself.

### Layout
- **Header:** pulsing ARMED pill (#C2362B), "Voice perio", and the pass with its progress, e.g.
  `Upper buccal pass · 1 of 16 charted`. A `· N skipped` suffix appears only when teeth are
  skipped. Then the m:ss remaining and the Disarm button.
- **Heard ribbon:**
  - "Listening… say the first depth" until a final arrives.
  - On an accepted final: green check, the heard text, and what happened. This is a polite live
    region.
  - On a refusal: amber, `Heard “X” — nothing charted`, and the existing guidance. This uses
    `role="alert"`.
- **Tooth strip:** five teeth of the cursor's arch, in the sheet's screen order (upper #1→#16,
  lower #32→#17), centred and clamped at the arch ends. Each card shows:
  - the tooth number and its tag: NOW, DONE, SKIPPED or NEXT
  - the active pass's three sites, large, with the next site ringed in teal (#0E7C7B)
  - the other surface's three values, small and grey
  - a flags chip when any flag is set

  The NOW card is enlarged with a teal ring, and NEXT cards are dimmed. On the lingual pass the
  rows swap.
- **Cue row (always shown):** "three two three", the four flag words, "skip this tooth",
  "missing", "jump to tooth fourteen", "go back to tooth three MB", "undo".
- **Fonts:** Sora for the display type and DM Sans for the body. Both are already loaded by the
  app.

### Decisions worth a look
1. **Site order inside a card follows the sheet, not the mockup's fixed MB·B·DB.** The cards use
   `screenSites`, the same order as the grid columns. On a patient-right tooth that is DB·B·MB.
   Each cell is labelled, so the HUD and the sheet never show the same tooth mirrored. If you
   want the mockup's fixed order, it is a one-line change in `hudCard`.
2. **NOW beats SKIPPED.** A jump or a tap can leave the cursor on a skipped tooth. That card stays
   NOW and its body says "skipped", with nothing ringed, so the strip always shows where she is.
3. **NEXT means "not charted on this pass", not strictly "after the cursor".** After a jump, a gap
   behind the cursor also reads NEXT. The spec fixes the four tags; a fifth (OPEN) would need
   your call.
4. **"missing" is reported as "tooth N marked missing".** The chart effect is identical to a skip.
   That is #225's reducer, unchanged.

## Stage → confirm → send is unchanged
- The HUD has no stage, send or save control, and it calls no API.
- While voice is armed, the HUD visually covers the staged-writes tray. To stage, she presses
  Disarm, which takes one tap, and the tray is exactly as before.
- Staging and sending lock the chart, and a locked chart disarms voice and closes the HUD. That is
  #225's existing rule.
- **Known limitation:** the HUD is not modal (`aria-modal="false"`), so that the grid keeps the
  keyboard. As a result, Tab can still reach the sheet's buttons behind it. Making the page
  `inert` would also freeze the grid. Any send still needs the existing confirm dialog, so
  review-then-send holds.

## Acceptance (tests)
`tests/hyg-perio-voice-hud.test.tsx`, which covers the model and the component (31 tests):

| Requirement | Pinned by |
|---|---|
| Window clamps at #1 and #16 | `upper #1…#16` table, plus the lower arch at #32/#17. No window ever crosses arches (all 32 teeth). |
| Row swap follows the pass | `when the pass flips to lingual, the rows swap`, plus the on-screen `data-pass` and the ringed site |
| Ribbon: accept and every rejection class | accepted; the grammar's five classes (`over_max`, `concatenated`, `out_of_vocabulary`, `bad_tooth`, `incomplete`); the sheet's four refusals (skipped, not Depth mode, nothing to undo, end of chart), each equal to the reducer's own sentence |
| HUD issues no request | At runtime: fetch, XHR `open`, `sendBeacon` and `Storage.setItem` are spied through render, a re-render and 5 s of ticks; none is called. In the source: the HUD files import no API, speech, auth or query module and name no transport. |
| Countdown and Disarm | 9:30 drops to 8:29 after 61 s; Disarm calls the disarm it is given |

`tests/hyg-perio-voice-hud-page.test.tsx`, the page with #225's mock harness (13 tests):

| Requirement | Pinned by |
|---|---|
| Opens on arm, absent while disarmed | first test |
| Every disarm path closes it, readings kept | HUD Disarm, banner Disarm, hidden tab, recognition error, navigation, 9.5 min, and the chart locking. Each asserts the mic stopped, and all but navigation and lock assert the save still holds 3/2/3. |
| Locked chart never painted green | the race test above. Mutation-checked: it fails with the guard removed. |
| Undo / skip / jump reflect in the strip | a spoken sequence: 3-2-3 → four → undo → skip → jump 14 → go back to 3 MB, asserting the NOW tooth, the window, the tags and the ringed site |
| Rejected and refused on the page | `1010` shows amber in the HUD while #225's line still says it; jump → skip → jump to a skipped tooth gives `refused`; nothing is saved |
| No new request on the page | the only calls are the existing ones (fetch, save, mint once); no stage or send starts; the words reach no request and no storage |
| Grid keeps the keyboard | a key typed with the HUD up still charts |

Mutation check: when the HUD is rendered regardless of `armed`, 6 of the page tests fail. The
navigation test passes either way, because navigation unmounts the page.

**#225's tests are untouched and green.** `hyg-perio-voice-page.test.tsx` (13),
`hyg-perio-voice-grammar.test.ts` (28) and `hyg-perio-voice-shots.test.tsx` have no diff.

## Gates (local, Node 22, pnpm 10.4.1)
- `pnpm run check` (tsc --noEmit): clean.
- `pnpm run test`: 138 files passed, 2363 tests passed, 160 skipped.
  - One earlier full run crashed an unrelated RCM file under load. It was green on rerun.
  - `dark-mode-contrast` caught a `bg-white` dot on the ARMED pill. It is now `bg-current`, and no
    exception was added.
- Backend: `node --check server.js` OK. `node --test`: 3053 of 3057 passed.
  - The failures were file-level and differed per run (`platform.test.js`, `sendToTc.test.js`).
    Both are green in isolation. This is the known Node 22 runner flake (CI shards).
  - The backend has no diff.
- Fresh-context reviewer: 2 rounds. Round 2 found nothing blocking.
  - Round 1 approved, with two MEDIUM items.
  - The locked-chart green was fixed and race-tested. The accessibility half became a polite live
    region, plus the documented non-modal limitation above.
  - The LOW items were taken or documented under "Decisions worth a look".
- CI on the merge ref: see the PR.

## Screenshots
`docs/screenshots/hyg/hyg-perio-voice-hud-0{1..4}-*-1180x900-{light,dark}.png`, produced by
`tests/hyg-perio-voice-hud-shots.test.tsx` (`HYG_SHOTS=1`) and then `scripts/shoot-hyg.mjs`.
Only the HUD dumps were shot; no other PNG was rewritten.

| Shot | Shows |
|---|---|
| 01-listening | ARMED, nothing said yet, window #1–#5 |
| 02-accepted | after "3 2 3 bleeding" and "4 3": #1 DONE with a bleeding chip, #2 NOW with MB ringed |
| 03-rejected | "1010" in amber: heard as one number, nothing charted |
| 04-lingual | upper lingual pass on #3: DL·L·ML large and the buccal values small beneath |

## Staging walk (Beau)

**Any chart interaction on staging uses the roland test patient Stedi Test 2, PatNum 12827, ONLY.**
Do not dictate onto any other chart. The item-20 test-patient rail refuses a non-test send anyway.

1. Staging already has `HYG_VOICE=1` from item 35. `GET /auth/me` shows `"hygVoice": true`.
2. Open the hyg day for **roland**, then an appointment for **12827**, then the visit, then Perio.
   Expect the grey VOICE OFF bar and no HUD.
3. Click **Arm voice** and allow the microphone. The HUD opens over the sheet:
   - a pulsing ARMED pill, `Upper buccal pass · 0 of 16 charted`, and the countdown at ~9:30,
     ticking down
   - the strip shows #1–#5 with #1 NOW and its first site ringed
   - the cue row is at the bottom
4. Say "three two three bleeding". The ribbon turns green with `3, 2, 3, bleeding` and
   `charted to tooth 1 · bleeding on 1 MB · moved to tooth 2`. #1 shows DONE with a bleeding chip,
   and #2 is NOW.
5. Say "ten ten". The ribbon turns amber: `Heard “1010” — nothing charted`, plus the guidance. The
   progress count does not move.
6. Say "skip this tooth". #2 shows SKIPPED and #3 is NOW. Then say "undo"; the ribbon names what it
   took back.
7. Say "jump to tooth fourteen". The strip shows #12–#16 with #14 NOW, which checks the clamp at
   the arch end. Then say "go back to tooth three MB". The strip returns to #1–#5 with #3 MB ringed.
8. Say "go back to tooth three ML". The pass label reads `Upper lingual pass`, and the large row
   becomes DL·L·ML with the buccal values small beneath.
9. Press a digit key on the keyboard while the HUD is up. It charts, and the HUD shows it.
10. Disarm paths. Each closes the HUD and leaves the sheet showing everything charted:
    - the HUD **Disarm**
    - re-arm, then switch tabs and come back
    - re-arm, then leave for the day view
    - optionally, re-arm and leave it for 9.5 minutes
11. With the HUD closed, use the existing tray: **Stage chart**, then Send, then the confirm dialog.
    It works exactly as before. **Confirm only on 12827.** Verify the exam in Open Dental, and
    remove it with the page's undo if this was only a walk.
12. In the browser devtools Network tab, with the HUD up and speaking, the only requests are the
    sheet's own saves. The HUD adds none.

## Open items
- **Site order in the cards follows the sheet, not the mockup's fixed MB·B·DB** (Decision 1). This
  needs your call.
- **The tag set has no OPEN tag** for a gap behind the cursor (Decision 3).
- **The HUD is not modal**, so Tab can reach the sheet's controls behind it (see above).
- **The live region mounts with the accepted ribbon** (round-2 reviewer note). Some screen readers only
  announce changes inside a region that already exists, so the FIRST accepted phrase may go unspoken.
  The fix is a persistent `aria-live` wrapper around the ribbon. It was left out to avoid unreviewed code after the final round.
- Carried from item 35, unchanged here: numerals 10–12 are refused, and there is one server-wide
  voice budget.
