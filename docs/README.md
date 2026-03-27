# CareIn Dashboard — Docs

## Open Dental calendar integration

**Source of truth:** These docs only. Do not assume or invent Open Dental API behavior beyond what is documented here. Mark unclear or missing items as UNKNOWN and add TODO.

| Document | Purpose |
|----------|----------|
| **[OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md](./OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md)** | **Cursor master brief.** Product goal, fetch order, normalized model, derived selectors, UI rules, gotchas, phases. Use when building or refactoring the calendar view. |
| **[OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md](./OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md)** | **Backend API contract.** What the middleware must expose (`/api/opendental/...`): endpoints, query params, response shapes, implementation checklist. Use when adding or changing backend calendar routes. |
| **[OPEN_DENTAL_CALENDAR_ARCHITECTURE.md](./OPEN_DENTAL_CALENDAR_ARCHITECTURE.md)** | **Architecture & implementation plan.** File structure, TypeScript types, normalized state, selectors, UI breakdown, phased plan, missing backend routes, and **unresolved unknowns** (UNKNOWN/TODO). Start here before implementing; implement Phase 1 first. |

The brief assumes the backend fulfills the contract in the backend spec. Implement in order: read-only day calendar → drawer + patient enrichment → open slots/ASAP → realtime (subscriptions/webhooks).
