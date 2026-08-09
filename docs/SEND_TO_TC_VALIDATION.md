# "Send to TC" — staging validation (Mango slice M6)

The voice side of the cross-module handoff. This is the click-list for proving it
on staging before it goes near prod.

## 0. Prerequisite — both halves deployed

This slice CALLS `POST /api/tc/cases/from-call` (PR #42, the TC track) from
`POST /api/unified-calls/:id/send-to-tc` (PR #41, this one). Both merged to
`develop` on 2026-08-08 and deployed to staging together as image tag
**`f8ee636`**.

Confirm the running revision carries both before validating:

```bash
az containerapp revision list -n ca-carein-backend -g rg-carein-staging \
  --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
```

The image tag must be a develop commit at or after `f8ee636`. If only one half
were deployed, every Send would return the honest failure — *"Couldn't reach the
TC app — nothing was sent. Try again."* — which is correct behaviour, but proves
nothing about the happy path.

## 1. What must be true on staging

| Thing | Expected | How to check |
|---|---|---|
| `tc` entitlement | ON for tenant `carein` | The module switcher offers **Treatment Coordinator** |
| Valley OD | connected | Slice-5 validation already proved this |
| `ALLOW_MANGO_DEV_SEED` | `true` | Only needed if the store was wiped |

Staging's call store is ephemeral. **A redeploy wipes it** — if the worklist is
empty, reseed (step 2). If the calls are still there, skip to step 3.

## 2. Reseed the synthetic calls (only if the store was wiped)

Reuses the per-location fixture verbatim — no new fixture, no PHI. Pull the token
from Key Vault; never paste it into a file.

```bash
TOKEN=$(az keyvault secret show --vault-name kv-carein-staging \
          -n dashboard-api-token --query value -o tsv)

curl -sS -X POST https://staging.carein.ai/api/mango/dev/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d @docs/fixtures/per-location-od-seed.json | jq
```

Expected: `mango_call_seed_valley_confident` → office `valley`, `od_sync_status`
`matched`, PatNum **7115** (`Stedi TestValley`).

## 3. Beau's click-through

### a. The happy path — a new case

1. Open the worklist → find the **valley confident** call
   (`Matched: Stedi TestValley`).
2. A **Send to TC** button sits next to *Send to chart*. Click it.
3. Button reads **Sending…** and is disabled while in flight.
4. Toast: **"Case created in TC for Stedi TestValley"** with an **Open in TC**
   action.
5. Click **Open in TC** → lands on the case in the TC module.
6. **In the TC UI, verify the snapshot:** the case is under **Stedi TestValley**,
   at the **valley** office, and carries the call's summary text and a link back
   to the call. TC stores its own copy — nothing there should be a live pointer
   into the voice module.
7. Back on the worklist row: the button is now a passive **"In TC"** link, not a
   button. Refresh the page — it must still say **In TC** (this is the
   persistence proving itself).

### b. Idempotency — the second send

1. Open the **call detail** page for the same call
   (`/calls/<id>`) — the button is in the *Patient Record* panel.
2. It should already read **In TC**. That is the UI-level guard.
3. To prove the SERVER-level guard, hit it from the **browser console on the
   staging dashboard** (F12 → Console), where the SSO session cookie is already
   attached:

   ```js
   await (await fetch('/api/unified-calls/mango_call_seed_valley_confident/send-to-tc',
     { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
   ```

   Expected: `success: true`, `alreadySent: true`, and the **same** `case_id` as
   step 3a. **No second case appears in TC.**

> **Do not try this with the dashboard bearer token.** `/api/unified-calls/*`
> and `/api/tc/*` both sit behind `tenantContext`, which resolves the tenant from
> `req.user.email` — and `req.user` is set only on the Entra SSO path
> (`middleware/auth.js`). A bearer token carries no user identity, so every such
> request fails closed with **403 `TENANT_UNRESOLVED`** before it reaches any
> route. That 403 is identical for a route that exists and one that doesn't, so
> it also cannot be used to probe whether an endpoint is deployed — use the
> revision's image tag for that. Only `/api/mango/dev/seed` (tenant-exempt) works
> with the bearer token, which is why step 2 above does.

### c. The Roland control

1. Find the **roland control** call. Match it to a patient first (Pick Patient),
   then **Send to TC**.
2. The case must land under **Roland**, not Valley. PatNum numbering restarts per
   Open Dental database — a case filed under the wrong practice is the failure
   this check exists to catch.

### d. The attach path

Use the seeded **valley review** call — it is the second valley call, and
resolving it to the same patient is exactly the real-world shape.

1. Find `mango_call_seed_valley_review` (shows as **Needs match**).
2. **Pick Patient** → search `TestValley` → PatNum **7115**. (This also writes
   the chart note, which is the existing resolve flow — expected.)
3. Now **Send to TC** on that call, while the case from step (a) is still open
   (`pending_tc` is an OPEN status).
4. Toast must read **"Added to Stedi TestValley's existing TC case"** — *not*
   "Case created". Different words because the coordinator's next move differs.
5. Both calls appear as `voice_handoff` events on the ONE case in TC.

### e. The refusals (these should be invisible in normal use)

| Try | Expected |
|---|---|
| The **unknown-office** seeded call | No **Send to TC** button at all |
| An **unmatched** call | No button (match it first) |
| Sign in as a voice-only tenant | No button anywhere |

## 4. What to check in the audit trail

One row per successful send, in the tenant's `audit_log`:

```
action=CREATE  resource_type=tc_case  resource_id=<case_id>  office=valley|roland  result=SUCCESS
```

A repeat send writes **no** second row. A failed send writes an `ERROR` row and
persists no linkage.

## 5. Known-good failure behaviour

Worth seeing once, so the honest states are trusted:

- Stop/scale the TC route (or validate before the TC PR merges) → toast reads
  **"Couldn't reach the TC app — nothing was sent. Try again."**, the button
  returns to idle, and the row does **not** show "In TC".
- Nothing is ever marked sent unless the server confirmed the case.
