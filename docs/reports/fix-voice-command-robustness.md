# Item 37: voice command robustness (dashboard only)

**Branch:** `fix/voice-command-robustness`, cut from `origin/develop` at `db9986b`
**Scope:** dashboard only. There are no backend changes, no new routes, and no change to the voice lab's backend route.

## The problem

On staging, depths, flags, skip and undo all worked by voice. "Jump to tooth N" and "go back to tooth N \<site\>" did not: both came back with the amber rejection.

The cause is how the speech service writes its results. Azure returns two versions of each phrase:

- **Display text.** The words reformatted for reading. Number words become digits, "to tooth thirty" can become "2:30", and capitals and commas are added.
- **Lexical text.** The words as spoken, before that reformatting.

The perio parser was reading the display text. It only matched exact lowercase words, so the reformatting broke the two navigation commands.

## The fix

### 1. Read the lexical text (`client/src/lib/speech/speechSession.ts`)

`speechSession.ts` is still the only file that imports the Speech SDK.

**What the pinned SDK (1.52.0) provides, checked in its `distrib` source:**

- Setting `speechConfig.outputFormat = OutputFormat.Detailed` changes how each final is built. The SDK parses it with `DetailedSpeechPhrase`:
  - `result.text` is `NBest[0].Display`. When recognition did not succeed, it is empty.
  - `result.json` holds the full JSON. Its NBest entries each carry `Lexical`, `ITN`, `MaskedITN` and `Display`.
- **Partials have no lexical form in either format.** The SDK builds them from a hypothesis that carries only `Text`.

**What the code does with it:**

- Every result handed to a page now has a `lexical` field.
- A final carries `NBest[0].Lexical`. That is the same hypothesis whose Display became `result.text`.
- `lexical` is `null` for every partial, for a NoMatch, and for a final whose JSON has no NBest.
- When `lexical` is null, the perio sheet parses the display text instead (`textForParser`).
- Detailed output only changes what comes back from Azure. It does not ask Azure to keep anything.

**Where each version is used:**

- **Perio sheet.** The parser reads the lexical text.
- **HUD ribbon.** It shows the display text as a new line, `Recognized “…”`, under the headline. This applies to accepted, rejected and refused phrases.
- **Voice lab.** Each free-mode final shows both versions: the display text, and then `lexical …` (or `— (not provided)`). This is a display change only. Nothing new is sent to CareIN, and a test pins that.

### 2. Tolerant navigation, as a permanent backstop (`voiceGrammar.ts`)

This applies to whichever text the parser receives, and only to jump and go-back commands.

| Part of the command | What is accepted |
|---|---|
| Head | `jump`, `go back`, or `jump back` (read as go back) |
| "to" slot | Required. One of `to` / `two` / `too` / `2` |
| "tooth" slot | Optional. At most one of `tooth` / `two` / `2` |
| Tooth | A word or a numeral 1–32. Or a clock token `2:YY`, read as tooth YY (`2:30` → 30, `2:05` → 5) |
| Site (go back) | Every existing name, plus the letter pairs `m b` / `d b` / `m l` / `d l` (the lexical text spells abbreviations out as letters), plus the one sound-alike `missile` → `mesial` |

Other rules:

- **Upper case and punctuation** are normalised, as before. The tokenizer now keeps a clock time as one token.
- **All or nothing.** If the target is missing, outside 1–32, or ambiguous, the whole phrase is rejected with item 35's amber message.
- **Ambiguity.** A `two` or `2` in the "tooth" slot could be the tooth itself. So both readings are tried against the whole phrase:
  - If both parse, the phrase is rejected, with reason `bad_tooth` and the message "could name tooth …".
  - Example: "jump to two three" could be tooth 3, or tooth 2 followed by a depth of 3.
  - The set of rejection reasons was not changed. It is a closed set, and a #226 test pins it.

### 3. Depth rules are unchanged (re-pinned)

- Depth words 0–12 still chart.
- Single digits 0–9 still chart, as before.
- Two-digit numerals, including 10–12, are still refused.
- 1010, 1011, 80 and a0 are still refused.
- **A clock token is never a depth.** It is refused as one number wherever it appears ("2:30", "three 2:30", "three two 2:30 four").

Effect of reading lexical text: depths 10–12 now reach the parser as the words spoken ("eleven"). The old numeral refusals are still tested at the parser level, even though the live path will rarely produce them.

## Decisions for Beau

1. **"Mesial" or "distal" said alone.** Three of the captures are like this ("…tooth 3 mesial", "…three missile", "…three mesial").
   - To land them on a site, the bare word means that site **on the pass the cursor is currently on**. On the buccal pass it is MB or DB; on the lingual pass it is ML or DL.
   - The parser never looks at the chart, so the sheet's own reducer works this out when it applies the command (`voiceGoBackSurface`).
   - The ribbon names the resolved site ("moved to tooth 3 MB"). The small "Heard:" line under the banner echoes the command as spoken ("back to #3 mesial").
   - If you would rather a bare mesial or distal be refused, it is a two-line change.
2. **Clock times: only an hour of `2` is decoded.** That 2 is the misheard "to/tooth". Any other hour, such as "3:30" or "12:14", is rejected with `bad_tooth`.
3. **The "to" slot is required.** "Jump 2:30" (no "to") is refused, because it was never captured. "Jump to 2:30" works.
4. **When only one reading parses, it is taken.**
   - "jump to 2 14" moves to tooth 14, because the other reading would chart a refused depth of 14.
   - "jump to tooth two three" keeps item 35's meaning: tooth 2, then a depth of 3.
   - Both are pinned in tests.

## Not verified

- **The lexical-text test cases are not field captures.** The lab could not show lexical text when the captures were made. The display-text captures are the real evidence, and every one of them is a test case on both the parser and the page.
- **The first staging walk below is the first check against real Azure output.** One open question: if Azure writes "Jump to 2:05" as the display, it may give "two oh five" as the lexical text. That reading is not handled and would be refused (amber, nothing charted).

## Tests

All test files below are new except `tests/voicelab-page.test.tsx`.

| File | What it covers |
|---|---|
| `tests/fixtures/voiceCaptures.ts` | The 11 captured phrases, verbatim, each with the command it must produce |
| `tests/voice-command-robustness.test.ts` (43) | Every capture, with and without a trailing period; the presumed lexical forms; the tolerance limits; ambiguity; sound-alikes being navigation-only and absent from the phrase hints; the depth rules re-pinned; clock tokens never being depths; the tokenizer; `textForParser`; the bare mesial/distal resolution on both passes, through the reducer |
| `tests/speech-session-lexical.test.ts` (6) | Drives the real `speechSession.ts` against a mocked SDK. Checks that Detailed output is set and that a final's lexical text comes through. Checks that lexical is null for a partial, a NoMatch, a final with no NBest, and bad JSON |
| `tests/voice-command-robustness-page.test.tsx` (16) | On the perio voice entry plus the HUD: the lexical text decides where the cursor goes; the ribbon shows the display text for accepted, rejected and refused phrases; every capture, sent as display text only, still lands on the right tooth and site |
| `tests/voicelab-page.test.tsx` (updated) | Both versions in free mode, and nothing sent to CareIN |

The #225 and #226 test files (`tests/hyg-perio-voice-*.test.ts(x)`) were not touched, and they all pass.

**Guard test** (`backend/test/voiceMediaGuard.test.js`, unchanged): 17 of 17 pass. Its planted-offender tests copy the modified `speechSession.ts`, and each planted offender still fails the scan. The Speech SDK is still imported in exactly one file.

**The new tests catch breakage.** Four mutations were tried, and each one made tests fail:

| Mutation | Tests that failed |
|---|---|
| No clock decoding | 6 |
| No ambiguity check | 1 |
| No sound-alike | 5 |
| Clock token allowed down the depth path | 1 |

**Gates:**

- Dashboard: `pnpm run check` clean. `pnpm run test` passed 2429, with 160 skipped.
- Backend: `node --check server.js` OK.
- Backend `node --test` full run: 3034 of 3039 passed and 2 files failed (`sendToTc`, `onDemandTranscription`). Both passed when rerun on their own, and nothing under `backend/` was changed. This is the known Node 22 test-runner flake that CI's shards work around.
- An earlier full dashboard run had one timeout in `rcm-shell` while `npm ci` was running. It passed when rerun.

**Review:** one fresh-context review round. It approved, with no blockers. Its two low-severity findings, about readings where only one parses, are now pinned as deliberate.

## Staging walk

Use the Roland test patient **Stedi Test 2, PatNum 12827**, and no other chart.

1. **Voice lab first (no chart).** Open `/voicelab`, arm it, and stay in free mode. Say each of these:
   - "jump to tooth fourteen"
   - "jump to tooth thirty"
   - "jump back to tooth three mesial buccal"
   - "go back to tooth three M B"

   Each row should show both the display and the lexical text. Note the lexical text. It confirms or corrects the presumed lexical cases.
2. Open the perio sheet for a 12827 hygiene visit at Roland, in Depth mode, and arm voice.
3. Say "jump to tooth thirty".
   - Expected: the HUD moves to #30.
   - The ribbon headline says "jump to #30".
   - The line under it reads `Recognized “…”` with Azure's display text, which may well be "2:30".
4. Say "jump to tooth fourteen", then "jump to tooth five". Each should land on that tooth.
5. Say "jump back to tooth three, mesial, buccal". Expected: tooth 3 MB is ringed.
6. While on a buccal site, say "go back to tooth three mesial". Expected: 3 MB.
7. Move to a lingual site and say it again. Expected: 3 ML.
8. Say "three two three". The depths should chart from the ringed site onward.
9. Say "eleven". It should chart 11 (the lexical text is "eleven").
10. Say "jump to tooth thirty three". It should come back amber, with nothing charted.
11. Say "undo" to take back step 8 and step 9's readings as needed. Then disarm.

**Do not stage or send the chart**, unless you want to clean it up through the normal flow.
