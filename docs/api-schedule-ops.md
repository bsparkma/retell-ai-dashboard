# API ScheduleOps

Source: https://www.opendental.com/site/apischeduleops.html

## Why this exists
ScheduleOps links a schedule block to one or more operatories. This is the relational way to know which room columns a schedule item affects.

## Calendar role
- Exact mapping of schedules/blockouts to operatory columns.
- Required for multi-operatory blockout rendering.

## Important reads
- `GET /scheduleops`
- `GET /scheduleops?ScheduleNum={ScheduleNum}`
- `GET /scheduleops?OperatoryNum={OperatoryNum}`

## Fields the app should store
- `ScheduleOpNum`
- `ScheduleNum`
- `OperatoryNum`

## How the calendar should use it
- Build `scheduleOpsByScheduleNum` mappings.
- Use it to render schedule overlays on the correct operatory columns.
- Prefer this mapping over only parsing the comma-separated `operatories` string on schedules.

## Important doc behavior
- One schedule can map to many operatories.
- A schedule can also have no scheduleops.

## Implementation warnings
- Code defensively when a schedule has no scheduleops.
- Multi-chair blockouts should show on every affected operatory column.
