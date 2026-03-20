# API Patients

Source: https://www.opendental.com/site/apipatients.html

## Why this exists
Patients provide communication and identity context that the voice-agent calendar needs in the drawer, search, and follow-up workflows.

## Calendar role
- Drawer enrichment.
- Search.
- Communication preference badges.
- Language and textability indicators.
- New patient / operational notes.

## Important reads
- `GET /patients/{PatNum}`
- `GET /patients/Simple?...`
- `GET /patients?...`

## Fields the calendar should care about first
- `PatNum`
- `LName`
- `FName`
- `Preferred`
- `Birthdate`
- `WirelessPhone`
- `HmPhone`
- `WkPhone`
- `Email`
- `PriProv`
- `priProvAbbr`
- `ClinicNum`
- `clinicAbbr`
- `Language`
- `TxtMsgOk`
- `PreferConfirmMethod`
- `PreferContactMethod`
- `PreferRecallMethod`
- `ApptModNote`
- `MedUrgNote`
- `FamFinUrgNote`
- `Premed`
- `DateTStamp`
- plus display/support fields like `PatStatus`, `Gender`, `Position`, `Guarantor`

## Important doc behavior
- Patients cannot be deleted via the API.
- Deleted patients and their associated resources cannot be modified through the API.
- `Patients/Simple` is better for broader list/search style retrieval.
- The full single-patient record includes more operational and financial detail than the calendar usually needs.

## How the calendar should use it
- Use `Preferred` if present for display name.
- Use phones and `TxtMsgOk` to drive call/text actions.
- Use `Language` for language badges and routing.
- Use contact/confirm preferences in the drawer.
- Use `ApptModNote`, `MedUrgNote`, and `FamFinUrgNote` carefully for attention flags.
- Use `Premed` as a visible prep badge in the drawer.

## Loading strategy recommendation
- Do not preload the full patient table.
- Either load patient mini-profiles for visible appointments only or fetch patient details lazily when the drawer opens.

## Implementation warnings
- Patient payloads are large.
- Financial fields are mostly not needed for the main grid.
- Do not put full patient records on appointment cards.
