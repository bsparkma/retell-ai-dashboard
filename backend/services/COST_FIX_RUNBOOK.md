# Transcription cost fix — closed-hours deploy runbook (2026-07-26)

Branch: `fix/mango-transcription-dedup-guard` (off `develop`, commit `a11b136`).
Merge into the develop train alongside the day-1 fixes + attribution-normalize fix, then one
gated closed-hours promotion → staging → prod.

## What ships in the code (already committed)
- **Dedup guard** — `mangoApiClient.fullSync` reuses an existing transcript by `external_id`;
  never re-sends an already-transcribed call to Azure Speech. Backed by
  `unifiedCallStore.findByExternalId()`.
- **Re-analysis guard** — `syncScheduler` Step 2 skips the summarizer LLM when the stored
  call already has a `summary` (failed analyses retry).
- **Circuit breaker** — `MAX_TRANSCRIPTION_MINUTES_PER_DAY` (default **120**, `0`=unlimited).
  Callers skip cleanly (metadata still ingests); `transcribeBuffer` hard-throws
  `TRANSCRIPTION_BUDGET_EXCEEDED` as a backstop.
- **Durable-store enabler** — store path is `CALLSTORE_DIR`-configurable; default unchanged.

## Env changes to apply at deploy (closed hours)

PROD `ca-carein-prod-backend` (rg-carein-prod):
```bash
az containerapp update -g rg-carein-prod -n ca-carein-prod-backend --set-env-vars \
  MANGO_SYNC_SCHEDULE="15 * * * *" \
  MAX_TRANSCRIPTION_MINUTES_PER_DAY="120"
# Optional — activates the durable AzureFile volume for the call store (see #5 below).
# Only add once you've confirmed the /data mount is writable by the app:
#   CALLSTORE_DIR="/data"
```
- `MANGO_SYNC_SCHEDULE` `*/5 * * * *` → `15 * * * *` (hourly) — Beau's product-round call;
  also caps re-transcription blast radius 12× if the dedup ever regresses.
- `MAX_TRANSCRIPTION_MINUTES_PER_DAY=120` — explicit; the code default is already 120.

STAGING `ca-carein-backend` (rg-carein-staging): **leave `MANGO_INGEST_MODE=off`** (set
2026-07-26 21:59 UTC, verified halting — `Mango sync skipped (MANGO_INGEST_MODE=off)`).
Flip to `api` only for a bounded test session, then back to `off`.

## Post-deploy verification (prod)
1. Watch one hourly sync log: expect `found N, transcribed 0, reused M` in steady state
   (transcribed should be ~0 for calls already in the store).
2. Confirm scheduler cadence is hourly (`Next sync` ~1h out, not 5 min).
3. `GET /api/health` (or transcription stats) shows `dailyMinutes` / `dailyBudgetMinutes`.

## #5 — durable store, characterized (planning note)
- The store persists to `path.join(__dirname,'../../data/unified_calls.json')` = **`/app/data`**.
- **Prod** mounts an AzureFile volume (`callstore`) at **`/data`** — a DIFFERENT path — so the
  volume is currently **not** protecting the store. Prod persisted across the recent restarts
  only because they were env-only revisions on the ephemeral `/app/data` layer; the **next
  image deploy wipes it**, forcing a full re-fetch + (pre-guard) re-transcription of the
  lookback window.
- **Staging** has **no volume** → `/app/data` is wiped on every image deploy (matches the
  observed behavior).
- Fix path: set `CALLSTORE_DIR=/data` in prod (and mount a volume in staging if durability is
  wanted there). Verify `/data` is writable by the `node` user first — the Dockerfile chowns
  `/data` to `node:node`, so it should be. The dedup guard makes deploy-wipe far cheaper
  (only first post-wipe sync re-transcribes), but durable storage removes it entirely.

## Not changed
- **OPENAI log noise** (`OPENAI_API_KEY not set…` ×7223): the string does not exist in
  `develop` — it is dead code from the pre-Azure analyzer still running in prod
  (`rev 0000014`). It disappears on this deploy; no code change needed.
