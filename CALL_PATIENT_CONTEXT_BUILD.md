# Call Detail Patient Context — Cursor Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. All decisions are made. Build exactly what is described. Run `npx tsc --noEmit` from `new-dashboard/` after every file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` and stop.

---

## Context

The Call Detail page (`new-dashboard/client/src/pages/CallDetail.tsx`) shows a stub "Patient Record" card (around lines 325–365) that only displays the caller's name and phone number from the call record — no real patient data from Open Dental.

The backend already has a working patient endpoint (`GET /opendental/patients/:id`) and a phone-based search (`GET /opendental/patients/search?q=`). The API client already has `getOpenDentalPatient(patientId)` but it returns `Record<string, unknown>` with no type.

**The goal:** Replace the stub card with a real patient panel that fetches and displays the matching Open Dental patient record. Auto-match by patient ID if available, fall back to phone number search if not.

---

## Dev Environment Note — Open Dental Connector

If the Open Dental connector is not running in the dev environment, **the patient panel will always render the "no match" state**. That is expected behavior, not a bug. The lookup endpoints will return empty results (or the API client's catch will return `null`), and `CallPatientPanel` should fall through to the no-match branch showing the caller name and phone number from the call record.

This means:

- Visual audits should still pass on UI rendering (loading state → no-match state with caller info + Link button + toast on "Open in Open Dental").
- You will not be able to manually verify the "patient found" or "phone-match — verify identity" rendering paths without a live connector. That is OK — verify those branches via TypeScript, prop shape, and code review only.
- Do not add fake patient data, mock responses, or dev-only stubs to force the "found" state to render. The no-match state is the correct dev fallback.

---

## What Is In Scope

- `OdPatient` interface matching the `/patients/:id` response shape
- `getOpenDentalPatient()` return type corrected in `api.ts`
- `searchPatientByPhone()` method added to `api.ts`
- Patient lookup logic in `CallDetail.tsx` (ID → phone fallback)
- `CallPatientPanel` component replacing the stub card in `CallDetail.tsx`
- Investigation and fix of the `useSlotMarkerSummary` first-render race (see Phase 4)

## What Is NOT In Scope

- `DrawerPatientContext.tsx` — do not modify or import this component. It belongs to the calendar feature and expects a different `Patient` type. Build a new component instead.
- Any backend changes — patient endpoints already work
- Any calendar, slot marker, or scheduling files
- Patient editing or write-back to Open Dental
- "Link to Patient" full implementation (keep as placeholder toast for now)

---

## Backend Patient Response Shape

`GET /api/opendental/patients/:id` returns:

```typescript
{
  success: boolean;
  patient: {
    id: number;
    firstName: string;
    lastName: string;
    preferredName: string;
    fullName: string;
    dateOfBirth: string;      // ISO date string
    phone: string;            // HmPhone or WkPhone, whichever is set
    email: string;
    address: {
      street: string;
      city: string;
      state: string;
      zip: string;
    };
    insurance: {
      primary: string;        // PriIns carrier name
      secondary: string;      // SecIns carrier name
    };
    lastVisit: string;        // ISO date string or empty
    balance: number;          // BalTotal
    isActive: boolean;        // PatStatus === 0
  };
}
```

`GET /api/opendental/patients/search?q={phone}` returns:

```typescript
{
  success: boolean;
  patients: Array<{ /* same shape as above minus insurance/lastVisit/balance */ }>;
  query: string;
  count: number;
}
```

---

## Phase 1 — Types and API Client

### 1A. Define `OdPatient` interface

Add to `new-dashboard/client/src/lib/api.ts` (or a shared types file if one exists — follow existing patterns):

```typescript
export interface OdPatientAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface OdPatientInsurance {
  primary: string;
  secondary: string;
}

export interface OdPatient {
  id: number;
  firstName: string;
  lastName: string;
  preferredName: string;
  fullName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  address: OdPatientAddress;
  insurance: OdPatientInsurance;
  lastVisit: string;
  balance: number;
  isActive: boolean;
}
```

### 1B. Fix `getOpenDentalPatient` return type in `api.ts`

Find the existing `getOpenDentalPatient(patientId: number)` method. Change its return type from `Record<string, unknown>` (or whatever it currently is) to `Promise<OdPatient>`. Update the implementation to return `response.patient`.

### 1C. Add `searchPatientByPhone` to `api.ts`

```typescript
async searchPatientByPhone(phone: string): Promise<OdPatient | null> {
  try {
    const res = await this.request<{ success: boolean; patients: OdPatient[]; count: number }>(
      `/opendental/patients/search?q=${encodeURIComponent(phone)}`
    );
    return res.patients.length > 0 ? res.patients[0] : null;
  } catch {
    return null;
  }
}
```

### Phase 1 Audit Gate
`npx tsc --noEmit` — zero errors. All three type additions compile cleanly.

---

## Phase 2 — Patient Lookup Logic in CallDetail

Read `CallDetail.tsx` fully before modifying.

### Add patient state

```typescript
const [patient, setPatient] = useState<OdPatient | null>(null);
const [patientLoading, setPatientLoading] = useState(false);
const [patientSource, setPatientSource] = useState<'id' | 'phone' | 'none'>('none');
```

### Add patient fetch effect

After the existing call fetch effect (the one that calls `api.getUnifiedCall(id)`), add a second effect that runs when `call` is set:

```typescript
useEffect(() => {
  if (!call) return;

  const patientId = call.metadata?.patient_id as number | undefined;
  const phone = call.caller_number;

  setPatientLoading(true);

  const lookup = patientId
    ? api.getOpenDentalPatient(patientId).then((p) => { setPatientSource('id'); return p; })
    : phone
    ? api.searchPatientByPhone(phone).then((p) => { setPatientSource(p ? 'phone' : 'none'); return p; })
    : Promise.resolve(null);

  lookup
    .then((p) => setPatient(p))
    .catch(() => setPatient(null))
    .finally(() => setPatientLoading(false));
}, [call]);
```

### Phase 2 Audit Gate
`npx tsc --noEmit` — zero errors. No runtime changes visible yet — patient state exists but nothing renders it.

---

## Phase 3 — CallPatientPanel Component

### Build `CallPatientPanel`

Create this as a component **inside `CallDetail.tsx`** (not a separate file — it's only used here). Place it above the main `export default function CallDetail()`.

Props:
```typescript
interface CallPatientPanelProps {
  patient: OdPatient | null;
  loading: boolean;
  source: 'id' | 'phone' | 'none';
  callerName: string;
  callerPhone: string;
}
```

Visual layout — use existing `Card`, `CardContent`, `CardHeader`, `CardTitle` components already imported on the page:

**Loading state:** Show a skeleton (use `Skeleton` from `@/components/ui/skeleton` if available, otherwise a simple "Loading patient record…" text in muted style).

**No patient found state:**
- Display caller name and phone (from call record)
- Label: "No matching Open Dental patient found"
- Keep the existing "Link to Patient" button as a toast placeholder

**Patient found state — display these fields (only render a field if it has a value):**

| Field | Label | Format |
|---|---|---|
| `fullName` or `firstName + lastName` | Name | Plain |
| `preferredName` | Goes by | Show only if different from firstName |
| `dateOfBirth` | Date of birth | Format as MM/DD/YYYY |
| `phone` | Phone | Plain |
| `email` | Email | Plain |
| `address` | Address | `street, city, state zip` on one line |
| `insurance.primary` | Primary insurance | Plain |
| `insurance.secondary` | Secondary insurance | Only if non-empty |
| `lastVisit` | Last visit | Format as MMM D, YYYY. If empty, "No visits on record" |
| `balance` | Balance | Format as `$0.00`. Only show if balance !== 0 |
| `isActive` | Status | Only show if `!isActive` — render as a red "Inactive" badge |

**Source indicator:** Below the patient name, show a small muted badge:
- `source === 'id'` → "Matched by patient ID"
- `source === 'phone'` → "Matched by phone number — verify identity"

The phone-match case should feel slightly more cautious (the "verify identity" note is important — phone number matches may not be definitive).

**"View in Open Dental" button:** Keep as a toast placeholder. Label: "Open in Open Dental". Toast: "Open Dental deep-link coming soon".

### Replace the stub card in CallDetail

Find the existing stub Patient Record card (around lines 325–365). Replace it entirely with:

```tsx
<CallPatientPanel
  patient={patient}
  loading={patientLoading}
  source={patientSource}
  callerName={call.caller_name ?? 'Unknown'}
  callerPhone={call.caller_number ?? ''}
/>
```

### Phase 3 Audit Gate
`npx tsc --noEmit` — zero errors.

Verify manually (run dev server):
- [ ] Open a call detail page — patient panel renders
- [ ] Without Open Dental connected (typical dev): no-match state shows caller name/phone with "Link" button — this is the expected dev path
- [ ] With Open Dental connected: loading state visible briefly, then patient fields render with correct labels and source badge
- [ ] "View in Open Dental" shows toast
- [ ] Rest of call detail page unchanged (transcript, summary, recording still present)

Code-review only (cannot verify visually without connector):
- [ ] Patient-found branch renders all fields per the table in Phase 3
- [ ] Phone-match branch shows "Matched by phone number — verify identity"
- [ ] ID-match branch shows "Matched by patient ID"

---

## Phase 4 — Fix useSlotMarkerSummary First-Render Race

**Background:** The Phase 5 audit noted that the 30-day marker summary on the Scheduling page shows all zeros on the very first render, then populates correctly on subsequent visits. This is a transient race during initial provider mount.

**Your task:**
1. Read `new-dashboard/client/src/features/slotMarkers/useSlotMarkers.ts`
2. Read `new-dashboard/client/src/features/slotMarkers/SlotMarkersContext.tsx`
3. Identify why the summary returns all zeros on first render
4. Fix it — the likely cause is that `useSlotMarkerSummary` computes counts before the context has finished loading markers. The fix should check `loading` state and return zeros (or a loading indicator) gracefully rather than computing on an empty array

**If you cannot determine the root cause after reading the code:** Leave the behavior as-is and document your investigation in a comment. Do NOT make a speculative fix that might introduce new bugs.

### Phase 4 Audit Gate
`npx tsc --noEmit` — zero errors.

If fix was made: navigate to Scheduling page AI Rules tab → 30-day summary grid shows correct counts on first render, no flash of zeros.

---

## Files to Create
None — `CallPatientPanel` lives inside `CallDetail.tsx`.

## Files to Modify

| File | Change |
|---|---|
| `new-dashboard/client/src/lib/api.ts` | Add `OdPatient` types, fix return type, add `searchPatientByPhone` |
| `new-dashboard/client/src/pages/CallDetail.tsx` | Add patient state + fetch, add `CallPatientPanel`, replace stub card |
| `new-dashboard/client/src/features/slotMarkers/useSlotMarkers.ts` | Fix first-render race (Phase 4) |

## Files NOT to Touch
- `features/calendar/drawer/DrawerPatientContext.tsx` — do not import or modify
- `features/calendar/types.ts` — do not modify
- Any backend files
- Any other page, feature, or component

---

## Final Audit Gate — Full Checklist

**TypeScript**
- [ ] `npx tsc --noEmit` exits 0 from `new-dashboard/`
- [ ] No `any` types introduced in modified files
- [ ] `OdPatient`, `OdPatientAddress`, `OdPatientInsurance` exported from `api.ts`

**Patient panel** (visually verifiable in dev without OD connector)
- [ ] Loading state renders while fetch is in flight
- [ ] No-match state shows caller info + Link button (this is the default dev render)
- [ ] "Open in Open Dental" button shows toast

**Patient panel** (code-review only without OD connector)
- [ ] Patient-found state shows all non-empty fields with correct labels
- [ ] Phone-match shows "Matched by phone number — verify identity"
- [ ] ID-match shows "Matched by patient ID"
- [ ] Balance only shows when non-zero
- [ ] Inactive badge only shows when `!isActive`
- [ ] "Goes by" only shows when different from firstName

**No regressions**
- [ ] Call transcript still renders
- [ ] Recording player still renders
- [ ] Call summary/sentiment still renders
- [ ] Other call detail fields unchanged

**Code quality**
- [ ] No `console.log` in production code
- [ ] No `TODO` comments left in changed files
- [ ] No hardcoded patient IDs or test values

**Maximum 20 attempts per gate. Write `BLOCKED.md` if any gate cannot pass.**

Commit on pass: `feat: call detail patient context panel`
