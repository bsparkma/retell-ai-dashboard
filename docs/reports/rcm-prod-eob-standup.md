# PROD RCM stand-up — the EOB pipeline

Infrastructure, configuration, and one honesty fix. Everything additive: `maxReplicas` stays
1, the `/data` AzureFile mount untouched, no entitlement changed, posting still fail-closed.

**Written for: Beau, plus whoever reviews this PR.**

---

## 0. The thing you should read first

**RCM was not dark in prod, and prod EOB upload was broken while real people were using it.**

The inventory turned up something the plan did not account for. `GET /api/rcm/eob`, `/era`,
`/remittances` and `/posting/queue` were all answering 200/304 from `dashboard.carein.ai` —
so the `rcm` entitlement was already flipped on the prod tenant. And:

```
2026-09-30T01:00:24Z  POST /api/rcm/eob  503 117
2026-09-30T01:00:34Z  POST /api/rcm/eob  503 117
2026-09-30T01:01:51Z  POST /api/rcm/eob  503 117
2026-09-30T01:06:30Z  POST /api/rcm/eob  503 117   ← ~40 min before this session
```

117 bytes is `EOB_STORAGE_UNAVAILABLE`. Four attempts in six minutes.

The promotion checklist in `docs/RCM_EOB_INGESTION.md` §5 said to set the env vars *before*
flipping the entitlement, precisely so this could not happen. The entitlement went first.
Nothing was lost — the blob guard refuses before storing anything — but the module was live,
under real logins, with a front door that answered a bare 503.

That is also why the honesty fix in §5 of this report is a **code guard** and not another
checklist line. A checklist is exactly what did not hold here.

---

## 1. Inventory: staging vs prod, before and after

| Piece | staging | prod BEFORE | prod AFTER |
| --- | --- | --- | --- |
| Blob account | `stcareinstaging` | `stcareinprod` | unchanged |
| `rcm-eob` / `rcm-era` containers | ✅ 2026-08-17, public access None | ✅ **already existed**, 2026-08-17, public access None | unchanged — **nothing was created** |
| Container-scope RBAC | ✅ | ✅ `id-carein-prod` (SP) + `admin@carein.ai` (User) — Storage Blob Data Contributor, both containers | unchanged |
| `RCM_BLOB_ACCOUNT_URL` | ✅ set | ❌ absent → the 503s above | ✅ set |
| Document Intelligence | ✅ `docint-carein-staging` — FormRecognizer, S0, southcentralus, custom subdomain, publicNetworkAccess Enabled | ❌ **did not exist** | ✅ `docint-carein-prod`, identical shape |
| Doc Intelligence RBAC | ✅ `Cognitive Services User` → `id-carein-staging` at account scope | ❌ none | ✅ `Cognitive Services User` → `id-carein-prod` at account scope |
| `RCM_OCR_ENDPOINT` | ✅ set | ❌ absent | ✅ set |
| Key Vault secret for OCR | ❌ **none exists** | ❌ none | ❌ **none — deliberately** |
| `CALLSTORE_DIR` | `/data` | `/data` | unchanged (breaker counters persist) |
| Other `RCM_*` vars | none set (all defaults) | none set | **still none set** |

Only two things were genuinely missing in prod: the Document Intelligence resource, and the
two env vars. The blob containers and their RBAC had been in place since 2026-08-17.

### The Key Vault line in the brief was wrong, and here is the evidence

The brief asked for the endpoint/key to be stored "under the naming pattern staging uses."
There is no such pattern. `kv-carein-staging` holds 16 secrets and not one is a Document
Intelligence key:

```
azure-openai-key  azure-speech-key  control-db-url  dashboard-api-token
dashboard-session-secret  dashboard-sso-client-secret  mango-password  mango-username
opendental-customer-key  opendental-customer-key-valley  opendental-developer-key
psql-staging-admin-password  retell-api-key  staging-control-db-owner-url
staging-tenant-carein-db-owner-url  tenant-carein-db-url
```

Staging authenticates with the **managed identity** — `RCM_OCR_AUTH_MODE` defaults to
`managed_identity`, and `RCM_OCR_API_KEY` is read only when the mode is explicitly
`api_key`, which no environment sets. The endpoint is not a secret.

Minting a prod key would have created a long-lived credential where staging has none — a
weaker posture, not a matching one. **Approved and implemented as managed identity only. No
key was minted and nothing was added to `kv-carein-prod`.**

---

## 2. Every command, with its read-back

Subscription pinned on every call: `Azure subscription 1`. (Its id, and the prod
identity's principalId, are deliberately not written out here — resource identifiers
belong in the environment, not in a committed report. Read them with
`az account list` and `az identity show -n id-carein-prod -g rg-carein-prod --query principalId`.)

**Pre-flight.** `gh run list --workflow=prod.yml` — latest `prod-cd` completed **success**
at 20:21Z + 13m32s. No deploy in flight.

### 2a. The resource

```bash
az cognitiveservices account create --subscription "Azure subscription 1" \
  -n docint-carein-prod -g rg-carein-prod \
  --kind FormRecognizer --sku S0 --location southcentralus \
  --custom-domain docint-carein-prod --yes
```

Created `2026-09-30T01:22:44Z`. Read back side by side with staging — **identical**:

| | `docint-carein-prod` | `docint-carein-staging` |
| --- | --- | --- |
| kind | FormRecognizer | FormRecognizer |
| sku | S0 | S0 |
| location | southcentralus | southcentralus |
| customSubDomainName | docint-carein-prod | docint-carein-staging |
| publicNetworkAccess | Enabled | Enabled |
| disableLocalAuth | unset | unset |
| provisioningState | Succeeded | Succeeded |

### 2b. RBAC

```bash
# $PID is id-carein-prod's principalId, read with:
#   az identity show -n id-carein-prod -g rg-carein-prod --query principalId -o tsv
MSYS_NO_PATHCONV=1 az role assignment create --subscription "Azure subscription 1" \
  --assignee-object-id "$PID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services User" \
  --scope ".../resourceGroups/rg-carein-prod/providers/Microsoft.CognitiveServices/accounts/docint-carein-prod"
```

`MSYS_NO_PATHCONV=1` because Git Bash rewrites a leading `/subscriptions/...` into a Windows
path and `az` then fails with `MissingSubscription`, which reads like a login problem.

Read back — one assignment, matching staging's shape exactly:

```
<id-carein-prod principalId>   ServicePrincipal   Cognitive Services User
```

That is `id-carein-prod`'s **principalId**, read explicitly — not its clientId; `az identity list -o table` shows the clientId in the column people reach for,
and an assignment made against it would be silently useless.

### 2c. Both env vars, one call, one restart

```bash
az containerapp update --subscription "Azure subscription 1" \
  -n ca-carein-prod-backend -g rg-carein-prod \
  --set-env-vars RCM_BLOB_ACCOUNT_URL=https://stcareinprod.blob.core.windows.net \
                 RCM_OCR_ENDPOINT=https://docint-carein-prod.cognitiveservices.azure.com
```

One call rather than two, because each `--set-env-vars` restarts the backend and prod has
known readiness-probe flakiness at `maxReplicas=1`.

| | before | after |
| --- | --- | --- |
| revision | `--0000048` | `--0000049` |
| env count | 29 | **31** (exactly +2) |
| image | `carein-backend:a83039e` | `carein-backend:a83039e` ✅ unchanged |
| `CALLSTORE_DIR` | `/data` | `/data` ✅ |
| volume / mount | `callstore-vol` → `/data` (AzureFile) | identical ✅ |
| minReplicas / maxReplicas | 1 / 1 | 1 / 1 ✅ |

Revision `--0000049`: `healthState: Healthy`, `runningState: RunningAtMaxScale`, 1 replica.
`GET https://dashboard.carein.ai/api/health` → **200**.

Startup log for the new revision is clean — secrets loaded from `kv-carein-prod`, OD health
`roland=up valley=up`, call store loaded (6914 calls), `[callstore] persist ok`. No blob
error, no OCR complaint. Worth noting: the container **refuses to start** if
`RCM_OCR_UNUSABLE_CONFIDENCE > RCM_OCR_MIN_CONFIDENCE`, so a clean boot also proves the
threshold invariant holds at defaults.

---

## 3. Migrations: all applied, nothing run

**I did not run the migrate job.** It had already run today.

`caj-carein-prod-migrate` execution `x22fc2q`, **2026-09-29T20:33:52Z**, on image
`carein-backend:prod`:

```
[migrate-prod] control-plane migrations (carein_owner)…
No migrations to run!
[migrate] up complete
[migrate-prod] tenant migrations: carein (carein_owner)…
[migrate-tenant] using explicit DB URL override for 'carein'
No migrations to run!
[migrate-tenant] up complete for 1 tenant(s)
[migrate-prod] all migrations complete.
```

`origin/main` (= `a83039e` = the prod image tag) and `origin/develop` both carry the same
**30** tenant migrations, including all 16 `rcm_*` ones from `1786622400000_rcm_schema`
through `1787900000000_rcm_shadow_comparison`, plus the newest
`1789300000000_fees_post_requested_by`. node-pg-migrate compares the files on disk against
`pgmigrations` and found nothing unapplied, in order, on both planes.

**Stated precisely so it is not over-read:** "No migrations to run!" proves the applied set
is complete *relative to the image's migration files*. It does not enumerate names. Getting
the enumerated list would need a container exec and a `pgmigrations` SELECT, which I could
not complete — see §6.

---

## 4. The caps and the dup-hash pre-check

### There are TWO rails, and the brief merged them

| Rail | Var | Default | Prod setting |
| --- | --- | --- | --- |
| **OCR pages** | `RCM_OCR_MAX_CENTS_PER_DAY` | **200 = $2.00/day** | unset → $2.00/day |
| **LLM extraction** | `RCM_EXTRACTION_MAX_CENTS_PER_DAY` | **1000 = $10.00/day** | unset → $10.00/day |

The **$10/day is the LLM rail**. The OCR rail is **$2/day**. Separate caps, separate clocks,
separate persisted docs, separate error codes (`ocrBudget.js` vs `extractionBudget.js`). The
OCR rail can refuse *before* spending, because page counts are knowable up front; the token
rail cannot.

**Neither was raised and no threshold var was set at all** — every default is the intended
production value. `CALLSTORE_DIR=/data` on prod means both counters are persisted to the
AzureFile volume, so a deploy cannot hand back a fresh budget.

### Dup-hash pre-check — live in the prod image

`backend/routes/rcm/eob.js`: SHA-256 of the bytes, then

```sql
SELECT … FROM rcm_eob_uploads WHERE office_id = $1 AND file_hash = $2 ORDER BY uploaded_at DESC LIMIT 1
```

**before any spend.** An already-extracted document returns `200 { duplicate: true }` with
the existing result. Index `rcm_eob_uploads_office_hash_idx` on `(office_id, file_hash)` —
non-unique by design, since a deliberate re-upload is legitimate; the race is closed
separately by the partial unique index `rcm_eob_uploads_office_hash_unique`.

---

## 5. Posting-safety state (the added gate) — every prod office is in shadow mode

Read from the **running app** on revision `--0000049`, through the same
`postingGate.readOfficeSettings` the drain itself calls:

```
CEILING=["roland"]
ROWS=["roland","valley"]
OFFICE roland={"drainEnabled":false,"updatedAt":null,"updatedBy":null,
                "writeoffMode":"writeoff_field","writeoffAdjTypeName":null,"rowMissing":false}
OFFICE valley={"drainEnabled":false,"updatedAt":null,"updatedBy":null,
                "writeoffMode":"writeoff_field","writeoffAdjTypeName":null,"rowMissing":false}
MODULES=["fees","hyg","rcm","tc","voice"]
```

- `OFFICES_ENABLED_FOR_POSTING` in the prod image is `Object.freeze(['roland'])`
  (`backend/services/rcm/postingDrain.js:380`). Roland clears the code ceiling; valley does
  not.
- **`drain_enabled` is `false` for both offices.** `drain_updated_at` and `drain_updated_by`
  are null — seeded rows nobody has ever flipped.
- `rowMissing: false` for both, so the migration reached the database and a missing row is
  not what is producing the `false`.

A chart write needs **both** conditions (`services/rcm/postingGate.js`). Valley fails both;
roland fails the operator switch. **No prod office can post to Open Dental.** Gate passed.

`MODULES` also confirms `rcm` is entitled — and `tc`, which `CLAUDE.md` still describes as
shipping dark. That is a separate doc-drift item, out of scope here.

---

## 6. The honesty fix

### What was actually wrong

The blob half was **already honest**: `blobStore.isConfigured()` is checked before anything
is stored, and it 503s. Nothing was ever accepted into nothing there.

The **OCR half** was the real gap. With `RCM_OCR_ENDPOINT` absent, a scan was accepted,
stored in the blob container, given a row, queued — and only then failed with
`no_extractable_text`, rendered as *"This PDF has no text layer — most likely a scan."*

Every word of that is true and the whole of it is misleading. It describes the biller's
**file** when the fact is about the **deployment**. She goes back to the scanner, scans the
page again, and it fails again, because nothing was ever wrong with the paper.

And the panel showed *"Scan-reading (OCR) spend today: $0.00 of $2.00"* for a rail that could
not run — which reads as "scans work, nobody has used them."

### The diff

**`backend/services/rcm/eobDocumentText.js`** — extracted `readTextLayer` (the pdf-parse +
worker-release dance) and `textLayerIsUsable` (the `meaningfulTextLength >= MIN_DOCUMENT_CHARS`
floor), then added `hasUsableTextLayer(buffer)`. **One predicate, two callers**: the route's
refusal and the worker's escalation cannot drift, because drift would either refuse a
document the worker could read or accept one it could not.

**`backend/services/rcm/documentOcr.js`** — split the transport into `analyzeRemote` so
reachability is recorded in exactly one place, and added `lastOutcome()`. `reachable` is
`true` only after a call came back, `false` only after one failed, and `null` until either
has happened since boot. Only **transport** outcomes move it: `OCR_ANALYZE_FAILED` (a 4xx
that is not 401/403) means Azure answered and rejected *that document*, so it leaves
`reachable` true. The local guards are outside the try block — the empty-buffer guard raises
`OCR_CALL_FAILED`, and filing that as an outage would have a zero-byte upload tell an
operator the network was down.

**`backend/routes/rcm/eob.js`** — the refusal, plus `ocrStatus()` feeding `configured` /
`reachable` / `lastOutcomeCode` into all four wire sites:

```js
if (!documentOcr.isConfigured()) {
  let needsOcr = false;
  try { needsOcr = !(await hasUsableTextLayer(file.buffer)); }
  catch { needsOcr = false; }          // unopenable — not a claim about OCR
  if (needsOcr) return res.status(503).json({
    success: false, error: OCR_UNAVAILABLE_MESSAGE,
    code: 'EOB_OCR_UNAVAILABLE', ocr: ocrStatus(),
  });
}
```

Three properties, each deliberate:

- **The parse is INSIDE the `isConfigured()` guard, not beside it.** In every armed
  environment — staging, and prod as of today — this costs exactly nothing, because we never
  need to know whether the document is a scan. It only runs in the one configuration where
  the answer changes what we do.
- **After the dedup probe.** A document already extracted in this office was read by
  something, and handing back the proposal we hold is not a claim about OCR.
- **A PDF that will not OPEN is not this refusal's business.** `PDF_UNREADABLE` falls through
  to the worker, which gives it the accurate reason. Answering a corrupt file with "reading
  isn't set up here yet" would commit the very error this guard exists to undo, with the
  blame merely pointed the other way. **This one came out of mutation testing** — my first
  version failed closed on a parse error, one mutation survived, and fixing the guard rather
  than the test was the right call.

**Frontend** — `OCR_NOT_CONFIGURED` + `OCR_NOT_CONFIGURED_DETAIL` in
`features/rcm/labels.ts`; `configured` / `reachable` / `lastOutcomeCode` on
`EobExtractionState` in `features/rcm/api.ts`; a banner in `EobUploadPanel.tsx` above the two
paused banners; and the OCR spend line now suppressed when `configured === false`.

> **Scanned document reading isn't set up here yet.** PDFs that carry their own text still
> read normally. A scan or a photo will be turned away until someone switches this on.

Deliberately **not amber**. The paused banners mean "waiting on a clock" and resolve
themselves; this means "a switch is missing here" and will look identical tomorrow. And the
lane **stays open** — text-layer PDFs (most payer-portal exports) extract fine with no
reader, so disabling the input would take away work she can do today.

`ocr?.configured === false`, never `!ocr?.configured`: the field is optional so a dashboard
can talk to a server that predates it, and `undefined` means "this server does not say."
Rendering a missing field as a missing resource would put the banner on every healthy
deployment. There is a test for exactly that.

### Mutation-proven

Backend — `node --test routes/rcm/eobRoutes.test.js`, 27 tests. Every mutation must turn the
suite red:

| Mutation | Result |
| --- | --- |
| guard removed entirely (always accept) | ✅ caught |
| `isConfigured` check inverted | ✅ caught (11 tests) |
| every document reported readable | ✅ caught |
| unopenable PDF refused as a config problem | ✅ caught |
| copy blames the document instead of the environment | ✅ caught |
| refusal state omitted from the response | ✅ caught |

Frontend — `tests/rcm-eob.test.tsx`, 27 tests:

| Mutation | Result |
| --- | --- |
| banner never rendered | ✅ caught |
| `undefined` treated as "no reader" (falsy check) | ✅ caught |
| cap printed for a rail that cannot run | ✅ caught |
| copy reverts to blaming the file | ✅ caught |

**Nothing uncaught, nothing skipped.** Baseline green before and after each run.

New backend tests pin: a scan refused with nothing stored, no row, no job, **no audit row**;
a text-layer PDF still accepted with OCR off; a scan accepted when OCR *is* configured (the
guard is inert in every armed environment); an unopenable PDF not blamed on the deployment;
and `GET` reporting `configured` separately from `paused`, with `reachable: null` until
proven.

### Doc correction

`docs/RCM_EOB_INGESTION.md` §5: the stale "RCM ships dark" premise is replaced with what
actually happened, including the out-of-order entitlement flip and the four 503s. The
provisioning tables now show prod as armed, the promotion checklist is closed with all four
items ticked and the real command sequence, and the managed-identity-not-Key-Vault decision
is recorded. The `EOB_OCR_UNAVAILABLE` refusal is documented in the POST response table and
in a new §10 "Refused at the front door". The §8 prerequisite line that said the module
"ships dark" now says what keeps prod safe is the shadow gate, not the module gate.

---

## 7. Test gates

| Gate | Result |
| --- | --- |
| `pnpm run check` (tsc --noEmit) | ✅ clean |
| `pnpm run test` (vitest) | ✅ **1983 passed**, 126 skipped, 0 failed |
| `node --check server.js` | ✅ |
| `node scripts/shard-runner.mjs` (what CI runs) | ✅ **2726 tests, 2723 pass, 0 fail**, 3 skipped, 4/4 shards green |

Two notes, both pre-existing and worth recording:

- A bare `node --test` intermittently reports one spurious failure with a varying test count
  (2710 vs 2726 across runs). That is the known Node 22 test-runner IPC decode bug
  (`nodejs/node#64061`, fixed in v24.20/v26.7, never backported to 22). CI shards for this
  reason and the sharded run is green.
- `tc-contract-bundle` and `hyg-contract-bundle` went red when the worktree's
  `node_modules` was junctioned from the DEV clone — the floating-esbuild byte-diff hazard
  `CLAUDE.md` documents. A clean `pnpm install --frozen-lockfile` fixed both with no source
  change.

---

## 8. Validation — partially blocked, and here is exactly where

**What is proven.** The resource exists with staging's shape. The role assignment exists,
scoped to that account, against the correct principalId. Both env vars are on revision
`--0000049`, which booted clean and is Healthy. Nothing else on the app moved. Posting is
fail-closed for every office. The honesty fix is tested and mutation-proven.

**What is NOT proven: one live OCR round-trip through the prod managed identity.** I could
not complete it, for two independent reasons:

1. **The upload endpoint cannot be reached without a signed-in human.** `tenantContext`
   fails closed at `403 TENANT_UNRESOLVED` for any request with no user identity, and the
   shared `DASHBOARD_API_TOKEN` carries none — `backend/middleware/tenantContext.js:221`,
   and `config/permissions.js:289` says so in as many words. There is no header or env
   override. Only an Entra SSO session reaches `/api/rcm/eob`. I have no credential for one,
   and I will not forge a session cookie to manufacture an actor identity in an audit trail.
2. **In-container exec was blocked.** Writing the synthetic PDF into the prod container was
   refused by this environment's permission layer (`[Remote Shell Writes]`). That was my
   fallback for exercising `documentOcr.analyze` directly against the new resource.

So the last mile is yours, and it is about two minutes.

### The synthetic document is ready

`SYNTHETIC-eob-standup.pdf` — 1,048 bytes, generated for this slice, filename prefixed
`SYNTHETIC-` per your instruction so no biller works it as real. Entirely fictional: payer
"MERIDIAN MUTUAL DENTAL (FICTIONAL PAYER)", subscriber "SYNTHETIC, PATIENT A", member id
`SYN000000001`, claim `SYNCLM0001`, check `SYN-000123`, $184.00 across D0120/D1110/D0274.
Page one is headed **"SYNTHETIC TEST DOCUMENT - NOT A REAL REMITTANCE"**. No real patient,
provider, payer or claim number appears in it.

It is in this session's scratchpad, not committed — I did not want a PDF in the repo that
someone could later mistake for a fixture. Say the word and I will commit it under
`backend/test/fixtures/rcm/eob/` beside the existing three.

### What to do

1. Sign in to `https://dashboard.carein.ai/rcm` and upload the synthetic PDF for **roland**.
2. It should land `Waiting` → `Extracting` → `Proposal ready`, and the check should appear on
   Today / Checks. This document has a text layer, so it will read via pdf-parse and spend
   **nothing** on OCR — which validates the blob half end to end.
3. To validate OCR specifically, upload `Test_EOB_Scanned.pdf` from
   `backend/test/fixtures/rcm/eob/` (image-only, already synthetic). That forces the OCR
   pre-step, spends ~1 page ≈ **$0.0015**, and the row's provenance should read
   **"Read by OCR (1 page, NN% confidence)"**. On staging this fixture returned 1 page, 77
   words, 0.9909 mean confidence in ~2.3s.

**Screenshots: I have none, and I would rather say so than hand you something I rendered
locally and captioned as prod.** The dashboard is behind Entra SSO and I cannot authenticate
as you. If you upload and paste a screenshot into this PR, that is the arrival evidence.

### Setting it aside afterwards

The upload row is a proposal in `pending_review` — **it cannot reach Open Dental**, because
roland's `drain_enabled` is `false` and valley is not in the code ceiling either. So it is
already inert. To close it out properly, use **Set aside → sent in error** on the check with
the note *"Synthetic document from the 2026-09-29 prod EOB stand-up — not a real
remittance."* That parks it in the set-aside view, out of the working queues, with a reason
attached, and leaves the audit trail intact. Where it rests: `rcm_claims` in the set-aside
state, its `rcm_eob_uploads` row `extracted`, and the PDF in `stcareinprod/rcm-eob` under an
opaque uuid key.

### Staging re-verified

No shared config was changed — the two env vars are prod-only and `docint-carein-prod` is a
separate resource — but I checked anyway. `ca-carein-backend` revision `--0000201`,
`healthState: Healthy`, `RunningAtMaxScale`, image `carein-backend:4fedf49`, env count 31,
`RCM_BLOB_ACCOUNT_URL` and `RCM_OCR_ENDPOINT` both intact, `minReplicas`/`maxReplicas` 1/1.
`docint-carein-staging` still carries exactly one role assignment, to its own managed
identity. Untouched.

---

## 9. Monthly cost of the new resources

Verified against the Azure retail price API for `southcentralus` during this session — the
pricing *web page* renders `$-` placeholders and is useless.

| Item | Cost |
| --- | --- |
| Document Intelligence S0 — fixed monthly fee | **none.** Consumption only. |
| `S0 Read Pages` (`prebuilt-read`) | **$1.50 per 1,000 pages** (tier 0; a $0.60/1K tier begins past 1M pages, irrelevant here) |
| Blob storage | containers already existed; EOB PDFs are small — **< $0.50/month** |
| Key Vault | nothing added — **$0** |

`$1.50/1,000` is exactly what `RCM_OCR_CENTS_PER_KPAGE=150` encodes, so the breaker's
arithmetic matches the real list price.

- **Hard ceiling: ~$60/month**, set by the $2.00/day OCR cap, and the cap refuses *before*
  spending because page counts are knowable up front.
- **Realistic: well under $1/month.** A few hundred scanned pages a month at practice volume.
- **Net new expected: under $1/month.**

For scale: `prebuilt-layout` would be **$10.00/1,000 pages** — 6.7× — and returns structure
the extraction prompt does not consume. `RCM_OCR_MODEL` is unset and should stay unset;
changing it *requires* changing `RCM_OCR_CENTS_PER_KPAGE` to match or the breaker
under-counts by that factor.

---

## 10. Open items

1. **The live OCR round-trip** — §8. Yours, ~2 minutes.
2. **`OFFICES_ENABLED_FOR_POSTING` vs the entitlement order.** The entitlement went in
   before the config this time. Worth deciding whether the platform console should refuse to
   flip a module whose required env vars are absent — that would have caught this before the
   first 503, and it is a real slice rather than a doc line.
3. **`CLAUDE.md` says `/api/tc` "ships dark, no tenant is entitled yet".** `MODULES` on prod
   reads `["fees","hyg","rcm","tc","voice"]`. Stale, not touched here.
4. **The fractional-cap bug is still open.** Both rails `Math.trunc` the cap env, so
   `RCM_OCR_MAX_CENTS_PER_DAY=0.5` becomes `0` = **unlimited**. Known, flagged, unfixed —
   `ocrBudget` and `extractionBudget` should be fixed together. No env sets a fractional
   value today.

No secrets, endpoints-with-keys, or real patient data appear anywhere in this report.
