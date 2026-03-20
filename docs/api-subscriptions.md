# API Subscriptions

Source: https://www.opendental.com/site/apisubscriptions.html

## Why this exists
Subscriptions tell Open Dental which events to send to your webhook endpoint.

## Calendar role
- Enables event-driven updates for appointment and patient changes.
- Controls whether changes are watched from the database or from UI actions.

## Important reads / writes
- `POST /subscriptions`
- `GET /subscriptions`
- `PUT /subscriptions/{SubscriptionNum}`
- `DELETE /subscriptions/{SubscriptionNum}`

## Important fields
- `SubscriptionNum`
- `EndPointUrl`
- `Workstation`
- `CustomerKey`
- `WatchTable`
- `PollingSeconds`
- `UiEventType`
- `DateTimeStart`
- `DateTimeStop`
- `Note`

## Important doc behavior
- `OpenDental.exe` can process both UI and Database Events.
- `OpenDentalAPIService.exe` can only process Database Events.
- Database-event subscriptions require:
  - `WatchTable`
  - `PollingSeconds`
- UI-event subscriptions require:
  - `UiEventType`
- `Workstation` should usually be specified unless your endpoint is localhost.
- If you omit `Workstation` in normal non-localhost scenarios, multiple machines may fire duplicate events.

## Recommended first subscriptions for this app
- `WatchTable = Appointment`
- `WatchTable = Patient`
- optionally `WatchTable = Provider`

## Recommended initial polling values
- Start around 5 to 10 seconds for appointment changes if the event path is dedicated and stable.
- Increase polling interval if office infrastructure is noisy or you want to reduce chatter.

## Example strategy
Create a dedicated backend webhook endpoint per event family, such as:
- `/api/opendental/events/appointment`
- `/api/opendental/events/patient`

Use one dedicated workstation or service processor to avoid duplication.

## Implementation warnings
- Misconfigured workstation handling will create duplicate events.
- Do not add UI subscriptions unless you have a clear reason.
- DateTimeStart gets updated each time database polling occurs, so understand that it behaves like a moving cursor for polling windows.
