# API AppointmentTypes

Source: https://opendental.com/site/apiappointmenttypes.html

## Why this exists
Appointment types define office-specific appointment classifications. They carry labels, colors, patterns, and procedure-code-related rules.

## Calendar role
- Type chips on appointment cards and in the drawer.
- Filter source for appointment type filtering.
- Secondary color source for appointments.
- Future logic source for default patterns or code requirements.

## Important reads
- `GET /appointmenttypes`
- `GET /appointmenttypes/{AppointmentTypeNum}`

## Fields the app should store
- `AppointmentTypeNum`
- `AppointmentTypeName`
- `appointmentTypeColor`
- `IsHidden`
- `Pattern`
- `CodeStr`
- `CodeStrRequired`
- `RequiredProcCodesNeeded`
- `BlockoutTypes`

## How the calendar should use it
- Show `AppointmentTypeName` as a chip/badge.
- Use `appointmentTypeColor` as the second priority color source.
- Support filtering by `AppointmentTypeNum`.
- Keep `Pattern` available for future scheduling logic.
- Keep `CodeStr`, `CodeStrRequired`, and `RequiredProcCodesNeeded` available for office-rule validation later.

## Implementation warnings
- Hidden types should usually be hidden from filter choices by default.
- Do not assume appointment type alone determines duration; appointment records still control actual scheduled instance details.
- `BlockoutTypes` may be useful later for more advanced schedule/blockout logic.
