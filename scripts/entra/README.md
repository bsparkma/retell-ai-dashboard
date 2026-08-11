# Entra staff accounts

Creates the CareIN team's Microsoft Entra sign-in accounts. Run manually, by Beau,
in the careindent tenant. **Nothing in CI touches this.**

## Prerequisites

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser
```

You need to be able to consent to the `User.ReadWrite.All` scope in the tenant
(Global Administrator or User Administrator).

## Run order

The account, the role row, and the lockdown land in that order on purpose — the
roles spine ships with a fallback ON so a wrong guess at somebody's address is an
inconvenience, not a lockout, and the fallback only comes off once every real
address has proven itself.

1. **Create the accounts.**

   ```powershell
   cd scripts\entra
   .\create-staff-accounts.ps1 -WhatIf   # review
   .\create-staff-accounts.ps1           # create
   ```

   Idempotent — existing accounts are skipped. Initial passwords print once, in
   the summary table; hand each person theirs over a channel you trust. They are
   forced to change it at first sign-in. No licenses are assigned (Entra sign-in
   is license-free; a Microsoft 365 license is only needed for mailboxes/Office).

2. **Deploy Roles PR A** and apply the control-plane migration, which seeds the
   matching `app_user` rows with each person's role:

   ```powershell
   cd backend
   npm run migrate
   ```

3. **Each person signs in** to the dashboard at least once.

4. **Verify each role** — hit `/auth/me` as that user (browser, signed in) and
   confirm `role` is what you expect and `permissions` is non-empty:

   ```json
   { "authenticated": true, "role": "hygiene", "isSuperAdmin": false,
     "permissions": ["tc.hygiene"] }
   ```

   Also watch the backend logs for this line:

   ```
   [roles] NO app_user ROW for <email> — degraded to role 'office' by the PR A bootstrap fallback
   ```

   Every address that appears there is either a typo in the roster or someone
   nobody mentioned. Fix it — correct the `ROSTER` const in
   `backend/migrations/1786449600000_roles_spine.js` and re-run the migration
   (the seed upserts, so a corrected role takes effect), or add the person — and
   re-verify. **The list must be empty before step 5.**

5. **PR B** flips the fallback off (fail-closed: no `app_user` row → no access)
   and ships the nav/Users page.

## Keep the two lists in lockstep

`$Roster` in `create-staff-accounts.ps1` and `ROSTER` in
`backend/migrations/1786449600000_roles_spine.js` must agree. An Entra account
with no `app_user` row works today only because of the PR A fallback, and will be
locked out the moment PR B lands.

## Tenant security settings

Confirm before handing out accounts:

- **Security defaults** are enabled (Entra admin center → Overview → Properties →
  Manage security defaults), **or** an equivalent Conditional Access policy
  requires MFA. Eleven new accounts with dashboard access to PHI should not exist
  without MFA.
- Everyone completes MFA registration at first sign-in.
- `temp@carein.ai` is one deliberately **shared** account for temp hygienists. It
  holds the `hygiene` role — the narrowest one — precisely because it is shared.
  Rotate its password whenever a temp finishes.
