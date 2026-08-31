# CLAUDE.md — CareIN dashboard, for coding agents

Read this first. Everything here was verified against the code on `origin/develop` in
August 2026. Where an older doc in this repo disagrees with this file, this file wins —
most root-level `*.md` files predate the Azure cutover and carry a `SUPERSEDED` banner.

Two rules before anything else:

- **Never edit the PROD folder** (`c:\Users\beau\carein cursor dashboard`). Work in the
  dev clone or a worktree. See [DEV_PROD_WORKFLOW.md](DEV_PROD_WORKFLOW.md).
- **Never put a real patient name, phone number, DOB, or PatNum-plus-name into code,
  comments, logs, commit messages, or test fixtures.** The synthetic fixtures below exist
  so you never have to.

---

## 1. Architecture

| Piece | Path | Stack | Status |
| --- | --- | --- | --- |
| Backend API | `backend/` | Node + Express, **CommonJS**, no build step | Active |
| Dashboard UI | `new-dashboard/` | React 19, Vite 7, TypeScript strict, Tailwind v4, shadcn/ui, wouter, Recharts | Active |
| Legacy UI | `frontend/` | React 18 + Material UI | **Deprecated — do not modify** |
| CareIN log sub-server | `new-dashboard/server/` | Express + esbuild bundle | Secondary; serves the vestigial "CareIN Log" tab |
| OD microservice | `od-microservice/` | — | Separate deployable |
| Retell MCP | `mcp/retell_mcp.py` | Python | Standalone tool, not part of the app |

The backend has no compile step — `node --check server.js` is the syntax gate. The
dashboard is TypeScript strict (`new-dashboard/tsconfig.json:11`), and tests are
**excluded** from typechecking (`tsconfig.json:3`), so a type error inside `tests/` will
not fail `pnpm run check`.

### Module namespaces and `requireModule`

There are **four** module namespaces, enforced by a DB CHECK constraint
(`backend/migrations/1785369600000_rename_module_carein_to_voice.js:46`):

```
voice | rcm | tc | scheduling
```

`requireModule(name, { exempt })` lives in **`backend/middleware/tenantContext.js:203`**
(not in `platform/registry.js`). It calls `isEntitledModule(req, name)`, a pure predicate
over `req.tenant.modules`, and **fails closed** — a missing `req.tenant` reads as *not
entitled*, so a route accidentally mounted outside the tenant gate 403s rather than
leaking. Denial body (`tenantContext.js:213`):

```json
{ "success": false, "error": "MODULE_NOT_ENTITLED", "module": "<name>", "message": "..." }
```

Note the code is in `error`, **not** `code`. The one exception is `POST
/api/unified-calls/:id/send-to-tc`, which deliberately sets both.

Middleware order in `backend/server.js`: `/auth` (outside `/api` entirely) →
`requireDashboardAuth` on `/api` → `tenantContext` on `/api` → per-mount module guards.

**Mount table** (`backend/server.js:214-237`):

| Mount | Guard |
| --- | --- |
| `/api/mango/recordings` (static) | `voice` |
| `/api/calls`, `/api/agents`, `/api/opendental`, `/api/opendental-sync`, `/api/live-calls`, `/api/admin`, `/api/callbacks`, `/api/unified-calls`, `/api/analytics`, `/api/retell-tools-config`, `/api/agent-config`, `/api/notifications-config`, `/api/slot-markers` | `voice` |
| `/api/mango` | `voice`, exempting `/dev/seed` |
| `/api/tc` | `tc` — **ships dark**, no tenant is entitled yet, so everything 403s by design |
| `/api/platform` | **none** — the platform console (PR C). No module guard is deliberate: this is the surface that *sets* entitlements, so gating it on one would be circular. Behind `requireSuperAdmin()`, which a tenant `admin` and the shared machine token both fail. See [docs/PLATFORM_CONSOLE.md](docs/PLATFORM_CONSOLE.md) |
| `/api/webhooks` | **none** — HMAC-verified, carries no tenant |
| `/api/retell-tools` | **none** — Retell HMAC-verified, live agent path |
| `/api/health` | none |

`backend/test/moduleGateWiring.test.js` scans `server.js` source to enforce this. It does
**not** yet cover `/api/tc` or `/api/mango/recordings` — if you add a mount, add it to
that test's list too.

The `/api/mango/recordings` static mount sits **below** the auth gate on purpose. It was
once above it, which served PHI audio unauthenticated on the public hostname; that
regression is pinned by `backend/test/recordingsAuthGate.test.js`. Never move it up.

---

## 2. The voice pipeline, end to end

```
Mango PBX ──► mangoApiClient (watermark + gap drain) ──► unifiedCallStore
Retell    ──► webhooks / poll ─────────────────────────► unifiedCallStore
                                     │
                                     ├─► callTwins        link the two legs
                                     ├─► onDemandTranscription ─► Azure Speech ─► transcriptShape
                                     ├─► openDentalSync   match ► review ► send  ─► OD commlog
                                     └─► tcCaseClient     send to TC ─► TC case
```

### 2.1 Ingestion — `backend/services/mangoApiClient.js`

Mango is pulled from the Django-REST API at `api.mangovoice.com` (SimpleJWT bearer). The
default auth provider is a pure-`fetch` HTTP login (`mangoApiClient.js:90`); a Puppeteer
provider (`:154`) survives only as a local/diagnostic fallback and is required lazily so
the normal path never loads Chromium.

**Recordings are transcribe-and-discard.** `mangoApiClient.js:14`: *"recordings are the
signed, EXPIRING S3 `recording_url` from call detail. We fetch → Azure Speech (BAA) →
discard; audio is never written to disk here."* `mangoNormalize.js:92` sets
`recording_url: null` for the same reason. Do not add a step that persists audio.

**The watermark.** `fullSync` walks backwards through `GET /calls/?ordering=-started_at`
(50/page) and stops when it crosses `watermark − OVERLAP`, not after N calls
(`mangoApiClient.js:268-283`). The watermark advances **on successful ingestion only,
never on transcription outcome**. State is a `DurableState` doc
`mango_ingestion_watermark.json` shaped `{ started_at, gap_from, gap_to }`
(`ingestionWatermark.js:78`).

**The gap machinery is structural, not a temporary patch.** If a page cap truncates a
walk, there is an unfetched range below the reached point.
`ingestionWatermark.js:25-29`: *"Holding the watermark there does NOT work: the next walk
restarts from the newest call, so new arrivals push its reach FORWARD and the unfetched
range widens every sync. A backlog deeper than one sync's page budget would never
drain."* So a truncated walk records a **gap** and later syncs drain it.

The three page budgets are also load-bearing (`mangoApiClient.js:355-361`): *"The normal
window, the already-covered skip region, and the gap drain each get their own — a shared
budget starves whichever comes last in the walk, which is always the drain, so the backlog
would never move."* Do not merge them.

The header does **not** use the word "permanent" — describe this as *structurally
necessary* rather than quoting that word.

Dedup guard at `mangoApiClient.js:475-480`: `findByExternalId` reuses an existing
transcript rather than re-sending a recording to Azure Speech. That guard is what ended a
re-transcription cost loop; don't route around it.

### 2.2 Twin linking — `backend/services/callTwins.js`

When the AI answers a call the PBX also logged, there are two rows. `isTwin(mangoCall,
retellCall)` (`callTwins.js:139-169`) links them. **All** of these must hold:

1. Argument order is enforced: Mango row must be `source === 'mango'`, Retell row
   `'retell'`. Two same-source rows can never link.
2. Mango `direction` explicitly `'outbound'` → refuse.
3. Caller match on the **last 10 digits**; fewer than 10 digits → refuse.
4. Both `call_date`s parseable.
5. Mango `duration_seconds > 0` — *"A zero-length PBX leg has no span to align against."*
6. Forward delay `retellStart − mangoStart` ∈ **[−2s, +120s]**.
7. **|Δend| ≤ 2s**, where end = start + duration.

The measured fan-out table is in the header (`callTwins.js:28-38`) and is the reason ±2s
was chosen:

```
Δend ±1s → 56/1   ±2s → 67/1   ±3s → 67/1
     ±5s → 68/1  ±10s → 69/1  ±30s → 70/2   ← first ambiguity
```

> *"±2s sits on the plateau with 15s of headroom before anything becomes ambiguous… Do NOT
> relax this to a Δstart-only rule to 'catch a few more' … loosening it is precisely what
> would start swallowing the follow-legs."*

**Do not loosen this rule.** `findTwin` treats two matches as a refusal, not a coin flip
(`:174`). Roles are `primary` (Retell) / `duplicate_leg` / `transferred_leg`; the
transferred role is chosen from Retell's `disconnection_reason`.

### 2.3 On-demand transcription

Transcription is a **human decision per call**, not an automatic step.
`MANGO_AUTO_TRANSCRIBE` defaults to false, and `config/mango.js:52-56` is explicit:
*"INGESTION AND TRANSCRIPTION ARE INDEPENDENT SWITCHES (M4)… Do not conflate them."*

The budget circuit breaker is **three pieces**, not one:

- **Primary gate** — `TranscriptionService.checkDailyBudget()`
  (`transcriptionService.js:166`). Callers *must* consult it so they can skip cleanly.
- **Hard backstop inside `transcribeBuffer`** (`transcriptionService.js:302-317`) — throws
  `TRANSCRIPTION_BUDGET_EXCEEDED` before building the request, *"even if a caller forgets."*
- **Caller pre-checks** — `mangoApiClient.js:511` (sync) and
  `onDemandTranscription.js:231` (on-demand, checked before asking Mango for the recording
  so a spent budget costs zero round trips).

Cap: `MAX_TRANSCRIPTION_MINUTES_PER_DAY`, default **120 min/day**, `0` = unlimited. The
accounting day is **local** (`TRANSCRIPTION_BUDGET_TZ`, default `America/Chicago`) because
UTC midnight lands mid-evening in Central. The counter is persisted to
`transcription_budget.json` so a container restart cannot hand back a fresh budget.
Minutes are charged after the fact, so a single long call can overshoot — the cap gates
*starting*, not the total.

**There is no queued/running/failed lifecycle.** The endpoint is synchronous and returns
one of a **closed set of 10 outcomes** (`onDemandTranscriptionLedger.js:43`,
`routes/mango.js:113`), and *"the UI switches on `status`, not the code"*:

| `status` | HTTP | Meaning |
| --- | --- | --- |
| `completed` | 200 | Transcript + summary written |
| `exists` | 200 | Already transcribed; zero spend |
| `not_found` | 404 | Call not in the store |
| `in_progress` | 409 | Another request holds the in-process lock |
| `recording_not_ready` | 422 | Plus `retryAfterMinutes` |
| `recording_unavailable` | 422 | Phone system no longer has it |
| `no_speech` | 422 | Plus `alreadyBilled: true` |
| `budget_exhausted` | 429 | Plus `resetsAt`, `usedMinutes`, `capMinutes` |
| `unavailable` | 503 | Azure Speech not configured |
| `error` | 500/502 | — |

Adding an outcome means adding it to `TranscribeStatus` in
`new-dashboard/client/src/lib/api.ts:103` — the union is deliberately closed so a new
outcome is a compile error, not a silent "something went wrong" toast.

`onDemandTranscription.js` persists, re-reads, and only then reports success
(`:371-376`): *"a success we cannot show the user again is a lie."*

### 2.4 Canonical transcript shape — `backend/utils/transcriptShape.js`

One shape in the store. Each entry:

```js
{ role: 'agent' | 'user' | null, speaker: number | null, content: string, start: number | null, end: number | null }
```

Only `normalizeTranscriptJson` is exported (`:115`). It returns `null` when the input is
not an array (callers then fall back to plain text) and is **idempotent by contract**,
because `normalizeCall` re-runs it on every watermark-overlap re-ingest.

`role` and `speaker` are deliberately separate (`:29-34`): *"Azure diarization gives an
INDEX, not a role… Collapsing the index into a role would print a guess into a patient's
chart as though it were known."*

### 2.5 Per-office Open Dental

Office keys are frozen: **`roland`** and **`valley`**, plus a system bucket **`unknown`**.
`valley` is internally the Fort Smith "Riley" office — the key stays frozen even though
the office is branded Riley (`officeAgents.js:28`).

**Only the customer key is per-office.** The developer key and API base URL are
process-wide (`openDental.js:50-53`): *"The developer key is shared across all of CareIN's
practices; the CUSTOMER key is what selects WHICH practice's database you are talking to —
so it, and only it, is per-office."*

The registry is `OFFICE_OD_SETTINGS` in `backend/config/odOffices.js:77`:

| Office | Customer key env | Key Vault secret | CommLog DefNum env | Default DefNum |
| --- | --- | --- | --- | --- |
| `roland` | `OPENDENTAL_CUSTOMER_KEY` | `opendental-customer-key` | `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM` | **486** |
| `valley` | `OPENDENTAL_CUSTOMER_KEY_VALLEY` | `opendental-customer-key-valley` | `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY` | **451** |

Convention: Roland keeps the bare legacy name; every additional office gets a
`_<OFFICE>` suffix. Adding an office is a config change, not new code.

**DefNums are practice-specific and must never cross** (`odOffices.js:44-50`): *"DefNum 486
must therefore NEVER be written to Riley's database (486 is not a CommLogType there at
all), and 451 must never be written to Roland's."* A non-numeric env override falls back
to the default rather than writing `NaN` into a chart.

`getOdOffice(key)` returns a **frozen** handle `{ officeKey, officeName, commTypeDefNum,
client }` and **throws** `OdOfficeError` rather than returning null — it never falls back:

| Code | HTTP | When |
| --- | --- | --- |
| `OFFICE_UNKNOWN` | 409 | Unknown key, or the `unknown` bucket |
| `OFFICE_NOT_OD_CONNECTED` | 409 | No registry entry, or `odEnabled === false` |
| `OFFICE_OD_KEY_MISSING` | 503 | Switched on but no customer key present |
| `OFFICE_MISMATCH` | 409 | See `assertOfficeMatch` below |

> *"A missing valley key can never silently fall back to Roland's key."* (`odOffices.js:26`)

**`assertOfficeMatch(expectedOfficeKey, handle)` is at `backend/config/odOffices.js:321`**
— not in `platform/odAccess.js`, which is a separate tenant-level seam. It asserts strict
equality between the operation's office key and the key frozen onto the handle, logs
`BLOCKED cross-office Open Dental operation`, and throws `OFFICE_MISMATCH`. On success it
returns the same handle, which is why the idiom is
`assertOfficeMatch(key, getOdOffice(key))`. Call sites: `openDentalSync.js:42, 299, 733,
838, 870`, `routes/retellTools.js:66`, `routes/unifiedCalls.js:390`. Its header calls it
*"the safety heart of this slice."*

There is **one** OD switch: `OFFICE_OD_SETTINGS[x].odEnabled`, read by both voice and
TC through `isOdReady(officeKey)` (intent AND credentials, per office). Today both
offices are `true`.

There was briefly a second, `officeAgents.OFFICES[x].odConnected`, which gated
`/api/tc/od/*`: TC reached Open Dental through the single process-wide client built
from **Roland's** key, so connecting Riley for voice had to leave TC shut or TC would
have served Roland's charts under a Riley selector. TC now resolves its client per
office through this registry (`backend/routes/tc/od.js requireOdOffice` —
`assertOfficeMatch(office, getOdOffice(office))`, re-asserted per OD call in
`odGetFor`), so the second flag gated nothing and was **removed**. `OFFICES` entries
now carry `officeId` and `officeName` only; `odOffices.test.js` pins that no second
switch has crept back.

TC's OD reads ride the transport's shared per-**credential** slot
(`config/openDental.js`), the same one voice uses, and tag `module: 'tc'` so 429s and
waits are attributed. They deliberately do **not** enter `services/rcm/odPacer`'s
serialized 1200ms queue: that queue exists so a biller's batch cannot degrade
interactive paths, and a TC treatment plan is a fan-out of up to 25 GETs on a screen
somebody is waiting on.

### 2.6 Matching, resolve, and link-only

Search is **call-scoped by design**: `GET
/api/unified-calls/:id/patient-search?q=&target_office=`, *"Deliberately call-scoped
rather than a bare /opendental/patients/search?office_id=… "* — the call is what fixes
the ORIGIN office and puts the look through a practice's records in the trail next to
the call that prompted it. Requires `q.length >= 2`, and audits with `resourceId: null`
because the query itself may be PHI.

`target_office` (optional) chooses WHICH practice's list to search; see **The
cross-office chart target** below.

Older non-office-aware searches still exist at `GET /api/opendental/patients/search` and
`GET /api/opendental-sync/patients/search` — they route through the tenant seam and take
no office. Prefer the call-scoped one for anything new.

`POST /api/unified-calls/:id/resolve-patient` (`unifiedCalls.js:688`) has four shapes:

| Body | Effect |
| --- | --- |
| `{ notAPatient: true, reason }` | Closes out, **no OD call**. Reasons: `spam, solicitor, vendor, lab, wrong_number, other` |
| `{ patientId, linkOnly: true }` | **Link-only** — sets `od_patient_id` + `od_sync_status: 'matched'`; `sent_by`/`sent_at` stay null; **writes nothing to the chart** |
| `{ patientId, note?, content_type?, commTypeDefNum? }` | Link **then** write the commlog |
| any of the above on an already-`synced` call | Idempotent no-op returning the existing `commLogNum` |

`commTypeDefNum` is the chart-note TYPE, picked at the send step. **Omitted, the write is
byte-for-byte what it was before the picker existed** (the office default from
`odOffices.js`). Supplied, `backend/services/commlogTypes.js` checks it against the CALL's
office's own `GET /definitions?Category=27` list and refuses anything else — **400
`COMMLOG_TYPE_INVALID`**, including the other practice's perfectly valid DefNum. That is
what turns the 486/451 never-cross rule from a convention into an enforced check.

Two facts, live-verified 2026-08-13, that the design rests on: 486 does not exist in
Riley's list and 451 does not exist in Roland's, so list membership IS the cross-office
check; and **DefNum 401 is valid in BOTH** — `ODHQ` in Roland, `Crown by Moolah` in Riley
— so there is no global allowlist and the question is only ever answerable per office.

A definitions read can never block a chart write: the office's own default is accepted
without consulting the list, so a non-default choice is the only thing that needs it
(**503 `COMMLOG_TYPE_UNVERIFIABLE`** when it cannot be produced). The catalogue is cached
per office for an hour and served STALE on a failed refresh. The offered list rides `GET
/api/unified-calls/:id/commlog-preview` as `commlogTypes`, so the office stays
server-derived from the call.

Why link-only exists (`unifiedCalls.js:768-779`): *"Identifying who called and filing a
note about it are two different decisions, and they were welded together."* The mechanism
is `linkCallToPatient(..., { syncNow: false })`. Link-only on an already-sent call
returns 200 for the same patient and **409 `ALREADY_SENT_TO_CHART`** for a different one.

Legacy route caution: `POST /api/opendental-sync/calls/:callId/link` defaults
`syncNow = true` and does **not** pass `expectOfficeKey`. It writes a commlog. Don't reach
for it in new code.

### The cross-office chart target

A call belongs to the office it rang at, permanently — that attribution is the call's
identity and drives the worklists, filters and analytics. **Which chart a note is filed
in is a separate fact**, and since 2026-08-24 it is a per-send choice.

The reason: the front desk at one practice regularly takes a call about the other
practice's patient. Locking the chart to the call's office meant Pick Patient searched
only that office's Open Dental, the patient was not in it, and the call could not be
charted anywhere at all.

|  | Origin | Target |
| --- | --- | --- |
| What | The office the call rang at | The office whose chart/patient list we touch |
| Where from | `getOfficeForCall(call)` — derived, never from a request | `target_office`, else the default below |
| Mutable | **Never** | Per request |

Three routes take `target_office` — `patient-search` (query), `commlog-preview` (query),
`resolve-patient` (body):

- **Absent → the default**, and that default is a **service invariant, not a route
  convenience**: `openDentalSync.defaultTargetOfficeFor(call)` — the office of the call's
  *linked patient* when it has one, otherwise the call's own. It follows the patient
  because a stored PatNum is only meaningful in the database it came from; defaulting a
  call linked at Riley back to Roland would aim a Riley PatNum at Roland's database.

  It lives in the **service** because `syncCallToCommLog` is reachable from callers that
  know nothing about targets — the legacy `POST /api/opendental-sync/calls/:id/sync` and
  the batch drain. A default defined in `routes/unifiedCalls.js` was a rule only the SPA's
  route obeyed, and the other callers resolved back to the call's office, hit the
  stale-match guard, discarded the human's link and re-matched by phone. The route now
  delegates; there is one definition.
- **Present → validated against the office registry** (`odOffices.isChartTargetOffice()`,
  the single definition of "one of this practice group's offices"; excludes `unknown`).
  Unrecognised → **400 `TARGET_OFFICE_UNKNOWN`**, never a fallback. Reachability is then
  the same per-office fail-closed check as everywhere else (`odBlockReason` → 409/503).
- **A stored link that disagrees with the resolved office is REFUSED**, not routed around:
  `syncCallToCommLog` returns `PATIENT_OFFICE_MISMATCH` (409), writes nothing and
  re-matches nothing. Which of the two facts is wrong is a question only a person can
  answer. Reachable today for a legacy row carrying no `od_patient_office` (read as
  `roland` by stated assumption) on a valley call — the pre-slice corruption shape.
- **`matchAndSetStatus` never re-matches an already-linked call** — it returns
  `already_linked` and touches nothing. Three of its four callers only skipped `'synced'`,
  so the hourly Mango sync would otherwise re-match a cross-office-linked call in the
  *call's* office and silently re-point it within the hour.
- `openDentalSync.linkCallToPatient` / `syncCallToCommLog` take `targetOfficeKey`
  (**selects**, from a validated human choice) alongside `expectOfficeKey` (**asserts**,
  can only refuse). `odForTarget()` is the seam; `odForCall()` is the call's own office.

`office_id` keeps its old job — an assertion that can only 409 — but is now compared to
the resolved **target**, not the call. A stale screen that names only the call's office
on a request whose target is elsewhere still gets `OFFICE_MISMATCH`. The UI sends both.

The `linkOnly` no-op check on an already-`synced` call compares **(PatNum, office)**,
never PatNum alone: 7115-in-Roland and 7115-in-Riley are two different people, and
comparing the number by itself would read a re-point at the other practice as a harmless
no-op.

Audit rows carry both: **`office` = the chart touched, `origin_office` = the call it came
from** (`migrations-tenant/1787200000000_audit_log_origin_office.js`). A cross-office
action is `origin_office IS DISTINCT FROM office`. The not-a-patient close-out records
only `office` — it touches no chart, so naming a target would be a lie.

Permission: `voice.chart_write`, and no new action. Aiming an existing privilege at a
different chart is not a new privilege — but a **cross-office patient search** takes the
same permission, because paging through the other practice's records is only ever the
first half of writing a note there. Same-office search stays open to every voice role
(a `tc` user identifying a caller is unaffected). The check is in the handler
(`holdsPermission(req, 'voice.chart_write')`) rather than at the mount, because the answer
depends on a target resolved mid-request; refusal is **403 `CROSS_OFFICE_SEARCH_FORBIDDEN`**
and is audited `READ … UNAUTHORIZED` with both offices.

UI: `pages/calls/ChartOfficeSelect.tsx` (selector + the persistent mismatch line), used by
both `PickPatientModal` and `SendToChartDialog`, and rendered only when the caller holds
`voice.chart_write` (`canCrossOffice` prop — the parents already compute it for the chart
buttons). Changing the office **clears the selected patient** and, in Pick Patient,
**hides the stored match candidates** — those PatNums were matched in the other database
and mean a different person here. The Send dialog's confirm button names the practice. Tests: `backend/test/crossOfficeChartTarget.test.js` and
`new-dashboard/tests/cross-office-chart-target.test.tsx`.

### 2.7 Send to TC — `backend/services/tcCaseClient.js`

**The payload is assembled server-side from the stored call, never from the request body**
(`unifiedCalls.js:958-963`). `office_id` in the body is an assertion that can only cause a
refusal, never a redirect. The only `req.body` read in the whole handler is that
assertion.

Transport is a **loopback HTTP call to this same process** —
`POST {internalBaseUrl()}/api/tc/cases/from-call`, 10s timeout — forwarding the caller's
own cookie/bearer so the TC route derives the same actor, tenant, and its own
`requireModule('tc')` guard. There is no service credential.

Payload: `od_patient_id`, `office`, `call_id`, `call_summary`, `call_url`, `patient_name`,
and `patient_phone` **omitted entirely** when the caller number is missing or the literal
`'Unknown'`. Response `{ case_id, url, attached }`; `attached: true` means it joined an
open case. Idempotent on `call_id`.

Refusals, in evaluation order: `CALL_NOT_FOUND` 404 → `MODULE_NOT_ENTITLED` 403 →
`OFFICE_MISMATCH` 409 → `OFFICE_UNKNOWN` 409 → `NO_MATCHED_PATIENT` 409 →
`PATIENT_NAME_UNAVAILABLE` 409 → `SEND_TO_TC_FAILED` 500. Client-side codes:
`TC_UNREACHABLE`, `TC_MODULE_NOT_ENTITLED`, `TC_ENDPOINT_MISSING`, `TC_ERROR`,
`TC_BAD_RESPONSE`. Status 0 and 404 are both remapped to **502** — *"the TC app didn't
take it… rather than echoing a 404 that reads like 'call not found'."*

A 200 with no case in the body is `TC_BAD_RESPONSE`, not success: *"persisting a
half-known linkage would be worse than refusing."* A failed send **never** persists
`tc_case_id`.

### 2.8 The unified call store — `backend/services/unifiedCallStore.js`

An in-memory `Map` plus four indexes, persisted as **one JSON file**:

```
${CALLSTORE_DIR:-<repo>/data}/unified_calls.json   (+ .tmp during writes)
```

Writes are atomic (tmp + `rename`) and debounced 500 ms via `requestPersist()`, with a
60 s autosave and a final persist on shutdown. Reads replay every call through
`addCallInternal` and then run a `relinkAllTwins()` backlog pass.

There **is** a `call_record` Postgres table
(`backend/migrations-tenant/1780449833070_call_record.js`) but it is **schema only** — no
code reads or writes it. The JSON → Postgres cutover is a deliberate later slice.

`CALLSTORE_DIR` carries a live durability warning (`:134-141`): prod mounts an AzureFile
volume at `/data`, but the default path is `<app>/data`, so *"until `CALLSTORE_DIR=/data`
is set, the store rides the EPHEMERAL container layer and is wiped on every image
deploy."*

#### The preservation whitelist — read this before touching `normalizeCall`

`normalizeCall` **rebuilds the record from scratch** and `addCallInternal` replaces the
stored call, so any field not named in the output literal is **dropped**. That is the
entire reason the whitelist exists (`:379-384`): *"without carrying these through, every
addRetellCall (webhook re-delivery AND the 15-min poller) would wipe od_sync_status and
defeat commlog dedup."*

There are **two** layers, and they are not the same list:

- **Layer A — `normalizeCall` (`:285-449`)**: names the field in the output literal.
- **Layer B — `addRetellCall` (`:466-518`)**: `call.x ?? existing?.x ?? null`, inheriting
  from the *stored* record when an incoming Retell payload doesn't mention the field.

Families in Layer A:

| Family | Fields | Why |
| --- | --- | --- |
| Mango office attribution | `called_number`, `direction` | `getOfficeForCall` reads `called_number`; dropping it made **every** Mango call resolve to office `unknown` (day-1 bug) |
| Chart-note compact summary | `action_needed`, `callback_number` | Otherwise the note's Action/Callback lines reset |
| Transcription attribution | `transcribed_at`, `transcribed_by`, `transcribe_source`, `transcribe_last_outcome`, `transcribe_last_attempt_at`, `transcribe_last_attempt_by` | The hourly sync re-ingests inside the watermark overlap; without these, "who pressed Transcribe" is erased within the hour. `no_speech` in particular must survive or accidental re-billing is silently re-armed |
| OD commlog sync state | `od_sync_status`, `od_patient_id`, **`od_patient_office`**, `od_patient_name`, `od_commlog_num`, `od_synced_at`, `od_match_confidence`, `od_match_candidates`, `od_sync_attempted_at`, `od_sync_error`, `sent_by`, `sent_at`, `sent_note`, `note_edited` | Losing these defeats commlog dedup and drops the matched name from the worklist. **`od_patient_office` is the load-bearing one**: `openDentalSync.patientOfficeOf()` reads an absent value as `'roland'`, so a PatNum that loses its office is not a vaguer match — it is a different person. Added to both layers with the cross-office target |
| Triage / review queue | `triage_status` (default `'new'`), `triage_outcome`, `triage_by`, `triage_at`, `triage_note`, `not_a_patient` (default `false`), `not_a_patient_reason`, `resolved_by`, `resolved_at` | A re-add would reset a triaged call to `'new'` and lose attribution |
| TC handoff | `tc_case_id`, `tc_case_url`, `tc_sent_at`, `tc_sent_by` | The "In TC" chip would vanish within the hour and invite a second send while the case sits in TC unreferenced |
| Twin linkage | `linked_call_id`, `link_role` | A linked duplicate leg would un-hide itself within the hour and resolved clutter would reappear |
| Retell disconnection | `disconnection_reason` | *"the ONLY honest basis for telling an AI-completed call from one the AI transferred to a human"* — the duration delta cannot, because both legs end at the same instant by construction |

**Layer B omits three of those families**: `called_number`/`direction`,
`action_needed`/`callback_number`, and the six `transcribe_*` fields. If you write "the
whitelist" as one list you will be wrong for one of the two layers. Also
`triage_status` defaults to `'new'` in Layer A and `null` in Layer B; Layer A runs last,
so `'new'` wins.

Regression coverage is `backend/services/unifiedCallStore.test.js` and
`callTwinsStore.test.js`. **Add a test there whenever you add a locally-set field.**

#### Retention: the delete and stub primitives

The store used to have no removal path beyond `clear()` ("for testing") and grew
monotonically across restarts. It now has two primitives, and the difference between them
is the whole design:

| Primitive | What it does | Who calls it |
| --- | --- | --- |
| `stubCalls(ids)` | Replaces a record **in place** with a thin audit stub, same id | The nightly pruner |
| `deleteCalls(ids)` | Removes the record entirely and **tombstones** the id | The one-shot legacy purge only |

**Retention window: 30 days** (`CALL_RETENTION_DAYS`; `0` = never prune). Past it, a call's
transcript, summary, recording refs, caller name/number, notes and disposition detail are
gone, replaced by `{ id, record_kind: 'stub', source, office, call_date, pruned_at,
linked_call_id, link_role, actions[] }`. `actions` records what people DID —
`{action, actor, at}` — never content. **A stub carries no PHI**, pinned by a test that
asserts the absence of every content field.

Rules that hold everywhere:

- **Twins age out as a unit.** `expandTwins` pulls in the other leg for both primitives, so
  a `linked_call_id` never points at nothing.
- **No resurrection.** `addCallInternal` returns `null` for a stub and for a tombstoned id,
  so the watermark overlap and webhook re-delivery cannot un-prune a call or revive a
  purged one. `updateCall` refuses on a stub, and `routes/unifiedCalls.js` turns that into
  **409 `CALL_PRUNED`** — never a 404, which would mean something different.
- **The office is frozen at prune time.** `getOfficeForCall` returns `call.office` for a
  stub rather than re-deriving it from `called_number`/`handler_id`, which a stub drops.
- **`purgedIds` is bounded by design** — only the one-shot purge writes to it; the nightly
  pruner stubs and never deletes.

The legacy purge (`services/legacyPurge.js`) targets Mango rows whose called line was never
in `MANGO_LINE_OFFICE` (office `unknown`). It is **dry-run by default**, needs
`confirm: 'DELETE'` to run live, **refuses to proceed without a backup on disk**, and skips
twinned rows rather than dragging an attributable Retell call down with them. Exposed as
`POST /api/admin/call-store/purge-legacy` behind `requireSuperAdmin()` — the first place
that gate is actually mounted.

`persist()` logs `[callstore] persist ok calls=N bytes=B ms=T`. That line is the
before/after measurement for the readiness-probe work, and a test pins its format because
the runbook greps it.

`backend/migrations-tenant/1786500000000_tc_voice_handoff.js:12` justifies snapshotting
summary text into the handoff event with *"The voice side prunes call records on its own
schedule"*. As of this slice **that is now true** — and it is exactly why TC must keep
snapshotting rather than dereferencing a call.

`getStats()` returns `totalCalls`, `prunedCalls`, `liveCalls`, `todayCalls`, `bySource`, `byHandler`, `sentiment`,
`emergencyCalls`, `callbacksNeeded`, `lastSync`, and `twins`. The `twins.transferDisconnects`
counter is a **tripwire**: while it reads 0, every linked Mango leg is a pure duplicate of
an AI-completed call, which is the premise the hide-from-worklist behavior rests on.

---

## 3. Hard rules

These are enforced in code. If a change would relax one, stop and ask.

1. **Review-then-send.** CareIN never auto-writes a chart note unless
   `COMMLOG_AUTO_WRITE === 'true'`, which is off by default (`routes/webhooks.js:353-364`).
   A confident match lands in `'matched'` and waits for a human to send it from the
   worklist. The matcher itself (`openDentalSync.js:1132`) only sets status — *"No
   auto-write ever happens here."* Confidence gate is 0.80 **plus** a hard no-alternatives
   rule; ambiguity means `needs_review`, never a guess.
2. **A call's OFFICE comes from the call, never from a parameter.** `getOfficeForCall`
   (`officeAgents.js:137`) derives it from `called_number` for Mango (via the
   `MANGO_LINE_OFFICE` DID map; unmapped → `unknown`, warn-once, **never Roland**) and from
   `handler_id ?? agent_id` for Retell (unmapped → fallback `roland`). A body `office_id`
   is an assertion that can only 409. Nothing re-attributes a call.

   The one thing a request may choose is the **chart target** — `target_office`, a
   validated office key naming which practice's chart a note is filed in (see §2.6).
   It never changes the call's office, it is refused unless it names a registered
   office, and it only exists because a call about one practice's patient can ring at
   the other. Everything else — the OD client, the DefNum, the PatNum validation — then
   follows that one resolved key. There is still no way for a request to end up at an
   office nobody named.
3. **A PatNum needs an office.** PatNum numbering restarts in every OD database. Every
   stored `od_patient_id` is written with `od_patient_office` — including a deliberate
   cross-office link, where they disagree with the call's own office — and both survive
   re-normalization (§2.8). A stored match whose office disagrees with the one an
   operation resolves to is **refused** — `PATIENT_OFFICE_MISMATCH`, nothing written and
   nothing re-matched. (It was discarded and re-matched until 2026-08-24; re-matching by
   phone lands the note on whoever shares the caller's number in the resolved office,
   which is worse than refusing and much worse once a human can link cross-office on
   purpose.) Any route taking a bare `:patientId` must be given `?office_id=` and 400s
   without it.
4. **Honest states.** A failed send never looks sent. A transcription success is only
   reported after the transcript is read back. A 200 without a case id is a refusal.
   Ambiguity is a refusal, not a coin flip.
5. **Fail closed.** No tenant → 403. No module → 403. Control DB unreachable → 503. No
   office key → 503. A failed audit write on a PHI path **propagates**, so PHI is not
   served without a recorded trail.
6. **Never write directly to Open Dental MySQL.** Use the OD cloud API through the
   office-keyed client registry.
7. **No real patient data anywhere.** Use the fixtures below.

### Test-patient fixtures

| PatNum | Name | Office | Use |
| --- | --- | --- | --- |
| `7115` | `Stedi TestValley` | **valley** | The valley test patient — and the reason the office layer exists: **PatNum 7115 in Roland is a different, real person.** Never assume a PatNum without its office. |
| `12827` | `Test 2, Stedi` | roland | Roland fixture for resolve/preview route tests |
| `12828` | `Test, MangoTest` | roland | TC test patient + the Mango staging seed. Chosen because its phone is on exactly one record, so `phone_exact` yields a single 0.95 match → `'matched'` |
| `11373` | — | roland | **Rejected as a fixture** — its number is a shared family phone, so phone matching returns multiple records and the match is ambiguous by construction |

Gotcha worth knowing: `12828` is `LName: "Test", FName: "MangoTest"`, so a last-name-only
search misses it entirely. The dual-lane merge in the OD search is what makes it findable
and is not optional.

---

## 4. Environment and config truth table

Secrets are marked 🔒 — **document names only, never values**. In staging/prod they come
from Key Vault, never from a `.env`.

### Mango ingestion

| Var | Default | What flipping it does |
| --- | --- | --- |
| `MANGO_INGEST_MODE` | `off` | **Only the literal `api` turns ingestion on** (`config/mango.js:57`). Every other value — including `scraper` and typos — **silently resolves to `off`**. The DOM scraper mode is retired. |
| `MANGO_AUTO_TRANSCRIBE` | `false` | `'true'` (case/space-insensitive) makes the sync auto-send calls to Azure Speech. Independent of `MANGO_INGEST_MODE`. Leave off — transcription is a per-call human decision. |
| `MANGO_SYNC_SCHEDULE` | `15 * * * *` | Cron for the sync. An invalid cron makes `start()` return without scheduling — the sync silently never runs. |
| `MANGO_SYNC_DISABLED` | unset | `'true'` blocks **both** the cron and manual `runSync`. Lives in `middleware/envGuards.js:23`, not `config/mango.js`. Set it in dev so a dev box can't contend for the shared portal session. |
| `MANGO_WORKLIST_MODE` | `all` | `flagged` limits "Needs attention" to emergency / appointment / callback calls. |
| `MANGO_WATERMARK_OVERLAP_MINUTES` | `120` | How far back past the watermark each walk re-reads. |
| `MANGO_SYNC_MAX_PAGES` | `10` | Circuit breaker (10 × 50 = 500 calls), **not** a routine limiter. Exceeding it records a gap. |
| `MANGO_SYNC_MAX_SKIP_PAGES` | `60` | Separate budget for already-covered history. |
| `MANGO_RECORDING_LAG_MINUTES` | `30` | How long after a call the recording is assumed unpublished. |
| `MANGO_SUMMARY_MIN_SECONDS` | `20` | Minimum duration to summarize. |
| `MANGO_USERNAME` / `MANGO_PASSWORD` 🔒 | — | Portal login; Key Vault `mango-username` / `mango-password`. |

### Transcription

| Var | Default | Effect |
| --- | --- | --- |
| `MAX_TRANSCRIPTION_MINUTES_PER_DAY` | `120` | The circuit breaker. `0` = unlimited. Non-numeric falls back to 120. |
| `TRANSCRIPTION_BUDGET_TZ` | `America/Chicago` | Day boundary for the budget and the on-demand ledger. |
| `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_REGION` | — | Fast Transcription target. |
| `AZURE_SPEECH_AUTH_MODE` | `managed_identity` | `api_key` for local dev. |
| `AZURE_SPEECH_API_KEY` 🔒 | — | Only read when auth mode is `api_key`. |
| `AZURE_SPEECH_LOCALES`, `AZURE_SPEECH_MAX_SPEAKERS` | — | Locale list; diarization speaker cap. |

### Open Dental

| Var | Effect |
| --- | --- |
| `OPENDENTAL_DEVELOPER_KEY` 🔒 | Shared across all practices. |
| `OPENDENTAL_CUSTOMER_KEY` 🔒 | **Roland.** |
| `OPENDENTAL_CUSTOMER_KEY_VALLEY` 🔒 | **Valley/Riley.** Absent ⇒ valley reports not-connected; it can never fall back to Roland's key. |
| `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM` | Override for Roland's CommLog DefNum (default 486). |
| `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY` | Override for Valley's (default 451). |
| `OPENDENTAL_API_BASE_URL` | Process-wide, not per-office. |
| `OPENDENTAL_WRITE_DISABLED` | `'true'` blocks every OD mutation → 403 `OD_WRITE_DISABLED`. **Set this in dev.** |
| `OPENDENTAL_ALLOW_MOCK` | `'true'` **and** `NODE_ENV !== 'production'`. Cannot be enabled in prod. |
| `COMMLOG_AUTO_WRITE` | Only the literal `'true'` auto-writes a chart note from the webhook. Default off = review-then-send. |
| `OFFICE_TIMEZONE` | `America/Chicago`. Day boundaries for OD sync, **and** the zone `CALL_RETENTION_SCHEDULE` is read in (passed explicitly to node-cron, so it does not depend on a container `TZ`). **Distinct from `TRANSCRIPTION_BUDGET_TZ`.** |

### Open Dental health check

`backend/services/odHealthCheck.js` probes **each office** with one cheap read
(`GET /preferences?PrefName=ProgramVersion`) and reports `up | down | unknown`.
It replaced the 3-minute self-polling loop inside the OD client, which made
~25,000 OD calls/day into a `syncComplete` event with zero listeners and whose
error spam was nonetheless the only outage detector we had.

Unlike most switches here, **an unparseable value falls back to the default
rather than disabling the job** — a health checker that silently never runs is
worse than none, because its silence reads as "everything is fine". (Contrast
`MANGO_SYNC_SCHEDULE`, where an invalid cron quietly disables the sync.)

| Var | Default | Effect |
| --- | --- | --- |
| `OD_HEALTH_CHECK_DISABLED` | unset | Only the literal `'true'` turns the checker off. Set it on a dev box that must not talk to a live practice server. |
| `OD_HEALTH_INTERVAL_MINUTES` | `5` | Probe cadence. 5 min ⇒ 288 probes/office/day. `0`, negatives and garbage all fall back. |
| `OD_HEALTH_TIMEOUT_MS` | `10000` | Well under the client's 30s, so a hung eConnector is classified `timeout` rather than stalling a cycle. |
| `OD_HEALTH_FAILURE_THRESHOLD` | `2` | Consecutive failures before an office is called **down** (~10 min at the default interval). One success always calls it **up**. |
| `OD_HEALTH_HEARTBEAT_MINUTES` | `60` | One `[odhealth] heartbeat …` line per window, so silence can be told from a dead checker. |

Logging is **transition-only**: one line down, one line up, nothing while
steady — the 899-email eConnector flood is the anti-pattern. Grep `[odhealth]`.
State is exposed on `GET /api/opendental/sync/status`, `GET /api/admin/health`
(`services.openDental.offices`), and per office in the worklist roster
(`odHealth`). The checker only **observes** — it gates no OD operation.

### Retell

| Var | Effect |
| --- | --- |
| `RETELL_API_KEY` 🔒 | API auth **and** webhook signature verification. The key must carry the "webhook badge" or webhooks 401. |
| `RETELL_WEBHOOK_SECRET` 🔒 | Present in config; the webhook path verifies with the API key. |
| `RETELL_TOOLS_ENABLED` | Default off. Flip only after pasting matching tool definitions into the Retell dashboard. |
| `RETELL_AGENT_PUBLISH_DISABLED` | `'true'` blocks `PATCH /api/agents/:id` → 403. **Set this in dev.** |
| `WEBHOOK_VERIFY_DISABLED` | Local debugging only; logs a loud warning every request. |

### Runtime and platform

| Var | Default | Effect |
| --- | --- | --- |
| `PORT` | `5003` prod / `5103` otherwise | Backend listen port. |
| `NODE_ENV` | unset | `production` turns on Key Vault secret loading, `cookieSecure`, and the per-tenant audit startup gate, and refuses the OD mock. |
| `CALLSTORE_DIR` | `<repo>/data` | Where `unified_calls.json` and the small durable-state docs live. **Prod sets `/data`** to land on the AzureFile volume. Unset in a container = wiped on every image deploy. Purge backups are written here too. |
| `CALL_RETENTION_DAYS` | `30` | How long a call keeps its full record before being reduced to an audit stub. **`0` = never prune** (the kill switch). A non-numeric value falls back to 30 rather than to NaN, which would silently disable retention. **Now a FALLBACK, not the top of the chain**: `platform_setting['call_retention_days']` outranks it when a row exists (the platform console writes that row; the migration seeds none, so an untouched environment behaves exactly as before). Full precedence in [docs/PLATFORM_CONSOLE.md](docs/PLATFORM_CONSOLE.md). If the control plane has never been readable since boot, the nightly prune **skips** rather than falling back to this value. |
| `CALL_RETENTION_SCHEDULE` | `30 3 * * *` | Cron for the nightly prune. Unlike `MANGO_SYNC_SCHEDULE`, an **invalid** expression falls back to the default rather than leaving the job unscheduled — a job that destroys data must not silently never run. |
| `DASHBOARD_API_TOKEN` 🔒 | — | Shared bearer for `/api` and the Socket.IO handshake. Required in production; the server 503s without it. |
| `INTERNAL_API_BASE_URL` | derived from `PORT` | Only needed if the modules are ever split across containers. Unset is the norm. |
| `AZURE_KEY_VAULT_NAME`, `AZURE_USE_MANAGED_IDENTITY`, `AZURE_MANAGED_IDENTITY_CLIENT_ID` | — | The managed-identity branch needs all three. |
| `CONTROL_DB_URL` 🔒, `TENANT_<NAME>_DB_URL` 🔒, `AUDIT_APP_ROLE` | — | Control plane and per-tenant data plane. The app connects as the least-privilege `carein_app` role; that is what makes `audit_log` append-only. |
| `DASHBOARD_SSO_*`, `DASHBOARD_SESSION_SECRET` 🔒 | — | Entra auth-code + PKCE. See `docs/SSO.md`. |

**`TZ` is not read anywhere in the backend.** If you need a timezone, it is
`OFFICE_TIMEZONE` or `TRANSCRIPTION_BUDGET_TZ`. (Prod does set a container-level `TZ` for
`moment()`-derived local times — that is an Azure app setting, not something the code
reads.)

---

## 5. Dev workflow

### Branch and test

```bash
git fetch origin
git checkout -b feature/<slice> origin/develop     # or fix/<thing>
```

Branch off `origin/develop`, never off a merged branch. **A merged branch is dead** —
delete it locally and cut a fresh one; don't keep committing onto it.

**One clone, one session.** Two agents in the same working tree will fight over the index.
Use `git worktree add ../carein-<slice> -b feature/<slice> origin/develop` if you need
parallel work.

```bash
# backend — no build step
cd backend && npm ci
node --check server.js         # syntax gate
node --test                    # unit tests, invoked directly (there is no npm test script)
node scripts/shard-runner.mjs  # the SAME suite, split across 4 `node --test` runs — CI runs this

# dashboard — pnpm, not npm
cd new-dashboard && pnpm install --frozen-lockfile
pnpm run check                 # tsc --noEmit  ← the script is `check`, NOT `typecheck`
pnpm run test                  # vitest run
```

There is **no lint script and no eslint dependency** anywhere in this repo.

**Why CI shards the backend suite.** Every Node 22 carries a parent-side bug in
`node --test`'s IPC reader: a per-message size decoded with a signed shift, which
surfaces as `Unable to deserialize cloned data due to invalid or unsupported
version` against an arbitrary file, with no assertion in it and a test count that
DROPS — that dropped count is how you tell it from a real failure. Upstream fixed
it in `nodejs/node#64706`, released in **v24.20.0 / v26.7.0 and in no Node 22**;
the runtime image is `node:22-alpine`, so CI stays on 22 on purpose. Sharding
means no single parent decodes the whole stream — a smaller target, **not a
fix**. `backend/scripts/shard-runner.mjs` has the whole story. `node --test`
locally is still fine and still the fastest way to run one file.

`--frozen-lockfile` matters. `new-dashboard/tests/tc-contract-bundle.test.ts` re-runs
esbuild over `backend/tc/contract.entry.ts` and **byte-compares** the result against the
committed `backend/tc/contract.gen.cjs`. Because that bundle inlines all of zod, a
floating esbuild or zod patch resolved by a plain `pnpm install` can produce a byte diff
with `shared/tc` untouched. If it goes red, regenerate with the pinned toolchain:

```bash
cd new-dashboard && pnpm exec esbuild ../backend/tc/contract.entry.ts \
  --bundle --platform=node --format=cjs \
  --alias:zod=./node_modules/zod --outfile=../backend/tc/contract.gen.cjs
```

Run it from `new-dashboard/` so the **pinned** esbuild is used — never `npx esbuild`. The
`--alias:zod` is load-bearing: without it, two zod instances land in one bundle and schema
composition silently breaks with `".extend: expected a Zod schema"`.

> This test **passes** on a clean `--frozen-lockfile` install; it is not a known-red test.
> Verified 2026-08-10 on Node 22 / pnpm 10.4.1.

### CI/CD path

`push → develop` runs `.github/workflows/staging.yml` → Azure **staging**, automatically.
`push → main` runs `prod.yml` → Azure **prod**, gated on a GitHub `production` environment
approval. Both run the same gate in this order: `pnpm run check` → `pnpm run test` →
`node --check server.js` → `node --test` → migrations against an ephemeral Postgres →
`node scripts/smoke-spine.js`.

Full pipeline detail, the environments table, and the operational gotchas are in
[DEV_PROD_WORKFLOW.md](DEV_PROD_WORKFLOW.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Conventions

- Commit messages: imperative present tense — "Add endpoint", not "Added endpoint".
- Branches: `feature/`, `fix/`, `docs/`.
- **A held PR is a draft.** If a review holds a PR for an answer, `gh pr ready --undo <n>`
  it at once and mark it ready only when the reviewer releases it. See
  [DEV_PROD_WORKFLOW.md](DEV_PROD_WORKFLOW.md) §2 — #121 merged with its gating question
  open, and only an already-merged gate kept that off a chart.
- No `any` in TypeScript — use `unknown` and narrow.
- No `SELECT *` — name columns explicitly.
- All Open Dental queries scoped by office (and by `ClinicNum` where the OD API takes one).
- No external orchestration tools (no n8n, Zapier, Cal.com).
- Never read or modify `.env`; never commit credentials.

---

## 6. Where to look next

### What you can actually read — start here, every session

**Everything a coding agent is expected to know is in this repo.** Read these
before touching the slice they cover; they are the sources of truth, and they are
reachable from the working tree with no tool but `cat`:

| Before you touch | Read |
| --- | --- |
| Anything at all | this file |
| The RCM posting machinery, the drain, the takeback, the workbench | [docs/RCM_POSTING.md](docs/RCM_POSTING.md) — including **§1a, the canon**, and **§15, the known limits** |
| Anything that approves or refuses a claim | [docs/RCM_APPROVAL_GATE.md](docs/RCM_APPROVAL_GATE.md) |
| Any dashboard screen | [new-dashboard/HANDOFF.md](new-dashboard/HANDOFF.md) |
| Branching, worktrees, the deploy pipeline | [DEV_PROD_WORKFLOW.md](DEV_PROD_WORKFLOW.md) |

**Project memory is NOT one of them.** The PM works in a desktop app with its own
memory store; that store is not in this repo, not under `.claude/`, and not
anywhere a session running here can open. It reaches a coding agent **only by
being quoted into the prompt**. So:

- A prompt that says *"read the project memory first"* is asking for something
  that cannot be done from here. Say so, and work from the docs above.
- A prompt that cites a decision by number (D-7, D-11, D-13, D-15…) without
  stating it is citing something invisible. **Ask for the text, or find it in
  `docs/RCM_POSTING.md` §1a** — never guess what a decision number means, and
  never assume a number that is not there does not exist.
- Anything ruled in a review that a later slice will need has to be **written
  into a doc in this repo** in the same PR. A ruling that lives only in the PM's
  memory is a ruling the next session will break.

### The rest



| Topic | Doc |
| --- | --- |
| Call lifecycle diagram, environments table, office model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deploy pipeline, gotchas, dev/prod folder rules | [DEV_PROD_WORKFLOW.md](DEV_PROD_WORKFLOW.md) |
| Module entitlement | [docs/MODULES.md](docs/MODULES.md) |
| Platform console, retention window precedence | [docs/PLATFORM_CONSOLE.md](docs/PLATFORM_CONSOLE.md) |
| Per-office OD proof and validation | [docs/PER_LOCATION_OD_VALIDATION.md](docs/PER_LOCATION_OD_VALIDATION.md) |
| OD cloud API contract (authoritative) | [docs/OD_API_CONTRACT.md](docs/OD_API_CONTRACT.md) |
| Mango ingestion + transcription | [docs/MANGO_TRANSCRIPTION.md](docs/MANGO_TRANSCRIPTION.md) |
| RCM approval gate + the D-11 blocking/annotating split | [docs/RCM_APPROVAL_GATE.md](docs/RCM_APPROVAL_GATE.md) |
| Audit log schema | [docs/AUDIT.md](docs/AUDIT.md) |
| Health probes, Azure Monitor alerts, reading Log Analytics | [docs/PROBES_AND_ALERTS.md](docs/PROBES_AND_ALERTS.md) |
| Secrets and Key Vault | [docs/SECRETS.md](docs/SECRETS.md) |
| TC module | [docs/TC_SCHEMA.md](docs/TC_SCHEMA.md), [docs/TC_IMPORT.md](docs/TC_IMPORT.md), [docs/TC_OD_READS.md](docs/TC_OD_READS.md) |
| RCM module | [docs/RCM_SCHEMA.md](docs/RCM_SCHEMA.md), [docs/RCM_OD_WRITES.md](docs/RCM_OD_WRITES.md), [docs/RCM_FIXTURES.md](docs/RCM_FIXTURES.md), [docs/RCM_EOB_INGESTION.md](docs/RCM_EOB_INGESTION.md) |
| Dashboard conventions | [new-dashboard/HANDOFF.md](new-dashboard/HANDOFF.md), [new-dashboard/NOTES.md](new-dashboard/NOTES.md) |

Most other root-level `*.md` files describe a DigitalOcean droplet or an on-prem PM2 box
that no longer exists. They carry a `SUPERSEDED` banner — they are kept as history, not as
instructions.

## 7. Known issues

- **Retell legacy list endpoints.** `backend/config/retell.js` still calls
  `POST /v2/list-calls` and `GET /list-phone-numbers`, which Retell deprecated on
  2026-06-15 in favor of `POST /v3/list-calls` and `GET /v2/list-phone-numbers`. The v3
  response is `{ items, pagination_key, has_more }`, not a bare array. When they are
  removed, `syncScheduler.runRetellSync` will fail **silently** (its `Array.isArray` guard
  logs a warning and returns), and `routes/calls.js` will fall back to
  `generateMockCalls()` — i.e. fake calls in the UI. Not yet migrated.
- **`ecosystem.config.js` is stale** and conflicts with the live `ecosystem.config.cjs`
  (wrong `PORT` 5000, wrong `NODE_ENV`). Use the `.cjs`.
- **`docs/MODULES.md` drift**: it still describes `/api/mango/recordings` as registered
  above the auth gate, and `/api/tc` as "future". Both are wrong; the code is right.
- **`audit.source_ref`** exists for exactly the voice→TC handoff, but the send-to-TC route
  does not populate it.
