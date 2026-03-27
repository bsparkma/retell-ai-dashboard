# API Definitions

Source: https://www.opendental.com/site/apidefinitions.html

## Why this exists
Definitions are general configuration lists used throughout Open Dental. For the calendar, the main value is display/config support such as blockout-related labels and office-configurable lookups.

## Calendar role
- Configuration support.
- Blockout-related label mapping.
- Future dropdown/admin mapping.

## Important reads
- `GET /definitions`
- `GET /definitions?Category={Category}`
- `GET /definitions?Category={Category}&includeHidden=true`

## Fields the app should store
- `DefNum`
- `ItemName`
- `ItemValue`
- `Category`
- `category`
- `isHidden`

## Important doc behavior
- `includeHidden` defaults to false.
- Categories drive meaning.

## How the calendar should use it
- Use as a lookup/config layer, not the main calendar engine.
- Keep available for blockout-related display mapping and future admin/config UI.

## Implementation warnings
- Do not over-engineer the first calendar around Definitions.
- Pull only the categories you actually need if your backend wants to stay lean.
