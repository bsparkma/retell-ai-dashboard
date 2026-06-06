# Slice A: Webhook Commlog Hardening — CC-ready PRD

_Drafted 2026-06-06. Harden the live `call_analyzed` webhook → Open Dental commlog path so it can't
(1) double-write on a Retell retry, (2) write to the WRONG patient on an ambiguous match, or (3) throw
on a non-string transcript — and ack Retell fast. These touch **live patient charts** (auto-logging is
on in Azure prod), so this is correctness, not polish. Rides the develop→staging pipeline, then
promote to prod via the manual flow once green. Branch off `develop`; commit via a throwaway worktree
so the PROD folder stays on `main`. Do NOT touch `main`/the PROD folder/`.env`._

## Context (verified in code)
- The webhook handler `handleCallAnalyzed` (`backend/routes/webhooks.js`, ~L226–329) does its OWN
  match + write: `matchCallToPatient(...)` → if `confidence >= 0.7`, build the `[CareIN AI — Inbound
  Call]` note → `openDentalSyncService.createCommLog(patient.id, commLogEntry)` (~L313). It **never
  checks or sets `od_sync_status`**, so there's no dedup.
- A separate path, `syncCallToCommLog` (`backend/services/openDentalSync.js`, ~L187–262), IS already
  idempotent: it returns early if `od_sync_status === 'synced'` (~L191) and, after a successful write,
  sets `od_sync_status: 'synced'` + `od_commlog_num` + `od_patient_id` + `od_match_confidence`
  (~L234–238). The webhook just bypasses it.
- `matchByPhone` (`openDentalSync.js` ~L71–90): a single phone match → confidence `0.95`; **multiple
  matches → returns `patients[0]` at confidence `0.75` with the rest in `alternatives` (~L84)**. Since
  the webhook writes at `>= 0.7`, an ambiguous (multi-record) number auto-writes to a guessed chart.
- `transcript.match(pattern)` is called assuming a string in `services/callAnalyzer.js:187` and
  `routes/calls.js:52`; a non-string transcript (the transcript_object array) throws
  `transcript.match is not a function` on the call_started/ended persist path.

## Scope — four fixes

### 1. Idempotency / dedup by call_id (the load-bearing fix)
Make the webhook's commlog write idempotent AND consistent with the sync path. **Preferred:** route
`handleCallAnalyzed`'s write through `syncCallToCommLog` (which already does the
`od_sync_status==='synced'` check + sets `synced`/`od_commlog_num`/`od_patient_id`/`od_match_confidence`).
If `syncCallToCommLog` builds a different note than the rich `[CareIN AI — Inbound Call]` template,
either align it or pass the prebuilt note through — **the current note format must be preserved.** If
routing through it is too invasive, instead replicate its guard around the existing `createCommLog`
call: skip if the call is already `synced`; after a successful write, persist
`od_sync_status='synced'` + `od_commlog_num` on the call in the unified store.
**Outcome:** a Retell retry of the same `call_id` does NOT create a second commlog, and because
`od_sync_status` is now set on the webhook path, a later manual `/sync-all` won't re-write it either.

### 2. Ack 200 first, then write async
The outer handler currently `await`s `handleCallAnalyzed` (the OD write) before returning 200, so the
ack waits on OD latency. Respond `200` to Retell **immediately**, then run the match + commlog write in
the background. With #1 making retries harmless, this reduces retries and decouples the ack from OD
latency (and is what makes future scale-to-zero safe). Keep the existing error logging; a failure in
the async work must never crash the process.

### 3. Ambiguous match → `needs_review`, do NOT auto-write
Only write the commlog automatically when the match is **confident and unambiguous** — a single
exact-phone match with no `alternatives` (≈ the `0.95` path), name+phone agreement, etc. When the match
is **ambiguous** — `matchByPhone` returned `alternatives` (number on multiple records), or confidence
is in the fuzzy band — **do not write.** Instead:
- set `od_sync_status = 'needs_review'` on the call, and
- **persist the candidate patients** (the top guess + `alternatives`: id + name) on the call record in
  the unified store, so the Slice-B review UI can show them.
Keep the existing no-match handling routed to the same `needs_review` state.

### 4. `transcript.match` type-guard
In `callAnalyzer.js:187` and `calls.js:52`, guard the `.match()` calls so a non-string `transcript`
(e.g., a transcript_object array) doesn't throw — coerce to string or skip matching when it isn't a
string. This clears the recurring `transcript.match is not a function` on call_started/ended persist.

## Out of scope — Slice B (UI phase)
- The **review-queue UI** (list `needs_review` calls → search/pick the OD patient → confirm).
- The **resolve-to-patient endpoint + write action** the review UI calls.
- The **synced / OD-write audit view**.
Slice A only records the `needs_review` state + candidates so Slice B can build on it.

## Implementation notes (decisions made during build)

- **Replicate the guard (option B), don't route through `syncCallToCommLog`.** `syncCallToCommLog`
  builds a different note via `formatCommLogEntry` (the "📞 CALL SUMMARY" template), and the firm
  `[CareIN AI — Inbound Call]` requirement plus the fix-3 ambiguity decision both live naturally in the
  webhook. So the webhook keeps its match + note and gains an inline idempotency guard mirroring
  `syncCallToCommLog` (`od_sync_status==='synced'` skip; set `synced`/`od_commlog_num`/`od_patient_id`/
  `od_synced_at`/`od_match_confidence` after a successful write).
- **Enabling fix — the store must preserve `od_*` across re-adds.** `unifiedCallStore.normalizeCall`
  rebuilds the record field-by-field and `addCallInternal` *replaces* it, so the prior `od_sync_status`
  was being wiped on every `addRetellCall` (webhook re-deliveries AND the 15-min poller). That silently
  defeats dedup — including the *existing* `/sync-all` dedup. So `normalizeCall` now carries the `od_*`
  sync fields through, and `addRetellCall` merges the existing record's `od_*` when the incoming payload
  omits them. This is necessary for #1 to actually hold across retries.
- **Concurrency.** Because #2 makes the write async, two near-simultaneous retries could both pass the
  persisted-status check before either finishes. A module-level in-flight `Set<call_id>` guards that
  window; the persisted `od_sync_status` guards sequential retries after completion.
- **Confident-write threshold.** Auto-write only when `matchResult.patient` exists, there are **no
  `alternatives`**, and `confidence >= 0.85` (covers single exact-phone `0.95` and strong name+phone
  `0.98`/`0.85`). Everything else — multi-record phone (`0.75` + alternatives), phone-without-name
  (`0.70`), single fuzzy-name (`≤0.80`), or no match — becomes `needs_review` with candidates stored
  and **no write**. Tunable, but the principle is firm: never auto-write to a guessed chart.
- **Field name.** Uses `od_commlog_num` (matching the existing `syncCallToCommLog` convention) rather
  than `od_commlog_id`.

## Verification
- **Unit (`node --test`):** dedup (second `call_analyzed` with the same `call_id` is a no-op / single
  write); the ambiguous-match branch sets `needs_review` + stores candidates and does NOT call the OD
  write; a non-string transcript doesn't throw; the store preserves `od_sync_status` across re-add.
- **Staging (signed webhook to the raw caddy URL, "Stedi Test" name-match pattern):**
  - A confident single match writes the commlog AND sets `od_sync_status='synced'` + `od_commlog_num`.
  - Re-sending the same signed `call_analyzed` (simulated Retell retry) writes only ONE commlog.
  - An ambiguous-match payload → NO commlog, call shows `needs_review` (visible in the CareIN Log),
    candidates stored.
  - Webhook returns `200` quickly (before the OD write completes).
- Then promote develop→prod via the manual flow once green.

## Handling
Branch `feature/webhook-commlog-hardening` off `develop`; PR → pipeline → staging → controlled
re-validation → promote to prod. Live-OD writes only via the controlled signed-webhook protocol. Report
at a stop point after the staging validation, before the prod promotion.
