# Hygiene Prototype Review → H1 Build Plan

PM review of the v0 prototype in `C:\Users\beau\carein-hyg` (2026-08-24). ~10k lines TS, 70 files. Source of truth for the hygiene module's UX spec. **Not merged wholesale — mined.**

---

## 1. Verdict

The prototype is good enough to be the spec. Three things it got right that I did not ask for and that change the H1 plan:

1. **The routing slip is your real slip, not a generic one.** Sections (a)–(l), the DX code vocabulary (`I D RD XD E AB EXCR FX CR PAIN RCT MISS OM N LF SAP AT OH UE GR`), motivation codes (`FF R esthetic pain function insurance`), priority P1–P4, the records-needed matrix per treatment code, and two **hard checks** ("Recare scheduled", "TX entered in OD") that gate Send. This is the paper workflow encoded. H1 builds *this* slip, not the one in my original prompt.
2. **Section (a) "From Open Dental" is read-only context** (scheduled procedures, recall due, med alerts, insurance remaining, pending tx, family due). That is a real OD read surface H1 has to serve — and it is all GET-verified coverage from H0.
3. **Treatment items are one list on the visit**, entered on the Router via the tooth chart, consumed by the slip, Findings (Optimal vs Holding), Ortho (post-ortho watch items), and the TC handoff. `deriveCategory()` replaces manual TC category selection. Keep this model exactly.

## 2. Corrections needed in the prototype (before hygienists see it)

| # | Issue | Fix |
|---|---|---|
| P1 | **No git checkpoint.** Folder has no `.git`. The Manus loss was this exact failure. | `git init && git add -A && git commit -m "v0 export 2026-08-24"` — today. |
| P2 | Notes stage summary reads **"Signed by {name}"**. Violates B1 (app never signs). | Change to "Typed name: {name} — unsigned". Banner copy stays "Unsigned — sign in Open Dental if required". |
| P3 | **Voice commands are not parsed.** Only the scripted demo transcript exists; `next/back/skip/missing/lingual/start at tooth N` never move the cursor. README should not claim a grammar. | Acceptable for a UX prototype — but tell hygienists "the demo is a script" so feedback is about the *confirm pattern*, not recognition. |
| P4 | Office isolation is by `apptId` only (visit-store, staged-writes keyed on appointment). Works because mock appts are office-scoped. | Fine for prototype. In the real build office derives server-side from the appointment; never trusted from client. |
| P5 | Staged perio write is a single "perio" kind. Real OD write is 1 exam + N measure rows (60–100+ requests, resumable). | Prototype OK. H4 design note: the staged item needs sub-item progress. |
| P6 | Off-roster synthetic names ("Test Kiwi Sample" etc.). All are clearly fake fruit names — acceptable. | No action. Keep the "Test/Sample/Mock/Placeholder" prefix convention. |

## 3. What is portable into the monolith

Copy-adapt (small edits, keep the shape):

- `src/lib/dentition.ts` + test — **verbatim**. Becomes `new-dashboard/src/lib/dentition.ts`. Single source of tooth ordering (upper 1→16, lower 32→17, primary A→J / T→K).
- `src/mock/types.ts` → the **TreatmentItem**, **DxCode/DX_LABELS**, **MotivationCode/MOTIVATION_LABELS**, **TreatmentStatus**, **deriveCategory** — verbatim into a shared `hyg/types.ts`; the backend gets the same types as a zod schema.
- `src/mock/records-matrix.ts` — **verbatim** as office-standard config (later per-office editable in Settings).
- `src/components/Odontogram.tsx` — port; swap mock imports for props.
- `src/store/staged-writes-store.ts` — the **state model** (`Draft → Staged → Sending → Written | Failed`, replace-by-(appt,kind), sequential send, retry) becomes the contract for `/api/hyg/visits/:id/writes`. The Zustand store itself is replaced by a server-backed store + React Query.
- `src/features/visit/router/*` (~1,400 lines) — the **field inventory and section order** (a)–(l), not the component code. RouterState interface maps 1:1 to the router payload schema.
- `src/features/visit/finish/finish-tab.tsx` — the hard-check gate and review card layout.

Re-spec, do not port:

- All stores → server state. Staged writes must persist (a hygienist walking away mid-visit must not lose work; iPad refresh = today's failure mode).
- `od-snapshot.ts` → real `GET` reads through `getOdClientForOffice(officeKey)`.
- Perio grid + dictation → H4 (voice perio). Keep the components as reference only.
- Ortho tab (1,421 lines) → H2. Large, good, not H1.
- Inbox / Submissions → reuse existing TC module screens; do not duplicate.

## 4. H1 scope (locked)

**H1 = Hygiene Day View + Digital Router, both offices, paper-parallel.** Nothing writes to OD in H1 except the routing slip PDF → patient images ("Routers" category, DefNum by name per office) and the TC handoff (existing TC create path). No perio, no notes, no ortho.

Why this cut: it replaces the paper slip (the thing hygienists actually touch every visit), exercises the whole stage → review → send spine against real OD, and creates the `hyg` module namespace + entitlement + per-office switch that H2–H4 sit on. Perio (the flashy part) waits until the spine is proven.

### H1 deliverables

1. **Module scaffold**: `hyg` added to `tenant_module` CHECK constraint (migration), `requireModule('hyg')` on `/api/hyg/*`, per-office `hyg.odEnabled` switch (both offices, default OFF in prod until validated).
2. **Day View** `/hyg/day`: GET whole-day appointments per office, partition client-side by operatory, `IsHygiene` on appointment authoritative, operatory `IsHygiene` for layout, confirmed-status string per office, summary strip incl. **unsent count**.
3. **Visit workspace** `/hyg/visit/:apptId` with **Router tab + Finish tab only** (other tabs rendered disabled with "H2/H4" labels).
4. **Router** = sections (a)–(l) from the prototype, incl. Odontogram + TreatmentItem list, records-needed matrix, hard checks.
5. **Staged writes** persisted in per-tenant Postgres (`hyg_visit`, `hyg_staged_write`, `hyg_treatment_item`), audit_log on every state transition.
6. **Send**: router → HTML render → PDF → `POST /documents/Upload` with the office's "Routers" DocCategory (resolved by name, never hardcoded); TC handoff → existing TC case create with treatment items in the snapshot. Read-back after write before marking `Written`.
7. **Staging validation** on designated test patients only (roland 12827 / 12828; valley 7115).

### H1 explicitly excludes
Perio charting, note writing (GroupNote), ortho, voice, Inbox/Submissions rebuild, PDF fidelity beyond "readable slip".

---

## 5. Claude Code prompt — H1 slice 1 of 3 (scaffold + Day View)

> Paste into Claude Code in the DEV clone or a fresh worktree `C:\Users\beau\carein-wt\feature-hyg-scaffold`. Three slices → three PRs. Do not start slice 2 until slice 1 is reviewed.

```
Read project memory first: carein-app-map.md, then carein-hyg-app-discovery.md, then carein-modules-model.md. Then read new-dashboard/HANDOFF.md and docs/ARCHITECTURE.md.

Reference prototype (READ ONLY, do not copy files wholesale): C:\Users\beau\carein-hyg — specifically src/lib/dentition.ts, src/mock/types.ts (TreatmentItem, DxCode, MotivationCode, deriveCategory), src/mock/records-matrix.ts, src/store/visit-store.ts (RouterState), src/features/day/*.

Task: HYG slice 1 — hygiene module scaffold + Day View. Branch feature/hyg-scaffold-dayview off origin/develop after git fetch.

1. Module registration
   - Migration adding 'hyg' to the tenant_module CHECK constraint (control DB). Follow the existing migration pattern used for 'rcm'.
   - requireModule('hyg') guarding a new namespace backend/routes/hyg/*. Mount at /api/hyg.
   - Per-office setting hyg.odEnabled (boolean, per officeKey) in the same place other per-office OD settings live (OFFICE_OD_SETTINGS or its successor). Default false. Every /api/hyg route that reads OD must fail closed (403 with an honest message) when the office's hyg.odEnabled is false.

2. Shared types
   - new-dashboard/src/lib/dentition.ts: port verbatim from the prototype, with its vitest test.
   - shared hyg types: TreatmentItem, DxCode + DX_LABELS, MotivationCode + MOTIVATION_LABELS, TreatmentStatus, deriveCategory, RECORDS_MATRIX + recordsNeededFor — port from the prototype. Backend gets matching zod schemas. TypeScript strict, no any.

3. Day View API
   - GET /api/hyg/day?office=<key>&date=YYYY-MM-DD. Office key validated against the frozen list (roland | valley); PatNums never cross offices. Uses getOdClientForOffice(officeKey). Pulls the whole day's appointments (no provider filter exists), pulls operatories, and returns { operatories: [{id,name,isHygiene}], appointments: [{aptNum, patNum, patientDisplay, age, opNum, provNum, providerDisplay, start, lengthMin, isHygiene, apptTypeLabel, confirmedStatus, flags: {xraysDue, perioDue, examNeeded, openTcCase}}] }. /scheduleops pages at exactly 100 — handle pagination. Confirmed status comes back as the resolved string per office. flags may be null in slice 1 where the OD read is not yet wired — return null, never a fake false.
   - Cache per (office,date) for 60s server-side; add a manual refresh.

4. Day View UI (new-dashboard, route /hyg/day, gated on module entitlement like /tc)
   - Columns-by-operatory schedule, hygiene operatories first, 7:00–17:00 axis, 10-min grid, Now line, "Up next" panel for the selected hygienist, summary strip: patients today / perio due / exams needed / UNSENT (count of hyg_visit rows with staged-but-unsent writes — returns 0 in slice 1 since the tables land in slice 2; wire the field anyway).
   - Office switcher must swap ALL data. Hygienist picker per office from OD providers filtered to hygienists (ProvNum list per office in config for now).
   - iPad landscape first (1180x820), ≥44px targets. Use the prototype's day-view components as layout reference; rewrite against the API shape above.
   - Appointment card tap → /hyg/visit/:aptNum (route exists, renders a "Slice 2" placeholder with patient header from the day payload).

5. Guardrails
   - No OD writes anywhere in this slice.
   - Real patient names never in commits/PR/docs. Screenshots only of staging test patients.
   - tsc --noEmit clean, existing tests pass, new dentition test passes.
   - Do NOT touch .env, Azure infra, or the prod folder.

Deliver: push the branch, open a PR against develop titled "Add hyg module scaffold and hygiene day view", PR body = what was built, how to verify on staging (office, date, expected columns), and any OD API surprises. Then report back with the PR link. Do not merge.
```

### Slices 2 and 3 (drafted after slice 1 review)
- **Slice 2** — hyg_visit / hyg_staged_write / hyg_treatment_item tables (tenant migration), Router tab (a)–(l) + Odontogram + treatment items, stage endpoint, Staged-writes drawer, Finish tab with hard checks. Still no OD writes.
- **Slice 3** — Send: slip render → PDF → documents/Upload with per-office "Routers" DefNum resolved by name; TC handoff via existing TC create; read-back before Written; retry; audit_log; staging validation on test patients; per-office odEnabled flip on staging.

---

## 6. Open decisions for Beau

1. **Priority scale**: prototype uses P1–P4 (Urgent … Watch) for treatment items *and* Routine/Soon/Urgent for the TC handoff urgency. Pick one for the real build. Recommend P1–P4 everywhere and map to TC urgency on handoff (P1→Urgent, P2→Soon, P3/P4→Routine).
2. **Hard checks**: "Recare scheduled" / "TX entered in OD" gate Send in the prototype. In H1, front desk does those in OD *after* the hygienist sends. Keep as blocking, or make them a soft warning + an Inbox item for front desk? Recommend soft warning in H1 (hygienist cannot control front desk timing), revisit after two weeks of paper-parallel.
3. **Which hygienist pilots** the paper-parallel and at which office first. One person, one office, two weeks.
