# 16 — DIAGNOSIS: why the note precheck keeps failing

Branch `diag/hyg-note-precheck`, off `origin/develop`. Worktree
`C:\Users\beau\carein-wt\diag-hyg-note-precheck`. **Read-only: no code change, no write, no fix.**
Every Open Dental call below is a GET, made by the fixture-guarded
`backend/scripts/diag-hyg-groupnotes.js` (unchanged) or by a read-only inline check, on
**roland, PatNum 12828**, inside the staging container (revision `ca-carein-backend--0000189`,
2026-09-21 ≈23:22–23:40 UTC). Staging logs were read through Log Analytics (read-only query).

---

## 0. The answer, first

**It is not a timeout.** Both staging sends that failed `NOTE_PRECHECK_UNAVAILABLE` got an answer
from Open Dental in **under one second**. The answer was a refusal:

```
[OD API] GET /procedurelogs/GroupNotes
[OD API] Response Error: No GroupNote(s) found for PatNum <redacted>.
```

That is Open Dental saying **"this patient has no visit notes yet"** — as an error, not as `[]`.
`readGroupNotes` (`backend/services/hyg/odWriter.js:289-299`) turns **any** non-OK answer, or any
non-array body, into `GROUP_NOTES_UNREADABLE`, and `writeGroupNote` (`odWriter.js:386-397`) reports
that as `NOTE_PRECHECK_UNAVAILABLE` — *"Open Dental did not answer…"*. So:

- **A patient with no prior GroupNote can never receive one from CareIN.** The precheck refuses
  before the write, on every attempt.
- **That is why Retry reproduces it every time.** A timeout would be intermittent (the 2026-09-08
  diag saw 3 of 5); this is deterministic, because the patient's note count is.
- The guard did its job — nothing was written — but for the wrong reason, and the message on
  screen ("did not answer") is not what happened.

Recommended fix: **(d)** — see §5.

## 1. Where the failing sends came from (staging logs)

Every `[hygsend]` line in 21 days of staging logs:

| UTC | Revision | Apt | Outcome |
|---|---|---|---|
| 2026-09-05 21:36 | 163 | 110123 | note Failed — `Response Error: Invalid JSON.` on `POST /procedurelogs/GroupNote` (the pre-fix payload bug; no precheck existed then) |
| 2026-09-08 13:54 | 164 | 110123 | note Failed — `POST` answered **201**; the old read-back looked on the wrong surface (fixed since) |
| 2026-09-08 19:08 | 166 | 110123 | note Written |
| 2026-09-09 01:18 | 167 | 110162 | note, slip, handoff Written |
| **2026-09-21 14:34** | 188 | **105887** | **note Failed, slip Written** — GroupNotes read → `No GroupNote(s) found for PatNum <redacted>.` |
| **2026-09-21 17:17** | 188 | **105887** | **note Failed** (the Retry) — same refusal, same PatNum |

So the `NOTE_PRECHECK_UNAVAILABLE` failures are exactly the two 09-21 sends, and both are this
refusal. In each, the GroupNotes GET and its error are within the same ~0.9 s log bucket as the
requests around it.

> ⚠️ **Apt 105887's patient is NOT a designated fixture.** Its PatNum is none of 7115, 12827,
> 12828 (it is redacted here on purpose). The 14:34 send also **wrote a routing-slip PDF into that
> patient's images** (`POST /documents/Upload` → 201). If staging's roland key reaches roland's
> live database, that document is in a real chart. This is outside this item's scope and nothing
> here touched it — it needs a person to look (§6).

## 2. The five runs (roland, PatNum 12828)

`diag-hyg-groupnotes.js`, five complete runs, ≥45 s apart (plus the exec endpoint's own throttle
retries between them). Elapsed is `GET /procedurelogs/GroupNotes` → its `Response`, from the
timestamps of the transport's own log lines, measured in-process by a wrapper around the script.

| Run | UTC start | GroupNotes status | GroupNotes elapsed | Rows | Whole script |
|---|---|---|---|---|---|
| 1 | 23:28:49 | 200 | **896 ms** | 2 | 2 939 ms |
| 2 | 23:29:45 | 200 | **511 ms** | 2 | 3 123 ms |
| 3 | 23:30:45 | 200 | **791 ms** | 2 | 2 664 ms |
| 4 | 23:31:45 | 200 | **554 ms** | 2 | 2 482 ms |
| 5 | ≈23:35 | 200 | **665 ms** | 2 | 2 892 ms |

**0 timeouts in 5.** Min 511 ms, max 896 ms, mean 683 ms. Three earlier attempts the same evening
(23:22–23:24, whose output was cut short by an az-CLI console-encoding crash after the first
request) also got 200 in **543 / 557 / 589 ms**. About 1.6 s of each script run is `loadSecrets()`.

**History size.** 12828 carries **2** GroupNotes (ProcNums 406983, 406901) — not months of
accumulated rows. Nothing here is large enough to test "elapsed proportional to history", and
nothing in these numbers suggests it: 2 rows took 511–896 ms.

**Caveat, stated plainly:** these runs were at ~18:30 local, when voice and RCM traffic on the shared
credential is light. The 09-08 timeouts (3 of 5 at 30 s) were measured under shared load. This
evening does not disprove those; it shows the surface is fast when uncontended, and that the
09-21 failures were not timeouts at all.

## 3. Does waiting for the OD slot count toward the timeout? No.

- The slot wait is a `setTimeout` **inside the axios request interceptor**:
  `backend/config/openDental.js:270` — `if (wait > 0) await new Promise((r) => setTimeout(r, wait));`
- axios arms the timeout later, in the adapter, on the socket:
  `node_modules/axios/lib/adapters/http.js:650` (axios 1.10.0) — `req.setTimeout(timeout, …)`.
  Request interceptors run before `dispatchRequest` (`axios/lib/core/Axios.js:155`), so the wait
  is over before the timer exists.
- Two further facts from the same code: `req.setTimeout` is Node's socket **inactivity** timer, not
  a total-duration cap; and a 429 retry (`openDental.js:315`, `return this.client(config)`) re-enters
  the interceptors and gets a **fresh** timeout, so a 429-retried read can take far longer than 30 s
  in total without ever "timing out".
- `readGroupNotes` passes no `timeoutMs`, so it runs on the client default `timeout: 30000`
  (`openDental.js:193`), as the brief said.

## 4. Does the surface page? No — `Limit` and `Offset` are silently ignored.

Read-only, 12828 (which has exactly 2 rows):

| Params | Status | Elapsed | Rows | ProcNums |
|---|---|---|---|---|
| `Limit=10` | 200 | 535 ms | 2 | 406983, 406901 |
| `Limit=1` | 200 | 265 ms | **2** | 406983, 406901 |
| `Limit=1&Offset=1` | 200 | 469 ms | **2** | 406983, 406901 |
| `Offset=5` | 200 | 379 ms | **2** | 406983, 406901 |

`Limit=1` returned two rows and `Offset=5` returned the first two, so neither parameter is honoured,
and neither is refused. **Paged prechecks are not a candidate fix** — a read cannot be made smaller
this way, and code that believed it had paged would be wrong without any error to say so. (Same
pattern already recorded for other OD list surfaces: filters silently ignored.)

## 5. Which fix the evidence supports

| Candidate | Evidence | Verdict |
|---|---|---|
| (a) longer explicit timeout on the precheck / read-back | 0 of 5 timeouts; 511–896 ms; both real failures answered in < 1 s | Does not fix the failure. Harmless, possibly useful under load, **not the cause** |
| (b) paged reads | `Limit`/`Offset` ignored (§4) | **Not possible** |
| (c) both | — | No |
| **(d) treat Open Dental's "No GroupNote(s) found for PatNum N" answer as an empty list** | Both 09-21 failures are exactly this answer; it is deterministic, which is why Retry always reproduces it | **Recommended** |

What (d) means, described not built:

1. In `readGroupNotes`, recognise that one refusal — the `No GroupNote(s) found for PatNum` text,
   for the PatNum that was asked about — as `{ ok: true, rows: [] }`. Only that one; every other
   non-OK answer stays a refusal.
2. The precheck then sees zero prior notes and writes. The read-back after the write is unchanged:
   if it still sees none, the note is `NOTE_UNCONFIRMED`, which is the honest state.
3. Split the precheck's message: "Open Dental refused the read (…its words…)" versus "did not
   answer". The current single message sent this investigation looking for a timeout.

**Measure before building:** the **HTTP status** of that refusal was not captured — the transport's
error line logs the body, not the status. The fix should key on status + text, so the first step is
one read of `GET /procedurelogs/GroupNotes` on a **fixture with no GroupNotes** (12827 is the likely
candidate; this item was held to 12828, which has two). A unit test can then pin the exact shape.

(a) is still reasonable as a follow-up under load — a timeout of e.g. 45–60 s on these two reads —
but only with (d); on its own it changes nothing about the failure that was reported.

## 6. Needs a person

- **The non-fixture patient on apt 105887** (§1). A routing slip was written into that patient's
  images from staging on 2026-09-21 14:34 UTC. Confirm whether staging's roland credential points at
  the live roland database, and if so, whether that document should be removed in Open Dental.
- Whether hygiene walks on staging should be refused for non-fixture patients the way the scripts
  are. Today the product has no such guard — the day view shows the real schedule.

## 7. Hard rules

No write verb anywhere (every call a GET). No real patient read: every read was PatNum 12828 through
the fixture-guarded script or the fixture-pinned inline check; the non-fixture PatNum above comes
from existing staging logs and is redacted. No throttle or `minIntervalMs` change. No `.env`, no
secrets read, no Azure configuration changed. No code changed on this branch.

## 8. Push / PR

Pushed to `origin/diag/hyg-note-precheck`; report-only PR into `develop`: see the line appended
below. Not merged.
