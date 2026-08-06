# Mango ingestion & transcription — the two switches

Ingestion and transcription are **independent**. They used to be one thing, and conflating
them is what made the cost problem and the coverage problem look like the same problem.

| Env var | Default | What it controls |
|---|---|---|
| `MANGO_INGEST_MODE` | `off` | Whether Mango calls are pulled in at all. `api` = pull from the internal REST API on the hourly cron. Metadata, worklist rows, office attribution, the M3 watermark. |
| `MANGO_AUTO_TRANSCRIBE` | `false` | Whether the hourly sync also sends those calls to Azure Speech. **Off since M4** — transcription is a per-call human decision made from the dashboard. Set to `true` to restore the legacy automatic behaviour for an office that wants it. |

**Ingestion stays ON.** Turning transcription off costs nothing in coverage: every call
still gets a store row, and the M3 watermark still advances (it advances on ingestion
alone, never on transcription outcome). That is precisely what lets the on-demand button
reach *any* call at *any* later time — including the ones the old auto pipeline missed
during the afternoon budget blackout.

## The on-demand button

`POST /api/mango/calls/:callId/transcribe` — SSO-gated, module-gated (`voice`), audited.
Rendered in two places: an inline action on each worklist row, and the primary button next
to playback on the call detail page.

The UI switches on the `status` field, not the HTTP code:

| `status` | HTTP | Meaning |
|---|---|---|
| `completed` | 200 | Transcribed, summarized, **persisted**, returned. |
| `exists` | 200 | Already had a transcript. Dedup guard — zero Azure spend. |
| `in_progress` | 409 | Another click for this call is still running (per-call lock). |
| `recording_not_ready` | 422 | Mango hasn't published the recording yet (call younger than `MANGO_RECORDING_LAG_MINUTES`, default 30). |
| `recording_unavailable` | 422 | Mango no longer serves a recording for this call. |
| `no_speech` | 422 | Azure Speech ran but heard nothing. No empty transcript is stored. |
| `budget_exhausted` | 429 | Daily audio-minute breaker is spent. Carries `resetsAt`. |
| `unavailable` | 503 | Azure Speech isn't configured in this environment. |
| `not_found` | 404 | No such Mango call in the store. |
| `error` | 500/502 | Nothing was saved; the call stays transcribable. |

Guarantees, in order of how much they cost when broken:

- **Success is claimed only after the transcript is persisted** and readable back out of
  the store. The route this replaced returned `success: true, transcript: null`.
- **The breaker is surfaced, never bypassed.** `MAX_TRANSCRIPTION_MINUTES_PER_DAY` (120,
  rolling on the offices' `America/Chicago` day) is unchanged; a spent budget is a 429 that
  tells the user when it resets.
- **A double click bills once.** Per-call in-flight lock, released in `finally`.
- **An existing transcript is reused, never re-billed.**
- **Nothing here writes to Open Dental.** Review-then-send is untouched; the only
  OD-adjacent step is `matchAndSetStatus`, which sets worklist status and writes nothing.

## Related knobs

| Env var | Default | Notes |
|---|---|---|
| `MAX_TRANSCRIPTION_MINUTES_PER_DAY` | `120` | Daily audio-minute breaker. `0` = unlimited. |
| `TRANSCRIPTION_BUDGET_TZ` | `America/Chicago` | Day boundary for the breaker **and** the on-demand ledger. |
| `MANGO_RECORDING_LAG_MINUTES` | `30` | The age at which "no recording" stops meaning "not published yet" and starts meaning "gone". |
| `MANGO_SUMMARY_MIN_SECONDS` | `20` | Below this the transcript is kept and the summarizer LLM is skipped (D4). |
| `CALLSTORE_DIR` | `<app>/data` | Set to a mounted volume (`/data` in prod) or the call store, the budget accounting and the on-demand ledger all reset on deploy. |

## Where the spend shows up

Admin → **Usage & Costs** → *Mango transcription (on demand)*: today's audio minutes
against the daily breaker, on-demand transcriptions per office, and the month's estimated
Speech + summary spend at list rates.

Two accounting stores back it, both durable and both rolling on the offices' local day:

- `transcription_budget.json` — the breaker's minutes-used (pre-existing).
- `mango_ondemand_transcription.json` — per-office outcome counts, month totals, and the
  last 200 attempts (call id, office, actor, outcome, minutes). No PHI.

The HIPAA `audit_log` row is written separately for **every** attempt — `CREATE` for a
completed run, `READ` for everything else — and is fail-closed as usual.

## In the sync log

```
✅ Mango API sync: found 23, transcribed 0, reused 0, auto-off 19, budget-skipped 0, ...
📊 Mango sync[roland]: ingested 14, transcribed 0, reused 0, auto-off 11, budget-skipped 0, ...
```

`auto_off` counts exactly the calls automatic transcription *would* have billed — it sits
after the missed / too-short / unavailable classifications, so it answers "what is the
valve saving us?" and never disguises a breaker firing (`budget_skipped`) as a policy.
