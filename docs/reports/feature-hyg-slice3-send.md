# Hyg H1 Slice 3 — the Send

Branch `feature/hyg-slice3-send`.

**⚠️ BASED ON `feature/hyg-slice2-visit`, NOT ON `develop`.** Slice 2 (PR #147)
is not merged yet, and this slice is unbuildable without its tables, its
contract bundle and its staged-write state machine. The brief anticipated this:
*"if it is not merged yet, branch off it and say so in your report — the PM will
retarget."* The PR is open against `feature/hyg-slice2-visit` so the diff shows
only slice 3's work; **retarget it to `develop` once #147 lands.**

The module is still DARK. No tenant is entitled and no office's pilot switch is
on, so nothing here can reach a real chart until Beau flips both.

---

## Acceptance criteria

| # | | Evidence |
| --- | --- | --- |
| 1 | Exactly one file can write; the allow-list names it; the guard still fails if a second one does | `hygNoOdWrites.test.js` — three tests, quoted below |
| 2 | No write without a server-side re-validation that records the approving user | `hygSend.test.js` "the note lands…" asserts `sent_by`; `sendUnits.test.js` "a payload from an older build is refused" |
| 3 | Preview === sent, proven by mutating the payload between preview and confirm | `hygSend.test.js` — "THE PREVIEW IS THE WRITE: a payload that changed refuses the whole send" |
| 4 | A failed write leaves `Failed` with a reason, never `Written`; per-write state | "a note Open Dental accepts but cannot show back is Failed" + "partial success" |
| 5 | DocCategory by name per office, always sent; two offices → two DefNums; nothing hardcoded | "two offices resolve the SAME category name to DIFFERENT DefNums" |
| 6 | GroupNote unsigned with a typed name block; nothing claims a signature | payload assertion on `isSigned:false` + `/(?<!un)\bsigned\b/i` over the whole page |
| 7 | No procedure logs → honest refusal, not a fabricated attachment | "an appointment with no procedures refuses honestly" — and **zero writes** |
| 8 | Office asserted before every write; a mismatched handle refused | `resolveAppointment` runs `assertOfficeMatch` and now runs FIRST; "the office is asserted before any write" |
| 9 | `tsc --noEmit` clean, no `any`; green on 4 shards | below |

### 1 — the one-file allow-list, diffed

```js
+/**
+ * THE ALLOW-LIST. One file, and this constant is the whole of it.
+ */
+const OD_WRITE_LAYER = Object.freeze(['odWriter.js']);

-test('no hyg source names the Open Dental WRITE transport', () => {
+test('only the one allow-listed file names the Open Dental WRITE transport', () => {
   …
+    if (OD_WRITE_LAYER.includes(path.basename(file))) continue;
     if (/apiWriteRaw/.test(src)) offenders.push(path.basename(file));
```

Two tests were ADDED beside it rather than the list being trusted on its own:

- **"the allow-listed writer is REAL, and it is the only thing that can write"**
  — the named file must exist, must actually call `apiWriteRaw`, and must be the
  only place `/procedurelogs/GroupNote` and `/documents/Upload` appear in code.
  A POST assembled in `sendVisit.js` and passed down as a string would pass the
  grep above and fails this.
- **"the guard would FAIL if a second file learned to write"** — drives the same
  filter over a synthetic two-writer list, so a future refactor that widened the
  list to a directory cannot pass by having nothing to find.

Everything else in that file is unchanged: the behavioural statements, the
refusal-path statement, and slice 2's mutation allow-list. **The send route is in
`routes/hyg/visit.js`**, not a sibling — the mutation allow-list still names one
file, and a send is a mutation on a visit.

### 9 — gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2328 tests · 2325 pass · 0 fail · 3 skipped** (slice 2: 2300)
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1340 passed, 82 skipped, 0 failed** (slice 2: 1333)

---

## Verified against a real Postgres 16

`backend/scripts/rehearse-hyg-visit.js` grew slice 3's constraint, and running it
**caught a real defect in its own older step**: the pre-existing "a Written row
cannot be re-staged" check set `state='Written'` without a reference, which the
new CHECK correctly refuses. That is the constraint doing its job on the first
row it ever saw.

```
PASS  a Failed staged write with no reason is refused  — hyg_staged_write_failed_reason_check
PASS  half an attribution (sent_by with no sent_at) is refused  — hyg_staged_write_sent_pair_check
PASS  a Written row cannot be re-staged
PASS  a Written row with no reference is refused  — hyg_staged_write_written_ref_check
PASS  a reference on a row that was never Written is refused  — hyg_staged_write_written_ref_check
PASS  a Written row carries the reference the send recorded
PASS  deleting a visit cascades to its items and staged writes

[rehearse-hyg-visit] 23/23 checks passed
```

Connected as `carein_app`, the least-privilege role. The new column is additive,
so it inherits the table's grants and needs no GRANT block — stated in the
migration.

---

## The three writes

### The note → `POST /procedurelogs/GroupNote`

`GET /procedurelogs?AptNum=` for the ProcNums, then the GroupNote, then the same
read again — the note text must be there. **A 200 is not the claim.**

`isSigned: false` is sent explicitly, and the note carries the typed name block
the composer built: *"Entered in CareIN by hygienist@carein.ai. Unsigned."*
`ProvNum` is the appointment's hygiene provider when it has one and is OMITTED
when it does not, because a note attributed to provider zero is worse than one
attributed to nobody.

**No procedures → an honest refusal**, and not one write attempted. Creating a
procedure so a note has somewhere to live would be this module inventing clinical
data to satisfy its own workflow.

### The slip → `POST /documents/Upload`

DocCategory resolved by name from `/definitions?Category=18`, per office, every
time, and ALWAYS sent. Overridable with `HYG_SLIP_DOC_CATEGORY_<OFFICE>`; an
office with no category of that name gets a refusal that names the fix.

**The PDF is hand-rolled** (`services/hyg/slipPdf.js`, ~100 lines, no
dependency). Two reasons: this repo has no PDF writer and adding one puts a new
package on the path that files documents into a chart; and a hand-rolled one is
DETERMINISTIC — no timestamp, no `/Info`, no `/ID` — which is what makes "the
preview is the write" true of the bytes and not only of the text. A test parses
the output with `pdf-parse` (the library RCM's OCR rail already uses, so this is
not the module marking its own homework) and asserts the preview lines are in it.

### The treatment → TC's own `POST /api/tc/hygiene-intakes`

**The contract fit; nothing was reshaped.** That route already exists and is
already called the hygiene → TC handoff: it opens a case at `hygiene_review`,
stamps `submitted_by` from the session, and is gated `tc.hygiene`, which the
hygiene role holds. Transport is a loopback call forwarding the caller's own
credential, exactly like `services/tcCaseClient.js` — no service credential, so
TC applies its own guards.

**The mappings are lossy, and the losses are in one file with their reasons**
(`tcHandoffClient.js`): `Perio → quadrant` (TC has no perio category), Stage III
and IV both → `advanced_perio` (TC's scale has no fourth step), `Restorative`
and `Other` → `single_tooth` (TC's own default for unclassified work). A test
asserts every handoff category and every perio stage maps to a value TC's enum
actually has — a mapping outside it would be a 400 from TC *after* the hygienist
pressed the button, with the patient gone.

**One thing to know:** `/hygiene-intakes` has no idempotency key (unlike the
voice handoff's `source_call_id` unique index). What stops a double-send here is
the staged-write state machine — a `Written` row cannot be re-sent. That holds
within this app, not against a second caller, and it is worth knowing before
anyone adds a retry loop above it. Flagged rather than fixed, because fixing it
means changing TC.

---

## Decisions worth flagging

**1. The office gate now runs BEFORE the visit lookup on the send path.** A
valley request for a roland visit used to answer `VISIT_NOT_FOUND`; it now
answers `OFFICE_NOT_READY` with its reason. Both are true, and the second is the
one an operator can act on — an office CareIN is not talking to should hear that,
not "no such visit". Found by a test I wrote expecting the other answer.

**2. Failure of the whole batch on a stale preview, not of one item.** The brief
asked that a mutated payload be refused. It refuses everything, before any write,
because a send that half-honours a stale preview is worse than one that does not
start.

**3. 200 when every write failed.** The REQUEST succeeded: it did what it was
asked and reports what happened, per write. A 500 would say "we do not know what
happened" over a body full of outcomes.

**4. `written_ref` needed a migration.** Slice 2 recorded whether and by whom;
this records WHERE — `Document 4711 in Routers`. The difference is whether the
record can be followed three weeks later.

**5. Retry re-sends the same words.** A retry that re-composed would send
something she never read, which is the rule this slice is built around.

---

## Screenshots

`docs/screenshots/hyg/hyg-send-*`, light and dark, at the iPad's 1180 width.

| | Frame | |
| --- | --- | --- |
| `01-confirm` | 1180×1200 | the confirmation, showing the EXACT lines and naming the patient |
| `02-written` | 1180×1200 | both landed, each saying where and who sent it |
| `03-partial` | 1180×1200 | **the one that matters** — the note Written in green with its GroupNote reference, the slip Failed in red with an actionable reason and a Retry, and no aggregate verdict anywhere |
| `04-not-ready` | 1180×820 | the office is not switched on |

The shooter grew one line of CSS that freezes entry animations: a Radix dialog
opens from `opacity: 0` and headless Chrome photographed it mid-keyframe.

---

## Staging validation plan

The module is dark, so this is what to do the first time it is switched on. **Do
it on STAGING, and use a designated test patient only.**

**Patient: roland `12828` (`Test, MangoTest`).** Chosen over 12827 because it is
the TC test patient too, so the handoff lands somewhere expected; 12827 is the
fallback if 12828 has no appointment that day. **Never a real patient.**

**Before:**
1. Platform → Practices → turn `hyg` on; Platform → Hygiene → turn Roland on.
2. Confirm `OPENDENTAL_WRITE_DISABLED` is **not** `true` on staging, or every
   write returns `OD_WRITE_DISABLED` and the walk proves nothing.
3. In Open Dental, confirm the appointment for 12828 **has at least one
   procedure** — otherwise the note refuses honestly, which is a valid result
   but not the one being tested.
4. Confirm Roland has an image category named **Routers** (Setup → Definitions →
   Image Categories). If it is named something else, set
   `HYG_SLIP_DOC_CATEGORY_ROLAND`.

**The walk:**
1. Open `/hyg/day`, tap 12828's card, add one treatment item (a Crown on #3).
2. Stage the note, the slip and the handoff. Read the tray.
3. Press Send, read the confirmation, confirm.

**What to look for in Open Dental afterwards:**

| | Where | Expect |
| --- | --- | --- |
| the note | the appointment's procedures → Note | the slip text, ending *"Entered in CareIN by &lt;you&gt;. Unsigned."*, and **no signature** on the procedure |
| the slip | the patient's Images → **Routers** | a PDF named `Routing slip — <date>`, opening to the same lines the confirmation showed |
| the handoff | TC → hygiene inbox | one case at `hygiene_review` for MangoTest, submitted by you |

**Telling a partial send from a clean one:** the screen is the answer — every
row carries its own state, and a clean send is three green rows each naming
where it landed. Do not read the absence of an error as success. Cross-check
with `[hygsend] office=roland apt=… written=3 failed=0` in the container log,
which is one line per send.

**If something failed:** the row says why and offers Retry, which re-sends the
same words. `DOC_CATEGORY_NOT_FOUND` means the category name; `NO_PROCEDURES`
means the appointment; `NOTE_UNCONFIRMED` means Open Dental accepted the note
and did not show it back — check the chart by hand before retrying that one, in
case it landed twice.

**Afterwards:** delete the test document from the patient's images (documents
CAN be deleted), and close or delete the TC case. The GroupNote text is
append-only in `procnotes` and cannot be removed — which is exactly why this
walk uses a designated test patient.
