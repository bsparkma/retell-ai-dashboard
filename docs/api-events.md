# API Events

Source: https://www.opendental.com/site/apievents.html

## Why this exists
API Events are Open Dental webhooks that notify your system about database changes or UI actions.

## Calendar role
- Future realtime or near-realtime invalidation/sync.
- Event-driven refresh for appointments, patients, and other watched resources.

## Important doc behavior
- An API Event can fire from any workstation.
- It is a webhook-style request to an endpoint you choose.
- Two event classes exist: `Database Events` and `UI Events`.
- Event requests include:
  - the customer API key in the `Authorization` header
  - the machine name in the `Workstation` header
  - the event type in the `Event-Type` header

## Recommended architecture
- Treat events as notifications, not final truth.
- Receive event webhook.
- Store raw payload.
- Deduplicate.
- Queue reconciliation.
- Re-fetch authoritative records from Open Dental.
- Update backend cache/state.
- Push or invalidate frontend views.

## How the calendar should use it
- Start with polling + `DateTStamp` sync.
- Add event-driven refresh later for appointments and patients.
- Use UI events only if you have a specific workstation-driven UX need.

## Implementation warnings
- Do not trust event notifications as the only data model.
- UI events and database events are different and should be handled differently.
