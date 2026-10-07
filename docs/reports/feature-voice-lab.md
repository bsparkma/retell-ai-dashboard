# Item 34 — Voice lab (staging-only streaming dictation measurement)

Branch `feature/voice-lab` off `origin/develop` @ `7fdc12c`. PR **#224** → develop. **Not merged.**
LANE: RED.

## Queue-file claims, checked against the code

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Existing transcription uses the Fast Transcription REST API | ✅ | `backend/services/transcriptionService.js:343`: ``const url = `${this.endpoint}/speechtotext/transcriptions:transcribe?api-version=…` `` |
| Speech key is in Key Vault as `azure-speech-key` | ✅ (code + inventory) | `backend/config/secrets.js:61`: `{ secretName: 'azure-speech-key', envKey: 'AZURE_SPEECH_API_KEY' }`. The `kv-carein-staging` inventory at `docs/reports/rcm-prod-eob-standup.md:58-62` lists `azure-speech-key`. Presence in `kv-carein-prod` can't be confirmed from the repo, but the lab never runs there. |
| The existing breaker is 120 min/day and persisted | ✅ | `transcriptionService.js:62-63` (`MAX_TRANSCRIPTION_MINUTES_PER_DAY`, default `return 120;`) and `:74` (`new DurableState('transcription_budget.json', …)`) |
| Secrets path | ✅ | `loadSecrets()` copies vault secrets onto `process.env` when `NODE_ENV === 'production'` (`secrets.js:328`). Staging runs that way with `AZURE_KEY_VAULT_NAME=kv-carein-staging` (`docs/PHASE3_STEP2_STAGING_NOTES.md:61-62`). The lab reads `process.env.AZURE_SPEECH_API_KEY` and nothing else. No `.env` was read. |
| Region southcentralus | ✅ (docs) | `docs/ARCHITECTURE.md:166` |
| Real-time STT retains nothing by default, and audio logging, `storeAudio` and custom-model content logging are what turn retention on | Not code-verifiable | This comes from Microsoft's documentation, as the queue file says. The guard below makes every one of those switches unnameable in code. |

One finding worth knowing: staging's Speech config uses the custom-subdomain `AZURE_SPEECH_ENDPOINT` with managed identity (`transcriptionService.js:192-196`, `:214-228`). It may not have `AZURE_SPEECH_REGION` set. The lab needs the region, both for the STS URL and for the browser SDK. Without it, the token route returns an honest `503 VOICE_LAB_SPEECH_UNCONFIGURED`. Setting `AZURE_SPEECH_REGION=southcentralus` doesn't change call transcription, because an explicit endpoint wins at `:194`.

## The prod-vs-staging marker (acceptance row 8)

NODE_ENV can't tell the two apart: staging also runs `NODE_ENV=production`, because that's how it loads Key Vault. The marker is the **Key Vault name**, `kv-carein-staging` vs `kv-carein-prod` (`docs/ARCHITECTURE.md:162`). The lab reuses the existing positive-identification helper rather than copying it:

```js
// backend/config/hygFixtureGate.js:88-91
function isStaging(env) {
  const vault = String(env.AZURE_KEY_VAULT_NAME || '').trim().toLowerCase();
  return vault.includes('staging');
}
```

```js
// backend/config/voiceLab.js:47-52
function isProductionEnvironment(env = process.env) {
  const vault = String(env.AZURE_KEY_VAULT_NAME || '').trim().toLowerCase();
  if (vault.includes('prod')) return true;
  if (String(env.NODE_ENV || '').trim() === 'production' && !isStaging(env)) return true;
  return false;
}
```

The lab treats the process as production, and refuses, in two cases:
- the vault name contains `prod`;
- `NODE_ENV=production` without a staging vault. That includes an unset vault name and the legacy default `kv-carein-core`.

The flag must be exactly `VOICE_LAB === '1'`.

## What changed

**Backend**
- `config/voiceLab.js`: the switch. `resolveVoiceLab()` returns `{ enabled, reason: 'enabled' | 'flag_off' | 'production' }`.
- `routes/voiceLab.js`: `POST /token` is the only route. `mountVoiceLab(app)` mounts it only when the switch allows. `server.js` calls it below the auth gate and tenant context. When the lab is off, `/api/voicelab/*` falls through to the app's 404. The route works like this:
  - a request carrying a body gets `400 VOICE_LAB_NO_PAYLOAD`;
  - a missing key or region gets `503`;
  - a spent budget gets `429 VOICE_LAB_BUDGET_EXHAUSTED`, with `usedMinutes`, `capMinutes` and `resetsAt`, and an error that says call transcription is unaffected;
  - an STS failure gets `502`, and the reservation is released.
  - Logs carry codes, minutes and milliseconds only.
- `services/voiceLab/speechToken.js`: `POST https://<region>.api.cognitive.microsoft.com/sts/v1.0/issueToken` with `Ocp-Apim-Subscription-Key`, and a 10 s timeout. Failures report the HTTP status only. The STS body and the fetch error object are dropped.
- `services/voiceLab/labBudget.js`: the lab's own breaker, described in the next section.
- `routes/auth.js`: `/auth/me` adds `voiceLab: isVoiceLabEnabled()`, the same decision the mount makes.

**Lab breaker metering**
- Each token mint **reserves a fixed 10 minutes**. That equals the token's lifetime, and the page auto-disarms at 9.5 minutes counted from the mint. So a reservation is an upper bound on what one token can stream, not an estimate.
- A reservation must fit whole. With the default cap of `VOICE_LAB_DAILY_MINUTES=30`, that's three sessions a day.
- Unset or blank → 30. Zero, negative or non-numeric → 0, which **refuses every mint (fail closed)**. This is the opposite of the call breaker, where 0 means unlimited.
- The day rolls at midnight America/Chicago (`services/localDayClock.js`). State persists in its own `voicelab_budget.json`, through the same `DurableState` mechanism as the call breaker.
- It never requires `transcriptionService`, never reads `MAX_TRANSCRIPTION_MINUTES_PER_DAY`, and never opens `transcription_budget.json`. A test pins all three.

**Dashboard**
- `pages/voicelab/speechSession.ts` is the **only** file that imports the SDK. It uses `SpeechConfig.fromAuthorizationToken(token, region)`, `en-US`, the default microphone, continuous recognition, and a `PhraseListGrammar` holding the phrase list. SDK telemetry is off.
- `pages/voicelab/scoring.ts` is pure:
  - the vocabulary: zero…nineteen, plus bleeding, suppuration, plaque and calculus;
  - median and nearest-rank p95;
  - accuracy, where a numeral like "5" counts as "five";
  - confusion pairs and the copyable text;
  - `deriveLatencies`.
- `pages/voicelab/VoiceLab.tsx` (`/voicelab`) is lazy-loaded from `App.tsx`, so the SDK is in its own chunk.
  - It renders `NotFound` unless `/auth/me` says `voiceLab: true`.
  - It shows a big ARMED/DISARMED banner. The mic opens only on Arm.
  - It disarms on navigation away, when the tab is hidden, on pagehide, and automatically 9.5 minutes after the mint. An arm that resolves after the person has left is closed at once.
  - Scripted run: 50 random digit words. Empty finals (noise) aren't scored, and "Skip" records a miss.
  - Free mode shows partials, and finals with their timings.
  - Results live only in React state. Nothing goes to localStorage and nothing is sent to CareIN.
- **Latency definitions:**
  - **End of speech → final** is the SDK's own `SpeechServiceResponse_RecognitionLatencyMs`: from the last audio fragment that contributed to the result to the result's arrival. If the SDK doesn't report it, the page falls back to the result's audio offset plus duration, measured against the stream start.
  - **First partial** is measured **from start of speech**, not end. A partial arrives *during* speech, so measuring it from the end would be negative. Speech start is anchored from the final's offset and latency.
- `pages/Home.tsx`: a "Voice lab" link renders only when `voiceLab` is true.
- `lib/auth.ts` gains `voiceLab: boolean` (absent reads as false). `lib/api.ts` gains `voiceLabToken()`, which sends no body.

**Guard (permanent): `backend/test/voiceMediaGuard.test.js`**
- It scans backend/ and new-dashboard/{client,shared,server}. It finds more than 200 files, so the scan isn't vacuous.
- It matches the **raw source**, so a comment can't hide a call and neither can a string holding `/*`. These names may not appear anywhere:
  - `enableAudioLogging` and the property form `…EnableAudioLogging`
  - `storeAudio`
  - `contentLoggingEnabled`
  - `destinationContainerUrl`
  - `setServiceProperty`
  - `endpointId` and `fromEndpoint` (custom-model endpoints, including the `SpeechServiceConnection_EndpointId` property)
  - `MediaRecorder` in the dashboard
- The Speech SDK may be imported only by `client/src/pages/voicelab/speechSession.ts` (an allow-list of exactly one). It may not be imported, or listed as a dependency, in the backend.
- It also runs heuristics on comment-stripped source:
  - no disk write (`writeFile*`, `createWriteStream`, `appendFile*`) on a line that names audio, a recording, or an audio file extension;
  - lab files may not name `fs`, local or session storage, IndexedDB, a `/data` path, or `createObjectURL`.
- **It bites.** A copy of `speechSession.ts` with `speechConfig.enableAudioLogging();` appended fails with exactly that offender. Every other rule is planted the same way and caught in both trees, and the unplanted copy is shown clean first.

## New dependency

| Package | Pinned | Where | Notes |
| --- | --- | --- | --- |
| `microsoft-cognitiveservices-speech-sdk` | **1.52.0** (exact, no caret) | `new-dashboard/package.json` | Microsoft's official Speech SDK. The lockfile diff only adds lines: the SDK plus its transitive deps (`ws@8.22.0`, `bent@7.3.12`, `uuid@11.1.1`, `@azure/core-auth@1.11.0`, `https-proxy-agent@7.0.6`, `@types/webrtc@0.0.37`, and their deps). No existing entry changed. A guard test asserts the exact pin. |

The backend has no new dependency.

## Acceptance

| # | Test(s) |
| --- | --- |
| 1 | `voiceLab.test.js`: the switch matrix; flag off → 404 and no mint; prod vault plus flag → 404 with the boot line logged; mounted below auth and tenant context. `auth.test.js` (3 new tests, existing ones untouched): `voiceLab` is false when off, true on staging, false on prod with the flag. `voicelab-page.test.tsx`: no Home link, and `/voicelab` is the 404 page and never asks for a token. |
| 2 | `voiceLab.test.js`: the body keys are exactly `[region, success, token]`. The key string is absent from the body, the headers and every captured log line (the token is absent from logs too), and that holds on the 401 path. The key reaches only the STS header. |
| 3 | `voiceLab.test.js`: the 4th mint returns 429 with an honest message. The call breaker's minutes, cap, allowed flag and **file bytes** are identical before and after. Cap 0 refuses. The day rolls at Central midnight. The lab sources never name the call breaker. |
| 4 | `voiceMediaGuard.test.js`: 12 tests, including the planted-`enableAudioLogging` bite. |
| 5 | `voicelab-scoring.test.ts`: 14 tests covering median and p95, accuracy including numerals, confusion pairs, the copyable text, an empty run, prompt picking and latency derivation. |
| 6 | `voiceLab.test.js`: the router stack is exactly `[POST /token]` with no router middleware; other `/api/voicelab/*` paths 404; a body gets 400 and no mint; no other backend file names a voicelab route. `voicelab-page.test.tsx`: no request or stored value carries a recognised word. |
| 7 | `voiceLab.test.js`: the lab's module graph contains no OD module. Driving success, budget-refusal, payload-refusal and 404 paths with `getOdOffice` stubbed to a `FakeOd` leaves `od.calls`, `od.writes` and the handle requests all empty, and the only outbound URL is the STS. |
| 8 | This report: the marker is quoted above and the dependency table is above. |

## Gates (local, Node 22, pnpm 10.4.1)

- backend: `npm ci` ✅. `node --check server.js` ✅. `node scripts/shard-runner.mjs`: 4 shards all green, **3046 tests, 3043 pass, 0 fail, 3 skipped**.
- new-dashboard: `pnpm install --frozen-lockfile` ✅. `pnpm run check` ✅. `pnpm run test`: **2279 passed, 152 skipped, 0 failed** (134 files).
  - The first full run had one failure: `tests/rcm-shell.test.tsx` › "keeps Posting history out of the nav for a biller and in it for an admin" hit the **5000 ms timeout** while the backend suite ran in parallel on the same machine.
  - Re-run in isolation, it passed in 590 ms. A clean full re-run was green twice.
  - It's a load-induced timeout in a file this branch doesn't touch. No assertion was changed.

## Reviewer verdict

A fresh-context reviewer subagent got the queue file and `git diff origin/develop...HEAD`.

- **Round 1: APPROVE with should-fixes.** It confirmed all six:
  - (a) the key and token never reach the client or a log;
  - (b) the guard bites and isn't vacuous;
  - (c) the lab breaker is a separate counter and the 120-min breaker is untouched;
  - (d) prod is refused even with the flag, and fails closed;
  - (e) zero OD calls;
  - (f) the SDK is confined to the lab session and the page is lazy-loaded.

  Its findings and what happened to them:
  - **Fixed in `72c90d4`:**
    - The `\bendpointId\b` regex missed `SpeechServiceConnection_EndpointId`.
    - The regex comment-stripper could be fooled by a string holding `/*` into hiding a call. The guard now matches raw source.
    - The auto-disarm counted from mic start; it now counts from the mint.
    - A doc comment and the lazy import had been placed in the wrong spot.
  - **Accepted as known limits:**
    - An arm cancelled mid-mint keeps its 10-minute reservation.
    - A release that straddles midnight credits the new day.

    Fixing either needs a second backend lab route, and row 6 forbids that. Both err toward spending *less* than the cap.
  - **Row 8 (this report):** written after CI, as required.
- **Round 2: APPROVE, no new findings.** All fixes were confirmed correct, raw matching was confirmed to produce no false positives on the real tree, and (a)–(f) still hold.

## CI

PR **#224**, workflow `build-test`, run 37554670319: **PASS** (3m6s), first push, no fix pushes needed.

- It ran on the merge ref: `HEAD is now at 526c58c Merge 72c90d4… into 7fdc12c…`.
- new-dashboard: 134 files passed, 24 skipped.
- backend: `TOTAL: 3047 tests · 3044 pass · 0 fail · 3 skipped`, 4 shards all green.

The local `rcm-shell` timeout did not recur in CI. This report commit is docs-only.

## Staging test steps (for Beau)

1. On the **staging** backend container app (`ca-carein-backend`), set the non-secret env vars:
   - `VOICE_LAB=1`;
   - `AZURE_SPEECH_REGION=southcentralus`, if not already set;
   - optionally `VOICE_LAB_DAILY_MINUTES` (default 30).

   The key is already in `kv-carein-staging` as `azure-speech-key`. Nothing new goes in Key Vault. **Do not set `VOICE_LAB` on prod** (it would be refused anyway; the boot log says so).
2. Deploy (merge to develop → staging pipeline), then check the boot log for `[voicelab] mounted at /api/voicelab`.
3. Sign in on an operatory PC on the office network. Home shows a dashed **Voice lab** link. Open it: the banner reads **DISARMED**.
4. Click **Arm microphone** and allow mic access. The banner turns red, **ARMED**. If you instead see "not configured", the region or key is missing; "budget is used up" means today's 30 minutes are spent.
5. **Start 50-prompt run.** Say each word as it appears. Use **Nothing recognised — skip** if a word never registers. At the end, read the accuracy, final median and p95, and first-partial median, then press **Copy results** and paste them into the §0 gate record.
6. Free mode: say "three four five" and watch the partials and finals with their timings.
7. Navigate away or switch tabs and confirm the mic indicator in the browser goes off. Reload and confirm the results are gone.
8. When done, unset `VOICE_LAB` on staging, or leave it on for repeat measurements; each arm costs 10 minutes of the lab's own daily budget.
