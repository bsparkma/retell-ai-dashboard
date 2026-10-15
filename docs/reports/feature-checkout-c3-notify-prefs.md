# Report: queue item 51, Checkout C3 (`feature/checkout-c3-notify-prefs`)

**LANE: RED. NEEDS REVIEW. Beau merges.**
- **Tenant migration** with two new tables, and their event/level CHECKs.
- **New vocabulary:** two events, three levels.
- **New TC route.**
- **One existing test's expected list is extended:** `tests/tc-settings.test.tsx`, `SECTION_LABELS`, gains "Notifications". That edit is a red trigger on its own. The list grows; nothing is weakened.
- **The queue file marks itself RED.**

**Migration timestamp:** `1791600000000_tc_notification_prefs.js`. origin/develop's newest at push is `1791500000000_tc_checkout_outcome.js` (item 50). Open PR #238 still carries `1791000000000`.

**Queue files 49–55** live untracked in the PROD folder at `C:\Users\beau\carein cursor dashboard\pm-prompts\queue\`, not in the repo.

## What shipped

**Preferences.** Events: `checkout_handoff`, `referral_signoff`. Levels:
- `silent`: badge only
- `banner`: in-app toast
- `sound_banner`: toast plus a chime

The effective level for one person in one office = **their override ?? the office default ?? `banner`**. That rule is one pure function, `resolveNotificationLevel`, in `shared/tc/notifications.ts`, used by both ends.

**Backend: `/api/tc/notification-prefs`** (mounted `tcFull`):

| Route | Who | What |
| --- | --- | --- |
| `GET /?office=` | any TC user | every event's effective level for **the caller**, its source (user, office or default), the raw override, the raw office default, and `canEditOffice` |
| `PUT /mine/:event` `{level\|null}` | any TC user | the caller's own override. `null` clears it back to the office default. Keyed by the **session's email, lowercased**; the strict body refuses any user field |
| `PUT /office/:event?office=` `{level\|null}` | `admin.all` only | the office default. `null` clears it back to the built-in `banner` |

Every change is audited:
- Resource type `tc_notification_pref` or `tc_notification_default`.
- `prior_state` is the level it replaced, or `unset`. These are slugs, inside the prior_state grammar.

**Migration `1791600000000_tc_notification_prefs.js`:**
- `tc_notification_defaults (office_id, event)`, and `tc_notification_prefs (user_email, event)` with a lowercase CHECK on `user_email`.
- Event, level and office CHECKs, written inline.
- The carein_app CRUD grant block, role-guarded.

**Client:**
- **Settings → Notifications**, a ninth section after DentaFlow's eight. For each event it shows "You get: …" with where that came from, a **Your alerts** select ("Use the office default" or a level), and an **Office default** select that is editable only when the server says `canEditOffice`. It also has a "Test the sound" button, and choosing *Sound + banner* plays the chime once so you hear what you picked.
- **C2's checkout alert now obeys the preference** (`useCheckoutWatch`). On each tick it reads the caller's prefs alongside the summary:
  - `silent`: the badge updates, with no banner and no sound
  - `banner`: the banner, as in item 50
  - `sound_banner`: the banner and the chime, at most one chime per tick
  - **A preference that cannot be read falls back to `banner`, so the alert is never lost.**
- **The chime** (`features/tc/notifications/chime.ts`) is synthesised with the Web Audio API, so no audio file ships. It never throws: no AudioContext, a refused context, or an autoplay block all mean silence while the banner still shows.
- **In-app only:** no web push, no service worker, no device tokens. Live updates ride the existing `usePolling` cadence; there is no new realtime infrastructure.

## Judgment calls Beau should know about

1. **The office default is editable by the practice admin only** (`admin.all`). There is no TC-settings permission in the map. Inventing one would mean a new roles-vocabulary entry, which R2's `doctor` ruling is about to touch anyway. Office managers see the office default read-only.
2. **Overrides are per person, not per office.** "I want sound for checkouts" is a fact about the person, so one override follows them across Roland and Valley. Office defaults are per office.
3. **`referral_signoff` has no producer yet.** It is in the vocabulary and the Settings UI now so preferences can be set ahead of R2, which fires it.
4. **A machine caller** (the shared dashboard bearer) passes `admin.all`, as it does for every permission (`holdsPermission` → `isMachineCaller`). This matches the platform's existing rule and is not a new hole.

## Files

| File | Change |
| --- | --- |
| `backend/migrations-tenant/1791600000000_tc_notification_prefs.js` | **new** |
| `backend/routes/tc/notifications.js` | **new**: the three routes |
| `backend/routes/tc/index.js` | `router.use('/notification-prefs', tcFull, …)` + header |
| `new-dashboard/shared/tc/notifications.ts` | **new**: events, levels, labels, the resolver, schemas |
| `backend/tc/contract.entry.ts`, `backend/tc/contract.gen.cjs` | export + regenerated (pinned esbuild, `--alias:zod`) |
| `new-dashboard/client/src/features/tc/notifications/{notificationsApi.ts,chime.ts}` | **new** |
| `new-dashboard/client/src/features/tc/settings/NotificationsSection.tsx` | **new** |
| `features/tc/settings/sections.ts`, `pages/tc/TcSettings.tsx` | the ninth section |
| `features/tc/checkout/useCheckoutWatch.ts` | the alert obeys the level |
| `tests/tc-settings.test.tsx` | **existing test, list extended** by one label (`"Notifications"`). No other line changed |
| tests (new) | backend: `routes/tc/tcNotificationPrefs.test.js` (8), `test/notificationPrefsMigration.test.js` (7). Dashboard: `tc-notification-prefs.test.tsx` (8), `tc-chime.test.ts` (3), `tc-notify-shots.test.tsx` (1 dump) |
| `docs/screenshots/tc/tccheckout-05-notifications-1280x600-{light,dark}.png` | 2 shots |

## Acceptance

| # | Row | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Pref round-trips per user per event; office default applies when the user has none | **PASS** | `tcNotificationPrefs.test.js`: "nobody has chosen ⇒ banner/default"; "my override round-trips, and clearing it falls back to the office default" (office `silent` → mine `sound_banner` (source user) → `null` → `silent` (source office), with the row deleted rather than stored as null); "office defaults are per office" |
| 2 | silent → badge only; banner → toast; sound_banner → toast + sound | **PASS** | `tc-notification-prefs.test.tsx`: the four "the checkout arrival obeys the preference" cases, including the never-lost fallback |
| 3 | A user can only read/write their own prefs; the office default needs the settings permission | **PASS** | "my prefs are keyed by MY session email (lowercased)": a forged `userEmail` body gets 400, and another user is unaffected. "only an admin may change the office default": a `tc` user gets 403 and nothing is stored. Hygienist gets 403 |
| 4 | Migration additive with GRANT block; above develop's newest at push | **PASS** | `notificationPrefsMigration.test.js` (CHECKs = contract, keys, grants, down, numbering, columns) |
| + | Every change audited | **PASS** | "every change is audited with the level it replaced (a slug)" |

## Vocabulary sweep (whole repo)

| Value | Readers | Updated? |
| --- | --- | --- |
| `TcNotificationEvent` (2) | migration CHECKs (both tables), route, contract labels, `NotificationsSection`, `useCheckoutWatch` | yes; CHECK = contract is pinned |
| `TcNotificationLevel` (3) | migration CHECKs, route, contract labels, section selects, `useCheckoutWatch` switch | yes; pinned |
| Settings section key `notifications` | `TcSettingsSectionKey` union, `TC_SETTINGS_SECTIONS`, `TcSettings.renderStaticSection`, `tests/tc-settings.test.tsx` `SECTION_LABELS` | yes. The test's list is extended, which is the one existing-test edit |
| Route `/api/tc/notification-prefs` | `routes/tc/index.js` mount; `roleGateWiring.test.js` requires the bare `tcFull` identifier, and it is used | green, unedited |
| Audit resource types `tc_notification_pref` / `tc_notification_default` | free text (no CHECK) | n/a |

**normalizeCall / call store:** not touched. **Open Dental:** none.

## Gates (merge tree)

Merge tree: `origin/develop` @ 91b60c9 merged, "Already up to date".
```
backend $ node --check server.js  -> OK
backend $ node --test             -> exit 1   # tests 3605  # pass 3601  # fail 1  # skipped 3
  not ok 53 - routes\\platform.test.js  failureType: 'uncaughtException'
  error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
  -> known Node 22 file-level flake (no assertion); isolated: node --test routes/platform.test.js -> # pass 20 # fail 0
new-dashboard $ pnpm run check    -> exit 0 (tsc --noEmit clean)
new-dashboard $ pnpm run test     -> exit 0   Test Files 155 passed | 34 skipped (189); Tests 2541 passed | 193 skipped (2734)
```
`tc-settings.test.tsx` (its list extended), `tc-checkout.test.tsx` and `tc-checkout-nav.test.tsx` (C2) are green.
`roleGateWiring` and `tc-contract-bundle` are green and unedited.

## Lane

LANE_PLACEHOLDER

## Staging test steps (after Beau merges)

1. TC → **Settings → Notifications**, as an office or tc user.
   - Both events read "You get: Banner (built-in default)".
   - The office-default selects are greyed out.
2. Set **Your alerts** for "A patient is headed to checkout" to **Sound + banner**.
   - You hear the chime once.
   - The line reads "(your choice)".
3. With checkout on for roland (item 50's console switch), alert checkout from a test-patient hygiene visit (12827 or 12828).
   - Within about 60s: a banner and a chime.
4. Switch it to **Badge only** and send another.
   - The nav badge count rises.
   - No banner, no sound.
5. As a practice **admin**, set the office default to **Badge only**.
   - A user with no override now reads "(office default)".

## Not in this slice / follow-ups

- R2 fires `referral_signoff` through the same preference.
- No push or email notification, by design (in-app only).
