# new-dashboard — Handoff

The active CareIN UI. Verified against `origin/develop`, August 2026.

The previous version of this file described the "CareIN Log" sub-feature as if it were the
whole app, and predated per-office Open Dental, on-demand transcription, Send to TC, and
twin linking. It has been replaced. For backend contracts see [../CLAUDE.md](../CLAUDE.md);
for frontend conventions see [NOTES.md](NOTES.md).

---

## Stack

| | |
| --- | --- |
| React | 19.2.1 |
| Vite | 7 (`vite --host`, dev port 3005) |
| TypeScript | 5.6.3, **`strict: true`** |
| Styling | Tailwind **v4** via `@tailwindcss/vite` (a Vite plugin, not PostCSS) |
| Components | shadcn/ui "new-york" on Radix — 60 primitives in `client/src/components/ui/` |
| Routing | wouter 3.7.1, **patched** (`patches/wouter@3.7.1.patch` injects route paths into `window.__WOUTER_ROUTES__`) |
| Charts | Recharts 2 |
| Validation | zod **v4** |
| Tests | Vitest 2 + jsdom 30 + Testing Library 16 |
| Package manager | **pnpm** (the backend uses npm — don't mix them) |

There is **no state or query library.** No react-query, no zustand, no redux. State is
`useState` + `useEffect` plus four hand-rolled contexts: `AuthContext`, `ModuleContext`,
`OfficeContext`, `ThemeContext`.

The wouter patch is why `pnpm.patchedDependencies` exists. Migrating this package to npm
would silently drop it.

## Layout

```
new-dashboard/
  client/src/          the app
    pages/             route components (calls/, tc/, …)
    components/        shared + ui/ (shadcn)
    features/          tc/ (~90 files), calendar/
    contexts/          Auth, Module, Office, Theme
    hooks/             useTranscribeCall, …
    lib/               api.ts, worklist.ts, transcribe.ts, sendToTc.ts, auth.ts
  server/              the CareIN-log Express sub-server (esbuild bundle)
  shared/tc/           zod contract shared with the backend
  tests/               45 files, ~590 cases, flat (no colocated tests)
```

## Scripts

```bash
pnpm install --frozen-lockfile
pnpm run dev            # vite --host, port 3005
pnpm run build          # vite build + esbuild the server bundle → dist/
pnpm run check          # tsc --noEmit   ← the typecheck script is `check`
pnpm run test           # vitest run
pnpm run test:coverage  # vitest run --coverage
pnpm run format         # prettier --write .
```

There is **no `typecheck` script and no lint script.** CI runs `pnpm run check` then
`pnpm run test`.

Tests are **excluded from `tsc --noEmit`** (`tsconfig.json:3`), so a type error inside
`tests/` will not fail `check`.

---

## Worklist features

The worklist is `client/src/pages/calls/CallWorklist.tsx`, rendered as the first tab of
`pages/Calls.tsx`. Pure decision rules live in `client/src/lib/worklist.ts` so they can be
tested without a DOM.

Shell: a "Needs attention" / "All calls" toggle with a count badge, search, newest/oldest
sort (persisted to `carein.worklist.sort`), a source filter (All / CareIN AI / Staff), a
`Sync` button, five disposition chips that double as filters, and an "Oldest unhandled: Nd"
nudge once the backlog passes two days. Four columns: Caller, Patient, Signals, Triage.

### Twin badges

There is **one** twin badge: **"Answered by CareIN AI"** (`lib/transcribe.ts:110`,
`ANSWERED_BY_AI_BADGE`). It renders **only for `link_role === 'duplicate_leg'`**, as a link
to the twin Retell call, with `stopPropagation` so it isn't swallowed by the row link.

The same string is also the fifth disposition chip and the only member of
`ALL_CALLS_ONLY_CHIPS` — selecting it force-switches the view to "All calls", because the
default view hides those rows. It is deliberately excluded from the per-row Signals cell so
it can't render twice.

**`transferred_leg` gets no badge at all** and stays in the worklist like any other staff
call. That is intentional: its recording is the *human* half of a conversation the AI's
transcript does not contain, so hiding it would hide real work.

`hasLinkedTwin()` exists in `lib/worklist.ts` but is not consumed by any component today.

### Link-only

`client/src/pages/calls/PickPatientModal.tsx`, dialog titled **Match patient**. The button
is **`Link`** (in-flight: `Linking…`), calling
`api.resolvePatient(call.id, { patientId, linkOnly: true, office_id })`.

Result: the row moves to **matched-but-not-sent** — `odPatientId` set, `odSyncStatus` not
`synced`, **nothing written to the chart**. The patient cell then shows `Matched: {name}`
plus two independent buttons, `Send to chart` and `Send to TC`.

The same modal hosts the not-a-patient close-out (`Close out` + a reason: spam, solicitor,
vendor, lab, wrong number, other), which is a separate call with `{ notAPatient: true }`.

Patient-cell states: OD-not-connected (two variants — unknown office vs named office),
`Not a patient · reason`, `Sent · {name}`, `Matched: {name}`, and unmatched, labelled
`Needs match (N)` when stored candidates exist, else `Unmatched`.

### Send to TC

`components`: `client/src/pages/calls/SendToTcButton.tsx`; pure logic in
`client/src/lib/sendToTc.ts`. Used in the worklist (both the `synced` and `matched`
branches) and in the call-detail patient panel with `variant="panel"`.

Visibility, in order (`sendToTcState`):

| Condition | Result |
| --- | --- |
| Tenant lacks the `tc` module | `hidden` |
| No `odPatientId` | `hidden` |
| `officeId` not in `FILEABLE_OFFICES` (`{roland, valley}`, hardcoded) | `hidden` |
| `tcCaseId` already set | `sent` |
| `odPatientName` blank | `disabled`, reason "patient name unavailable" |
| otherwise | `ready` |

States: `Send to TC` → `Sending…` → a success toast that distinguishes *already in TC* /
*added to an existing case* / *case created*, with an "Open in TC" action → the button
becomes a passive violet **`In TC`** pill.

`office_id` is sent as an **assertion**, not a selector — the server resolves the real
office from the call and refuses on mismatch.

This is the app's canonical `ApiError` consumer: it narrows on `err instanceof ApiError`
and maps `.code` then `.status` to specific copy (`MODULE_NOT_ENTITLED`, `OFFICE_MISMATCH`,
`OFFICE_UNKNOWN`, `NO_MATCHED_PATIENT`, `PATIENT_NAME_UNAVAILABLE`, default). Every message
ends in "nothing was sent". Nothing is patched optimistically; a 2xx without a `caseId` is
treated as a failure.

### Transcribe states

The UI switches on the response's **`status` field, never the HTTP code**. `TranscribeStatus`
in `lib/api.ts:103` is a closed union of ten values so that a new backend outcome is a
compile error rather than a silent "something went wrong" toast:

| `status` | Toast |
| --- | --- |
| `completed` | Transcribed and summarized (X.X min of audio). |
| `exists` | This call already has a transcript — nothing was re-run. |
| `in_progress` | This call is already being transcribed — hang tight. |
| `budget_exhausted` | Daily transcription budget is used up — resets at {time}. |
| `recording_not_ready` | Recording isn't ready yet — try again in a few minutes. |
| `recording_unavailable` | Recording is no longer available from the phone system. |
| `no_speech` | No speech was detected in this recording. |
| `unavailable` | Transcription isn't set up in this environment yet. |
| `not_found` | That call is no longer in the worklist. |
| `error` | Transcription failed — nothing was saved. Try again. |

Error toasts last 8 s, others 4 s. Button state: `completed`/`exists` → `done`,
`no_speech` → `no_speech`, everything else → `idle` — *a failed attempt never consumes the
affordance.*

Two confirmation dialogs guard spend, and both are **confirmations, not lockouts**
(`components/calls/TranscribeRebillDialog.tsx`): re-transcribing a `no_speech` call, and
transcribing a `duplicate_leg` whose AI twin already has a transcript. The duplicate-leg
check runs first and offers an "Open the AI call" link.

Concurrency is guarded by a `useRef<Set<string>>` rather than state, so a fast double-click
is a no-op before any render.

Labels differ by placement: `Transcribe` in the worklist row, **`Transcribe & Summarize`**
on the call detail page.

---

## Test status

`pnpm run test` — **45 files, 593 cases, all green** (verified 2026-08-10, alongside a clean
`pnpm run check`). (The old "136 tests across 4 files" line
referred to the original CareIN-server tests, which are still there but are now a
minority: `ingestion` 59, `analytics` 51, `fixture-ingestion` 15, `commlog` 11.)

Coverage thresholds (75%) apply only to `test:coverage`, which CI does not run, and the
`include` list is just three `server/lib/*.ts` files — the number says nothing about client
coverage.

Notable suites: `worklist`, `transcribe` + `transcribe-button`, `twin-link`,
`link-patient-only`, `send-to-tc` + `send-to-tc-reactivity`, `per-location-office`,
`modules`, `module-home`, and ~25 TC suites. `tc-contract-bundle` is a drift guard against
the backend's committed contract bundle — see [../CLAUDE.md](../CLAUDE.md) §5 if it goes
red locally.

`dark-mode-contrast.test.ts` is unusual: it is a **source scanner**, not a runtime test. It
greps for hardcoded light backgrounds that would bypass the dark-mode token flip. Worth
knowing that `CallWorklist.tsx` still has literal `backgroundColor: "white"` on the sort and
source toggles.

Fixtures are synthetic by construction. Never introduce a real patient name.

---

## Deployed shape

The built SPA is served by Caddy (`root * /srv`, `try_files {path} /index.html`); `/api/*`,
`/auth/*`, and `/socket.io/*` are reverse-proxied to the backend. Build with
`VITE_API_URL=/api` so the bundle resolves the API against `window.location.origin` and the
same artifact works by hostname, LAN IP, or behind the Azure ingress.

On the PM2 workstation, `carein-dashboard` runs the **esbuild bundle** at `dist/index.js`,
so `pnpm build` must precede `pm2 reload`. Note that PM2 gives that process port **3005** —
the same port the Vite dev server wants. They cannot both run.

### About hard refreshes after deploy

Assets are content-hashed by Vite (stock `assets/[name]-[hash].js`), and **there is no
service worker**, so stale JS is not a real failure mode. The one genuine exposure is
`index.html`: Caddy's `file_server` sends `ETag` and `Last-Modified` but **no
`Cache-Control`**, which leaves it to browser heuristic caching. If you ever want to
guarantee no hard refresh is needed, add `header /index.html Cache-Control "no-cache"` to
both `deploy/Caddyfile` and `deploy/container/Caddyfile`. Nothing in the repo documents a
hard-refresh requirement today.

(The `no-cache, no-store` block you may find in the repo-root `nginx.conf` serves the
deprecated `frontend/` app, not this one.)
