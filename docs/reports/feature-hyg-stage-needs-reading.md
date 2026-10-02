# Item 28 — Stage requires a reading; skips alone are not a chart

`feature/hyg-stage-needs-reading` → `develop`. Micro-slice. No migration.
`backend/services/hyg/odPerioWriter.js` untouched. No entry, send, drift or
writer changes.

This is the ruling on the scope call item 27 flagged rather than made.

---

## 1. What was actually wrong

"Staging a visit with no readings refuses rather than staging an empty chart"
already existed, in the right place, with the right words on the screen beside
it — the Stage note has always read *"Nothing to stage until there is a
reading."*

The predicate behind it did not mean that. `countPerioChart(...).empty` is:

```ts
counts.empty =
  counts.sitesCharted === 0 &&
  counts.teethSkipped.length === 0 &&          // ← a skip counted as content
  PERIO_FLAGS.every((flag) => counts[flag] === 0);
```

So a chart of nothing but skips was **not empty**, passed the guard, staged, and
sent a dated perio exam carrying **no readings** into a patient's permanent
record — an exam that reads, to anyone who opens that chart later, as though a
perio chart was done.

Hand-skipping made that reachable and it sat there unnoticed, because reaching
it took a deliberate odd sequence. **Item 27's pre-skip made it reachable with
the hygienist having entered nothing at all**: she opens a chart, Open Dental's
missing teeth skip themselves, and the Stage button lights up.

**The ruling:** a skip is a statement *about a tooth* — that it was not charted.
It is not a measurement. Stage requires at least one reading.

---

## 2. What was built

### 2.1 One predicate, in the shared contract

`new-dashboard/shared/hyg/perio.ts`:

```ts
export function perioHasReading(counts: PerioCounts): boolean {
  return counts.sitesCharted > 0 || PERIO_FLAGS.some((flag) => counts[flag] > 0);
}
```

A **depth** counts. A **flag** counts — bleeding on probing is something she
measured, and a flag can exist on a site with no depth. A **skip** does not, and
neither does the skip count. Flags are tallied on un-skipped teeth only (the
existing loop `continue`s past a skipped tooth), so a flag on a skipped tooth
cannot satisfy it either.

`PERIO_NO_READING_REFUSAL` lives beside it, so the server's refusal and the
screen's note are one string rather than two that drift.

### 2.2 `empty` was not replaced, and must not be

Both questions are live in the app and they are different:

| question | predicate | used by |
| --- | --- | --- |
| has anybody *touched* this chart? | `counts.empty` | item 27's pre-skip suppression |
| did she *measure* something? | `perioHasReading` | staging |

Item 27's pre-skip is deliberately suppressed by a chart that is non-empty,
**including one that only holds skips** — a tooth she skipped by hand is a
decision the pre-skip must not overrule. Collapsing the two predicates into one
would have broken that. The shared `perioHasReading` doc comment says so at the
definition, and `hyg-perio.test.ts` pins the pair that distinguishes them.

### 2.3 The server is the rail

`backend/services/hyg/stagedWriteComposer.js`, where the guard already lived:

```js
if (!chart || !counts || !contract.perioHasReading(counts)) {
  return { empty: contract.PERIO_NO_READING_REFUSAL };
}
```

→ `422` / `NOTHING_TO_STAGE`. The Stage button reads the same predicate and goes
grey, but **a greyed button is a courtesy**: the visit Send, a retry, and
anything else that reaches staging all come through this one function. A
client-only fix would not have been acceptance, and the tests for items 1–3 go
straight at the endpoint.

### 2.4 The refusal names the rule

> There are no perio readings on this visit yet, so there is nothing to stage.
> Skipped teeth do not count — a skip says a tooth was not charted, not what was
> measured. Open the perio chart and enter a reading first.

The first sentence is kept **verbatim** from the old message. Two existing tests
match on `/no perio readings/`, and keeping their assertion true unchanged is
part of acceptance 3 — a slice that had to edit them to stay green would have
been changing behaviour it claimed not to touch.

---

## 3. Acceptance

| # | | where |
|---|---|---|
| 1 | A chart of only skips is refused by the **server**, message naming the rule | `hygPerio.test.js` "ACCEPTANCE 1" ×2 (four teeth, and one) |
| 2 | One reading + any number of skips stages exactly as today | "ACCEPTANCE 2" ×2 (a depth, and a flag with no depth) |
| 3 | The existing no-readings refusal still holds; nothing else on the stage path moved | the two pre-existing tests pass **unedited**, plus "ACCEPTANCE 3" ×2 (stage → un-stage → re-stage, and skipping a tooth on an already-staged real chart) |
| 4 | The client button comes from the same shared predicate | `hyg-perio-page.test.tsx` "ACCEPTANCE 4" ×4, including the item-27 pre-skip case |

Plus 7 unit tests on the predicate itself in `hyg-perio.test.ts`.

### 3.1 One item-27 test was rewritten, deliberately

`STAGING a pre-skip-only chart stores it FIRST` asserted that Stage **is**
pressable on a chart of only pre-skips — the exact behaviour this slice removes.
It was not deleted, because it also guards a real defect found in item 27: a
baseline that suppressed the autosave by moving `lastSaved` also made `save()`
itself a no-op, so staging asked the server for a chart it had never been sent.
The test now types one reading before pressing Stage, which is the realistic
path and still proves the save precedes the stage and carries the pre-skips.

That is the whole edit to existing tests. No assertion was weakened.

---

## 4. Gates

Run on the tree CI tests, with the hash compared rather than assumed — see §5.

| gate | result |
|---|---|
| `node scripts/shard-runner.mjs` | 4/4 green, 2930 tests, 2927 pass, 0 fail, 3 skipped |
| `node --check server.js` | clean |
| `pnpm run check` | clean |
| `pnpm run test` | 2135 pass, 0 fail, 146 skipped |
| `HYG_SHOTS=1` perio shots | 19/19 (not run by CI, so run by hand) |
| no `any` | none added |
| `odPerioWriter.js` | untouched |
| migrations | none added |

Seven files changed, four of them tests and one the regenerated contract bundle.

---

## 5. Push, PR, and the merge tree

Filled in at push time.
