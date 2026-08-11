# new-dashboard — Conventions and decisions

Why the code looks the way it does. Verified against `origin/develop`, August 2026.
For what the app currently does, see [HANDOFF.md](HANDOFF.md). For backend contracts, see
[../CLAUDE.md](../CLAUDE.md).

The previous version of this file described a deferred "Call Log unification" and a
localhost-port world that no longer exists. It has been replaced.

---

## 1. The OfficeContext pattern

`client/src/contexts/OfficeContext.tsx`.

```ts
{ offices, office, setOffice, selected, loading }
```

It is a **real, writable, localStorage-persisted selector** (`carein.office`, sentinel
`ALL_OFFICES = "all"`), rendered as a dropdown in the sidebar. It is mounted **inside**
`RequireAuth`, so `useOffice()` throws outside the provider. A failed roster load degrades
to an empty list rather than throwing.

The rule that matters is not "the picker is cosmetic" — it is:

> **The selector scopes reads. Writes take their office from the call.**

- Reads pass it as a filter: `api.getUnifiedCalls({ office_id: office === ALL_OFFICES ? undefined : office })`.
- Actions do **not** consult it. `odConnectedForCall` resolves connectivity per row from
  `call.officeId`, because the old rule read the *selected* office and therefore offered the
  full action set on every row in the "All calls" view. Each call now answers for itself,
  from the office the **server** resolved for it.
- Every office-bearing write sends `office_id` as an **assertion the server can refuse**,
  taken from the server's own response for that call — never from `useOffice()`. See
  `SendToChartDialog.tsx`, `PickPatientModal.tsx`, `SendToTcButton.tsx`.

That is what makes a stale screen structurally unable to file a note into the wrong
practice: the client cannot name the target, only guess it and be corrected.

The office picker is hidden on TC "shared" routes.

**TC layers a second concept on top.** The backend has no all-offices query — TC's
`requireOffice` rejects anything non-concrete — so `ALL_OFFICES` inside TC is a
**client-side fan-out** over concrete offices, tolerant of partial failure, with
`showOfficeBadges` gating the presentational `<OfficeBadge>`. `OfficeBadge` reads no context
on purpose so list components stay testable without a provider.

---

## 2. HTTP clients — there are three

This is the single most common source of confusion in this package. They do not share
error handling.

### `api` — `client/src/lib/api.ts` (the main backend)

```ts
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";
```

`apiFetch` resolves `path` against `new URL(..., window.location.origin)`. That is what
makes a **relative** `VITE_API_URL=/api` work identically by hostname, LAN IP, or behind
the Azure ingress. It requires the env var to be set — the `localhost:5000` default is a
dev fallback and matches no deployment.

Every request sends `credentials: "include"` (the HttpOnly Entra SSO cookie) plus
`Authorization: Bearer <VITE_DASHBOARD_API_TOKEN>` when that variable is non-empty. Auth
routes are separate: `client/src/lib/auth.ts` derives `AUTH_BASE` by stripping a trailing
`/api`.

```ts
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
}
```

Shape is exactly `{ name: "ApiError", message, status, code }` — no body, no issues. The
message falls back through `err.message → err.error → res.statusText → HTTP <status>`.
`ApiError` still extends `Error` deliberately, so the many
`err instanceof Error ? err.message` call sites keep working unchanged.

Two handling tiers:

- **Default** — `toast.error(err instanceof Error ? err.message : "…", { duration: 8000 })`,
  and on failure, reload from the server rather than patching local state optimistically.
- **Precise** — narrow with `err instanceof ApiError` and branch on `.code`, then `.status`.
  `SendToTcButton.tsx` is the reference implementation and currently the only one.

**There is no retry, no backoff, no timeout, and no `AbortController` in `api.ts`.**
Cancellation is done ad hoc by callers with `let cancelled = false` closures. The
`retryAfterMinutes` field on `TranscribeResult` is informational; no code acts on it.

The one escape hatch: `transcribeMangoCall` uses raw `apiFetch` rather than the throwing
`request<T>` wrapper, because budget-spent / recording-not-ready / already-running are
**answers, not errors** and must reach the UI as a typed body.

### `careInApi` — same file, weaker contract

`CAREIN_BASE` falls back to `${window.location.origin}/api` in production builds. Its
wrapper `careInRequest` has **no credentials, no bearer token, and no `ApiError`** — it
throws a bare `Error`. It talks to the local Express sub-server in `server/index.ts`, not
the main backend. Consumers: the "CareIN Log" tab, `Analytics.tsx`, `CareInCallDetail.tsx`.

### `TcApiError` — `client/src/features/tc/api.ts`

`/api/tc` errors carry `{ success, error, code }` with the message under `error`, so the
main wrapper would surface "HTTP 403" instead of `MODULE_NOT_ENTITLED`. `TcApiError` adds
`feature` (for 501 `FEATURE_DISABLED`) and `issues` (validation).

Standing rule for that module: **none of the TC api functions toast.** They resolve with
the server's persisted row or throw; callers toast success *only* after the promise
resolves and keep dialogs open on rejection.

> Naming collision to watch: `tcErrorMessage` exists in **both** `lib/sendToTc.ts`
> (signature `(status, code)`) and `features/tc/api.ts` (signature `(err: unknown)`). They
> are unrelated.

---

## 3. Testing conventions

Runner config is `vitest.config.ts`, **separate** from `vite.config.ts`.

- `esbuild: { jsx: "automatic" }` — required because the app tsconfig uses
  `jsx: "preserve"` and vitest runs without `@vitejs/plugin-react`.
- Default environment is `node`; **`.tsx` files get jsdom** via `environmentMatchGlobs`.
  The extension is what buys you a DOM.
- `include` is `tests/**/*.test.ts(x)` — a flat directory, no colocated tests.
- Aliases `@` and `@shared` mirror `vite.config.ts`.
- Tests are excluded from `tsc --noEmit`.

Pattern to follow: put decision logic in a pure module under `lib/` (`worklist.ts`,
`transcribe.ts`, `sendToTc.ts`) and test it as `.test.ts` with no DOM; test the rendered
affordance separately as `.test.tsx`. `send-to-tc.test.tsx` and `send-to-tc-reactivity.test.tsx`
are a good example of the split — the second exists specifically to pin a bug where the
button needed a page refresh to appear.

Every fixture is synthetic. Do not introduce a real patient name, phone, or DOB.

---

## 4. Decisions worth not re-litigating

**Closed unions over string checks.** `TranscribeStatus` is a closed union of the backend's
ten outcomes so a new outcome is a compile error, not a silent generic toast. Same
motivation for `CallLinkRole`. If the backend adds an outcome, the type is where you find
out.

**A failure never reads as success.** No optimistic patching on any office- or chart-bearing
write. A 2xx without the expected payload is treated as a failure. Error copy on those paths
ends in "nothing was sent" on purpose.

**Confirmations, not lockouts.** Re-transcribing a `no_speech` call and transcribing a
duplicate leg both cost money and are both occasionally correct. The UI asks; it does not
refuse.

**A failed attempt does not consume the affordance.** Any transcribe outcome other than
`completed` / `exists` / `no_speech` returns the button to `idle`.

**Concurrency guards use refs, not state.** A double-click must be a no-op *before* the next
render, which state cannot guarantee.

**`transferred_leg` is deliberately unbadged and unhidden.** Only `duplicate_leg` is hidden
from "Needs attention" and badged "Answered by CareIN AI". A transferred leg contains the
human half of the conversation, which the AI transcript does not.

**`FILEABLE_OFFICES` is hardcoded** to `{roland, valley}` in `lib/sendToTc.ts`. When a third
office is added to the backend registry, this set must be updated too — it will not follow
automatically.

---

## 5. Known rough edges

- `hasLinkedTwin()` in `lib/worklist.ts` is exported but unused.
- `CallWorklist.tsx` has literal `backgroundColor: "white"` on the sort and source toggles,
  which is the exact pattern `dark-mode-contrast.test.ts` scans for.
- `socket.io-client` is still a dependency but nothing under `client/src` imports it.
  `activity.md` references a `contexts/SocketContext.tsx` that does not exist.
- `package.json` declares `vitest ^2.1.4` and `@vitest/coverage-v8 ^2.1.9`; they resolve to
  the same version in the lockfile, but the declared ranges do not match.
- `CHANGELOG.md`, `activity.md`, `plan.md`, and `ideas.md` are all frozen around May 2026
  and contain stale ports (5000, 5001) and a `SocketContext` that was never built. Treat
  them as history.
