# Slot Markers — Autonomous Build Prompt for Claude in Cursor

> **Instructions for Claude in Cursor:** Read this entire file before writing a single line of code. Follow every rule, phase, and audit gate exactly as written. Do not skip ahead. Do not ask for clarification — all decisions have been made and are documented here. Your job is to build, verify, and move forward.

---

## Your Role

You are the full-stack developer building the **Slot Markers** feature for the CareIN dental practice dashboard. The feature design has been fully approved. You are executing it autonomously, phase by phase, with self-auditing after each phase. Beau (the owner) will review your work when you are done — he is not available to answer questions during the build.

---

## Autonomous Execution Rules

1. **Complete one phase fully before starting the next.** Never begin Phase N+1 until Phase N passes its audit gate.
2. **Run `tsc --noEmit` after every file change.** Fix all TypeScript errors before continuing. Zero errors is the only acceptable state.
3. **Maximum 20 attempts per audit gate.** If you cannot pass a gate after 20 attempts, write a `BLOCKED.md` file at the project root documenting exactly what you tried, what failed, and what the current error state is. Then stop — do not move to the next phase.
4. **Track attempt count explicitly.** Before each attempt, note in your reasoning: "Attempt N of 20 for Phase X audit gate."
5. **Never use `any` types.** TypeScript strict mode is on. Use `unknown` and narrow properly.
6. **Never modify files outside the allowed list.** The list is in each phase. If you think you need to touch an unlisted file, stop and document it in `BLOCKED.md` instead.
7. **Never write to Open Dental MySQL or call a real connector endpoint.** All data comes from mock data. The connector is out of scope.
8. **Commit after each phase passes its audit gate.** Use message format: `feat: slot markers phase N — <short description>`

---

## Project Context

### Stack
- **Frontend:** React + Vite + TypeScript (strict mode)
- **UI components:** shadcn/ui (Radix primitives) — already installed
- **Icons:** `lucide-react` v0.453.0 — already installed
- **Styling:** Tailwind CSS
- **Toast notifications:** `sonner` — already installed
- **Path alias:** `@/` maps to `new-dashboard/client/src/`

### Working directory
All work is inside: `new-dashboard/client/src/`

### TypeScript check command
```bash
cd new-dashboard && npx tsc --noEmit
```
Run this from the `new-dashboard/` directory, not the repo root.

### Existing calendar feature (read — do not modify core files)
The calendar feature lives in `features/calendar/`. Key files to read and understand before Phase 2:
- `features/calendar/components/OperatoryColumn.tsx` — this is where you inject `SlotMarkerCard`
- `features/calendar/components/AppointmentCard.tsx` — copy the pixel-positioning formula from here
- `features/calendar/store/CalendarContext.tsx` — understand how the existing context works; yours must follow the same pattern
- `features/calendar/components/OpenSlots.tsx` — you will modify this in Phase 3
- `pages/Scheduling.tsx` — you will modify this in Phase 4

---

## Open Dental Setup (already done by Beau — read only)

- **CareIN Block patient PatNum:** `13290`
- **8 OD appointment types created** (names and colors set in OD, actual `appointmentTypeNum` values TBD — use `0` as placeholder in config until Beau fills them in)

| Category Key | OD Display Name |
|---|---|
| `new-patient` | CareIN — New Patient |
| `emergency` | CareIN — Emergency |
| `hygiene` | CareIN — Hygiene |
| `asap` | CareIN — ASAP |
| `restorative-fillings` | CareIN — Restorative: Fillings |
| `restorative-production` | CareIN — Restorative: Production |
| `restorative-extractions` | CareIN — Restorative: Extractions |
| `restorative-pediatric` | CareIN — Restorative: Pediatric |

---

## Data Types (implement exactly as specified)

### `features/slotMarkers/types.ts`

```typescript
export type SlotCategory =
  | "new-patient"
  | "emergency"
  | "hygiene"
  | "asap"
  | "restorative-fillings"
  | "restorative-production"
  | "restorative-extractions"
  | "restorative-pediatric";

export interface SlotMarker {
  id: number;
  date: string;         // "YYYY-MM-DD"
  startTime: string;    // "HH:MM" 24-hour — same format as appointment.time
  duration: number;     // minutes
  operatoryId: number;
  operatoryName: string;
  providerId?: number;
  providerName?: string;
  category: SlotCategory;
  clinicNum: number;
}

export interface SlotCategoryMeta {
  label: string;
  color: string;        // hex
  icon: string;         // lucide-react icon name — verified below
}
```

### `features/slotMarkers/config.ts`

```typescript
import type { SlotCategory, SlotCategoryMeta } from "./types";

export const CAREIN_BLOCK_PATNUM = 13290;

// Set to false when the connector /slot-markers endpoint is live
export const USE_MOCK_SLOT_MARKERS = true;

export const SLOT_CATEGORIES: Record<SlotCategory, SlotCategoryMeta> = {
  "new-patient":             { label: "New Patient",              color: "#3B82F6", icon: "UserPlus" },
  "emergency":               { label: "Emergency",                color: "#EF4444", icon: "AlertCircle" },
  "hygiene":                 { label: "Hygiene",                  color: "#22C55E", icon: "Sparkles" },
  "asap":                    { label: "ASAP",                     color: "#F97316", icon: "Zap" },
  "restorative-fillings":    { label: "Restorative: Fillings",    color: "#8B5CF6", icon: "Wrench" },
  "restorative-production":  { label: "Restorative: Production",  color: "#6D28D9", icon: "Crown" },
  "restorative-extractions": { label: "Restorative: Extractions", color: "#991B1B", icon: "Scissors" },
  "restorative-pediatric":   { label: "Restorative: Pediatric",   color: "#0D9488", icon: "Heart" },
};

// Beau fills these in after OD appointment types are created
// Use 0 as placeholder — the connector will do the real mapping later
export const OD_APPT_TYPE_TO_CATEGORY: Record<number, SlotCategory> = {};
```

> **Icon verification:** All 8 icon names above (`UserPlus`, `AlertCircle`, `Sparkles`, `Zap`, `Wrench`, `Crown`, `Scissors`, `Heart`) are confirmed present in lucide-react v0.453.0. Also use `Square` for the marker badge icon on `SlotMarkerCard`. Do not use any other icon names without verifying they exist in the installed package first.

---

## Phase 1 — Foundation

**Goal:** Create the `features/slotMarkers/` module with all types, config, mock data, API stub, context, hooks, and barrel export.

### Files to create (no existing files modified in Phase 1)

**`features/slotMarkers/types.ts`** — as specified above

**`features/slotMarkers/config.ts`** — as specified above

**`features/slotMarkers/mockData.ts`**

Provide at least 2 markers per category (16 total minimum), spread across the next 3 weeks. Use hardcoded date strings — do NOT use `new Date()` to generate them, as that will break on different run dates. Use operatoryId values of 1, 2, and 3 as placeholders (Beau will update these to match real OD operatory IDs later). All times in `"HH:MM"` 24-hour format. Durations must match typical dental appointment lengths (30, 60, or 90 minutes).

Example structure (fill out all 8 categories):
```typescript
import type { SlotMarker } from "./types";

export const MOCK_SLOT_MARKERS: SlotMarker[] = [
  { id: 9001, date: "2026-04-22", startTime: "09:00", duration: 60,  operatoryId: 1, operatoryName: "Op 1", category: "new-patient",            clinicNum: 1 },
  { id: 9002, date: "2026-04-23", startTime: "14:00", duration: 60,  operatoryId: 2, operatoryName: "Op 2", category: "new-patient",            clinicNum: 1 },
  { id: 9003, date: "2026-04-22", startTime: "08:00", duration: 60,  operatoryId: 1, operatoryName: "Op 1", category: "emergency",              clinicNum: 1 },
  { id: 9004, date: "2026-04-24", startTime: "11:00", duration: 60,  operatoryId: 3, operatoryName: "Op 3", category: "emergency",              clinicNum: 1 },
  // ... continue for all 8 categories, 2 entries each
  // spread dates across 2026-04-21 through 2026-05-09
];
```

**`features/slotMarkers/api.ts`**

```typescript
import type { SlotMarker, SlotCategory } from "./types";
import { USE_MOCK_SLOT_MARKERS } from "./config";
import { MOCK_SLOT_MARKERS } from "./mockData";

export interface GetSlotMarkersParams {
  startDate: string;
  endDate: string;
  clinicNum: number;
  category?: SlotCategory;
}

export async function getSlotMarkers(
  params: GetSlotMarkersParams
): Promise<SlotMarker[]> {
  if (USE_MOCK_SLOT_MARKERS) {
    return Promise.resolve(
      MOCK_SLOT_MARKERS.filter(
        (m) =>
          m.date >= params.startDate &&
          m.date <= params.endDate &&
          (params.category === undefined || m.category === params.category)
      )
    );
  }
  const url = new URL("/api/slot-markers", window.location.origin);
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);
  url.searchParams.set("clinicNum", String(params.clinicNum));
  if (params.category) url.searchParams.set("category", params.category);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load slot markers");
  return res.json() as Promise<SlotMarker[]>;
}
```

**`features/slotMarkers/SlotMarkersContext.tsx`**

Follow the exact same pattern as `features/calendar/store/CalendarContext.tsx`. The context must:
- Load markers on mount by calling `getSlotMarkers` for today through +6 months
- Expose `markers: SlotMarker[]`, `loading: boolean`, `error: string | null`, `refresh: () => void`
- Export a `SlotMarkersProvider` wrapper component
- Export a `useSlotMarkers()` hook that throws if used outside the provider

Use `clinicNum: 1` as default for now (Beau will wire the real clinic later).

**`features/slotMarkers/useSlotMarkers.ts`**

```typescript
// Three hooks — all read from SlotMarkersContext via useSlotMarkers()

// Returns markers for a single date
export function useSlotMarkersForDate(date: string): SlotMarker[]

// Returns markers for a date range, optionally filtered by category
export function useSlotMarkersForRange(
  startDate: string,
  endDate: string,
  category?: SlotCategory
): SlotMarker[]

// Returns count per category for the next 30 days from today
export function useSlotMarkerSummary(): Record<SlotCategory, number>
```

For `useSlotMarkerSummary`, today's date must be computed at render time (`new Date().toISOString().split("T")[0]`), not hardcoded.

**`features/slotMarkers/index.ts`** — barrel export:

```typescript
export type { SlotMarker, SlotCategory, SlotCategoryMeta } from "./types";
export { CAREIN_BLOCK_PATNUM, USE_MOCK_SLOT_MARKERS, SLOT_CATEGORIES, OD_APPT_TYPE_TO_CATEGORY } from "./config";
export { MOCK_SLOT_MARKERS } from "./mockData";
export { getSlotMarkers } from "./api";
export type { GetSlotMarkersParams } from "./api";
export { SlotMarkersProvider, useSlotMarkers } from "./SlotMarkersContext";
export { useSlotMarkersForDate, useSlotMarkersForRange, useSlotMarkerSummary } from "./useSlotMarkers";
```

**Mount `SlotMarkersProvider` in `App.tsx`**

Wrap the existing app tree with `<SlotMarkersProvider>` so both the calendar view and the scheduling page can consume markers. Read `App.tsx` first to find the right insertion point — do not restructure the existing tree, just wrap.

### Phase 1 Audit Gate

Run `tsc --noEmit` from the `new-dashboard/` directory. Zero errors required.

Also verify manually:
- [ ] All 6 files created in `features/slotMarkers/`
- [ ] `SlotMarkersProvider` mounted in `App.tsx`
- [ ] `useSlotMarkers()` hook throws a descriptive error if used outside the provider
- [ ] All types exported from `index.ts`
- [ ] No `any` types anywhere in the new files

**Maximum 20 attempts to pass this gate. If you cannot pass after 20, write `BLOCKED.md` and stop.**

Commit on pass: `feat: slot markers phase 1 — foundation, types, context, hooks`

---

## Phase 2 — Calendar Rendering

**Goal:** Render slot markers visually on the calendar inside `OperatoryColumn`. Markers must look distinct from real appointments.

### Files to create

**`features/calendar/components/SlotMarkerCard.tsx`**

This component renders a single marker absolutely positioned inside the operatory column. Follow the exact same positioning formula as `AppointmentCard.tsx`:

```typescript
// TIME_RAIL_START = 8, PIXELS_PER_HOUR = 64
const [hour, min] = marker.startTime.split(":").map(Number);
const top = ((hour - 8) * 60 + min) * (64 / 60);
const height = Math.max(marker.duration * (64 / 60), 28);
```

Import `TIME_RAIL_START` from `../components/CalendarTopBar` if exported, or hardcode `8` with a comment explaining it matches `TIME_RAIL_START`.

Visual treatment:
- `position: absolute`, `left: 4px`, `right: 4px` (same inset as AppointmentCard)
- Background: category color at **40% opacity** — use `${color}66` (hex + alpha)
- Left border: `3px solid <category color>` (full opacity)
- Border radius: `6px`
- Display: category label (e.g. "New Patient Block") — no patient name ever
- Small `Square` icon from lucide-react in top-right corner (size 10) to distinguish from real appointments
- On click: open `SlotMarkerTooltip` (see below) — do NOT trigger the AppointmentDrawer
- When the card height > 48px, also show time and duration below the label

Props:
```typescript
interface SlotMarkerCardProps {
  marker: SlotMarker;
}
```

**`features/calendar/components/SlotMarkerTooltip.tsx`**

Use the Radix `Popover` from `@/components/ui/popover` (already installed). The `SlotMarkerCard` controls the open state. Popover content shows:
- Category label (bold)
- Time: `startTime` formatted as 12-hour (e.g. "9:00 AM")
- Duration: `Xmin`
- Operatory name
- Provider name if present
- Footer line: "Set in Open Dental — edit there to move or remove"

### Files to modify

**`features/calendar/components/OperatoryColumn.tsx`**

Read the current file first. After the existing `cards.map()` block (inside the `absolute inset-0` wrapper div), add:

```tsx
{markersForColumn.map((m) => (
  <SlotMarkerCard key={m.id} marker={m} />
))}
```

Where `markersForColumn` comes from:
```typescript
const selectedDate = state.ui.selectedDate;
const markersForColumn = useSlotMarkersForDate(selectedDate).filter(
  (m) => m.operatoryId === operatoryId
);
```

Import `useSlotMarkersForDate` from `@/features/slotMarkers`. Import `SlotMarkerCard` from `./SlotMarkerCard`.

**Important:** `OperatoryColumn` already uses `useCalendarState()`. Adding `useSlotMarkersForDate` requires `SlotMarkersProvider` to be mounted above it in the tree — which was done in Phase 1 via `App.tsx`. Do not move the provider.

### Phase 2 Audit Gate

Run `tsc --noEmit`. Zero errors required.

Also verify manually (run the dev server with `npm run dev` from `new-dashboard/`):
- [ ] Markers appear on the calendar grid for dates that have mock data
- [ ] Markers are visually distinct from real appointments (semi-transparent, no patient name, Square icon)
- [ ] Markers are correctly time-positioned (a 9:00 AM marker appears at the 9 AM row)
- [ ] Clicking a marker opens the Popover (not the AppointmentDrawer)
- [ ] Popover shows correct category label, time, duration, operatory
- [ ] Real appointments still render normally — nothing broken
- [ ] No console errors

**Maximum 20 attempts. If you cannot pass after 20, write `BLOCKED.md` and stop.**

Commit on pass: `feat: slot markers phase 2 — SlotMarkerCard rendering in OperatoryColumn`

---

## Phase 3 — Open Slots Category Filter

**Goal:** Update the Open Slots tab to show markers by category. Markers are the sole source of slots in category mode.

### Files to modify

**`features/calendar/components/OpenSlots.tsx`**

Read the entire current file before modifying. Key changes:

**1. Add category state:**
```typescript
const [selectedCategory, setSelectedCategory] = useState<SlotCategory | "all">("all");
```

**2. Add category selector UI** — insert above the existing duration/time-preference row:

```
[ All ] [ New Patient ] [ Emergency ] [ Hygiene ] [ ASAP ] [ Restorative ▾ ]
```

"Restorative" is a `DropdownMenu` (from `@/components/ui/dropdown-menu`, already installed) listing the four restorative sub-types.

**3. Category mode replaces `findAvailableSlots`:**

When `selectedCategory !== "all"`:
- Do NOT call `api.findAvailableSlots()` — skip it entirely
- Call `useSlotMarkersForRange(startDate, endDate, selectedCategory)` to get slots
- Map each `SlotMarker` to a slot card displaying: time, duration, category badge, provider abbr if present

When `selectedCategory === "all"` (default):
- Show all markers across all categories grouped by date
- Do NOT show the old `findAvailableSlots` results — the "All" view is now a full marker overview
- Each slot card shows the category badge with its color

**4. Remove or hide the metrics grid** when in category mode — the `availabilityPercentage` metric comes from `getScheduleOverview()` which is a backend call. Keep the metrics grid visible only when the old "All" behavior would have shown it. If it fails to load (which it will in mock mode), show nothing rather than an error — use a `.catch(() => null)` and conditionally render.

**5. Empty states:**

Category mode (no markers found):
```
No [Category Label] blocks scheduled for this period.
Staff can add availability in Open Dental by placing a
"CareIN — [Category]" appointment for the CareIN Block patient.
```

All mode (no markers at all):
```
No slot markers found for this period.
Staff can add availability blocks in Open Dental.
```

**6. Slot card in category mode:**
Reuse the same card structure as the current slot cards, but add:
- A colored badge showing the category label
- Remove the duration selector (not needed in category mode — duration comes from the marker)

The duration selector and time-preference selector remain visible in "All" mode.

### Phase 3 Audit Gate

Run `tsc --noEmit`. Zero errors required.

Also verify manually:
- [ ] Category selector renders above existing filters
- [ ] Selecting "New Patient" shows only new-patient markers from mock data
- [ ] Selecting "All" shows all markers grouped by date with category badges
- [ ] Restorative dropdown contains all 4 sub-types and selecting one filters correctly
- [ ] Empty state shows when no markers match the selected category
- [ ] `findAvailableSlots` is NOT called when a specific category is selected
- [ ] Metrics grid hidden gracefully in category mode (no error shown)
- [ ] Voice agent info banner at bottom of OpenSlots is updated to mention block-driven scheduling

**Maximum 20 attempts. If you cannot pass after 20, write `BLOCKED.md` and stop.**

Commit on pass: `feat: slot markers phase 3 — Open Slots category filter`

---

## Phase 4 — Scheduling Page Update

**Goal:** Add a "Slot Marker Rules" card and 30-day summary to the Scheduling page's AI Rules tab.

### Files to modify

**`pages/Scheduling.tsx`**

Read the entire file first. The `SchedulingRules` component currently has two cards: Appointment Types and Scheduling Rules. Add a **third card** after them.

**Card: Slot Marker Scheduling**

```
Title: Slot Marker Scheduling
Icon: CalendarClock (already imported in the file)

Body:
The CareIN voice agent uses slot markers to determine what appointments
are available. Markers are placed by staff in Open Dental using the
"CareIN Block" patient.

Rules (read-only list — use the same visual style as the existing
availability rules but with no toggle switch):

  • Voice agent only offers times where a matching CareIN slot marker exists
  • No matching marker = no booking — caller is transferred to a team member
  • Agent looks up to 6 months ahead across all scheduled markers
  • Staff control all capacity by adding or removing markers in Open Dental

Footer:
"To add availability: open Open Dental → schedule → place an appointment
for the CareIN Block patient → select the correct CareIN appointment type."
```

**30-day Marker Summary section** (below the three cards, same visual level):

Title: "Next 30 Days — Slot Marker Availability"

Show a grid (2 columns on mobile, 4 on desktop) with one tile per category. Each tile:
- Category color dot (10px circle)
- Category label
- Count of markers in the next 30 days from today

Use `useSlotMarkerSummary()` from `@/features/slotMarkers`. If all counts are 0, show a notice:
```
No slot markers found for the next 30 days.
Ask your team to add availability blocks in Open Dental.
```

**Important:** `useSlotMarkerSummary` requires `SlotMarkersProvider` to be in the tree. It was mounted in `App.tsx` in Phase 1, so this will work without any additional provider wrapping.

### Phase 4 Audit Gate

Run `tsc --noEmit`. Zero errors required.

Also verify manually:
- [ ] "Slot Marker Scheduling" card renders as the third card in AI Rules tab
- [ ] Rules list is read-only (no toggles)
- [ ] 30-day summary grid renders below the cards
- [ ] Counts match the mock data (count manually from `mockData.ts` for the next 30 days)
- [ ] Zero-count notice appears if all categories have 0 markers in range
- [ ] No layout breakage on the Scheduling page

**Maximum 20 attempts. If you cannot pass after 20, write `BLOCKED.md` and stop.**

Commit on pass: `feat: slot markers phase 4 — Scheduling page Slot Marker Rules card`

---

## Phase 5 — Final Self-Audit

**Goal:** Verify the entire feature end to end. Fix anything found. This phase has no new code — it is a quality gate only.

### Full checklist

**TypeScript**
- [ ] `tsc --noEmit` passes with zero errors
- [ ] Grep for `any` types in `features/slotMarkers/` and the 3 modified files — zero hits
- [ ] All new interfaces and types exported from `features/slotMarkers/index.ts`

**Scope**
- [ ] No OD MySQL queries anywhere in new or modified files
- [ ] No calls to real connector endpoints (all data flows through the `api.ts` stub)
- [ ] `USE_MOCK_SLOT_MARKERS` is `true` — confirmed in `config.ts`
- [ ] `calendarStore.ts` is unchanged
- [ ] `calendarSelectors.ts` is unchanged
- [ ] `features/calendar/types.ts` is unchanged
- [ ] `CalendarGrid.tsx` is unchanged

**Calendar rendering**
- [ ] Markers appear in the correct operatory column
- [ ] Markers are time-positioned correctly using the pixel formula
- [ ] Markers do not overlap or obscure real appointments (they are siblings, not replacements)
- [ ] Clicking a marker opens Popover — does NOT open AppointmentDrawer
- [ ] Marker background is semi-transparent (40% opacity), border is full opacity

**Open Slots tab**
- [ ] Category selector renders and filters correctly for all 8 categories
- [ ] Restorative dropdown works for all 4 sub-types
- [ ] All mode shows all markers grouped by date
- [ ] Empty state copy is correct and helpful

**Scheduling page**
- [ ] Three cards visible in AI Rules tab
- [ ] Slot Marker Rules card has no toggles
- [ ] 30-day summary counts are correct against mock data

**No regressions**
- [ ] Calls page still works
- [ ] Dashboard page still works
- [ ] Calendar day view still loads appointments
- [ ] ASAP and Unscheduled tabs still work
- [ ] AppointmentDrawer still opens on real appointment clicks

**Code quality**
- [ ] No hardcoded credentials
- [ ] No TODO comments left in changed files
- [ ] No `console.log` statements left in production code
- [ ] All Lucide icon imports are named imports, not default imports

**Maximum 20 attempts to resolve any failures found. If issues remain after 20, document in `BLOCKED.md`.**

Commit on pass: `feat: slot markers phase 5 — final audit clean`

---

## What You Are NOT Allowed to Do

- Touch Open Dental MySQL, the connector service, or any network call to a real backend
- Modify `calendarStore.ts`, `calendarSelectors.ts`, `features/calendar/types.ts`, or `CalendarGrid.tsx`
- Add new npm packages (everything needed is already installed)
- Create documentation files (`.md`) other than `BLOCKED.md` if needed
- Push to any git remote — local commits only
- Ask Beau for clarification — all decisions are in this file and in `docs/superpowers/specs/2026-04-20-slot-markers-design.md`

---

## If You Get Stuck

1. Re-read `docs/superpowers/specs/2026-04-20-slot-markers-design.md` — the full design spec with additional detail is there
2. Re-read the existing source file you are working alongside
3. Try a different implementation approach
4. After 20 attempts, write `BLOCKED.md` with: which phase, which audit item failed, what you tried, current error output, and your best hypothesis for the root cause

---

## Summary of Files Touched

| File | Action |
|---|---|
| `features/slotMarkers/types.ts` | Create |
| `features/slotMarkers/config.ts` | Create |
| `features/slotMarkers/mockData.ts` | Create |
| `features/slotMarkers/api.ts` | Create |
| `features/slotMarkers/SlotMarkersContext.tsx` | Create |
| `features/slotMarkers/useSlotMarkers.ts` | Create |
| `features/slotMarkers/index.ts` | Create |
| `features/calendar/components/SlotMarkerCard.tsx` | Create |
| `features/calendar/components/SlotMarkerTooltip.tsx` | Create |
| `features/calendar/components/OperatoryColumn.tsx` | Modify |
| `features/calendar/components/OpenSlots.tsx` | Modify |
| `pages/Scheduling.tsx` | Modify |
| `App.tsx` | Modify (add SlotMarkersProvider) |
