# `docs/hyg-prototype/` — the hygiene prototype, vendored as reference

**This tree is documentation. Nothing here is compiled, bundled, linted, tested or
shipped.** It is Beau's v0 hygiene prototype (built outside this repo, ~10k lines of
TS/TSX), checked in so the H1 slices have the UX spec under version control instead of
in a folder on one laptop.

## Why it is here rather than merged

The prototype is the **design authority**, not the implementation. Its data layer is
Zustand stores over mock fixtures; the real module is server state over Open Dental and
per-tenant Postgres. Merging it wholesale would import a client-owned tenancy model
(`officeId` threaded through the client) into a codebase whose whole per-office design
exists to stop exactly that. So it is **mined**, file by file, slice by slice —
see `HYG_PROTOTYPE_REVIEW_AND_H1.md` for the PM's port/discard verdict per file.

## Proof that it is not wired into any build

| Toolchain | Why this tree is invisible to it |
| --- | --- |
| `new-dashboard` typecheck (`pnpm run check`) | `new-dashboard/tsconfig.json` `"include"` names exactly `client/src/**/*`, `shared/**/*`, `server/**/*`. This tree is outside `new-dashboard` entirely. |
| `new-dashboard` build (`vite build`) | `vite.config.ts` sets `root: <new-dashboard>/client`. Vite cannot reach a sibling of `new-dashboard`. |
| `new-dashboard` tests (`vitest run`) | `vitest.config.ts` `include` is `tests/**/*.test.ts{,x}`, resolved from `new-dashboard/`. `src/lib/dentition.test.ts` below is therefore never collected. |
| backend tests (`node --test`) | run from `backend/`; this tree contains no `.js` and is not under it. |
| repo-root `tsconfig.json` | carries an explicit `"exclude": ["docs/hyg-prototype", ...]`. The root config has no `include`, so without that line a root `tsc` would walk into this tree. |
| eslint | there is no eslint in this repo (no config, no dependency). |

There is also no import anywhere in `backend/` or `new-dashboard/` that resolves into
this directory — see the grep in the PR body, and `backend/routes/hyg/hygNoOdWrites.test.js`
for the module's other structural guard.

**Do not add this tree to any `include`, glob, alias or path mapping.** If you want a
piece of it, copy that piece into `new-dashboard/` or `backend/` and adapt it there.

## What was changed from Beau's export, and why

Two deviations from a byte-for-byte vendoring, both deliberate:

1. **Build config and lockfiles were not copied.** `vite.config.ts`, `tsconfig*.json`,
   `postcss.config.mjs`, `components.json`, `package-lock.json` and `pnpm-lock.yaml`
   describe how to build an app we are not building. Leaving a `tsconfig.json` inside a
   docs tree is an invitation for a future tool to discover it as a project root. The
   dependency list is preserved as `package.json.reference` for reference only.
   `docs/_src_snapshot_2026-08-24.tgz` (a tarball of the same `src/`) was also dropped.
2. **Four hygienist names and their licence numbers were replaced with synthetic ones**
   (`Hygienist A`–`D`, `SYNTHETIC-A`–`D`) in `src/mock/offices.ts`, and the ids and
   `createdBy` strings that referenced them were renamed to match in
   `src/mock/appointments.ts`, `src/mock/submissions.ts` and `src/mock/treatment-items.ts`.
   These read as real staff first names paired with plausible Arkansas RDH licence
   numbers. Staff are not patients, so this is not the no-PHI rule — but real people's
   professional credentials do not belong in a git history either, and the mock data
   loses nothing by being synthetic. Everything else is Beau's export verbatim.

The patient fixtures needed no scrubbing: they were already synthetic
(`Test Kiwi Sample`, `Placeholder Papaya`, …) plus the designated staging test patients.

## The map, for the slices that follow

| Path | H1 verdict |
| --- | --- |
| `src/lib/dentition.ts` + its test | **ported verbatim** in slice 1 → `new-dashboard/client/src/lib/hyg/dentition.ts` |
| `src/mock/types.ts` | **mined** in slice 1 → `new-dashboard/shared/hyg/contract.ts` (zod-first; `priority` replaced, see below) |
| `src/mock/records-matrix.ts` | **ported** in slice 1 → `new-dashboard/shared/hyg/records.ts` |
| `src/features/day/*` | layout reference for slice 1's `/hyg/day` — rewritten against the real API shape |
| `src/features/visit/router/*` | slice 2 — the field inventory and section order (a)–(l), not the component code |
| `src/features/visit/finish/*` | slice 2 — the review card; its hard checks become WARNINGS, not a gate |
| `src/store/staged-writes-store.ts` | slice 2 — the state model becomes the server contract; the Zustand store itself does not survive |
| `src/features/visit/perio/*` | H4 (voice perio). Reference only. |
| `src/features/visit/ortho/*` | H2. Reference only. |
| `src/features/inbox/*`, `src/features/submissions/*` | **do not port** — the TC module already has these screens |
| `src/mock/od-snapshot.ts` | **do not port** — replaced by real Open Dental reads through `getOdOffice(officeKey)` |
| `src/components/ui/*` | **do not port** — `new-dashboard` has its own shadcn/ui set already |

## One thing the prototype gets wrong on purpose, and one it gets wrong

- **On purpose:** the voice-perio "grammar" is a scripted demo transcript. `next`,
  `back`, `skip`, `missing` and friends do not move the cursor. Fine for a UX
  prototype; do not read the README's command list as a spec for recognition.
- **Not on purpose:** `priority: 1 | 2 | 3 | 4` (P1–P4). Beau has ruled that the real
  vocabulary is `"urgent" | "preventative" | "cosmetic"` — the words his offices use.
  **P1–P4 does not ship.** See `shared/hyg/contract.ts`, which also keeps
  `TreatmentPriority` and `TreatmentCategory` structurally unassignable to each other.
