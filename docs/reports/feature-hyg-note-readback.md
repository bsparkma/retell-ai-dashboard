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

## The diagnostic HAS now been run — and it changed the fix

Beau ran it against roland, PatNum 12828, AptNum 110123, on 2026-09-08.

```
GET /procedurelogs/GroupNotes?PatNum=12828   200, 1 row
  keys: Note, PatNum, ProcNum, ProcNums, ProvNum, isSigned
  ProcNum=406901   ProcNums=[406880, 406881]   (an ARRAY)
  Note="Done today: Prophy\r\nX-rays: BW-4, PA\r\nDoctor exam: Needed today\r\nPerio cla…"

GET /procedurelogs?AptNum=110123             200, 2 rows
  45 keys, and NEITHER `Note` NOR `ProcNote` among them.
  ProcNum=406881 D0220 · ProcNum=406880 D0140

GET /procnotes?PatNum=12828                  200, 1 row (the same note)
```

### Four findings, and one of them was a defect in this branch

**1. The note was on the chart all along.** ProcNum 406901 holds the 9/07 text.
The POST landed; only the confirmation missed. The diagnosis is confirmed rather
than merely reasoned.

**2. `/procedurelogs?AptNum=` carries no note text at all.** Forty-five keys, and
neither `Note` nor `ProcNote`. The old read-back was comparing against
`undefined` on every row of every send. Confirmed exactly as claimed.

**3. ⚠️ THERE IS NO DATE ON THE ROW — and the first version of this branch
matched on one.** No `ProcDate`, no `AptNum`, no `EntryDateTime`. The dedupe
would never have fired, and **every Retry would still have written a second
permanent note**. That is the whole load-bearing half of the slice, and it was
broken. It is fixed here.

It is also the *same mistake* as the bug being fixed: matching on a field that
was never there. The read-back looked for `Note` on a procedurelog row; the
dedupe looked for `ProcDate` on a GroupNotes row. Both were plausible, both were
absent, and both would have failed silently.

**The row does carry `ProcNums`, as an array — `[406880, 406881]`, exactly the
two procedures on appointment 110123.** So the match is on text **plus
ProcNums**, and that is *stronger* than the date would have been: a date says
"some visit that day", while these ProcNums are the procedures on ONE
appointment. Two prophy visits that compose byte-identical notes are two
different appointments with two different sets of procedurelog rows.

Equality, not overlap: if the appointment's procedures changed between a failed
send and a retry, the note is about different work and *should* be written.

**4. Open Dental returns `\r\n` where the app sent `\n`.** The newline fold in
`sameNoteText` was written as a defensive guess and is in fact load-bearing:
without it nothing would ever match, the dedupe would never fire, and every
retry would duplicate. That test's comment now cites the live output instead of
the docs.

### Two smaller things the run exposed

- **The script drew a conclusion from a failed read.** It printed "No note text
  on these rows at all" after a 30s timeout, because an unanswered read and an
  answered-but-empty one both arrive as an empty array. A diagnostic that states
  a finding it did not observe is worse than one that says nothing — it is the
  same class of mistake as the read-back it exists to investigate. Fixed.
- **The surface timed out at 30s on three of five attempts**, against a
  credential voice and RCM were also using. Not a blocker for a diagnostic, and
  worth knowing before anybody reads a single failure as a finding. `writeGroupNote`
  now makes two reads per note send where it made one, so this is also the
  clearest argument for the fail-closed pre-check: a timeout there refuses
  rather than risking the duplicate.

### The command, and the allow-list

```
# Designated test patient only. Nothing here writes.
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
  node backend/scripts/diag-hyg-groupnotes.js
```

`HYG_PROBE_APTNUM` is optional; omit it and the appointment-side read is skipped.
Note that the script does not load `dotenv` — like the RCM probe scripts it
expects the environment to be set, which is true inside the container and not on
a laptop. Locally: `node -r dotenv/config`, with `DOTENV_CONFIG_PATH` pointing at
a backend `.env`.

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
| 2 | Read-back uses `GroupNotes?PatNum=`; genuine miss still `NOTE_UNCONFIRMED` | `hygSend.test.js` — "THE 9/07 BUG…" and "a note Open Dental accepts but cannot show back is Failed, never Written"; **and the live run above** |
| 3 | Retry proven idempotent by test (write count asserted) | "RETRY DOES NOT WRITE TWICE…" — `assert.equal(noteWrites(client), 1)` after two sends. The matcher is `ProcNums`, not the date this surface does not have |
| 4 | What the 9/05 + 9/07 rows do after deploy | below |

### Gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2347 tests · 2344 pass · 0 fail · 3 skipped**
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1362 passed, 92 skipped, 0 failed**
- `backend/scripts/diag-hyg-groupnotes.js` run live against roland — see above
- No UI change, so no screenshots. The tray renders `errorMessage` as free text
  and switches on no code, so the new refusal needs no frontend work and the
  contract is untouched.

---

## What the write does now

`writeGroupNote` is four steps, and the first one is a read:

1. **Read the patient's GroupNotes.** Unreadable ⇒ refuse
   `NOTE_PRECHECK_UNAVAILABLE` and **write nothing**.
2. **An identical note already on the same ProcNums ⇒ do not POST.** Report the
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

**The dedupe requires the ProcNums, not just the text.** Two prophy visits can
compose byte-identical notes: "this text appears somewhere in the patient's
history" is not evidence that today's note was filed. The ProcNums pin it to one
appointment.

This was `ProcDate` until the diagnostic ran, and `ProcDate` does not exist on
this surface — see finding 3 above. The replacement is not a fallback; it is
better than what it replaced.

**Exact text, with `\r\n` folded to `\n` and nothing else.** The old read-back
used `.includes()`, which would have matched a longer note that merely
*contained* this one. Once that same comparison also decides whether to **skip** a
write, a loose match stops being cosmetic and becomes a note that never reaches a
chart. The one normalization is the newline convention, and the live run settled
it: the app sent `\n` and Open Dental returned `\r\n`. Without the fold,
nothing would ever match and every retry would file another copy forever.

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

Step 2 now reads "an identical note already on the same ProcNums", which the
diagnostic confirms is available: the 9/07 note is
`ProcNum=406901, ProcNums=[406880, 406881]`, and those are exactly the two
procedures on appointment 110123.

**One thing to know before pressing it:** if the 9/05 note's text was the
pre-#151 typographic version, it will not match the ASCII text a re-stage
composes today, so the dedupe will not fire and Retry writes a fresh (correct)
note beside the old one. That is one visible duplicate on one test patient —
check the chart first, and if the old text is there, leave the row alone rather
than retrying it.

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

1. **The fixed matcher has not itself been exercised against a live send.** The
   diagnostic proved the SHAPE — `ProcNums` present, no date, CRLF — and the
   matcher is written to it and unit-tested against it. What has not happened is
   a real Retry on the 9/07 row, which is the end-to-end proof. That is one
   button press once this is deployed, and step 2 above says what to check first.
2. **The GroupNotes read is now made twice per note send**, one before and one
   after, where there was one before. At the shared 1 req/s credential that is
   about one extra second on a send — and the diagnostic saw that surface time
   out at 30s three times in five, so the second read is not free in practice
   either. It buys the pre-check and the appeared-row diff, and it is not a
   candidate for caching: a cached answer to "what is already in this chart" is
   exactly the answer that must be fresh.
3. **`ProcNote` is still read as a fallback for `Note`.** The live row uses
   `Note`, so the fallback is now dead code with a documented reason. I have left
   it because `/procnotes` (the other note surface, which this file does not use)
   is the one H0 quotes `ProcNote` for, and removing it saves nothing. Say the
   word and it goes.
4. **#151's probe is still unrun and still worth running**, for a different
   question: which of the two envelope fixes cured the "Invalid JSON". This slice
   does not answer that — though the live row's `ProcNums: [406880, 406881]`
   being an ARRAY is consistent with the envelope having been the cause.
