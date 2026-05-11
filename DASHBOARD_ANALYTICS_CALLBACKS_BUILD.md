# Dashboard, Analytics & Callbacks — Full Cleanup Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. All decisions are made. Build exactly what is described. Run `npx tsc --noEmit` from `new-dashboard/` after every file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` and stop.

---

## Context

Three gaps remain after the Admin cleanup:

1. **Dashboard.tsx** — greeting is hardcoded "Good morning" regardless of time; "Today's Calls" and "AI Handled" stats pull from a 10-call limited list instead of real today-totals from the analytics API; "Avg Call Duration" shows "From API" as its sub-text; the Callbacks widget "View All" button links to `/calls` because there was no dedicated callbacks page yet.

2. **Analytics.tsx** — the hourly volume chart has a broken filter that drops all afternoon hours (1PM–6PM) because it uses `parseInt("1PM")` → `1` and checks `n >= 7`, so afternoon slots fail the check; the Export/Download button shows a toast saying "Export coming soon" with no implementation.

3. **Callbacks** — the backend has a complete callbacks API (`GET/POST/PATCH/DELETE /api/callbacks`, `GET /api/callbacks/stats`, `POST /api/callbacks/:id/attempt`) and `api.ts` has all the methods wired — but there is no dedicated Callbacks page. Staff manage callbacks from a tiny widget on the Dashboard with no actions available.

---

## What Is In Scope

- `Dashboard.tsx` — stat fixes + greeting fix
- `Analytics.tsx` — hourly chart bug fix + CSV export
- New `Callbacks.tsx` page (new file)
- `App.tsx` — add `/callbacks` route
- `DashboardLayout.tsx` — add Callbacks nav item
- `api.ts` — one new method (`deleteCallback`), update `logCallbackAttempt` signature

## What Is NOT In Scope

- Any backend changes — callbacks API is complete
- Admin, AgentBuilder, CallDetail, Scheduling, Calendar, or slot marker files
- Any new backend routes or data files

---

## Phase 1 — Dashboard.tsx Fixes

Read the full `Dashboard.tsx` before modifying.

### 1A. Time-aware greeting

Replace the hardcoded `"Good morning"` string with a computed value. Add a `greeting` constant derived from `currentTime`:

```typescript
const hour = currentTime.getHours();
const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
```

Replace `"Good morning"` in the JSX with `{greeting}`.

### 1B. Fix Today's stats — use analytics KPIs, not the 10-call list

Currently the `getAnalyticsSummary({ days: 1 })` fetch only saves `hourlyData`. Extend it to also capture today's KPIs.

Add state:
```typescript
const [todayKpis, setTodayKpis] = useState<{
  totalCalls: number;
  aiHandled: number;
  aiHandledPct: number;
  avgDurationSec: number;
} | null>(null);
```

In the existing `getAnalyticsSummary` `.then()` handler, after setting `hourlyData`, also set:
```typescript
setTodayKpis({
  totalCalls: res.kpis.totalCalls,
  aiHandled: res.kpis.aiHandled,
  aiHandledPct: res.kpis.aiHandledPct,
  avgDurationSec: res.kpis.avgDurationSec,
});
```

Update the three stats that were using `recentCalls`:

| Stat | Old value | New value |
|---|---|---|
| Today's Calls | `recentCalls.length` | `todayKpis?.totalCalls ?? recentCalls.length` |
| Today's Calls sub | `"X AI handled"` | `todayKpis ? \`${todayKpis.aiHandled} AI handled\` : \`${recentCalls.filter(...).length} AI handled\`` |
| AI Handled value | `recentCalls.length ? \`${Math.round(...)}\`% : "—"` | `todayKpis ? \`${todayKpis.aiHandledPct}%\` : "—"` |
| AI Handled sub | `"X of Y"` | `todayKpis ? \`${todayKpis.aiHandled} of ${todayKpis.totalCalls}\` : "No data"` |
| Avg Call Duration value | `recentCalls.length ? formatDuration(...) : "—"` | `todayKpis ? formatDuration(todayKpis.avgDurationSec) : "—"` |
| Avg Call Duration sub | `"From API"` (hardcoded) | `"Today"` |

### 1C. Fix Callbacks "View All" link

In the Callbacks card header, change:
```tsx
<Link href="/calls">
  <Button ...>View All <ArrowRight /></Button>
</Link>
```
to:
```tsx
<Link href="/callbacks">
  <Button ...>View All <ArrowRight /></Button>
</Link>
```

### Phase 1 Audit Gate
`npx tsc --noEmit` — zero errors. Verify:
- [ ] Greeting changes based on time of day
- [ ] "Today's Calls" no longer capped at 10
- [ ] "Avg Call Duration" sub-text reads "Today" not "From API"
- [ ] Callbacks "View All" links to `/callbacks`

---

## Phase 2 — Analytics.tsx Fixes

Read the full `Analytics.tsx` before modifying.

### 2A. Fix the hourly volume chart filter (bug)

The existing filter uses `parseInt(h.hour)` which returns `1` for `"1PM"`, `2` for `"2PM"`, etc., so all afternoon slots fail the `n >= 7` check.

**Remove** the complex inline filter on the `BarChart`'s `data` prop. Replace with a clean pre-computed variable placed just before the `return` statement:

```typescript
function parseHour24(label: string): number {
  const m = label.match(/^(\d+)(AM|PM)$/);
  if (!m) return -1;
  let h = parseInt(m[1]);
  if (m[2] === "PM" && h !== 12) h += 12;
  if (m[2] === "AM" && h === 12) h = 0;
  return h;
}
```

Place this helper **outside the component** (at file scope, after the `formatDurationShort` function).

Then inside the component, before the return, compute:
```typescript
const hourlyChartData = data
  ? data.hourlyVolume.filter((h) => {
      const h24 = parseHour24(h.hour);
      return h24 >= 7 && h24 <= 19; // 7AM–7PM
    })
  : [];
```

Replace the existing `data` prop on `<BarChart>` (the one with the long inline filter) with `{hourlyChartData}`. Remove the old inline `.filter(...)` entirely.

Also replace the `<Cell>` loop inside the Hourly chart — it currently maps `data.hourlyVolume` (which is wrong since the chart now uses `hourlyChartData`):
```tsx
{hourlyChartData.map((entry, i) => (
  <Cell key={i} fill={entry.calls > 5 ? "oklch(0.55 0.18 210)" : "oklch(0.55 0.18 210 / 0.5)"} />
))}
```

### 2B. Implement CSV export

Replace the `toast.info("Export coming soon")` click handler on the Download button with a real CSV download.

Add a helper function **outside the component** (at file scope):

```typescript
function downloadCSV(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

Replace the Export button's `onClick` with:

```typescript
onClick={() => {
  if (!data) { toast.warning("No data to export"); return; }
  const dateStr = new Date().toISOString().slice(0, 10);
  // Sheet 1: Call volume
  const volumeRows: string[][] = [
    ["Date", "AI (Retell)", "Staff (Mango)", "Total"],
    ...data.callVolume.map((r) => [r.date, String(r.retell), String(r.mango), String(r.retell + r.mango)]),
  ];
  downloadCSV(`carein-call-volume-${dateStr}.csv`, volumeRows);
  toast.success("Call volume exported");
}}
```

### Phase 2 Audit Gate
`npx tsc --noEmit` — zero errors. Verify:
- [ ] Hourly chart shows all hours 7AM–7PM including 1PM–6PM
- [ ] Export button downloads a CSV file (not a toast)

---

## Phase 3 — Callbacks Page (New)

### 3A. Update `api.ts` — add `deleteCallback` and update `logCallbackAttempt`

Read `new-dashboard/client/src/lib/api.ts` fully before modifying.

**Add `deleteCallback` method** (after `logCallbackAttempt`):
```typescript
async deleteCallback(id: string): Promise<void> {
  await request(`/callbacks/${encodeURIComponent(id)}`, { method: "DELETE" });
},
```

**Update `logCallbackAttempt`** to accept optional data:
```typescript
async logCallbackAttempt(
  id: string,
  data?: { result?: "completed" | "no_answer"; notes?: string }
): Promise<void> {
  await request(`/callbacks/${encodeURIComponent(id)}/attempt`, {
    method: "POST",
    body: JSON.stringify(data ?? {}),
  });
},
```

**Update `normalizeCallback`** — the `status` type is currently `"pending" | "in-progress" | "completed"` but the backend also returns `"failed"`. Fix:
```typescript
status: (c.status as "pending" | "in-progress" | "completed" | "failed") ?? "pending",
```

### Phase 3A Audit Gate
`npx tsc --noEmit` — zero errors.

---

### 3B. Create `new-dashboard/client/src/pages/Callbacks.tsx`

Build this as a new file. Do not use any pattern from `DrawerPatientContext.tsx`. Use the same `Card`, `CardContent`, `CardHeader`, `CardTitle`, `Button`, `Badge` components used on every other page.

#### State

```typescript
const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
const [stats, setStats] = useState<{ total: number; pending: number; overdue: number } | null>(null);
const [loading, setLoading] = useState(true);
const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed" | "failed">("pending");
const [priorityFilter, setPriorityFilter] = useState<"all" | "emergency" | "high" | "medium" | "low">("all");
const [actionInFlight, setActionInFlight] = useState<string | null>(null); // callback id being acted on
```

#### Data loading

```typescript
const fetchData = useCallback(async () => {
  setLoading(true);
  try {
    const [cbRes, statsRes] = await Promise.allSettled([
      api.getCallbacks(),
      api.getCallbackStats(),
    ]);
    if (cbRes.status === "fulfilled") setCallbacks(cbRes.value);
    if (statsRes.status === "fulfilled") setStats(statsRes.value.stats ?? null);
  } finally {
    setLoading(false);
  }
}, []);

useEffect(() => { fetchData(); }, [fetchData]);
```

#### Filtering

```typescript
const filtered = callbacks.filter((cb) => {
  if (statusFilter !== "all" && cb.status !== statusFilter) return false;
  if (priorityFilter !== "all" && cb.priority !== priorityFilter) return false;
  return true;
});
```

#### Action handlers

```typescript
const handleComplete = async (id: string) => {
  setActionInFlight(id);
  try {
    await api.updateCallback(id, { status: "completed" });
    toast.success("Callback marked complete");
    fetchData();
  } catch { toast.error("Failed to update callback"); }
  finally { setActionInFlight(null); }
};

const handleLogAttempt = async (id: string) => {
  setActionInFlight(id + "-attempt");
  try {
    await api.logCallbackAttempt(id, { result: "no_answer" });
    toast.success("Attempt logged");
    fetchData();
  } catch { toast.error("Failed to log attempt"); }
  finally { setActionInFlight(null); }
};

const handleDelete = async (id: string) => {
  setActionInFlight(id + "-delete");
  try {
    await api.deleteCallback(id);
    toast.success("Callback removed");
    fetchData();
  } catch { toast.error("Failed to delete callback"); }
  finally { setActionInFlight(null); }
};
```

#### Page layout

**Header row:**
- Title: "Callbacks" (h1, Outfit font, text-2xl font-bold)
- Sub-text: "Patient callback queue — track and manage follow-up calls"
- Right side: Refresh button (calls `fetchData`, disabled while `loading`)

**Stats bar** (four small stat chips in a flex row, below header):
- Total: `stats?.total ?? 0`
- Pending: `stats?.pending ?? 0` — amber color if > 0
- Overdue: `stats?.overdue ?? 0` — red text if > 0, else muted
- Completed: `(stats?.total ?? 0) - (stats?.pending ?? 0)` — green

Render as small `Card`s or inline chips — your choice, consistent with the rest of the app.

**Filter bar** (below stats, above list):

Status tabs — a segmented button group (same pattern as the Analytics date range selector):
`All | Pending | Completed | Failed`

Priority filter — a `select` element or a second segmented group:
`All | Emergency | High | Medium | Low`

**Callback list:**

One `Card` per callback. Sorted by priority then due date (emergency first, then high, medium, low; within each priority, sooner due dates first). Completed and failed items appear at the bottom when "All" tab is selected.

Each card layout:
```
[priority dot]  [patient name + status badge]       [due date]
                [phone number]
                [reason — up to 2 lines]
                [attempts: N  |  last attempt: X ago]
                [Mark Complete] [Log Attempt] [View Call →] [× delete]
```

**Priority dot colors:**
- emergency: `oklch(0.55 0.22 25)` (red)
- high: `oklch(0.62 0.22 25)` (orange-red)
- medium: `oklch(0.78 0.17 75)` (amber)
- low: `oklch(0.52 0.015 240)` (muted)

**Status badge:**
- pending: amber
- completed: green
- failed: muted/gray
- in-progress: blue

**Due date:**
- Show using `formatTimestamp` from `@/lib/utils` if available, otherwise format inline
- If `new Date(cb.dueDate) < new Date()` and status is pending → show in red "Overdue"

**Attempts line:**
- `attempts: ${cb.attempts}` + `last attempt: ${cb.lastAttempt ? formatTimeAgo(cb.lastAttempt) : "never"}`
- Import `formatTimeAgo` from `@/lib/utils`

**Action buttons** (only show for non-completed, non-failed callbacks):
- "Mark Complete" — variant `"outline"`, calls `handleComplete(cb.id)`. Show spinner if `actionInFlight === cb.id`.
- "Log Attempt" — variant `"ghost"`, calls `handleLogAttempt(cb.id)`. Show spinner if `actionInFlight === cb.id + "-attempt"`.
- "View Call →" — only render if `cb.linkedCallId` is truthy. Use `<Link href={\`/calls/${cb.linkedCallId}\`}>` wrapping a ghost button.
- Delete (×) — a small ghost button with `Trash2` icon from lucide-react, calls `handleDelete(cb.id)`. Show spinner if `actionInFlight === cb.id + "-delete"`. For completed/failed items show this only.

**Empty state:**
If `filtered.length === 0` and not loading:
- "No callbacks" with a `PhoneIncoming` icon and message matching the current filter (e.g., "No pending callbacks" when statusFilter is "pending").

**Loading state:**
Show `Loader2` spinner centered while initial load is in flight.

#### Import requirements

```typescript
import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PhoneIncoming, RefreshCw, Loader2, Trash2, CheckCircle2,
  Phone, Clock, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { api, type CallbackDisplay } from "@/lib/api";
import { formatTimeAgo } from "@/lib/utils";
```

---

### 3C. Add `/callbacks` route in `App.tsx`

Read `App.tsx` before modifying. Add:

```typescript
import Callbacks from "./pages/Callbacks";
```

Add the route inside `<Switch>`:
```tsx
<Route path="/callbacks" component={Callbacks} />
```

Place it after the `/calls/:id` route.

---

### 3D. Add Callbacks nav item in `DashboardLayout.tsx`

Read `DashboardLayout.tsx` before modifying.

**Add `PhoneIncoming` to the lucide-react import** at the top of the file (it's not currently imported there).

**Insert Callbacks nav item** into `navItems` after Calls:

```typescript
const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/calls", label: "Calls", icon: PhoneCall },
  { path: "/callbacks", label: "Callbacks", icon: PhoneIncoming },   // NEW
  { path: "/agents", label: "Agent Builder", icon: Bot },
  { path: "/scheduling", label: "Scheduling", icon: CalendarClock },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/admin", label: "Admin", icon: Settings },
];
```

**Update the slice indices** — Operations now has 5 items (indices 0–4) and Insights starts at index 5:

```tsx
{/* Operations section */}
{navItems.slice(0, 5).map(...)}

{/* Insights section */}
{navItems.slice(5).map(...)}
```

No other changes to DashboardLayout.

### Phase 3 Audit Gate
`npx tsc --noEmit` — zero errors.

Verify:
- [ ] `/callbacks` route renders — Callbacks page loads
- [ ] "Callbacks" appears in the sidebar under Operations, between Calls and Agent Builder
- [ ] Callbacks list loads from backend and shows correct items
- [ ] Status filter tabs work — Pending shows only pending, etc.
- [ ] Priority filter works
- [ ] "Mark Complete" updates status and refreshes list
- [ ] "Log Attempt" increments attempt count and refreshes
- [ ] "View Call →" appears only when `linkedCallId` is set, navigates to `/calls/:id`
- [ ] Delete removes the callback from the list
- [ ] Dashboard "View All" in the Callbacks widget now goes to `/callbacks`

---

## Files to Create

| File | Purpose |
|---|---|
| `new-dashboard/client/src/pages/Callbacks.tsx` | Full callbacks management page |

## Files to Modify

| File | Change |
|---|---|
| `new-dashboard/client/src/lib/api.ts` | Add `deleteCallback`, update `logCallbackAttempt`, fix `normalizeCallback` status type |
| `new-dashboard/client/src/pages/Dashboard.tsx` | Time-aware greeting, KPI stats from analytics, callbacks link fix |
| `new-dashboard/client/src/pages/Analytics.tsx` | Fix hourly chart filter bug, implement CSV export |
| `new-dashboard/client/src/App.tsx` | Add `/callbacks` route |
| `new-dashboard/client/src/components/DashboardLayout.tsx` | Add Callbacks nav item, update slice indices |

## Files NOT to Touch

- Any backend files — callbacks API is complete
- `Admin.tsx`, `AgentBuilder.tsx`, `CallDetail.tsx`, `Scheduling.tsx` — do not touch
- Any calendar or slot marker files

---

## Final Audit Gate — Full Checklist

**TypeScript**
- [ ] `npx tsc --noEmit` exits 0 from `new-dashboard/`
- [ ] No `any` types introduced in modified files

**Dashboard**
- [ ] Greeting is "Good morning" / "Good afternoon" / "Good evening" based on current hour
- [ ] "Today's Calls" uses analytics total, not capped at 10
- [ ] "AI Handled %" uses analytics `aiHandledPct`
- [ ] "Avg Call Duration" sub reads "Today"
- [ ] Dashboard Callbacks "View All" → `/callbacks`

**Analytics**
- [ ] Hourly chart shows 7AM–7PM including afternoon hours 1PM–6PM
- [ ] Export downloads `carein-call-volume-YYYY-MM-DD.csv` with correct headers and data
- [ ] No "Export coming soon" toast

**Callbacks page**
- [ ] Route `/callbacks` renders
- [ ] Sidebar shows "Callbacks" nav item in Operations section
- [ ] Stats bar shows Total, Pending, Overdue, Completed
- [ ] Status filter: Pending / Completed / Failed / All work correctly
- [ ] Priority filter works
- [ ] Cards show: name, phone, reason, priority dot, due date, attempt count
- [ ] Overdue items show "Overdue" in red
- [ ] Mark Complete, Log Attempt, Delete actions all work with spinners
- [ ] "View Call →" only appears when linked call exists
- [ ] Empty state renders when no callbacks match filter

**No regressions**
- [ ] Dashboard still loads all other widgets correctly
- [ ] Analytics charts other than hourly still render
- [ ] All existing nav items still work

**Code quality**
- [ ] No `console.log` in production code
- [ ] No `TODO` comments in changed files
- [ ] No hardcoded test data

**Maximum 20 attempts per gate. Write `BLOCKED.md` if any gate cannot pass.**

Commit on pass: `feat: dashboard stats fix, analytics export, callbacks management page`
