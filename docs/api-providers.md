# API Providers

Source: https://www.opendental.com/site/apiproviders.html

## Why this exists
Providers supply names, abbreviations, colors, hidden status, type context, and sync timestamps. They are needed for filters, labels, and schedule overlays.

## Calendar role
- Provider filter source.
- Provider chips on cards and drawer.
- Provider color fallback.
- Provider/hygiene context.
- Incremental sync source.

## Important reads
- `GET /providers`
- `GET /providers?DateTStamp=YYYY-MM-DD HH:mm:ss`
- `GET /providers?ClinicNum={ClinicNum}`
- `GET /providers/{ProvNum}`

## Fields the app should store
- `ProvNum`
- `Abbr`
- `LName`
- `FName`
- `MI`
- `Suffix`
- `FeeSched`
- `Specialty`
- `IsSecondary`
- `provColor`
- `IsHidden`
- `UsingTIN`
- `SigOnFile`
- `NationalProvID`
- `DateTStamp`
- `IsNotPerson`
- `ProvStatus`
- `IsHiddenReport`
- `Birthdate`
- `SchedNote`
- `PreferredName`
- `serverDateTime`

## How the calendar should use it
- Use `Abbr` on appointment cards.
- Use `PreferredName` or `FName + LName` in the drawer.
- Use `provColor` as the third priority color source.
- Filter by active/visible providers by default.
- Treat `IsSecondary=true` as likely hygiene context.
- Keep `SchedNote` available for advanced scheduling hints.

## Sync behavior
- `DateTStamp` can be used for provider sync.
- The docs call out a difference between `ClinicNum` queries and `DateTStamp` sync queries.
- When using `ClinicNum`, `serverDateTime` will not be returned.

## Implementation warnings
- Hidden or deleted providers may still be referenced by appointments.
- Do not assume a provider query filtered by clinic behaves exactly like global sync queries.
- Provider status and hidden state should affect filters, not erase historical references.
