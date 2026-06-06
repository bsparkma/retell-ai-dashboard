# Phase 3 Step 5 — Azure Production Cutover: Retro & Skill Source

**Date:** 2026-06-06 · **Status:** Complete & verified end-to-end

This is the post-mortem / runbook for moving CareIN production off the on-prem LAN
box onto Azure Container Apps. It is written to double as the source for a reusable
skill (`azure-containerapps-retell-cutover`). Commands and findings are concrete so
they can be lifted directly.

---

## 1. Mission

Cut CareIN production off the on-prem **LAN box** (`10.20.30.160` — PM2 + Caddy +
local Postgres, serving `dashboard.carein.ai`) onto **Azure Container Apps**
(`rg-carein-prod`, southcentralus), **zero-gap**, with the LAN box retained as
instant rollback (revert DNS → `A 10.20.30.160`).

**Outcome:** complete and verified, including the Retell post-call webhook →
Open Dental commlog write, with correct Central-time timestamps.

---

## 2. What was done (in order)

1. **Pre-staged a zero-gap TLS cert (BYO).** Container Apps *managed* certs cannot
   validate before the DNS flip (issuance needs the domain already resolving to the
   env). So we exported the existing LAN **Let's Encrypt** cert (Posh-ACME
   `fullchain.pfx`), re-exported to a temp PFX via .NET, then:
   ```
   az containerapp env certificate upload -g rg-carein-prod -n cae-carein-prod \
     --certificate-file <pfx> --password <pw> --certificate-name dashboard-carein-byo-le
   az containerapp hostname bind -g rg-carein-prod -n ca-carein-prod-caddy \
     --hostname dashboard.carein.ai --certificate <cert-id>
   ```
   Verified **before** any DNS change with:
   ```
   openssl s_client -connect <caddy-fqdn>:443 -servername dashboard.carein.ai
   ```
   (returned the LE cert from the Azure edge while DNS still pointed at the LAN box).
2. **Cutover (DNS flip, off-hours):** `dashboard.carein.ai` `A 10.20.30.160` →
   `CNAME ca-carein-prod-caddy.<env>.southcentralus.azurecontainerapps.io`.
3. **Verified the platform:** DNS across local/Google/Cloudflare; valid LE cert
   served; `/api/health` 200 (`environment: production`); SPA loads; SSO 302 →
   Microsoft with correct `redirect_uri` (MSAL `x-client-OS=linux` confirmed it was
   the Azure Linux container, not the Windows LAN box); 15-min Retell pull-sync OK.
4. **Debugged the Retell webhook → commlog path** (the bulk of the work — §4).
5. **Fixed the commlog timezone** (§5).
6. **Confirmed end-to-end:** a real call produced
   `call_started → transcript_updated → call_ended → call_analyzed`, then
   `POST /commlogs → 201`, `✅ commlog written`, with a Central-time `CommDateTime`.

---

## 3. THE most important insight

**"The call shows up in the dashboard" ≠ "the webhook fired."**

CareIN has two independent ingestion paths:

| Path | Trigger | Effect |
|---|---|---|
| **Pull** | 15-min Retell API poll | Populates the dashboard call list. Works with any valid API key. |
| **Push** | Webhook `call_analyzed` | **The only thing that writes the Open Dental commlog.** |

Confusing these cost the most time. A call can appear in the dashboard (pull) while
the commlog never writes (push broken). **The decisive test is always: does a
`call_started` webhook arrive at Azure at the *actual call-start timestamp*?**
Test-button samples have non-matching times; real calls match. Always cross-check
Azure logs against the Retell API call list.

---

## 4. The webhook saga — five stacked root causes

The post-call commlog never appeared on Azure. It was **five independent problems
layered on top of each other**, each masking the next. They were peeled off one at
a time:

1. **DNS propagation lag at Retell.** Early real calls produced *zero* webhooks on
   Azure — Retell's resolver still cached the old `A → 10.20.30.160`, so webhooks
   went to the LAN box. Meanwhile the pull-sync kept populating the dashboard,
   masking the problem.
2. **401 — signature mismatch.** Per Retell docs, webhooks are signed
   `HMAC-SHA256(rawBody + timestamp, api_key)`, and **only the API key bearing the
   "webhook badge" in the Retell dashboard can verify them.** Azure's
   `RETELL_API_KEY` held a *different* (badge-less) key — valid for the API/sync,
   wrong for webhook verification. **Fix:** moved the webhook badge onto the key
   Azure already used. (`RETELL_WEBHOOK_SECRET` is wired into the backend but the
   code doesn't use it — a red herring.)
3. **Wrong agent.** Real calls still didn't arrive; the Test button worked but live
   calls didn't. The answering agent (`agent_d1f76…` "After Hours Demo") had
   `webhook_url = https://carein-do.flamingketchup.com/...` — an old endpoint. We'd
   been editing a *different* agent.
4. **Unpublished draft.** Fixed the URL on the right agent, but it landed on an
   **unpublished draft version** (`is_published: false`). Live calls run the
   *published* version; the Test button uses the draft — exactly why Test → Azure
   but calls → old URL.
5. **Phone number pinned to old version.** The inbound number `+14793835400` was
   bound to `inbound_version: 0` (old URL). Resolution: a published **v1** carried
   the Azure URL, and repointing the number to **v1** finally routed live calls.

**Retell invariants to check (all four must line up):**
- the API key Azure verifies with **has the webhook badge**,
- the agent's `webhook_url` is correct,
- on a **published** version,
- that the **phone number's `inbound_agent_version`** actually points to.

---

## 5. Timezone fix

**Symptom:** commlog `CommDateTime` was +5h (wrote `20:19` UTC instead of `15:19`
Central).

**Root cause:** the container runs UTC; the LAN box ran Central. The webhook passes
Retell's `end_timestamp` (a Unix-epoch **number**) into `formatODDateTime`, which
for non-string input falls through to `moment(value).format('YYYY-MM-DD HH:mm:ss')`
— **process-local time**, which Node derives from the `TZ` env var. UTC container →
UTC timestamps.

**Fix (no code change — matches prior LAN behavior):**
```
az containerapp update -g rg-carein-prod -n ca-carein-prod-backend \
  --set-env-vars TZ=America/Chicago
```
(creates a new revision / restarts). `moment` handles CST/CDT automatically.
Verified: post-fix commlog `CommDateTime` reads Central. Per-clinic timezone
handling is a later hardening item.

---

## 6. Diagnostic toolkit

**Azure Container Apps logs**
```
az containerapp logs show -g rg-carein-prod -n ca-carein-prod-backend --tail N --only-show-errors
az containerapp logs show ... --follow      # live; Azure caps streams at ~10 min
```
Grep for: `webhook received | event: | call_analyzed | commlog | Invalid Retell signature`.

**Webhook 401 triage:** the handler logs a *specific* reason per failure (missing
header / malformed / replay window / key not set / rawBody not captured). If **only**
the generic `Invalid Retell signature` logs, the HMAC simply didn't match → **key
mismatch**.

**Retell API (read-only diagnostics; `Authorization: Bearer <api-key>`)**
```
POST /v2/list-calls   {"sort_order":"descending","limit":N}   # status, call_analysis, timestamps
GET  /get-agent/{id}                 # webhook_url, version, is_published (latest)
GET  /get-agent/{id}?version=N       # same, per version
GET  /list-phone-numbers             # inbound_agent_id + inbound_agent_version (what live calls use)
```

**Open Dental API (read-back / verification; `Authorization: ODFHIR {dev}/{cust}`,
base `https://api.opendental.com/api/v1`)**
```
GET /patients?Phone=<10digits>       # replicate the matcher's phone lookup
GET /commlogs?PatNum=<id>            # read commlogs back (CommType 486 = CareIN)
```
Note: OD returns both `CommType` (DefNum string) and `commType` (display name) —
`ConvertFrom-Json` chokes on the case collision; use `-AsHashtable` or `Invoke-WebRequest`
+ manual parse.

**TLS pre-flight (no DNS change):**
```
openssl s_client -connect <fqdn>:443 -servername <hostname>
```

**DNS propagation:**
```
Resolve-DnsName <host> -Server 8.8.8.8   # and 1.1.1.1; check CNAME + TTL on multiple resolvers
```

---

## 7. Environment-specific gotchas

- **Managed TLS cert can't pre-validate before the DNS flip** (TXT validation never
  completes; the cert sits Pending → Failed; a Failed managed cert won't self-retry,
  and delete/recreate *rotates the ACME token*). **Use a BYO cert** (upload the LAN
  LE PFX + bind) for a zero-gap flip, or finalize via CNAME validation *after* the
  flip.
- **Retell webhook signing key = the API key with the "webhook badge,"** which can
  differ from the key used for API calls.
- **Retell agents are versioned + draft/publish.** The Test button uses the draft and
  will mislead you. Webhook delivery follows the agent on the *inbound number*, not
  the account-level webhook.
- **`az` on the admin box** emits a harmless 32-bit cryptography `UserWarning` to
  stderr; `2>$null` / `-ErrorAction SilentlyContinue` can flip exit codes — use
  `--only-show-errors` and `$ErrorActionPreference='Continue'`.

---

## 8. Open tech debt (not blockers — file as follow-ups)

1. **Commlog write is NOT idempotent by `call_id`.** The `call_analyzed` handler
   calls `createCommLog` directly (blind INSERT / `POST /commlogs`); `call_id` is
   never passed and there is no dedup. A Retell retry double-writes. The dedup guard
   exists only on `syncCallToCommLog`/`/sync-all` (via `od_sync_status`), which the
   webhook bypasses — and it never marks the call synced, so a manual `/sync-all`
   would *also* re-write. **Hardening:** ack 200 first, then write async, keyed by
   `call_id`.
2. **`transcript.match is not a function`** thrown on every `call_started` /
   `call_ended` persist (when `transcript` isn't a string). Harmless to the commlog,
   but noisy.
3. **Scale config:** both apps are `min1/max1` (always-warm). Scale-to-zero was
   measured non-viable (cold path 24–48s > Retell webhook timeout, which would also
   trigger the non-idempotent double-write). Keep min1/max1 until the webhook is
   hardened.
4. **BYO cert does not auto-renew** (expires 2026-09-02). Re-upload + re-bind on each
   Posh-ACME renewal, or switch to a managed CNAME-validated cert now that DNS points
   at the env.
5. **Patient match by phone is ambiguous when a number is on multiple records.**
   `matchByPhoneExact` returns >1 → confidence 0.75 → writes to the **first** record
   OD returns. (Observed: the test cell was on both "John Doe" #12447 and "Patient
   Test" #1; commlogs landed on John Doe.)

---

## 9. Production resource inventory (rg-carein-prod, southcentralus)

- `cae-carein-prod` (Container Apps env), `log-carein-prod`, `kv-carein-prod`,
  `id-carein-prod` (managed identity), `psql-carein-prod` (B1ms).
- `ca-carein-prod-backend` (internal :5403, min1/max1) — runs the ebf1883 image.
- `ca-carein-prod-caddy` (external :8088) — FQDN
  `ca-carein-prod-caddy.<env>.southcentralus.azurecontainerapps.io`; custom domain
  `dashboard.carein.ai` bound SNI with BYO cert `dashboard-carein-byo-le`.
- Secrets in KV: `dashboard-api-token`, `retell-api-key`, `retell-webhook-secret`;
  OD keys (`opendental-developer-key`, `opendental-customer-key`) + others loaded at
  boot via managed identity (`config/secrets.js` SECRET_MAP), not as plain CA env vars.
- Backend env: `TZ=America/Chicago`, `OPENDENTAL_INTEGRATION_MODE=api`,
  `OPENDENTAL_API_BASE_URL=https://api.opendental.com/api/v1`,
  `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM=486`.

**Rollback:** LAN box stays running; revert DNS `dashboard.carein.ai` →
`A 10.20.30.160`.

---

## 10. Suggested skill shape

**Name:** `azure-containerapps-retell-cutover`
**Triggers:** moving a CareIN/Container Apps app to Azure; "webhook not reaching
Azure"; "Retell 401"; "commlog not writing"; "timestamps off by N hours"; DNS/cert
cutover for Container Apps.
**Sections:** (1) pre-flight checklist (BYO cert staged + verified; both apps
min1/max1; secrets in KV); (2) cutover steps; (3) the pull-vs-push verification
protocol + the 5-layer webhook failure decision tree (§3–4); (4) Retell config
invariants (§4); (5) timezone check (§5); (6) diagnostic command appendix (§6);
(7) known tech-debt checklist to harden post-cutover (§8).
