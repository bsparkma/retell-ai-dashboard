# CareIN Hygiene Workspace

A chairside hygiene charting prototype: voice-first perio exams, a router slip for front desk, treatment-coordinator handoffs, and an explicit stage → review → send model where nothing leaves the device until you tap Send.

## Stack

- Vite + React 19 + TypeScript
- wouter for routing
- Tailwind CSS v4 + shadcn/ui (new-york style, base primitives)
- Zustand for app/visit/staged-write state
- All data is in-memory mock data (`src/mock/`) — no backend, nothing persists across a refresh

## Structure

- `src/features/day` — Hygiene Day View (schedule grid, summary strip, up-next panel)
- `src/features/visit` — the per-appointment workspace: Router, Perio, Findings, Ortho, Notes, Finish tabs
- `src/features/inbox`, `submissions`, `templates`, `settings` — supporting screens
- `src/store` — `app-store` (office/date/hygienist/theme), `visit-store` (per-tab form state), `staged-writes-store` (the stage/send/retry pipeline), `appointment-status-store`
- `src/mock` — synthetic patients, appointments, perio history, templates, submissions (all fabricated placeholder data — no real PHI)

## Key interaction model

Nothing writes to "Open Dental" automatically. Each tab (Router, Perio, Findings, Notes, Ortho) has a **Stage** action that adds an item to the staged-writes drawer. The **Finish** tab reviews every staged item, sends them one at a time (with a simulated failure + retry path), and only unlocks "Finish visit" once everything is written.

## Treatment identification (Router → Findings)

The Router tab has a shared `Odontogram` component (`src/components/Odontogram.tsx`, also reusable from Perio/Findings/Ortho) showing full adult dentition (universal 1–32) or primary dentition (A–T) for child appointments, with quadrant/arch shortcuts and per-tooth item-count badges. Tapping one or more teeth (or "Whole mouth" for mouth-level treatments like Ortho/Aligners/Whitening) and picking a treatment code creates a `TreatmentItem`:

```ts
interface TreatmentItem {
  id: string
  teeth: number[] | "mouth"
  code: string                  // e.g. "Comp", "Crown", "RC", "EX", "IMP", "Ortho", "Aligners"
  category: TreatmentCategory   // Restorative | Endo | Surgery | Perio | Prosth | Ortho | Cosmetic | Other
  surfaces?: ToothSurfaceLabel[]
  dx: DxCode[]                  // diagnosis codes, e.g. "D", "FX", "RCT" — see DX_LABELS
  dxNote?: string
  priority: 1 | 2 | 3 | 4        // P1 Urgent … P4 Watch
  motivation: MotivationCode[]  // FF | R | esthetic | pain | function | insurance | other — see MOTIVATION_LABELS
  motivationNote?: string
  status: "proposed" | "watch" | "confirmed" | "scheduled"
  crownType?: "initial" | "replacement"
  prosthesis?: { newOrReplacement: "new" | "replacement"; years?: string }
  scheduleNext: boolean
  note?: string
  photos: string[]
  tags?: string[]                // e.g. "post-ortho"
  createdBy: string
  createdAt: string
}
```

`DX_LABELS` and `MOTIVATION_LABELS` (both in `src/mock/types.ts`) map the short chip codes to full words, shown via a "Show meanings" toggle in `treatment-item-card.tsx`. `deriveCategory(items)` picks a single `Submission["category"]` from a set of items (Ortho > Implant > Restorative > Cosmetic > Perio > Other) — this replaces manual category selection in Findings. `RECORDS_MATRIX` (`src/mock/records-matrix.ts`) maps a treatment code to the records it requires; `recordsNeededFor(items)` unions/dedupes across the current item set and feeds Router §(l) "Records needed for planned treatment."

Items are stored once on the visit (`visit.treatmentItems` in `visit-store.ts`) and shared everywhere:

- The Router slip preview renders the full item detail (teeth, code, dx, motivation, priority, status).
- The Findings tab splits items into **Optimal treatment** (proposed/confirmed/scheduled) and **Holding** (watch) — Holding items are individually checked in to a TC handoff via "Include in handoff" (excluded by default). Clicking an Ortho item's row opens the Ortho tab.
- The TC handoff staged write includes the full item detail.

A couple of mock patients (one per office) ship with pre-populated treatment items (`src/mock/treatment-items.ts`) so the slip and handoff previews aren't empty on first load.

## Router tab fields (a)–(l)

`RouterState` (`src/store/visit-store.ts`) is ordered into labeled sections: **(a)** From Open Dental — read-only, pulled live from `src/mock/od-snapshot.ts` (`OdSnapshot`: scheduled procedures, recall due, medical alerts, insurance remaining, pending tx, family members due), never written to by the hygiene workflow; **(b)** pre-visit checks; **(c)** visit type + last check-up; **(d)** records today; **(e)** done today; **(f)** perio classification; **(g)** doctor exam; **(h)** patient concerns / hygiene findings; **(i)** next hygiene visit, including the **Recare scheduled** hard check; **(j)** next restorative visit (auto-listed from `scheduleNext` items), including the **TX entered in OD** hard check; **(k)** admin; **(l)** records needed (from `recordsNeededFor`).

| Field | Source |
|---|---|
| (a) From Open Dental | read-only, `od-snapshot.ts` |
| (b)–(l) everything else | hygienist-entered, stored on `RouterState` |

## Ortho tab

A tab shown for ortho patients / `Ortho Adj` appointments, between Findings and Notes. It opens in **Adjustment** mode for `Ortho Adj` appointments and **Workup** mode for everything else, with a segmented control to switch.

**Workup** is four collapsible sections (`src/components/collapsible-section.tsx`), each with an independent "Not assessed" switch that greys out and disables its body without discarding entered data:

- **A. Clinical findings** — growth status, mixed dentition, dentition selector, molar/canine class L/R, overjet (negative-capable) / overbite / open-bite, crossbite (incl. scissor), crowding/spacing per arch, midline, missing/impacted/ectopic teeth (via three `Odontogram` selections), peg laterals, supernumerary, habits/airway/TMJ, facial/dental asymmetry, profile, lip competence, chief complaint + goals.
- **B. Records** — a checklist of pano/ceph/intraoral/extraoral/scan/impressions/models, each a 3-way "taken today / on file / needed" toggle (same `RecordStatus` type used by Router §(l)).
- **C. Proposed treatment** — track, complexity + reasons, braces (material/arch), aligners (brand/arch/est. trays), upper/lower expansion, myofunctional therapy, anticipated extractions (`Odontogram`), IPR/space maintenance, treatment-time band + explicit months, retention (type + pontic teeth), "Additional work after ortho" chips (each checked chip adds a `status: "watch"` treatment item tagged `post-ortho`, visible in Findings' Holding section and counted on Finish), referral.
- **D. Handoff** — appointment sequence, visit type, consult location, presenter, read-only insurance ortho benefit (from `od-snapshot.ts`), estimated fee band, "Notes for TC," and "Send to TC as Ortho case" — creates a mouth-level `category: "Ortho"` treatment item and stages a TC handoff whose preview is exactly five lines: track, estimated months, appliances, retention, post-ortho work.

**Adjustment** mode captures appliance/tray info, compliance, issues, elastics, wire change, OH grade, white-spot lesions (via `Odontogram`), months remaining, anticipated debond month, and next-visit interval, then stages an "Ortho adjustment" note.

## Finish tab hard checks

Once anything is staged, Finish shows two rows above the write cards: **Recare scheduled** and **TX entered in OD** (from Router §(i)/(j)). Unanswered (blank — not the same as "N") renders red with "Not answered — tap to fix" and jumps back to Router; "Send all" stays disabled until both are answered. A "Post-ortho watch items created: N" line appears whenever the Ortho tab's additional-work chips have added any.

## Run locally

```bash
pnpm install
pnpm dev
```
