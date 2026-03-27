# API ApptFieldDefs

Source: https://opendental.com/site/apiapptfielddefs.html

## Why this exists
ApptFieldDefs define which appointment custom fields exist and how they should be interpreted.

## Calendar role
- Source of truth for which custom appointment fields exist.
- Rendering metadata for text vs picklist fields.
- Drives drawer UI and badge mapping.

## Important reads
- `GET /apptfielddefs`
- `GET /apptfielddefs/{FieldName}` if needed by your backend pattern

## Important concepts from docs
- Appointment Field Defs organize notes specific to a patient appointment.
- They are displayed in the Edit Appointment window in Open Dental.
- Field types include at least `Text` and `PickList`.

## Fields the app should store
At minimum, store the field identity and render metadata returned by Open Dental, including:
- field name / identifier
- field type
- picklist values when present

## How the calendar should use it
- Build dynamic form/display rendering for custom appointment fields.
- Map selected high-value fields into appointment badges.
- Use picklist definitions to avoid invalid free-text assumptions.

## Implementation warnings
- Do not build the calendar around one office's current custom fields only.
- The field definitions tell you what can exist; the value layer still comes from ApptFields.
- Text fields and PickList fields should render differently.
