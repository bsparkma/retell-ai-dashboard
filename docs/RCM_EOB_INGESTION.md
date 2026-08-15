# RCM Slice 4 — EOB ingestion

EOB PDFs in, extraction **proposals** out.

A proposal is `rcm_claims` rows in `pending_review`, with `rcm_procedure_lines` and
`rcm_procedure_adjustments` beneath them. **Nothing in this slice touches Open Dental.**
There is no OD client in the ingestion module's require graph, and
`backend/routes/rcm/eobNoOdImports.test.js` fails if one appears. Turning an approved
proposal into a chart write is Slice 6, in a different module, behind
`assertOfficeMatch`.

This is the RCM module's **first write surface**. `rcm.write` was mounted and deliberately
unused in Slice 3 so that this POST would demand it by construction rather than by
whoever added it remembering.

---

## 1. The flow

```
browser  ── multipart PDF ──►  POST /api/rcm/eob?office=roland|valley
                                 │  auth gate → tenantContext → requireModule('rcm')
                                 │  → requireReadWrite(rcm.read, rcm.write) → requireOffice
                                 │
                                 ├─ magic-byte check (%PDF-), size floor/ceiling
                                 ├─ SHA-256 → dedup probe on (office_id, file_hash)
                                 ├─ Blob PUT under an OPAQUE uuid key
                                 ├─ INSERT rcm_eob_uploads … status 'uploaded'
                                 ├─ audit CREATE rcm_eob_upload  (fail-closed)
                                 └─ enqueue { tenantId, tenantSlug, office, uploadId }
                                                │
        eobExtractionQueue (serial, in-process) ▼
                                    eobExtractionWorker.runExtraction
                                      │
                                      ├─ LLM configured?      no → PAUSE (stays 'uploaded')
                                      ├─ daily $ cap left?    no → PAUSE (stays 'uploaded')
                                      ├─ status → 'processing'
                                      ├─ Blob GET → pdf-parse text layer
                                      ├─ budget.assertAllowed()      ← hard backstop
                                      ├─ Azure OpenAI, strict json_schema
                                      ├─ budget.charge(usage)        ← charged on return
                                      ├─ normalize + derive review reasons
                                      └─ ONE TRANSACTION:
                                           rcm_payment_batches      (1, status 'open')
                                           rcm_claims               (N, 'pending_review')
                                           rcm_procedure_lines      (per claim)
                                           rcm_procedure_adjustments (CARC/RARC)
                                           rcm_batch_claim_payments (N links)
                                           UPDATE rcm_eob_uploads → 'extracted'
```

`GET /api/rcm/eob?office=…` returns this office's uploads plus the breaker state.

### Endpoints

| Method | Path | Gate | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/rcm/eob?office=` | `rcm.write` | multipart, field name `file`, PDF only, 25 MB max |
| `GET` | `/api/rcm/eob?office=` | `rcm.read` | `?limit=` (≤200, default 50), `?offset=` |

Office comes from the validated `?office=` query param, router-wide
(`routes/rcm/index.js`). There is no body field that can change which practice a document
lands in.

### POST responses

| Status | When |
| --- | --- |
| `201` | New document stored and queued |
| `200` | These exact bytes are already on file for this office (`duplicate: true`; `requeued: true` when a stuck upload was put back on the queue) |
| `400` | `INVALID_OFFICE`, `NO_FILE`, `FILE_TOO_SMALL`, `INVALID_UPLOAD` |
| `401` | Not signed in |
| `403` | `MODULE_NOT_ENTITLED`, or `FORBIDDEN` with `action: "rcm.write"` |
| `413` | `FILE_TOO_LARGE` |
| `415` | `NOT_A_PDF` — decided on **magic bytes**, not the declared content type |
| `503` | `EOB_STORAGE_UNAVAILABLE` — no blob account configured |

---

## 2. Honest states on `rcm_eob_uploads`

The CHECK constraint allows four, and each means exactly one thing:

| `status` | Meaning |
| --- | --- |
| `uploaded` | The bytes are stored. Extraction has **not been attempted**. |
| `processing` | An attempt is in flight; money may have been spent. |
| `extracted` | Proposal rows exist. Set **inside the same transaction** as the rows it points at. |
| `failed` | We tried, on this document, and it did not work. `error_message` says why. |

**`error_message` on an `uploaded` row is not a failure.** It is the reason extraction has
not started — the daily cost cap is spent, or no LLM deployment is configured. `error_message`
is the only free-text column the Slice 1 schema gives us, so it does double duty; the UI
distinguishes the two cases by `status`, and so should you.

`extracted` never appears before its rows. The upload's flip is the last statement in the
same transaction as the batch, claims, lines, adjustments and links. A failure anywhere —
including on the flip itself — rolls all of it back and leaves the upload retryable.
`backend/services/rcm/eobExtractionWorker.test.js` injects a failure at both points and
asserts nothing survives.

### Retrying

**Re-uploading the same PDF is the retry.** There is no retry endpoint and no background
rescan, because a rescan is exactly the "background scanning" this slice is not allowed to
do. The POST dedups on `(office_id, file_hash)`:

- prior row `extracted` → returns the existing result, **spends nothing**
- prior row `processing` → returns it as-is, does **not** queue a second attempt
- prior row `uploaded` or `failed` → clears `error_message` and **re-queues**

That last case is also how a process restart recovers: the in-process queue does not
survive one, so anything left waiting is restarted by a person re-uploading it.

### The startup sweep

A restart also kills anything that was mid-attempt, and that row still says `processing` —
a claim that work is happening when the queue that owned it no longer exists. On boot,
`sweepInterruptedExtractions()` (`backend/services/rcm/eobStartupSweep.js`) marks every
`processing` row `failed` with:

> Extraction was interrupted — the server restarted while this document was processing.
> Upload it again to retry.

Nothing else is touched: an `uploaded` row waiting on the cost cap keeps its pause, an
`extracted` proposal is left alone, and an already-`failed` row keeps its own reason.

Two conditions make this safe, and both are load-bearing:

1. **It runs above `server.listen()`** — so no request served by this process can have set
   a row to `processing` yet. `eobStartupSweep.test.js` asserts that ordering against
   `server.js` source, because a mount-order constraint living only in prose is one waiting
   to be broken.
2. **`maxReplicas = 1`.** Under a second replica this sweep is actively harmful: replica B
   booting would mark replica A's genuinely in-flight extraction `failed`, and A would then
   commit a proposal against a row that says it failed. A "older than my boot" timestamp
   filter does **not** fix that — A's row was set to `processing` before B booted. The real
   fix is a lease/heartbeat on the row, and that is work to do **before** raising
   maxReplicas, not after.

It never blocks startup. An unreachable tenant database is logged and skipped — refusing to
start the app because one tenant's housekeeping failed would trade a stale row for an outage.

---

## 3. The daily cost breaker (decision D-4)

`backend/services/rcm/extractionBudget.js`. Same shape as the voice transcription rail,
for the same reasons — that rail exists because of a real cost incident.

- **Integer cents**, estimated from the response's token usage, rounded **up** to the cent.
- **$10.00/day** by default (`RCM_EXTRACTION_MAX_CENTS_PER_DAY=1000`). `0` = unlimited.
- **Local day**, `America/Chicago` by default. UTC midnight is early evening in Central, so
  a UTC-keyed counter rolls the budget mid-shift.
- **Persisted** to `rcm_extraction_budget.json` in `CALLSTORE_DIR`, so a container restart
  cannot hand back a fresh $10. This is the exact failure the transcription counter had.
- **Two gates, not one**: `check()` is the polite pre-check callers consult so they can
  pause cleanly; `assertAllowed()` is the hard backstop immediately before the spend, which
  throws even if a caller skips the first.

**The cap is a safety rail.** No code path raises it, retries around it, or splits a job to
slip under it. Changing it is an env change made deliberately by a person, with the same
do-not-raise culture as `MAX_TRANSCRIPTION_MINUTES_PER_DAY`.

**A tripped breaker never rejects an upload.** The POST still returns 201, the document is
stored, and the job is parked in the queue with a timer set for the next local midnight.
The API says so:

```jsonc
"extraction": {
  "paused": true, "usedCents": 1000, "capCents": 1000, "remainingCents": 0,
  "resetsAt": "2026-08-15T05:00:00.000Z", "timezone": "America/Chicago",
  "persisted": true, "queue": { "pending": 0, "deferred": 2, "running": false }
}
```

Because tokens are only priced after the call returns, the cap gates **starting** an
extraction, not the total. One large document can overshoot by its own cost — the same
stated property the transcription rail has, and the alternative is refusing every document
we cannot price in advance, which is all of them.

---

## 4. PHI handling

**Blob keys are opaque**: `tenant/<slug>/rcm/eob/<uuid>.pdf`. No filename, no patient name,
no claim number, and not even the office. EOB filenames routinely carry patient names, and a
key is not private — it lands in blob inventory, storage metrics, and any error string that
quotes it. `buildEobKey` takes **no** filename parameter, and `putEob` mints the key itself
rather than accepting one, so there is nothing to pass in by mistake. Pinned by
`backend/services/rcm/eobBlobStore.test.js`.

The uploaded filename **is** stored, in `rcm_eob_uploads.filename` — a PHI column in a PHI
table — because it is how the person who uploaded a document recognizes it. It never reaches
a blob path or a log line. The route logs upload ids, never filenames.

`file_key` and `file_url` are **not** in any response body. The container is private, there
are no SAS tokens, and a key in a response is a key in a browser cache.

Both the POST (CREATE) and the GET (READ) write an `audit_log` row **fail-closed** — the
list carries filenames, which makes it a PHI read. `resource_id` is the upload id we minted;
`resourceId` is null on the list read because "the office's uploads" has no single id.

Extracted document text is PHI. It exists in memory for one extraction, is never written to
disk, and is never logged — only its character count is.

---

## 5. Configuration

| Var | Default | Effect |
| --- | --- | --- |
| `RCM_BLOB_ACCOUNT_URL` | — | `https://<acct>.blob.core.windows.net`. Absent ⇒ POST 503s. |
| `RCM_BLOB_CONTAINER` | `rcm-eob` | Private container for EOB PDFs. |
| `RCM_EXTRACTION_MAX_CENTS_PER_DAY` | `1000` | The breaker. `0` = unlimited. Non-numeric falls back to 1000. |
| `RCM_EXTRACTION_BUDGET_TZ` | `America/Chicago` | Day boundary for the breaker. |
| `RCM_LLM_INPUT_CENTS_PER_MTOK` | `25` | Price estimate, cents per million input tokens. |
| `RCM_LLM_OUTPUT_CENTS_PER_MTOK` | `200` | Price estimate, cents per million output tokens. |
| `RCM_AZURE_OPENAI_DEPLOYMENT` | — | RCM-only override for `AZURE_OPENAI_DEPLOYMENT`. |
| `RCM_LLM_MAX_COMPLETION_TOKENS` | `16384` | Azure 400s a value above the deployment's window. |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_AUTH_MODE`, `AZURE_OPENAI_API_KEY` 🔒 | see CLAUDE.md | The platform's existing path, unchanged. Managed identity is the default; `api_key` is an explicit opt-in. |
| `CALLSTORE_DIR` | `<repo>/data` | Where the persisted breaker counter lives. **Prod sets `/data`.** Unset in a container = the counter resets on every deploy. |
| `OFFICE_TIMEZONE` | `America/Chicago` | Day used for `received_date` on extracted claims. |

Auth is Azure AD only — for blob and for the LLM. The platform's storage accounts have
shared-key auth disabled, so there is no connection-string path and none may be added.

There is **no** OpenAI-direct escape hatch here. `ALLOW_OPENAI_DIRECT` is honored by the
voice summarizer (a worse summary is the downside) and is deliberately ignored by this
module (invented dollar amounts in a claim is the downside).

---

## 6. What the extraction produces

One remittance (check/EFT) can pay **many** patients, so the model returns
`{ payment, confidence, claims[] }` and a single-patient EOB is the array-of-one case. Per
procedure line the model also returns **structured CARC/RARC** and a **per-line confidence**.

Review reasons land in `rcm_claims.needs_review_reasons` (a `text[]` with no CHECK):

`low_confidence`, `missing_npi`, `missing_dob`, `missing_check_number`,
`missing_subscriber_id`, `missing_payer`, `missing_claim_number`, `missing_patient_name`,
`no_procedures_extracted`, `paid_total_mismatch`, `billed_total_mismatch`,
`invalid_service_date`, `service_date_in_future`, `negative_amount`,
`batch_paid_total_mismatch`, and `uncertain_line:<N>` (1-based printed position).

**Low confidence widens review; it never resolves anything.** No branch anywhere "corrects"
a number the model was unsure about. An uncertain line is flagged and stored exactly as read.
Per-line confidences themselves live in `rcm_claims.raw_extracted_json` — `rcm_procedure_lines`
has no confidence column and its `flags` CHECK has no slot for uncertainty, so the pointer
lives on the claim and the value lives in the payload. Slice 7's review UI reads it there.

A whole-check imbalance is stamped on **every** claim in the batch, not only on the batch: a
reviewer works one claim at a time, and a flag that lives only on the batch is a flag nobody
sees.

Batches are created `'open'`, never `'ready'` — `ready` means a human has looked.

---

## 7. Known gaps

1. **Image-only PDFs do not extract.** The prompt is fed the PDF's **text layer**
   (`pdf-parse`), not the page image. A photographed or faxed EOB with no text layer fails
   honestly with `NO_EXTRACTABLE_TEXT` and a message telling the poster what to do instead.
   It is never silently routed to a vision model. See `eobDocumentText.js` for why: the
   platform's Azure OpenAI deployment is a text/JSON deployment, and the source repo's
   base64-PDF-as-`image_url` trick is not a documented Azure capability.

   **FOLLOW-UP SLICE — an OCR pre-step.** Faxed and photographed EOBs are common in dental
   offices, so this gap is real rather than theoretical. The intended shape is **Azure
   Document Intelligence** (BAA-covered under the same Azure Product Terms as Speech and
   OpenAI, and purpose-built for exactly this) as a **pre-step** that turns page images into
   text, feeding the *same* extraction engine — not a second extraction path and not a
   vision model. The seam already exists: `eobDocumentText.extractPdfText()` is the only
   place a PDF becomes a string, so OCR is a fallback inside that one function.

   **Not built now, deliberately.** It should be sized once real usage shows what fraction
   of uploads are image-only, and it carries its own cost rail question (Document
   Intelligence is priced per page, so it needs to be accounted against the same daily cap
   rather than beside it). Until then, `NO_EXTRACTABLE_TEXT` with guidance is the honest
   answer, and the *count* of that failure reason is the measurement that sizes the slice.
2. **PDF only.** The source also accepted PNG and JPEG. Those need (1), so they are out
   until it lands — at which point they become nearly free, since OCR takes an image either
   way.
3. **The queue does not survive a restart.** See §2 "Retrying" and "The startup sweep".
4. **Charging is post-hoc.** See §3.
5. **Single replica.** The startup sweep assumes `maxReplicas = 1`; raising it needs a
   lease on `processing` rows first. See §2 "The startup sweep".

---

## 8. Testing it on staging

Never a real EOB on staging before the Slice 6 era. Use a synthetic one.

### Prerequisites

- The tenant is entitled to `rcm` (Platform Console). It ships dark, so everything 403s until
  it is.
- `RCM_BLOB_ACCOUNT_URL` points at a private container the staging container app's managed
  identity can write (`Storage Blob Data Contributor`).
- `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` are set and the MI holds
  `Cognitive Services OpenAI User`.
- `CALLSTORE_DIR=/data` so the breaker counter persists.

### Make a synthetic EOB PDF

Any tool that produces a **text** PDF works — the important part is that it has a text
layer and contains no real person. A minimal generator, run from `backend/`:

```bash
node -e '
const fs = require("fs");
const lines = [
  "EXAMPLE DENTAL PLAN - EXPLANATION OF BENEFITS",
  "CHECK NUMBER: CHK-100200   CHECK DATE: 2026-08-10   EFT",
  "PATIENT: TESTPATIENT, ALPHA   DOB: 1985-03-15   SUBSCRIBER ID: SUB-0001",
  "CLAIM: CLM-2026-1001   DATE OF SERVICE: 2026-07-21   NPI: 1598324220",
  "D0120 PERIODIC ORAL EVAL   BILLED 59.00 ALLOWED 57.00 PAID 57.00  CO-45",
  "D1110 PROPHYLAXIS ADULT    BILLED 108.00 ALLOWED 106.00 PAID 106.00",
  "CLAIM TOTALS: BILLED 167.00 ALLOWED 163.00 PAID 163.00",
  "CHECK TOTAL PAID: 163.00",
];
let y = 720, content = "";
for (const l of lines) { content += `BT /F1 10 Tf 40 ${y} Td (${l}) Tj ET\n`; y -= 18; }
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
  + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n"
  + "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
  + `5 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`
  + "trailer<</Root 1 0 R>>\n";
fs.writeFileSync("synthetic-eob.pdf", Buffer.from(pdf, "latin1"));
console.log("wrote synthetic-eob.pdf");
'
```

### Upload it

> **`DASHBOARD_API_TOKEN` will NOT work here, and this is the trap the TC and Mango slices
> both hit.** `/api/rcm` sits behind `tenantContext`, which fails closed with
> **403 `TENANT_UNRESOLVED`** for any request carrying no *user* identity — and a shared
> bearer carries none (`middleware/tenantContext.js:221`). Every check below needs a real
> **SSO session cookie**. Sign in to the staging dashboard, then copy the session cookie out
> of DevTools (Application → Cookies) into `$COOKIE`.

The UI is the primary path: `/rcm` → **EOB ingestion** → the office's drop zone. To drive it
from a shell instead:

```bash
COOKIE='connect.sid=<value copied from the browser>'

curl -X POST "https://<staging-host>/api/rcm/eob?office=roland" \
  -b "$COOKIE" \
  -F "file=@synthetic-eob.pdf"
```

Test the role gate the same way, signed in as a `tc` user: the POST must 403 with
`action: "rcm.write"`, and the GET with `action: "rcm.read"`.

### Watch it

```bash
# The upload list, with the breaker state
curl -s "https://<staging-host>/api/rcm/eob?office=roland" -b "$COOKIE" | jq

# The proposal, once status reaches 'extracted'
curl -s "https://<staging-host>/api/rcm/claims?office=roland&status=pending_review" -b "$COOKIE" | jq
```

Expect, in order: `uploaded` → `processing` → `extracted`, then a claim in `pending_review`
carrying `totalPaidCents: 16300` and a `resultBatchId` on the upload.

Container logs show one line per extraction with the token count and the running spend:

```
[rcm/eob] upload <id> extracted with 1834 tokens (~1¢; $0.01 of $10.00 today)
```

### Also worth proving on staging

- **The breaker.** Set `RCM_EXTRACTION_MAX_CENTS_PER_DAY=1`, upload, and confirm the POST
  still returns 201, the row stays `uploaded` with the paused reason, and the list reports
  `paused: true` with a `resetsAt`. Then restore the cap and re-POST the same PDF to confirm
  it re-queues and extracts.
- **Dedup.** Upload the same file twice — one row, `duplicate: true`, no second spend.
- **The non-PDF refusal.** `curl -b "$COOKIE" -F "file=@something.png"` → 415 `NOT_A_PDF`.
- **Office scoping.** Upload to `valley`, then confirm `?office=roland` does not list it.
- **The startup sweep.** Point the app at an unreachable Azure OpenAI endpoint so an upload
  parks at `processing`, then `az containerapp revision restart`. After the restart that row
  must read `failed` with the "server restarted" reason — never a permanent `processing`.

---

## 9. Where the code lives

| Piece | Path |
| --- | --- |
| Routes | `backend/routes/rcm/eob.js` |
| Pure extraction engine (schema, prompt, normalization, review reasons) | `backend/services/rcm/eobExtraction.js` |
| Extraction worker (blob → LLM → rows, one transaction) | `backend/services/rcm/eobExtractionWorker.js` |
| Queue seam | `backend/services/rcm/eobExtractionQueue.js` |
| Startup sweep (interrupted → failed) | `backend/services/rcm/eobStartupSweep.js` |
| Cost breaker | `backend/services/rcm/extractionBudget.js` |
| Blob store (opaque keys) | `backend/services/rcm/eobBlobStore.js` |
| PDF text | `backend/services/rcm/eobDocumentText.js` |
| Azure OpenAI seam | `backend/services/rcm/rcmLlm.js` |
| UI | `new-dashboard/client/src/pages/rcm/EobUploadPanel.tsx` |
| API client | `new-dashboard/client/src/features/rcm/api.ts` |
| Screenshots | `docs/screenshots/rcm-eob/` |

Related: [RCM_SCHEMA.md](RCM_SCHEMA.md) (the `rcm_*` tables),
[RCM_OD_WRITES.md](RCM_OD_WRITES.md) (what Slice 6 will be allowed to do),
[MODULES.md](MODULES.md) (entitlement).
