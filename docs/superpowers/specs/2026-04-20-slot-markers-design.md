# Slot Markers — Design Spec
**Date:** 2026-04-20
**Status:** Approved
**Author:** Beau Sparkman + Claude Code

---

## Overview

Staff place special "marker" appointments in Open Dental to communicate scheduling availability to the CareIN dashboard and voice AI agent. Markers are OD appointments assigned to a dedicated CareIN Block patient — they use OD's native drag-and-drop so staff can place, move, resize, and delete them exactly like real appointments. The voice agent is block-driven only: it only offers slots where a matching marker exists, and transfers the caller to a team member if no match is found.

---

## Background & Motivation

Open Dental's native blockout system is difficult to move and adjust. Using placeholder appointments instead gives staff the full OD drag-and-drop experience. The dashboard and voice agent read these markers via the connector service to determine what appointment types are available and when.

---

## Scope

**In scope (this build — dashboard UI only):**
- `features/slotMarkers/` — config, types, mock data, api stub, context, hook
- Dashboard calendar — markers rendered visually distinct inside `OperatoryColumn`
- Open Slots tab — category-aware filtering driven by marker data
- Scheduling page — AI Rules section updated with Slot Marker Rules card + 30-day summary
- All UI runs against mock data; no connector calls are made

**Out of scope (connector work — Beau handles later):**
- Open Dental MySQL queries
- `GET /slot-markers` connector endpoint
- Any write-back to Open Dental
- Modifying `CalendarState`, `calendarStore.ts`, or `calendarSelectors.ts`

---

## Open Dental Setup (one-time, done by Beau)

### CareIN Block Patient
- **Name:** CareIN Block
- **PatNum:** 13290
- The connector will identify marker appointments by this PatNum

### Appointment Types (Admin > Appointment Types in OD)
All prefixed `CareIN —` to group them in OD dropdowns.

| Category Key | OD Display Name | Color |
|---|---|---|
| `new-patient` | CareIN — New Patient | Blue |
| `emergency` | CareIN — Emergency | Red |
| `hygiene` | CareIN — Hygiene | Green |
| `asap` | CareIN — ASAP | Orange |
| `restorative-fillings` | CareIN — Restorative: Fillings | Purple |
| `restorative-production` | CareIN — Restorative: Production | Dark Purple |
| `restorative-extractions` | CareIN — Restorative: Extractions | Maroon |
| `restorative-pediatric` | CareIN — Restorative: Pediatric | Teal |

Beau fills in the actual OD `appointmentTypeNum` values after creating them, then updates `OD_APPT_TYPE_TO_CATEGORY` in `config.ts`.

---

## Architecture

```
Open Dental Schedule
  └─ Marker appointments (PatNum 13290, appointmentTypeNum → category)
        │
        ▼
Connector Service (OUT OF SCOPE — built later by Beau)
  └─ GET /slot-markers?startDate&endDate&clinicNum
        │
        ▼
Dashboard (this build)
  ├─ SlotMarkersContext — holds marker array, loaded from api stub (mock)
  ├─ useSlotMarkers(date) hook — filters markers to a given date / date range
  ├─ OperatoryColumn — renders SlotMarkerCard alongside AppointmentCard
  ├─ Open Slots tab — category filter driven by markers, not findAvailableSlots
  └─ Scheduling page — AI Rules card + 30-day marker summary
        │
        ▼
Voice Agent (future integration)
  └─ Queries /slot-markers months ahead
     Match → 2-question script → offer 2 slots
     No match → transfer to team member
```

---

## Data Types

### `types.ts`

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
  id: number;           // OD appointmentNum (unique)
  date: string;         // "YYYY-MM-DD"
  startTime: string;    // "HH:MM" — same format as appointment.time in AppointmentCard
  duration: number;     // minutes
  operatoryId: number;
  operatoryName: string;
  providerId?: number;
  providerName?: string;
  category: SlotCategory;
  clinicNum: number;
}

export interface SlotCategoryMeta {
  label: string;        // Human-readable display name
  color: string;        // Hex color string
  icon: string;         // Lucide icon name (verified against lucide-react)
}
```

### `config.ts`

```typescript
import type { SlotCategory, SlotCategoryMeta } from "./types";

export const CAREIN_BLOCK_PATNUM = 13290;

// Set to false when connector endpoint is live
export const USE_MOCK_SLOT_MARKERS = true;

export const SLOT_CATEGORIES: Record<SlotCategory, SlotCategoryMeta> = {
  "new-patient":             { label: "New Patient",             color: "#3B82F6", icon: "UserPlus" },
  "emergency":               { label: "Emergency",               color: "#EF4444", icon: "AlertCircle" },
  "hygiene":                 { label: "Hygiene",                 color: "#22C55E", icon: "Sparkles" },
  "asap":                    { label: "ASAP",                    color: "#F97316", icon: "Zap" },
  "restorative-fillings":    { label: "Restorative: Fillings",   color: "#8B5CF6", icon: "Wrench" },
  "restorative-production":  { label: "Restorative: Production", color: "#6D28D9", icon: "Crown" },
  "restorative-extractions": { label: "Restorative: Extractions",color: "#991B1B", icon: "Scissors" },
  "restorative-pediatric":   { label: "Restorative: Pediatric",  color: "#0D9488", icon: "Heart" },
};

// Fill these in after OD appointment types are created
export const OD_APPT_TYPE_TO_CATEGORY: Record<number, SlotCategory> = {
  // e.g.: 42: "new-patient"
};
```

---

## State Management

Slot markers live in their own `SlotMarkersContext` — completely separate from `CalendarState`. Do NOT modify `calendarStore.ts`, `calendarSelectors.ts`, or `features/calendar/types.ts`.

### `SlotMarkersContext.tsx`

```typescript
interface SlotMarkersContextValue {
  markers: SlotMarker[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}
```

The context loads markers on mount by calling `getSlotMarkers()` from `api.ts`. It provides markers for the full range (today → +6 months).

### `useSlotMarkers` hook

```typescript
// Returns markers filtered to a specific date
function useSlotMarkersForDate(date: string): SlotMarker[]

// Returns markers filtered to a date range and optionally a category
function useSlotMarkersForRange(
  startDate: string,
  endDate: string,
  category?: SlotCategory
): SlotMarker[]

// Returns summary count per category for the next 30 days
function useSlotMarkerSummary(): Record<SlotCategory, number>
```

---

## `api.ts` — Stub (returns mock until connector is live)

```typescript
import { USE_MOCK_SLOT_MARKERS } from "./config";
import { MOCK_SLOT_MARKERS } from "./mockData";
import type { SlotMarker, SlotCategory } from "./types";

export interface GetSlotMarkersParams {
  startDate: string;  // "YYYY-MM-DD"
  endDate: string;    // "YYYY-MM-DD"
  clinicNum: number;
  category?: SlotCategory;
}

export async function getSlotMarkers(
  params: GetSlotMarkersParams
): Promise<SlotMarker[]> {
  if (USE_MOCK_SLOT_MARKERS) {
    // Filter mock data by date range and optional category
    return Promise.resolve(
      MOCK_SLOT_MARKERS.filter(
        (m) =>
          m.date >= params.startDate &&
          m.date <= params.endDate &&
          (!params.category || m.category === params.category)
      )
    );
  }
  // Real call (wired up when connector endpoint is live)
  const res = await fetch(
    `/api/slot-markers?startDate=${params.startDate}&endDate=${params.endDate}&clinicNum=${params.clinicNum}${params.category ? `&category=${params.category}` : ""}`
  );
  if (!res.ok) throw new Error("Failed to load slot markers");
  return res.json();
}
```

---

## `mockData.ts`

Provide at least one marker per category, spread across the next 2 weeks from today. Use `operatoryId` values of 1, 2, and 3 as placeholder operatory IDs — **note to developer**: update these to match the actual OD operatory IDs in your dev environment once Open Dental is connected. Times must be in `"HH:MM"` 24-hour format. All dates hardcoded as strings (`"2026-04-21"` etc.) — do not use `new Date()` to generate them, as that will break on different run dates.

```typescript
export const MOCK_SLOT_MARKERS: SlotMarker[] = [
  { id: 9001, date: "2026-04-21", startTime: "09:00", duration: 60, operatoryId: 1, operatoryName: "Op 1", category: "new-patient", clinicNum: 1 },
  { id: 9002, date: "2026-04-21", startTime: "14:00", duration: 60, operatoryId: 2, operatoryName: "Op 2", category: "emergency",   clinicNum: 1 },
  // ... one entry per category, across 2 weeks
];
```

---

## Feature: Calendar — SlotMarkerCard in OperatoryColumn

### Integration point
Markers are rendered **inside `OperatoryColumn.tsx`**, not in `CalendarGrid.tsx`. `CalendarGrid` is not modified.

In `OperatoryColumn`, after the existing `AppointmentCard` map, add:
```tsx
{markers.map((m) => (
  <SlotMarkerCard key={m.id} marker={m} />
))}
```

Where `markers = useSlotMarkersForDate(selectedDate).filter(m => m.operatoryId === operatoryId)`.

### Pixel positioning — identical formula to AppointmentCard

```typescript
// TIME_RAIL_START = 8 (8AM), PIXELS_PER_HOUR = 64
const [hour, min] = marker.startTime.split(":").map(Number);
const top = ((hour - 8) * 60 + min) * (64 / 60);
const height = Math.max(marker.duration * (64 / 60), 28);
```

`startTime: "HH:MM"` is the same format as `appointment.time` used in `AppointmentCard`. The formula is identical.

### SlotMarkerCard visual treatment
- `position: absolute`, same `left-1 right-1` inset as `AppointmentCard`
- Background: category color at **40% opacity**
- Left border: 3px solid, full category color
- Text: category label (e.g. "New Patient Block") — no patient name
- Small `Square` icon (Lucide) in top-right corner to distinguish from real appointments
- Not clickable into AppointmentDrawer — clicking opens a Radix `Popover`

### SlotMarkerTooltip (Popover on click)
Use the Radix `Popover` component already available via shadcn/ui (`@/components/ui/popover`). Show:
- Category label
- Time and duration
- Operatory name
- "Set in Open Dental — edit there to move or remove"

---

## Feature: Open Slots Tab — Category-Aware

### Key product decision
When a **category is selected**, markers are the **sole source of slots** — `api.findAvailableSlots()` is NOT called. Markers represent staff-designated availability, and the voice agent only works from them.

When **"All"** is selected (default), show all markers across all categories grouped by date — giving a full picture of what's been blocked out.

### Updated controls
Add a **Category selector** row above duration/time filters:
```
[ All ] [ New Patient ] [ Emergency ] [ Hygiene ] [ ASAP ] [ Restorative ▾ ]
```
"Restorative" is a dropdown containing the four sub-types.

### Slot card (category mode)
Each slot card shows:
- Time and duration (same as current)
- Category badge with category color
- Provider abbr if available

### Empty state (category mode)
```
No [Category Label] blocks found for this period.
Contact your team to add availability in Open Dental.
```

### Empty state (All mode)
```
No slot markers found. Staff can add availability blocks in Open Dental
by placing appointments for the CareIN Block patient.
```

---

## Feature: Scheduling Page — AI Rules Update

### New card: "Slot Marker Rules"
Add as a third card in the `SchedulingRules` component (after Appointment Types and Scheduling Rules cards).

Content:
- **Title:** Slot Marker Scheduling
- **Description:** The voice agent is block-driven. It only offers time slots where a CareIN slot marker exists in Open Dental. If no marker matches the caller's appointment type, the agent transfers to a team member.
- **Key rules listed** (read-only, not toggles):
  - Markers are placed by staff in Open Dental using the CareIN Block patient
  - Agent looks up to 6 months ahead
  - No marker = no booking = team member transfer
  - Staff control capacity by adding/removing markers in OD

### 30-day marker summary
Below the rules card, show a read-only grid of marker counts per category for the next 30 days. Data shape:

```typescript
// Computed by useSlotMarkerSummary() hook
type MarkerSummary = Record<SlotCategory, number>;
// e.g. { "new-patient": 4, "emergency": 2, "hygiene": 8, ... }
```

Display as a simple grid: category label, color dot, count. Label it "Next 30 Days — Slot Marker Availability".

---

## Voice Agent Rules (for future integration)

When connector endpoint is live:
1. Agent identifies appointment category from call
2. Calls `GET /slot-markers?startDate=TODAY&endDate=TODAY+6months&clinicNum=X&category=<category>`
3. Runs 2-question script (morning/afternoon + early/late week) against returned markers
4. Offers 2 matching slots
5. If empty response: *"I don't see any openings for that type of appointment right now. Let me connect you with a team member who can help find the right time for you."* → transfer

---

## File Structure

```
new-dashboard/client/src/
  features/
    slotMarkers/
      types.ts               — SlotMarker, SlotCategory, SlotCategoryMeta
      config.ts              — CAREIN_BLOCK_PATNUM, USE_MOCK_SLOT_MARKERS,
                               SLOT_CATEGORIES, OD_APPT_TYPE_TO_CATEGORY
      mockData.ts            — MOCK_SLOT_MARKERS array
      api.ts                 — getSlotMarkers() stub
      SlotMarkersContext.tsx — Context + provider
      useSlotMarkers.ts      — useSlotMarkersForDate, useSlotMarkersForRange,
                               useSlotMarkerSummary hooks
      index.ts               — Barrel export
    calendar/
      components/
        SlotMarkerCard.tsx        — Absolutely-positioned marker on OperatoryColumn
        SlotMarkerTooltip.tsx     — Radix Popover shown on marker click
```

**Files modified (calendar feature):**
- `OperatoryColumn.tsx` — inject `SlotMarkerCard` after `AppointmentCard` map
- `OpenSlots.tsx` — add category selector, replace slot source with marker data
- `pages/Scheduling.tsx` — add Slot Marker Rules card + 30-day summary

**Files NOT modified:**
- `calendarStore.ts`
- `calendarSelectors.ts`
- `features/calendar/types.ts`
- `CalendarGrid.tsx`

---

## Self-Audit Checklist (for Cursor build — run after each phase)

- [ ] `tsc --noEmit` passes with zero errors
- [ ] No `any` types introduced
- [ ] No direct OD MySQL calls or connector references
- [ ] `USE_MOCK_SLOT_MARKERS = true` — all data comes from mockData
- [ ] Markers visible and correctly positioned in OperatoryColumn
- [ ] Marker card is visually distinct from real appointments (semi-transparent, block icon)
- [ ] Clicking marker opens Popover (not AppointmentDrawer)
- [ ] Category filter on Open Slots tab uses markers, not findAvailableSlots
- [ ] "No markers" empty state appears when no matching markers exist
- [ ] Scheduling page has Slot Marker Rules card (read-only)
- [ ] 30-day summary renders with correct counts from mock data
- [ ] All new types exported from barrel `index.ts`
- [ ] Lucide icon names verified — all exist in installed lucide-react version
- [ ] No hardcoded credentials, no TODO comments left in changed files

---

## Build Phases

**Phase 1 — Foundation**
Create `features/slotMarkers/`: types, config, mockData, api stub, SlotMarkersContext, useSlotMarkers hooks, index barrel.
Self-audit: `tsc --noEmit` clean. Context loads mock data without errors.

**Phase 2 — Calendar Rendering**
Build `SlotMarkerCard` and `SlotMarkerTooltip`. Integrate into `OperatoryColumn` — markers appear on correct date/time/operatory using the pixel-positioning formula above.
Self-audit: Markers visible on calendar, positioned correctly, Popover opens on click.

**Phase 3 — Open Slots Category Filter**
Update `OpenSlots.tsx` — add category selector, replace slot source with marker data in category mode, add empty states.
Self-audit: Selecting a category shows only matching markers. "All" shows full marker overview.

**Phase 4 — Scheduling Page Update**
Add Slot Marker Rules card and 30-day summary to `pages/Scheduling.tsx`.
Self-audit: New card renders, summary counts match mock data.

**Phase 5 — Final Self-Audit**
Run full checklist above. Fix any remaining TypeScript errors. Confirm mock flag works cleanly and no OD code crept in.
