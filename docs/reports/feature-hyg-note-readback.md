# Hyg — the note read-back looked in the wrong place, and Retry double-wrote

Branch `feature/hyg-note-readback`, off `origin/develop` (`e16ded4`).

---

## The diagnosis holds, and there is a second half to it

The brief's diagnosis is right and the repo's own spike supports it.
`docs/HYG_SPIKE_H0_OD_COVERAGE.md:61`:

> `/procedurelogs/GroupNote` … Read: `GET /procedurelogs/GroupNotes?PatNum=`
> (25.2.38) … creates a `~GRP~` procedure spanning `ProcNums[]`

Both practices run 25.4.48, so the surface is there.

**The second half is why the old read-back could never have worked at all.** It
asked `GET /procedurelogs?AptNum=` and compared `String(p.Note ?? '')`. A
procedurelog row does not carry note text — Open Dental's own documentation,
quoted in H0 at line 158, says *"Cannot update notes on single procedures
through ProcedureLog endpoints; use API ProcNotes instead"*, because the note
lives in `procnote`. So `p.Note` was `undefined` on every row, the comparison ran
`''.includes(note)` every time, and the read-back was structurally incapable of
confirming anything.

That matters for what to expect after deploy: this was not a near miss that
happened to fail on 9/07. **Every** note send since slice 3 would have reported
`NOTE_UNCONFIRMED`, and 9/05 and 9/07 are simply the two that were made.

### How the tests stayed green over it

`hygSend.test.js`'s fake wrote the note back onto the `/procedurelogs` rows:

```js
client.routes['/procedurelogs'] = [{ ProcNum: 5001, Note: body.Note }, …];
```

A shape Open Dental does not produce. Six tests passed on top of a read-back
that could not work, because the harness answered the question the code asked
instead of the question the database answers. The fake now models the real
surface — a new `~GRP~` row appears on `GET /procedurelogs/GroupNotes?PatNum=`
with a ProcNum the database minted — and the appointment rows stay bare.

---

## ⚠️ The diagnostic has NOT been run

Same constraint as #151: this session has no Open Dental credentials and does not
read `.env`. `backend/scripts/diag-hyg-groupnotes.js` is written, checked in and
read-only. **Nothing in this slice has touched a live database.**

```
# STAGING. Designated test patient only. Nothing here writes.
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
  node backend/scripts/diag-hyg-groupnotes.js
```

`HYG_PROBE_APTNUM` is optional; omit it and the appointment-side read is skipped.

It prints, side by side: every row from `GET /procedurelogs/GroupNotes?PatNum=`
(ProcNum, ProcDate, AptNum, ProcCode, an 80-char note preview, and the full key
list of every row), every row from `GET /procedurelogs?AptNum=`, and
`GET /procnotes?PatNum=` for completeness. It then states in one line whether the
appointment rows carry note text at all — which is the claim above, and the one
thing that could still turn out otherwise.

**The single most load-bearing thing in that output is whether the GroupNotes
rows carry `ProcDate`.** The date is what lets a retry tell today's note from an
identical one written at another visit. If it is absent, the dedupe cannot fire
and a retry writes a second permanent copy — see "What is still open".

**It needs no allow-list entry**, as the brief required. It names no write verb
and `routes/rcm/rcmNoOdWrites.test.js` scans it clean:

```
node --test routes/rcm/rcmNoOdWrites.test.js   →  16 tests · 16 pass
```

So `probe-hyg-groupnote.js` remains the only hygiene name in that list, and the
question the PM raised about it in #151 is unchanged by this slice.

---

## Acceptance

| # | | Evidence |
| --- | --- | --- |
| 1 | Diag script exists, read-only, fixture-guarded; command at top of report | above; `rcmNoOdWrites` green with no new allow-list name |
| 2 | Read-back uses `GroupNotes?PatNum=`; genuine miss still `NOTE_UNCONFIRMED` | `hygSend.test.js` — "THE 9/07 BUG…" and "a note Open Dental accepts but cannot show back is Failed, never Written" |
| 3 | Retry proven idempotent by test (write count asserted) | "RETRY DOES NOT WRITE TWICE…" — `assert.equal(noteWrites(client), 1)` after two sends |
| 4 | What the 9/05 + 9/07 rows do after deploy | below |

### Gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2347 tests · 2344 pass · 0 fail · 3 skipped**
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1362 passed, 92 skipped, 0 failed**
- No UI change, so no screenshots. The tray renders `errorMessage` as free text
  and switches on no code, so the new refusal needs no frontend work and the
  contract is untouched.

---

## What the write does now

`writeGroupNote` is four steps, and the first one is a read:

1. **Read the patient's GroupNotes.** Unreadable ⇒ refuse
   `NOTE_PRECHECK_UNAVAILABLE` and **write nothing**.
2. **An identical note already on the visit's date ⇒ do not POST.** Report the
   row that is there.
3. POST.
4. **Read again, and confirm by the row that APPEARED** — the ProcNum present in
   the second read and not the first. Not merely by a row that matches, which an
   older identical note would also satisfy.

Step 4 is why the before-read is not only a dedupe check: diffing the two reads
is what identifies the `~GRP~` ProcNum Open Dental minted for *this* note, which
is the identifier `odWriter.js`'s own header demands of every `ok: true`. The
reference is now `GroupNote 60001 on 2 procedures (5001, 5002)` rather than an
echo of what we sent.

### Three judgement calls, and why

**An unreadable pre-check refuses instead of falling through to the POST.** That
is a new way for a send to fail, and it is deliberate. A write we could not have
confirmed, and whose retry could not have deduped, is *exactly* the write that
produced the duplicate. Declining costs a retry; making it costs a permanent row
in a patient's chart. It is also the platform's standing rule — fail closed.

**The dedupe requires the date, and does not fire without one.** Two prophy
visits can compose byte-identical notes: "this text appears somewhere in the
patient's history" is not evidence that today's note was filed. If the surface
turns out to carry no date, the branch simply never fires and the write proceeds
— the status quo, and never a `Written` that isn't true. The cost is that the
retry guard is inert in that case, which is why the diag matters before this is
relied on.

**Exact text, with `\r\n` folded to `\n` and nothing else.** The old read-back
used `.includes()`, which would have matched a longer note that merely
*contained* this one. Once that same comparison also decides whether to **skip** a
write, a loose match stops being cosmetic and becomes a note that never reaches a
chart. The one normalization is the newline convention — the app sends `\n`,
Open Dental's docs prefer `\r\n`, and a round trip may come back the other way.
That is the same note written the same way. If it did *not* match, every retry
would file another copy forever, which is why it is tested by name.

**The reference says which event it was.** A row that reads `Written` because
CareIN found the note already there gets `… — already on the chart` appended. The
two are not the same event, and a reference that blurred them would quietly turn
"we did not write twice" into "we wrote twice".

---

## Acceptance #4 — the 9/05 and 9/07 Failed rows after deploy

Both are `Failed` with `NOTE_UNCONFIRMED` over notes that, on this diagnosis,
**are in the chart**. Nothing is repaired at deploy time — there is no migration
and no sweep, because a background job that flipped rows to `Written` without a
human present would be the same "we think it worked" this module refuses.

What happens is the hygienist presses **Retry** on each row (Failed → Staged,
same words, no recomposition), then Send:

1. the pre-check reads that patient's GroupNotes;
2. it finds a row whose text is exactly the staged text and whose `ProcDate` is
   the visit date;
3. **no POST is made**, the row goes to `Written`, and the reference names the
   `~GRP~` ProcNum with `— already on the chart`.

So the repair is the same button that used to duplicate. That is the test called
"RETRY DOES NOT WRITE TWICE: the 9/07 row repairs itself instead of
duplicating", and it models the sequence exactly — the POST lands the row, Open
Dental then stops answering the confirming read, the row goes Failed, the read
recovers, Retry, Send, and `noteWrites(client) === 1`.

**Two things to know before pressing it:**

- **If the diag shows no `ProcDate`,** step 2 cannot happen, the note is posted
  again, and the chart gets a second permanent copy. Run the diag first.
- **If the 9/05 note's text was the pre-#151 typographic version**, it will not
  match the ASCII text a re-stage composes today, so the dedupe will not fire and
  Retry writes a fresh (correct) note beside the old one. That is one visible
  duplicate on one test patient — check the chart before pressing, and if the old
  text is there, leave the row alone rather than retrying it.

---

## Files

| | |
| --- | --- |
| `backend/services/hyg/odWriter.js` | the read surface, the pre-check, the appeared-row confirmation. Still the only file in the module that may write |
| `backend/services/hyg/sendVisit.js` | passes `visitDate`; `groupNoteRef()` builds the reference |
| `backend/scripts/diag-hyg-groupnotes.js` | new, read-only, fixture-guarded |
| `backend/routes/hyg/hygSend.test.js` | harness models the real surface; six new tests |
| `backend/services/hyg/sendUnits.test.js` | three unit tests over the matchers |
| `docs/HYG_MODULE.md` | §"Three destinations" + a new subsection |

TC, RCM and `backend/platform/` untouched. No migration, no contract change, no
new write path.

---

## What is still open

1. **The diag has not been run.** Until it is, "the note lands and now confirms"
   is a reasoned expectation, not a fact. Command at the top.
2. **`ProcDate` on the GroupNotes rows is unproven**, and the retry guard is
   inert without it. If the diag shows the surface carries a different date field
   than `ProcDate`, `groupNoteDate()` is a three-line change.
3. **Which of `Note` / `ProcNote` the surface echoes is unproven.** Both are read,
   and both are names from this repo's record rather than guesses — but if it is
   neither, the read-back fails closed as `NOTE_UNCONFIRMED` and nothing is
   duplicated. The diag prints the full key list of every row, which settles it.
4. **The GroupNotes read is now made twice per note send**, one before and one
   after, where there was one before. At the shared 1 req/s credential that is
   about one extra second on a send. It buys the pre-check and the appeared-row
   diff, and it is not a candidate for caching — a cached answer to "what is
   already in this chart" is exactly the answer that must be fresh.
5. **#151's probe is still unrun and still worth running**, for a different
   question: it says which of the two envelope fixes cured the "Invalid JSON".
   This slice does not answer that.
