# API Operatories

Source: https://www.opendental.com/site/apioperatories.html

## Why this exists
Operatories are the actual resource columns for the calendar. This is the backbone of the operatory-first day view.

## Calendar role
- Primary column model for the day grid.
- Clinic scoping for room resources.
- Ordering and visibility control.
- Hygiene-room labeling.

## Important reads
- `GET /operatories`
- `GET /operatories?ClinicNum={ClinicNum}`
- `GET /operatories/{OperatoryNum}`

## Fields the app should store
- `OperatoryNum`
- `OpName`
- `Abbrev`
- `ItemOrder`
- `IsHidden`
- `ProvDentist`
- `ProvHygienist`
- `IsHygiene`
- `ClinicNum`
- `SetProspective`
- `IsWebSched`
- `OperatoryType`
- `operatoryType`

## How the calendar should use it
- Use `OperatoryNum` as the unique column id.
- Sort visible columns by `ItemOrder`.
- Hide `IsHidden=true` by default.
- Filter by `ClinicNum` when clinics are enabled.
- Show `Abbrev` and `OpName` in headers.
- Show hygiene labeling when `IsHygiene=true`.
- Use `ProvDentist` and `ProvHygienist` as default staff chips in the header when useful.

## Implementation warnings
- Hidden operatories can still appear in historical appointment references.
- Do not make providers the primary calendar columns if the main workflow is chair/room-based scheduling.
- `IsWebSched` and `SetProspective` are useful later but should not drive the initial calendar layout.
