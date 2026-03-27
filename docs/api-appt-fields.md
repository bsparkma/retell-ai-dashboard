# API ApptFields

Source: https://opendental.com/site/apiapptfields.html

## Why this exists
ApptFields store highly customizable appointment-level values that offices add in Open Dental. Example: `Ins Verified = Yes`.

## Calendar role
- Dynamic appointment badges.
- Operational readiness flags.
- Drawer detail fields.
- Office-specific workflow markers.

## Important reads / writes
- `GET /apptfields?AptNum={AptNum}&FieldName={FieldName}`
- `PUT /apptfields`

## Important behavior
- If the field does not have a value for that appointment, GET returns an empty string.
- PUT updates the existing value or creates it if missing.
- Offices must already create the field in Open Dental setup before the value layer is useful.

## Suggested use cases for this app
- Insurance verified
- Needs translation
- Ready to call
- Sedation cleared
- Records received
- Treatment coordinator follow-up

## How the calendar should use it
- Never hardcode the full list of custom appointment fields.
- Render known operational fields as compact badges when configured.
- Render all other fields in the right-side drawer.
- Support read + write through your backend if you want the dashboard to update status.

## Implementation warnings
- Do not confuse field definitions with field values.
- ApptFields alone do not tell you which fields exist; pair them with ApptFieldDefs.
- Empty string means no stored value, not necessarily false.
