# API Appointments

Source: https://opendental.com/site/apiappointments.html

## Why this exists
Appointments are the primary scheduling records for the calendar. This endpoint drives the appointment cards, the day view, the ASAP list, and slot search.

## Calendar role
- Main source for rendered appointment cards.
- Supports day view and range view.
- Supports incremental sync using `DateTStamp` + `serverDateTime`.
- Supports special flows like ASAP and slot lookup.

## Important reads
- `GET /appointments/{AptNum}`
- `GET /appointments?date=YYYY-MM-DD`
- `GET /appointments?dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD`
- `GET /appointments?PatNum={PatNum}`
- `GET /appointments?AptStatus={status}`
- `GET /appointments?Op={OperatoryNum}`
- `GET /appointments?ClinicNum={ClinicNum}`
- `GET /appointments?DateTStamp=YYYY-MM-DD HH:mm:ss`
- `GET /appointments?AppointmentTypeNum={AppointmentTypeNum}`
- `GET /appointments/ASAP`
- `GET /appointments/Slots`

## Key query params for the calendar
- `date`: single-day calendar load.
- `dateStart`, `dateEnd`: range loads for prefetch or week/day switching.
- `ClinicNum`: clinic scoping.
- `Op`: operatory scoping.
- `AptStatus`: work queue filtering.
- `PatNum`: patient-specific appointment lookups.
- `DateTStamp`: incremental sync.
- `AppointmentTypeNum`: type-based filtering.

## Fields the app should store
- `AptNum`
- `PatNum`
- `AptStatus`
- `Pattern`
- `Confirmed`
- `confirmed`
- `TimeLocked`
- `Op`
- `Note`
- `ProvNum`
- `provAbbr`
- `ProvHyg`
- `AptDateTime`
- `NextAptNum`
- `UnschedStatus`
- `unschedStatus`
- `IsNewPatient`
- `ProcDescript`
- `Assistant`
- `ClinicNum`
- `IsHygiene`
- `DateTStamp`
- `DateTimeArrived`
- `DateTimeSeated`
- `DateTimeDismissed`
- `InsPlan1`
- `InsPlan2`
- `DateTimeAskedToArrive`
- `colorOverride`
- `AppointmentTypeNum`
- `Priority`
- `PatternSecondary`
- `ItemOrderPlanned`
- `IsMirrored`
- `serverDateTime`

## How the calendar should use it
- Use `Op` as the operatory column key.
- Use `AptDateTime` as the start time.
- Use `Pattern` / pattern-derived duration for height and duration.
- Use `ProcDescript` as the main procedure summary on the card.
- Use `ProvNum` and `ProvHyg` for provider/hygiene context.
- Use `AptStatus`, `confirmed`, and `Priority` for badges.
- Use `DateTimeArrived`, `DateTimeSeated`, and `DateTimeDismissed` for visit progression indicators.
- Use `DateTStamp` and returned `serverDateTime` for incremental sync.

## ASAP behavior
`GET /appointments/ASAP` returns the ASAP list. Open Dental considers an appointment to be on the ASAP list when `Priority` is `ASAP` instead of `Normal`.

## Slots behavior
`GET /appointments/Slots` gives candidate openings. Treat slot results as candidate availability, not the full truth. The app still has to validate slots against clinic, operatory, provider, schedule overlays, blockouts, and local business rules.

## Allowed appointment status values called out in docs
- `Scheduled`
- `Complete`
- `UnschedList`
- `ASAP`
- `Broken`
- `Planned`
- rare: `PtNote`, `PtNoteCompleted`

## Color priority recommendation
1. `colorOverride`
2. Appointment type color
3. Provider color
4. Fallback by status

## Sync recommendation
- Initial load by date or date range.
- Re-sync using `DateTStamp`.
- Store the returned `serverDateTime` from the latest sync and reuse it as the next cursor.

## Implementation warnings
- Do not use appointments as the only source of truth for availability; schedules and blockouts matter.
- Do not overload cards with every appointment field.
- Hidden/inactive operatories or providers may still be referenced by older appointments.
- ASAP and Slots should be treated as secondary views, not the default day grid.
