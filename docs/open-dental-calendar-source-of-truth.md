# Open Dental Calendar Source of Truth

Purpose: this file tells Cursor exactly which local docs define the Open Dental behavior for the calendar feature.

## Rule for Cursor
Use only the local markdown files in `docs/opendental/` as the source of truth for the Open Dental calendar feature. If behavior is not stated in these docs, mark it as unknown and add a TODO instead of assuming.

## Canonical docs
- `api-appointments.md`
- `api-appointment-types.md`
- `api-appt-fields.md`
- `api-appt-field-defs.md`
- `api-operatories.md`
- `api-providers.md`
- `api-schedules.md`
- `api-schedule-ops.md`
- `api-clinics.md`
- `api-patients.md`
- `api-definitions.md`
- `api-events.md`
- `api-subscriptions.md`

## What is authoritative vs derived

### Authoritative Open Dental resources
- Appointments
- AppointmentTypes
- ApptFields
- ApptFieldDefs
- Operatories
- Providers
- Schedules
- ScheduleOps
- Clinics
- Patients
- Definitions
- Events / Subscriptions

### Derived app models
- Calendar operatory columns
- Appointment cards
- Schedule overlays
- Open-slot candidates
- ASAP queue view models
- Drawer view models
- Attention flags and readiness badges

## Non-negotiable modeling rules
- Main day view is operatory-first.
- Operatories are the primary column resources.
- Schedules and blockouts must be layered behind appointments.
- Patients enrich the drawer and search, not the whole grid.
- Custom appointment fields must be dynamic.
- Slot results are candidate openings, not the only truth.
- Events are notifications; authoritative records still come from Open Dental reads.

## Recommended build order
1. Read-only day view.
2. Drawer + patient enrichment.
3. Open slots + ASAP + action workflows.
4. Event-driven sync.
