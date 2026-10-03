# Three flow fixes — the split, the door, and archive

Three things the owner asked for after working real checks:

**1. The EOB opens beside the figures, not above them.** At ≥1280px the
document takes one column at full height and the work flows down the other;
below that width it stacks, document first.

**2. Every claim offers "Fix a figure on this claim"** — a door to the confirm
screen, anchored at that claim. The confirm screen stays the one audited place
a figure is edited; the door only chooses where it opens.

**3. A check that was never queued and never posted can be archived** — off
Today, off the Checks tabs, out of every count, with its dup-hash freed so the
same file can come in again. Anything with posting history refuses by name and
points at Set aside.

Branch `feature/rcm-match-layout-archive`, off `origin/develop` at `bbe6b83`,
which carries PR #210. Six commits plus this report. **Not merged.**

---

## 1 · Side by side

### The defect

`EobViewerPanel` opened inside the carrier panel, above the table. The one
reason a biller opens the document — comparing a figure on the page with a
figure on the screen — put the two a full scroll apart.

### The fix

The `docOpen` state lifted from `CarrierPanel` to `ClaimWorkbench`, because
opening the document now changes the *page's* layout, not only the panel's.
With the document open:

- **≥1280px** (`xl:grid-cols-2`): the viewer takes the left column —
  `xl:sticky xl:top-4`, frame at `xl:h-[calc(100vh-11rem)]`, the column's full
  height — and everything a biller works flows down the right: the carrier's
  table, then the Open Dental panels. The same shape the confirm screen
  already has.
- **below 1280px** (`grid-cols-1`): stacked, document first.

One page scroll per the standing rule. The frame's own scroll is the one
internal exception a page image is allowed — the same exception the confirm
screen's sticky viewer already claims, and no `overflow-y-auto` wrapper was
added anywhere.

Closed, the workbench renders exactly the layout it had (`3fr/2fr`, carrier
left). The toggle button stays in the carrier panel's header, where the
figures it is about are.

**Screenshots:** `docs/screenshots/rcm-match-layout-archive/`
`mla-01-doc-beside-figures-1440x900-{light,dark}.png` (side by side) and
`mla-01-doc-beside-figures-1024x900-light.png` (stacked).

---

## 2 · The door to the edits

`confirmHref(batchId, claimId?)` grows an optional `?claim=` anchor. The
confirm screen reads it once, on the first load that holds the named claim:
scrolls that claim's panel into view and selects its first line so the
document panel follows. Nothing else about the screen changes — **no editing
is built outside the confirm screen**; the door is a link and nothing more.

Two places offer it, each per claim:

- **the match page / workbench** — in the carrier panel's header, beside
  "See the EOB" (`fix-figure-door`). Only when `?from=` named the check AND
  the check's `fieldConfirm.required` is true.
- **the check page** — one per claim row, in the row's action strip beside
  "Match this claim again" (`fix-figure-<claimId>`). Only when
  `r.fieldConfirm?.required`.

No door on an 835: its figures were parsed, not read, and there is no page to
fix them against. No door without `?from=` either — there is then no honest
batch id to route to.

**Screenshots:** `mla-02-door-claim-page-…png`, `mla-03-door-check-rows-…png`.

---

## 3 · Archive a test check

### The shape (owner-ruled)

Migration `1790000000000_rcm_check_archive.js`:

- `archived_at / archived_by / archived_reason` on `rcm_payment_batches` — the
  set-aside stamp shape exactly, with the same both-directions pairing CHECK
  and the same partial index. The reason is **required free text**, her own
  line, PHI-capable and therefore never copied into an audit row.
- `rcm_eob_uploads.status` CHECK widens with `'archived'`, and the partial
  unique dedupe index `rcm_eob_uploads_office_hash_unique` is rebuilt to
  exclude it alongside `'failed'`.
- `carein_app` grants re-asserted on both tables.
- The `down` refuses while any upload row holds the word — the withdraw
  migration's vocabulary rule, not the set-aside one.

### The routes

`POST /api/rcm/remittances/:id/archive` and `/:id/unarchive`, both on
**`rcm.write`** by the mount's method gate — deliberately *not* in
`QUEUE_PATHS`, because archiving re-arms a dedupe guard and is the one of
these acts that can lead to money's file being ingested twice. A `reviewer`
is refused naming `rcm.write`.

**The guard is the feature.** Inside the same transaction as the stamp, the
route reads `rcm_posting_queue` for the batch; *any* row — queued (approved),
posting, posted, failed, partially posted (the swept case), blocked, retired —
refuses with **409 `ARCHIVE_POSTING_HISTORY`**, naming the plan state(s) and
pointing at Set aside. Records that explain money are never hidden by
archive. There is no override and no force flag.

On success, in one transaction:

- the stamps are written (audited as `rcm_remittance_archive`, UPDATE, no
  free text in the trail);
- the linked EOB upload flips `extracted → archived`, freeing its hash — the
  upload probe in `routes/rcm/eob.js` now skips `archived` rows, so a
  re-upload of the same bytes is a fresh 201, not a duplicate;
- the ERA remittance key releases `posted → failed`, the state
  `reserveRemittanceKey` takes over atomically on the next upload — and only
  while the key still names this batch.

**Blobs and rows are kept everywhere. Archive is a status, never a delete,
and `audit_log` is untouched as ever.**

Unarchive clears the stamps and re-arms both guards where that is still
honest: an upload hash a *newer live upload* now holds stays with the newer
upload (flipping it back would put two live rows on one hash), and a key a
newer upload has taken over is left alone. Idempotent over a check nobody
archived.

### Off the board

- `attentionFor` short-circuits on `archived` first — before set-aside —
  returning the one observation `archived`.
- The list treats archived as **a partition, not a filter**: every view
  including `all` pages over the live rows; `view=archived` is the one home.
  `total`, `needsAttentionCount`, `parkedCount` and `setAsideCount` count
  live rows only; `archivedCount` comes back beside them.
- `GET /api/rcm/summary` stops counting archived batches, on the same
  argument as archived claims.
- The **Archived** tab joins Checks with its whole-office count; the chip and
  dot vocabularies each learn the one word, taken from the tab's own label.
- The detail still opens an archived check — the tab has to lead somewhere —
  and it wears a banner (who, when, why) with one verb: **Bring it back**.

On the check page the third quiet action sits beside Save for tomorrow and
Set aside, with its anchored dialog demanding the reason. On a check the row
can already see posting history for, the control greys itself with the short
reason and the way that fits; the server's 409 carries the full sentence
either way.

**Screenshots:** `mla-04-archive-dialog-…png`, `mla-05-archive-refused-…png`,
`mla-06-archived-banner-…png`, `mla-07-archived-tab-…png`.

---

## Constitution

- **Slugs additive.** `archived` joins the upload status CHECK, the
  observation vocabulary, `WORKLIST_FILTERS`, `WAITING_STATES` and
  `REMITTANCE_VIEWS`; nothing was renamed and no stored slug changed.
- **One primary.** The archive dialog's `Archive it` is the only
  primary-styled control it adds, inside a panel; the smoke walk's
  one-primary sweep stays green across every screen it renders.
- **Budgets pinned.** One re-pin, the allowed one: **Checks list 100 → 105**,
  paid for by the Archived tab and the footer's third way a check leaves the
  list. Every other screen stayed inside its pin — the archive control's own
  chrome was trimmed to fit (the posting-history reason is nine words; the
  server's refusal carries the long sentence).
- **Banned words.** No rendered string says batch, plan, drain, withheld,
  recoupment or read-back; the plain-language scan covers every new file and
  stays green.
- **No OD writes.** Nothing in this slice touches an Open Dental client.
  `rcmNoOdWrites.test.js` is untouched and green.
- **W-16 / D-17 / Q2 / proof block untouched.** No posting-truth, decision or
  match-interstitial surface changed; their suites run unmodified.
- **Fictional fixtures.** Every payer, patient, number and figure in tests,
  dumps and screenshots is synthetic.

## Mutation proofs

Each mutation was applied, the named suite run, and the change reverted:

| Mutation | Suite | Result |
| --- | --- | --- |
| Never-archive-posted guard inverted (`plans.rows.length > 0` → `false`) | `backend archiveCheck.test.js` | **KILLED** — all seven posting-history refusal tests fail |
| `attentionFor`'s archived short-circuit removed | `backend archiveCheck.test.js` | **KILLED** — off-the-board counts fail |
| EOB upload probe stops skipping `archived` | `backend eobRoutes.test.js` | **KILLED** — the re-upload-after-archive test fails |
| Client partition widened (`matchesFilter` archived → `true`) | `rcm-match-layout-archive.test.tsx` | **KILLED** |
| `hasPostingHistory` weakened to `false` | `rcm-match-layout-archive.test.tsx` | **KILLED** |
| Split loses `xl:grid-cols-2` | `rcm-match-layout-archive.test.tsx` | **KILLED** |

## Verification

- `node --check server.js` · backend `node --test`: **green**
  (2,886 tests; one earlier run showed the known Node 22 runner decode flake,
  re-run clean).
- `pnpm run check` (tsc, strict): **clean**.
- `pnpm run test`: **green** (2,093 passed; one unrelated nav test timed out
  once under full-suite load and passes alone and on re-run).
- New coverage: 19 backend tests (`archiveCheck.test.js`) + 1 in
  `eobRoutes.test.js`; 14 frontend tests
  (`rcm-match-layout-archive.test.tsx`); guard-suite pins updated for the
  fifth tab and the seventh chip.
- Screenshots: 9, listed above, shot from jsdom dumps under the app's built
  CSS — no backend, no PHI possible.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
