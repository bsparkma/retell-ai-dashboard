# API Clinics

Source: https://www.opendental.com/site/apiclinics.html

## Why this exists
Clinics determine whether the office is multi-location and give you the clinic filter model.

## Calendar role
- Clinic selector.
- Clinic filtering across operatories, appointments, schedules, and patients.
- Multi-location awareness.

## Important reads
- `GET /clinics`

## Fields the app should store
- `ClinicNum`
- `Description`
- `Address`
- `Address2`
- `City`
- `State`
- `Zip`
- `BillingAddress`
- `BillingAddress2`
- `BillingCity`
- `BillingState`
- `BillingZip`
- `PayToAddress`
- `PayToAddress2`
- `PayToCity`
- `PayToState`
- `PayToZip`
- `Phone`
- `Abbr`
- `IsHidden`

## Important doc behavior
- Clinics GET returns all non-hidden clinics.
- An empty list means the dental office does not use the Clinics feature.

## How the calendar should use it
- If clinics are returned, show a clinic selector.
- If no clinics are returned, run in single-office mode.
- Use `ClinicNum` to scope appointments, operatories, and patients.

## Implementation warnings
- Empty clinics is not an error state.
- Do not require clinic selection if the office is single-site.
