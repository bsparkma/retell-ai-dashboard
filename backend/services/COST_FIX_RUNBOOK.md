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
  MAX_TRANSCRIPTION_MINUTES_PER_DAY="120" \
  CALLSTORE_DIR="/data"
```
- `MANGO_SYNC_SCHEDULE` `*/5 * * * *` → `15 * * * *` (hourly) — Beau's product-round call;
  also caps re-transcription blast radius 12× if the dedup ever regresses.
- `MAX_TRANSCRIPTION_MINUTES_PER_DAY=120` — explicit; the code default is already 120.
- `CALLSTORE_DIR=/data` — points the call store at the durable AzureFile volume.

### CALLSTORE_DIR pre-flight — VERIFIED 2026-07-26 (condition #1) ✅
- AzureFile mount **present** on prod backend: volume `callstore-vol` (env storage
  `callstore` → account `stcareinprodfbe70ffb`, share `data`) mounted at `/data`.
- App runs as `uid=1000(node)`; `/data` is `drwxrwxrwx` (0777, world-writable, root-owned).
  World-write ⇒ the non-root `node` user **can write**. Live probe confirmed the mount and
  ownership; `/data` is currently empty (store still writes to `/app/data`).
- Re-verify at deploy if desired:
  `az containerapp exec -g rg-carein-prod -n ca-carein-prod-backend --command "ls -ldn /data"`
  (expect `drwxrwxrwx`), and `--command "id"` (expect `uid=1000(node)`).

### Expect a ONE-TIME wipe tonight (condition #2)
First boot with `CALLSTORE_DIR=/data` starts from an **empty** store — the old ~1348-call
file lives on the ephemeral `/app/data` layer, not on the volume, so it does not carry over.
The first sync re-ingests the 1-day window and re-transcribes it **once** (~$1–2, and now
hard-capped by the `MAX_TRANSCRIPTION_MINUTES_PER_DAY=120` breaker). This is expected and
one-time. After this, the store lives on the volume and **deploys no longer wipe it**.
(Triage/worklist history from before tonight is not migrated — acceptable per the store's
in-JSON-store design; the OD commlog is the durable record of anything already sent.)

STAGING `ca-carein-backend` (rg-carein-staging): **leave `MANGO_INGEST_MODE=off`** (set
2026-07-26 21:59 UTC, verified halting — `Mango sync skipped (MANGO_INGEST_MODE=off)`).
Flip to `api` only for a bounded test session, then back to `off`.

## Post-deploy verification (prod)
1. Watch one hourly sync log: expect `found N, transcribed 0, reused M` in steady state
   (transcribed should be ~0 for calls already in the store; the FIRST post-deploy sync
   transcribes the 1-day window once — condition #2).
2. Confirm scheduler cadence is hourly (`Next sync` ~1h out, not 5 min).
3. `GET /api/health` (or transcription stats) shows `dailyMinutes` / `dailyBudgetMinutes`.
4. Confirm the store is on the volume:
   `az containerapp exec -g rg-carein-prod -n ca-carein-prod-backend --command "ls -l /data"`
   → expect `unified_calls.json` present (proves writes land on the AzureFile share, not `/app/data`).

## PROVE durability before retiring the closed-hours rule (condition #3)
The closed-hours rule stays in force until deploy-survival is demonstrated, NOT assumed:
1. After tonight's deploy + first sync, record **2 call ids** from the worklist and add a
   **triage mark** to one (e.g. resolve / not-a-patient) so there is a human-written field
   to check. Note them here: `___________`  /  `___________` (+ which one was triaged).
2. On the **NEXT** deploy (whenever — a real change, not a forced roll), re-open the worklist
   and confirm those call ids AND the triage mark **survived**. Also confirm the first
   post-deploy sync logs `transcribed 0, reused …` (no re-transcription burst).
3. Only after that survives → declare **deploy-anytime safe** and lift the closed-hours rule.

## #5 — durable store, characterized (planning note)
- The store persists to `path.join(__dirname,'../../data/unified_calls.json')` = **`/app/data`**.
- **Prod** mounts an AzureFile volume (`callstore`) at **`/data`** — a DIFFERENT path — so the
  volume is currently **not** protecting the store. Prod persisted across the recent restarts
  only because they were env-only revisions on the ephemeral `/app/data` layer; the **next
  image deploy wipes it**, forcing a full re-fetch + (pre-guard) re-transcription of the
  lookback window.
- **Staging** has **no volume** → `/app/data` is wiped on every image deploy (matches the
  observed behavior).
- Fix path: set `CALLSTORE_DIR=/data` in prod (done tonight, verified above). The dedup guard
  makes deploy-wipe far cheaper (only first post-wipe sync re-transcribes), but durable storage
  removes it entirely.

### Staging: intentionally EPHEMERAL (condition #4)
Staging `ca-carein-backend` has **no volume** and stays ephemeral **by design**: ingestion is
`MANGO_INGEST_MODE=off` (opt-in for bounded test sessions only), so any deploy-wipe
re-transcription is small, bounded to a test window, and now hard-capped by the circuit
breaker. We are NOT adding a staging volume — its store is expected to reset on each image
deploy. If durable staging is ever wanted (e.g. long-running staging soak), mirror prod:
```bash
# create a file share on the staging storage account, then:
az containerapp env storage set -g rg-carein-staging -n cae-carein-staging \
  --storage-name callstore --azure-file-account-name <stg-acct> \
  --azure-file-share-name data --azure-file-account-key <key> --access-mode ReadWrite
# then add a volume+mount at /data on ca-carein-backend and set CALLSTORE_DIR=/data.
```
So the two envs are understood: **prod = durable (/data volume), staging = ephemeral (no volume)**.

## Not changed
- **OPENAI log noise** (`OPENAI_API_KEY not set…` ×7223): the string does not exist in
  `develop` — it is dead code from the pre-Azure analyzer still running in prod
  (`rev 0000014`). It disappears on this deploy; no code change needed.
