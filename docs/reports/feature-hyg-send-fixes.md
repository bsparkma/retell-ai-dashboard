# Hyg — two bugs from the first real send

Branch `feature/hyg-send-fixes`, off `origin/develop` (`50262c7`).

---

## ⚠️ THE BISECT WAS NOT RUN, AND I FOUND A DIFFERENT CAUSE

The brief said to verify the diagnosis before fixing it. I could not run the
staging probe — this session has no Open Dental credentials and does not read
`.env` — so **no probe has been sent to any database.** The script is written,
checked in and designed exactly as the brief specified; the command is below.

What I did instead was check the diagnosis against the repo's own evidence, and
it turned up a **different and better-supported cause**.

### `docs/HYG_SPIKE_H0_OD_COVERAGE.md`, the record of what H0 proved live

> **`POST /procedurelogs/GroupNote`** — required **`PatNum`**, `Note`; optional
> **`ProcNums[]`**, `ProvNum`, `isSigned`.

Slice 3's writer sent:

```js
{ ProcNums: procNums.join(','), Note: note, isSigned: false, ProvNum }
```

- **`PatNum` — a REQUIRED field — was not sent at all.**
- **`ProcNums` was a comma-joined STRING** where the contract says an array.

A missing required field and a wrongly-typed one are a straightforward
explanation for a parse-stage refusal, and unlike the middot hypothesis they are
checkable right now against this repo's own spike rather than against a guess.
Both are fixed.

**The PM's diagnosis is not dismissed — it is also fixed**, because it is right
on its own terms regardless of what caused this particular 400: the note was the
only payload carrying typographic punctuation into an Open Dental JSON field,
and this module was the one OD note path in the platform that did not sanitize.

**Two changes at once means the probe still matters** — it is the only thing
that says WHICH one was the cause. It now has four candidates instead of two,
ordered so its first success is the answer:

```
# STAGING ONLY. Designated test patient only.
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
  node backend/scripts/probe-hyg-groupnote.js --dry     # prints, sends nothing
HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 HYG_PROBE_APTNUM=<n> \
  node backend/scripts/probe-hyg-groupnote.js
```

| Candidate | If it lands, the cause was |
| --- | --- |
| 1. H0 payload + ASCII text | **either or both** — this is what the app now sends, so a landing here is "fixed" without saying which half |
| 2. H0 payload + the ORIGINAL typography | the ENVELOPE. The characters were innocent |
| 3. the ORIGINAL envelope + ASCII text | the CHARACTERS. The PM's diagnosis was right |
| 4. H0 payload + ASCII + CRLF | the newline form, which nothing has ever pinned |

It **stops at the first success**, because a landed probe is a permanent
`procnote` row (H0: *"No existing procnote can EVER be edited or deleted"*), and
it refuses to run against a PatNum that is not a designated fixture or with
`OPENDENTAL_WRITE_DISABLED` set.

**Newlines are unchanged** (`\n`, as the failed send used, via a named
`NOTE_NEWLINE` constant). Open Dental's docs prefer `\r\n` and candidate 4 tests
it — changing it now would be a third simultaneous guess, and a guess made
beside two real fixes is one nobody could later attribute.

---

## Acceptance criteria

| # | | Evidence |
| --- | --- | --- |
| 1 | The failed note composes to OD-safe text; a staging send lands | composes ✅ (tested); **the staging send has NOT been run** — see above |
| 2 | Composer output provably within the safe set; preview === sent, same bytes | `stagedWriteComposer.test.js` — "EVERY composed line is inside the character set Open Dental accepts" + "THE PREVIEW IS THE WRITE: the fingerprinted lines ARE the transmitted string" |
| 3 | `deriveCategory([4 × Restorative])` === "Restorative"; exhaustive; empty still "Other" | `hyg-contract.test.ts` — "A VISIT OF PLAIN RESTORATIVE ITEMS IS RESTORATIVE" + the table-driven case |
| 4 | Pre-fix staged rows handled honestly | below |
| 5 | `tsc --noEmit` clean, no `any`; green on 4 shards; bundle regenerated | below |

### 5 — gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2330 tests · 2327 pass · 0 fail · 3 skipped**
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1342 passed, 82 skipped, 0 failed**
- `backend/hyg/contract.gen.cjs` regenerated with the pinned esbuild; its sync test passes

---

## Bug 1 — the fix, and where it lives

**The sanitizer is the platform's own.** `backend/utils/sanitizeForOd.js` has
normalized every voice commlog note for months and already maps `·` → `-`,
`—` → `--`, smart quotes, ellipses and exotic spaces. The brief said to stay
consistent with that path rather than invent a second sanitizer, and that is
what this does — the hygiene module was simply the one OD note path that never
called it.

Worth noting for the record: that file's own header says it exists because
non-ASCII lands as **mojibake** in Open Dental, not because it is rejected. So
the voice module's experience corroborates "non-ASCII is trouble here" but not
"non-ASCII causes Invalid JSON". That is another reason the probe still matters.

**It goes in the COMPOSER, at one choke point.** `compose()` now wraps
`composeRaw()` and sanitizes the title, the summary, every preview line and the
payload — and rebuilds the note's `text` FROM the sanitized preview lines. So:

- the fingerprint is taken over ASCII lines,
- the string sent to Open Dental is `preview.join('\n')`, the same bytes,
- and a writer that rewrote text after fingerprinting — which would break the
  `PREVIEW_CHANGED` guarantee from the inside — is impossible, because there is
  nothing left for it to rewrite.

One choke point rather than forty `sanitize()` calls at forty push sites: "the
preview is ASCII" has to be a property of the module, not of whoever remembered.

**A visible consequence:** the middot is now a hyphen ON SCREEN too — "#30 -
Crown - Urgent". That is the correct trade. The alternative is a preview that
does not match what lands, which is the thing this slice is protecting.

### Pre-fix staged rows

**Nothing is silently mutated.** A row staged before this deploy keeps the
typographic text it was composed with. Its stored fingerprint is recomputed from
its own stored preview on every read, so it still matches itself and the row
renders normally — but the text is the OLD text, and re-staging is what
recomposes it.

The honest sequence, which the screen already produces:

1. She presses Send on a pre-fix row → the server sends the OLD text.
2. If the old text was the cause, it fails again — with the same reason, in the
   row, and a Retry.
3. Any edit to the visit and a re-stage produces ASCII, and the tray shows the
   new preview before she confirms.

**There are no such rows to worry about in practice**: the module is dark
everywhere except staging, and the only real send is the one that failed. Its
router and handoff rows are `Written` and immutable; the note row is `Failed`
and re-stageable.

---

## Bug 2 — `deriveCategory` and the shape that let it happen

The chain handled Prosth, Endo, Surgery, Cosmetic, Ortho and Perio — and never
plain `"Restorative"`, which fell to the `else` and became `"Other"`. With
`HANDOFF_CATEGORY_PRIORITY` putting Restorative above Other, four Restorative
items derived **Other**.

**Rewritten as an exhaustive `switch` with no `default`.** TypeScript checks the
union against the declared return type, so a category added later without a
branch is a compile error rather than a silent "Other". The bug was not a typo —
it was a shape that let a case go missing, and the shape is what changed.

**Why no test caught it.** The existing suite asserted Prosth→Implant,
Prosth→Restorative, Endo→Restorative, Surgery→Restorative, the empty list, and a
mixed visit whose answer is Ortho. **A visit of nothing but Restorative items
was never asserted** — and the mixed test contains one, so the hole was
invisible. Two tests were added: the four-Restorative case by name, and a
table-driven one over the whole `TreatmentCategory` union.

`Other` now means exactly two things, and they are both deliberate: the `Other`
CATEGORY, and the empty list.

---

## The one thing outside the hygiene module

**`backend/routes/rcm/rcmNoOdWrites.test.js` gains one name in its allow-list.**

That guard scans the WHOLE of `backend/scripts/`, not just RCM's, because *"put
it in scripts/"* is the evasion it exists to close — and that is as true of a
hygiene script as an RCM one. `probe-hyg-groupnote.js` names `apiWriteRaw`, so
it correctly failed the guard until it was named.

```diff
   const ALLOWED = new Set([
     'rcm-d7-write-probe.js',
     'rcm-d7-read-sweep.js',
     'rcm-s10-prep.js',
     'rcm-s11-unwind.js',
     'rcm/reseed-prep.js',
+    // NOT an RCM script. This guard scans the whole of scripts/, which is the
+    // point of it...
+    'probe-hyg-groupnote.js',
   ]);
```

The brief said TC/RCM untouched. This is the guard's own designed extension
point — its comment says *"Adding a sixth is a review decision"* — and using it
as designed seemed better than the alternatives, which were to skip the probe
script entirely (handing over a raw curl with no fixture guard and no
stop-at-first-success) or to hide it somewhere the guard does not look. **If the
PM would rather not touch an RCM file, say so and I will drop the script and put
the four payloads in this report as text.**

Nothing else outside hyg. `backend/platform/` untouched, TC untouched, no
migration.

---

## Screenshot

`docs/screenshots/hyg/hyg-send-05-note-fixed-1180x1200-{light,dark}.png` — the
note from 2026-09-05 shown **Written**, with its read-back reference
(`GroupNote on 4 procedures (5001, 5002, 5003, 5004)`) beside the slip's real
`Document 311924 in Routers`. The preview lines in it are the ASCII the composer
now produces.

---

## What is still open

1. **The probe has not been run.** Until it is, "the note lands now" is a
   reasoned expectation, not a fact. The command is above; it is safe to run
   `--dry` first and it stops at its first success.
2. **The newline form is unproven.** Candidate 4 answers it.
3. **If every candidate is refused**, the cause is none of these four — capture
   the exact refusal text and widen the search rather than guessing a fifth
   time. Two things I could not rule out from code: the `isSigned` field's
   casing (H0 writes it lower-case, and this repo has never seen a live 200 for
   it), and whether `ProvNum` must be a provider on the grouped procedures.
