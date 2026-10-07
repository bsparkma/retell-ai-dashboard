# Item 35 — Perio voice entry

Branch `feature/hyg-perio-voice` off `origin/develop` (eeae164), worktree
`C:\Users\beau\carein-wt\hyg-perio-voice`. PR #225 → `develop`. **Not merged.**

## What shipped

Hands-free probing depths on the existing hyg perio sheet. Audio goes browser → Azure Speech directly
(10-minute token). Recognised text is parsed in the browser. What it becomes is readings in the chart
she is already editing, through the sheet's own entry reducer. From there it goes through the
**existing** save → stage → confirm → send. No new Open Dental path. No auto-write. Office and PatNum
are derived exactly as before.

| Piece | File |
|---|---|
| Switch | `backend/config/hygVoice.js` — `HYG_VOICE === '1'` exactly; no prod refusal (prod never sets it) |
| Token route | `backend/routes/hyg/voice.js` — `POST /api/hyg/voice/token?office=`, mounted in `routes/hyg/index.js` |
| Budget | `backend/services/hyg/voiceBudget.js` — `hyg_voice_budget.json`, `HYG_VOICE_DAILY_MINUTES` |
| `/auth/me` | `hygVoice` boolean, same predicate as the route (`backend/routes/auth.js`) |
| Shared session | `new-dashboard/client/src/lib/speech/speechSession.ts` (moved from `pages/voicelab/`) |
| Grammar | `new-dashboard/client/src/features/hyg/perio/voiceGrammar.ts` (pure) |
| Reducer | `features/hyg/perio/entry.ts` — new `voice` action (`applyVoice`) |
| UI | `features/hyg/perio/PerioVoiceEntry.tsx`, rendered by `pages/hyg/HygPerio.tsx` |

### The route
- **Where it sits:** inside the hyg router. It is therefore below the `/api` auth gate and tenant
  context, behind `requireModule('hyg')`, and behind `requireReadWrite`, which makes a POST demand
  `hyg.write`. It is also behind the router-wide `requireOffice`; the office is only that scope and
  is never sent to Azure.
- **Flag check:** the flag is read **per request**, through the same predicate `/auth/me` uses, so
  the route and the UI cannot disagree. When it is off, the request falls through to the 404.
- **Body:** any body is refused (400 `HYG_VOICE_NO_PAYLOAD`), whether `express.json` parsed it or
  not. Any non-zero `Content-Length` or chunked framing counts.
- **Response:** only `{ success, token, region }`. The client parses it with a **strict** zod
  schema, so an extra field is refused before the page sees it.
- **Token mint:** it reuses the lab's `services/voiceLab/speechToken.js` (item 34 built it as the
  plumbing perio would reuse). That file has no requires. The lab's route and the lab's budget are
  not loaded; a module-graph test pins this.
- **Logs:** codes, minutes and ms only, e.g. `[hyg-voice] token minted in 1ms (10/60 min reserved today)`.

### The budget
- Each mint reserves 10 minutes. The token lives 10 minutes and the UI disarms at 9.5, so the
  reservation is an upper bound.
- A reservation must fit whole. The default cap is 60, so six arms a day per server.
- 0, a negative or a non-numeric cap refuses everything.
- The day rolls at Central midnight.
- A failed mint releases its reservation. Disarming early refunds nothing (see open items).

### The grammar
- **Depths:** 0–12 as words, 0–9 as numerals. Each auto-advances along the sheet's existing
  `chartingOrder` by dispatching the reducer's own `number` move, so voice and keyboard walk
  identically (pinned by a test).
- **Flags:** `bleeding`, `suppuration`, `plaque`, `calculus`. A flag lands on the site just charted
  and **sets** rather than toggles.
- **Commands:**
  - `skip this tooth` and `missing` skip the current tooth and never un-skip.
  - `jump to tooth <N>` goes to the tooth's first open site.
  - `go back to tooth <N> <site>`: sites by every common name (DB, distobuccal, disto buccal,
    distofacial, B/buccal/facial, MB…, DL…, L/lingual, ML…).
  - `undo` behaves as Backspace, and is refused when there is nothing to undo.
- **A final is all or nothing.** One unreadable word refuses the whole final, with a visible amber
  flag that names what was heard and why, and nothing is charted. Depths auto-advance, so dropping
  a word mid-final would shift every later depth onto the wrong site.
- **Ignored:** empty finals (breath, a cough, punctuation only) are dropped silently.
- **Refused in the reducer:** a depth past the last site, a depth onto a skipped tooth, a jump onto
  a skipped tooth, and anything said while the sheet is in a non-Depth mode. Each leaves the chart
  untouched and uses the sheet's existing refusal banner.
- **Phrase list:** `PERIO_VOICE_PHRASES` holds the full vocabulary: depths, flags, commands, teeth
  1–32 as said, and site names. A test checks the phrase list and the parser vocabulary against
  each other in both directions.

### The lab's three confusions (acceptance row 4)
The lab's specific confusion pairs are not recorded anywhere in the repo; the item-34 report has no
run results. I pinned the three classes the spec names. **Beau: if the lab printed specific pairs,
check that each falls into one of these:**

| Confusion | Examples | Reason |
|---|---|---|
| Depth past 12 | `thirteen`, `15`, `19`, `twenty` | `over_max` |
| Concatenated numbers | `1010`, `80`, `323`, `05`, `3.5`, `1,010`, and **`10` `11` `12`** | `concatenated` |
| Out of vocabulary | `banana`, `for`, `to`, `won`, `ate`, `bleed` | `out_of_vocabulary` |

**Deliberate departure from the spec, for Beau to rule on.** The spec says depths are "words or
numerals". Two-digit numerals, including 10–12, are rejected, because Azure's display text writes
"one one" as `11` exactly as it writes "eleven". Trusting `11` could chart a wrong depth silently,
which is the worst thing this grammar can do. Depths 10–12 still chart from the words, or by hand.
The refusal message says so. The real fix is to read Azure's *lexical* form rather than its display
text: a change to the shared session, worth doing once a pilot shows how often deep pockets are
dictated.

### Arm / disarm (decision V-6)
- **Look:** a full-width red **VOICE ARMED** bar, or a grey **VOICE OFF** one.
- **Per visit:** the component is keyed by `office:aptNum`, so every visit starts disarmed.
- **Never saved:** the state is in component memory only. The guard forbids storage in the voice
  files.
- **Disarm triggers:** route change or unmount, `visibilitychange` to hidden, `pagehide`, 9.5
  minutes after the **mint**, the chart locking for a send (Sending / Failed / Written), and any
  recognition error.
- **Late events:** a session that opens after she left is closed at once. Speech events from a
  disarmed or stale session are dropped, so nothing charts once the bar says VOICE OFF.
- **SDK loading:** the SDK is loaded only on Arm (dynamic import), so it stays out of the perio
  page's bundle.

## Acceptance

| # | Proof |
|---|---|
| 1 Flag off ⇒ 404 + no UI | `hygVoice.test.js`: through the real hyg stack, the flag off (and `'true'`) gives 404, with no mint and no reservation. With the flag on, the request still needs the module, `hyg.write` (`reviewer` gets 403), auth (401) and an office (400). `auth.test.js`: `hygVoice` is false for `'' '0' 'true' 'on' ' 1' '1 '` and true only for `'1'`. `hyg-perio-voice-page.test.tsx`: flag off renders no voice UI and never mints. |
| 2 Key/token never beyond `{success,token,region}`, never in logs | `hygVoice.test.js`: the body keys are exactly those three; the key is in no body, header or log line; the token is in no log line; a failed STS echoes neither key nor body and releases the reservation; a missing key or region gives 503. The client's strict schema refuses an extra `key` field, and the request carries no body. |
| 3 Three budgets independent, byte-identical | `hygVoice.test.js` seeds `transcription_budget.json` and `voicelab_budget.json`, spends perio voice to 429, then asserts **both files are byte-identical** and both services report the same numbers. The reverse also holds: with both others spent at 9999, perio voice still mints and counts only its own 10. A source scan and the module graph show the voice files never name either other budget. Cap 0 refuses, and the Central-midnight roll is tested. |
| 4 Parser rejects the confusions, plus full command coverage | `hyg-perio-voice-grammar.test.ts`, 28 tests: each confusion class, all-or-nothing, every command form and every site name, flags, ignored finals, the phrase list, and reducer placement in charting order. Also end of chart, undo with nothing to undo, non-Depth modes, and skipped teeth. On screen, `1010`, `80`, `fourteen` and `banana` each raise the flag and nothing is saved. |
| 5 Zero OD calls | `hygVoice.test.js`: the voice module graph contains no OD module. Driving success ×6, the budget 429, the payload 400, an unknown path 404 and the flag-off 404 with a `FakeOd` leaves `od.calls`, `od.writes` and the requested office handles all empty. The only outbound URL is the STS. `hygNoOdWrites.test.js` pins `voice.js` to no store, writer or OD client. |
| 6 Per-visit reset, nav / hidden / 9.5 min disarm | `hyg-perio-voice-page.test.tsx`: opens disarmed and stores nothing on arm; moving to another `aptNum` closes the mic and opens disarmed; navigating off the sheet closes the mic; the hidden tab disarms; the 9.5-minute timer is scheduled at ≤ 9.5 min from the mint and firing it disarms; a final after disarm charts nothing; a locked chart cannot be armed. |
| 7 Guard bites with the moved allow-list | `voiceMediaGuard.test.js`, 17 tests, 5 new: the perio UI importing the SDK **fails**; the old `pages/voicelab/speechSession.ts` coming back with the SDK **fails** (the allow-list moved, it did not grow); red-list names planted in the perio UI and the route **fail**; localStorage, sessionStorage, `fs` and MediaRecorder planted in perio voice files **fail**; every named voice file exists. |
| 8 This report | Staging walk below. |

### Guard edits (argued in the PR)
- **`hygNoOdWrites.test.js`:** the one-file *mutation* allow-list becomes `['visit.js', 'voice.js']`.
  - It is a POST because it spends budget, and must not be fetchable by a prefetch.
  - It mutates nothing in the visit store or in Open Dental.
  - A new test pins `voice.js` to exactly `post '/token'` and forbids `visitStore`, the writers,
    `getOdOffice`, `withTenantDb` and the transport verbs.
- **`voiceMediaGuard.test.js`:** `SDK_ALLOWED` is now the shared file and is still one entry. The
  rule text changed from "outside the voice lab session" to "outside the shared speech session", and
  the session's persistence label from "lab file" to "voice file". Every expectation is as strict as
  before.
- **`voicelab-page.test.tsx`:** the mock path and function name follow the move. No assertion changed.

## Gates (local, Node 22, pnpm 10.4.1)
- `pnpm run check` ✅.
- Dashboard `pnpm run test`: **2,320 passed, 156 skipped, 0 failed** (161 files).
  - The first run caught one real issue: `dark-mode-contrast` flagged a `bg-white` on the Disarm
    button, which was fixed in the component. No guard was touched.
- Backend `node --check server.js` ✅. `node scripts/shard-runner.mjs`: 4 shards, **3,072 tests,
  3,069 pass, 0 fail, 3 skipped**.
- **Fresh-context reviewer, 2 rounds.**
  - Round 1 found no blockers and 3 should-fix items: the end of chart overwriting, `11` read as
    "one one", and stale finals after disarm.
  - It also raised nits: unparsed bodies, and undo with nothing to undo.
  - All of these were fixed in `bcf6d05` with tests. Round 2 was clean.
- CI on the merge ref: see the PR (#225).

## Screenshots
These are in `docs/screenshots/hyg/hyg-perio-voice-0{1..4}-*-1180x900-{light,dark}.png`, produced
by `tests/hyg-perio-voice-shots.test.tsx` (`HYG_SHOTS=1`) and then `scripts/shoot-hyg.mjs`:
1. off
2. armed after "three two three bleeding": #1 DB/B/MB = 3/2/3, with bleeding on MB
3. "1010" refused, 0 of 192 charted
4. budget spent

## Staging walk (Beau)

**Perio writes on staging use roland test patient 12827 ONLY.** Do not dictate onto any other
patient's chart. The item-20 test-patient rail refuses a non-test send anyway.

1. Set the staging app settings:
   - `HYG_VOICE=1`
   - optionally `HYG_VOICE_DAILY_MINUTES` (the default of 60 is fine)
   - confirm `AZURE_SPEECH_API_KEY` and `AZURE_SPEECH_REGION=southcentralus` are present (the lab
     already uses them)
   - restart the revision
2. `GET /auth/me` should show `"hygVoice": true`. Production must still show `false`; nothing sets
   it there.
3. Open the hyg day for **roland** and pick an appointment for PatNum **12827**. Open the visit, then
   Perio. The grey **VOICE OFF** bar is under the mode buttons.
4. Click **Arm voice** and allow the microphone. The bar turns red: **VOICE ARMED**.
5. Say "three two three bleeding". Check that #1 DB/B/MB show 3/2/3, MB has a bleeding dot, and
   "Heard: 3, 2, 3, bleeding" is shown. Wait for "Saved on this visit".
6. Say "ten ten" or "one oh one oh". Expect the amber flag "Heard “1010” as one number…" and no
   change to the progress count.
7. Say "jump to tooth 14", then "four four four". Check that they land on #14's first open sites.
   Then say "go back to tooth 14 mesiobuccal two" and check that #14 MB becomes 2.
8. Say "skip this tooth" (the tooth is struck through) and "undo" (the last reading clears).
9. Switch tabs and come back. Expect VOICE OFF with "the page was hidden". Re-arm, open another
   visit, and expect it to open VOICE OFF.
10. With the chart Draft, press **Stage chart**, then Send. The existing confirm dialog shows every
    reading. **Confirm only on 12827.** Verify the exam in Open Dental, then delete it with the
    page's undo if this was only a walk.
11. Log Analytics: `[hyg-voice]` lines carry only `token minted in Nms (x/60 min reserved today)`,
    codes and minutes. No key, no token, no words.
12. Exhaust the budget (arm and disarm 6 times). The 7th arm says "Today's perio voice budget is
    used up…". The call-transcription and voice-lab budgets are unaffected.

## Open items
- **Numerals 10–12 are refused** (see above). This needs Beau's ruling; the lexical-form read is
  the proper fix.
- **One server-wide budget.** There is no per-user split, and an early disarm refunds nothing.
  At 60 minutes, that is 6 arms per day for the whole practice. Size it before the pilot.
- **The shared mint lives in `services/voiceLab/`.** Removing the lab would need `speechToken.js`
  moved first; the module-graph test will say so loudly.
- **The stale `.git/packed-refs.lock`.** There is a 0-byte `packed-refs.lock` from 2026-10-06 20:16
  in the PROD folder's `.git`. Every commit prints a warning, but commits and pushes succeed. I left
  it alone because it is in the PROD folder; deleting it is safe once no git process is running.
