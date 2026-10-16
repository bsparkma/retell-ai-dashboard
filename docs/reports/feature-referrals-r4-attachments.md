# Report: queue item 55, Referrals R4 (`feature/referrals-r4-attachments`)

**LANE: RED. NEEDS REVIEW. Beau merges.** Why RED:
- a storage configuration surface (`TC_BLOB_ACCOUNT_URL`, `TC_REFERRAL_BLOB_CONTAINER`, managed identity);
- a PHI disclosure path;
- new routes on three routers, and a new hygiene submit route;
- new refusal codes in the closed `HYG_VISIT_ERROR_CODES`;
- the regenerated TC and hygiene contracts.

**Migration timestamps:** none. R1's `tc_referral_attachments` table carries the metadata.

**Queue file:** `C:\Users\beau\carein cursor dashboard-dev\pm-prompts\queue\55-referrals-r4-attachments.md`
(DEV clone). Started automatically on #249's merge. This is the last slice of the 49–55 run.
**R5** (email send / OD commlog) is out of scope.

## ⚠ One infra step before this works on staging/prod
**The container does not exist yet.** It must be created in TC's storage account:
- name `tc-referrals`, or whatever `TC_REFERRAL_BLOB_CONTAINER` is set to;
- private, with no SAS;
- the app's managed identity needs **Storage Blob Data Contributor** on it.

Until then, every upload answers **503 "Attachment storage isn't set up here yet. Nothing was saved."**,
writes no metadata row, and the referral is untouched. That is fail closed, by design. I did not
touch Azure.

## What shipped
**No Open Dental Images. Nothing sends.**

### Storage: `services/tc/referralAttachmentStore.js`
It follows the `eobBlobStore` pattern:
- **Account and auth:** TC's own storage account (`TC_BLOB_ACCOUNT_URL`, already set wherever TC media works), with managed identity in Azure and `DefaultAzureCredential` on a workstation. No secrets anywhere.
- **Container:** `TC_REFERRAL_BLOB_CONTAINER`, default `tc-referrals`.
- **Missing container:** a `ContainerNotFound`/404 from the service becomes `REFERRAL_STORAGE_UNAVAILABLE`.
- **Keys** are minted server-side (`tenant/<slug>/tc/referral/<uuid>.<ext>`, via `buildBlobKey`) and never leave the server.

### Upload (`POST …/attachments`, multipart `file`)
- **Type is decided by the BYTES** (magic numbers: PNG, JPEG, WebP, GIF, PDF), never by the claimed type or filename. Anything else gets 415.
- **≤ 10 MB** (413 beyond; exactly 10 MB is allowed). **≤ 5 per referral** (409).
- **The count holds under concurrency.** The referral is row-locked before its status and count are read. On real Postgres the reviewer sent 3 uploads at once onto 4 existing files: 1 succeeded and 2 were refused.
- **Files are taken only while the referral is a draft or awaiting sign-off**, before any decision. Otherwise 409 `REFERRAL_LOCKED`.
- **Filenames are sanitized:** no path, no quotes or control characters, 150 characters at most, UTF-8 kept intact.
- **The blob is written FIRST**, then the row, in one transaction with the audit row. A storage refusal leaves no row; a failure after the blob write leaves an orphan blob (findable), never a row claiming a missing file. A refused attempt rolls back and does not touch the referral.
- **The bytes stay in memory**: never spooled to the container's disk.

### View (`GET …/attachments/:aid`): FETCH, AUDIT, SERVE
- The bytes are read first, then the **audit row is written**, then they are served. A failed audit refuses the view: 500, no bytes. A failed read audits an ERROR attempt and serves nothing.
- The response headers are:
  - `Content-Type` from **our key**, never from the row or the client;
  - `nosniff` and `inline`;
  - an RFC 6266 filename;
  - **`Cache-Control: private, no-store`**, so the browser keeps no copy, every look comes back through the route, and every look is audited.
- **The list of files is audited too.** File names can carry PHI.

### Who reaches what
| Router | Gate | Routes |
|---|---|---|
| TC `/api/tc/referrals` | tc.full | upload, list, view |
| Sign-off `/api/tc/referrals/signoff` | doctor + admin | list, view, only for referrals in or past sign-off (never a draft) |
| Hygiene `/api/hyg/visit/:aptNum` | hyg.write | upload, and **submit**, only for a referral THIS visit started; the gate runs before the body is read |

The reviewer checked cross-office access on real Postgres. View, list or upload with `office=valley`
on a roland referral, or an attachment id under the wrong referral, all return 404 with no READ row.

### The form
- **Upload zone:** drag, click to pick, or **paste**. Win+Shift+S puts the snip on the clipboard, so Ctrl+V works as well as dragging. The helper line is exactly the spec's: **"Press Win+Shift+S to snip the X-ray, then drag it here."** Images or PDF, 10 MB each, "N of 5 left". A refused file is named, with the reason; the server still decides.
- **Order: draft, then files, then submit, on every surface.** Files are taken only before a decision, and an office without sign-off approves the moment a referral is submitted.
  - **TC case / checkout:** the files upload onto the draft before the submit. A file that does not land keeps the referral a draft and says which file failed and why.
  - **Chairside:** with files, the referral is created as a draft (`?submit=false`), the snips land, then the new hygiene submit route sends it. If a file fails, the referral stays a draft with a **Send for sign-off** button beside the switcher, so it is never stranded. With no files, it is still one atomic create-and-submit.
  - **Call detail:** the same order. With no files, "Save & submit" is still one atomic request.
- **The doctor sees the files:** the sign-off detail lists them, and **View** opens each through the audited route.
- **Case referral rows** list their files with View.

## Acceptance
| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | Type, size and count limits enforced server-side | PASS | `tcReferralAttachments.test.js` (bytes beat the claimed type; 10 MB+1 → 413; exactly 10 MB → 201; the 6th → 409); real Postgres: the concurrent count limit holds |
| 2 | Not configured or missing container → honest error, no row | PASS | unconfigured → 503 with no row, no blob, no audit; missing container → 503; any other put error → 500 with no row |
| 3 | Every view audited; a failed audit refuses | PASS | two views → two READ rows; with the audit failing → 500, no bytes (unit test and real Postgres with `REVOKE INSERT ON audit_log`) |
| 4 | Cross-office fetch refused | PASS | unit test + real Postgres: valley gets 404 on view, list and upload; a mismatched attachment id gets 404; no READ row written |
| + | Sign-off off: the file arrives with the referral | PASS | `hygReferral.test.js` "sign-off OFF — the X-ray lands on the draft, THEN it is approved"; UI tests for the order and the retry |

## Vocabulary
- **New response codes:** REFERRAL_STORAGE_UNAVAILABLE, ATTACHMENT_TYPE_NOT_ALLOWED, ATTACHMENT_TOO_LARGE, ATTACHMENT_LIMIT, REFERRAL_LOCKED, ATTACHMENT_READ_FAILED, NO_TENANT. INVALID_UPLOAD already exists in fees and RCM.
- **`HYG_VISIT_ERROR_CODES`** gains every code the two new hygiene routes can return. The hygiene contract was regenerated.
- The TC client has no closed code union; it shows the server's message.
- **New audit resource type** `tc_referral_attachment`. There is no CHECK on resource types; actions and results stay within READ/CREATE and SUCCESS/ERROR.
- **New shared contract:** `TcReferralAttachment`, `REFERRAL_ATTACHMENT_HINT`, `attachmentProblem`. The TC bundle was regenerated.

## Judgment calls for Beau
1. **Files only before a decision** (draft or pending sign-off). The doctor sees everything they approve; nothing is added afterwards. The alternative, adding files to approved referrals before sending, would let a file arrive the doctor never saw.
2. **No delete** in this slice. A wrong file stays until R5 (or a follow-up) adds removal. The five-file cap leaves room.
3. **The container must be created**, as above. Until it is, uploads fail closed.
4. **An orphan blob is possible** if the database write fails after the blob landed. That beats a row claiming a file that isn't there. A reconciliation sweep can find orphans; none is built.

## Files
| File | Change |
|---|---|
| `backend/services/tc/referralAttachmentStore.js` | **new** |
| `backend/routes/tc/referralAttachments.js` | **new**: upload, list and view handlers |
| `backend/routes/tc/referrals.js`, `referralSignoff.js` | mounted |
| `backend/routes/hyg/visit.js` | chairside upload; `?submit=false`; the submit route |
| `new-dashboard/shared/tc/referrals.ts`, `shared/hyg/contract.ts` + both bundles | contract and codes |
| `client/src/features/tc/api.ts` | `tcUpload`, `tcFetchObjectUrl` |
| `client/src/features/tc/referrals/{AttachmentZone.tsx,ReferralsPanel.tsx,referralsApi.ts}` | zone, form, panel, views |
| `client/src/features/hyg/{api.ts,visit/VisitReferral.tsx}`, `pages/calls/CallReferralButton.tsx`, `pages/tc/TcReferralSignoff.tsx` | flows |
| `docs/SECRETS.md` | the two storage settings |
| tests (all **new**) | `tcReferralAttachments.test.js` (20), `hygReferral.test.js` additions (5), `referrals-r4-attachments.test.tsx` (12 + shot) |
| `docs/screenshots/tc/tccheckout-12-referral-attachments-*` | shots |

No existing test's assertions changed.

## Gates
GATES_PLACEHOLDER

## Lane / review
LANE_PLACEHOLDER

## Staging test steps (after Beau merges AND the container exists)
1. **On a test case (12827): New referral.** Snip an X-ray with Win+Shift+S, paste it into the zone, then **Save & submit**. The row shows the file. **View** opens it, and an audit row is written each time.
2. **As the doctor:** open the referral from the queue and **View** the X-ray, then approve.
3. **Chairside on a test visit:** attach a snip, then **Send for Dr. sign-off**. The file is on the referral the doctor sees.
4. **Refusals:**
   - a `.txt` renamed `.png` is refused by the server;
   - a sixth file is refused;
   - with the container deleted or renamed, an upload says storage isn't set up and nothing is saved.
