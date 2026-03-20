# API Schedules

Source: https://www.opendental.com/site/apischedules.html

## Why this exists
Schedules supply the background availability and blockout layer behind appointments.

## Calendar role
- Practice closures/banners.
- Provider availability overlays.
- Blockout overlays.
- Secondary staffing context for employee schedules.

## Important reads
- `GET /schedules/{ScheduleNum}`
- `GET /schedules?date=YYYY-MM-DD`
- `GET /schedules?dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD`
- `GET /schedules?SchedType=Practice|Provider|Blockout|Employee|WebSchedASAP`
- `GET /schedules?ProvNum={ProvNum}`
- `GET /schedules?BlockoutDefNum={DefNum}`
- `GET /schedules?EmployeeNum={EmployeeNum}`

## Fields the app should store
- `ScheduleNum`
- `SchedDate`
- `StartTime`
- `StopTime`
- `SchedType`
- `ProvNum`
- `BlockoutType`
- `blockoutType`
- `Note`
- `operatories`
- `EmployeeNum`
- `DateTStamp`

## Meaning of schedule types
- `Practice`: office-wide schedule context.
- `Provider`: provider availability.
- `Blockout`: blocked time.
- `Employee`: employee staffing schedule.
- `WebSchedASAP`: special scheduling context.

## How the calendar should use it
- Render `Practice` schedules as office-wide banners or top overlays.
- Render `Provider` schedules as provider availability overlays.
- Render `Blockout` schedules as hard blocked overlays.
- Keep `Employee` schedules out of the main operatory grid unless you intentionally enable staffing views.
- Use date/date range queries for the active day and prefetch.

## Important doc behavior
Certain values are only meaningful for certain schedule types:
- `blockoutType` only matters for `Blockout`.
- `ProvNum` only matters for `Provider`.
- `EmployeeNum` only matters for `Employee`.

## Implementation warnings
- Do not treat schedules as optional fluff; the calendar will lie about availability without them.
- The `operatories` field is useful but should not be the only mapping source when ScheduleOps is available.
- Practice closures and meetings should be impossible to miss in the UI.
