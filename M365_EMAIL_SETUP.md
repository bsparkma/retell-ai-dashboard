# Microsoft 365 / CareIN Email Setup Runbook

_Last completed: 2026-06-02_

Records how the `carein.ai` company email + Microsoft 365 / Entra ID tenant was set up,
the gotchas hit along the way, and the next Azure/Entra steps for the CareIN stack.

---

## What was set up

- **Org / tenant:** CareIN Dental LLC — `careindent.onmicrosoft.com`
- **Billing:** Microsoft Customer Agreement (**MCA**) — direct from Microsoft (NOT a GoDaddy-managed/CSP tenant)
- **Subscription:** Microsoft 365 Business Basic (1 license assigned)
- **Primary admin mailbox:** `admin@carein.ai`
- **Domain:** `carein.ai` — registered + DNS hosted at GoDaddy, mail/identity on Microsoft 365
- **Identity layer:** Microsoft Entra ID Free (the tenant's directory — backbone for all Azure work)

Webmail: https://outlook.office.com  •  Admin center: https://admin.microsoft.com

---

## Why direct-from-Microsoft (not GoDaddy's $1.99 email)

GoDaddy's cheap email is a resold, stripped-down M365 plan:
- $1.99 is a first-year teaser; renews ~$9.99–$11.99/user/mo (≈150% markup vs ~$6 direct).
- Limited admin (no full M365 admin center).
- **Dealbreaker:** tenant is GoDaddy-controlled → you don't cleanly own the Entra ID tenant
  that every Azure integration (app registrations, service principals, HIPAA scope) depends on.

Buying direct creates a tenant **you own outright**. Domain stays at GoDaddy; only DNS records point to Microsoft.

---

## Gotcha #1 — admin.microsoft.com redirecting to GoDaddy

**Symptom:** signing into `admin.microsoft.com` bounced to GoDaddy.
**Cause:** cached GoDaddy cookies (from editing DNS) hijacking the redirect — NOT a managed tenant.
**Fix:** open the admin center in an **Incognito/private window** (or clear GoDaddy cookies / stay logged out of GoDaddy).
**Confirm it's truly direct:** Billing → Your products shows **(MCA)** and products "bought from Microsoft."

## Gotcha #2 — domain stuck on "Incomplete setup"

**Symptom:** `carein.ai` showed "Incomplete setup"; test email never arrived (bounced).
**Cause:** DNS service records (MX etc.) not fully written/propagated yet.
**Fix:** Settings → Domains → click `carein.ai` → let Microsoft **finish/connect DNS automatically**
(it pushes records to GoDaddy). If manual: delete leftover GoDaddy email/MX records first, then add Microsoft's.
Status flips to **Healthy** once MX is live. Resend test AFTER Healthy — earlier bounced tests won't appear.

---

## Setup steps (as performed)

1. Bought **Microsoft 365 Business Basic** direct at microsoft.com (created `careindent.onmicrosoft.com`).
2. Signed into **admin.microsoft.com** (Incognito) as the admin account.
3. **Settings → Domains → Add domain → `carein.ai`** → verified via TXT record at GoDaddy DNS.
4. Let Microsoft **auto-connect DNS** at GoDaddy (MX, SPF, DKIM x2, autodiscover).
5. Domain → **Healthy**.
6. Assigned **Business Basic license** to the `admin@carein.ai` user.
7. **Test:** Gmail → `admin@carein.ai` and reply back — both directions pass, not flagged as spam. ✅

---

## Security — do this

- [ ] **MFA / Security defaults:** Admin center → Show all → Security → Microsoft Entra → Security defaults → **Enable**.
- [ ] Record recovery email / billing contact (currently the personal Gmail).
- [ ] Keep `careindent.onmicrosoft.com` admin login as documented backup sign-in.

---

## Optional niceties

- **Shared mailboxes** (free, no license): `hello@carein.ai`, `support@carein.ai` — Admin → Teams & groups → Shared mailboxes.
- Add `beau@carein.ai` as a personal mailbox/alias alongside `admin@`.

---

## Next: Azure / Entra foundation for the CareIN stack

The tenant created here is the identity layer for everything Azure. Next steps:

1. **App registrations (Entra)** — register the CareIN dashboard, the Open Dental connector service,
   and any Azure-calling service as apps with their own client IDs/secrets (stop hardcoding creds in `.env`).
2. **Managed identities / service principals** — let Azure-hosted services authenticate to MySQL connector
   + Stedi flows without stored keys.
3. **Conditional Access + MFA** — enforce MFA org-wide; restrict admin access.
4. **HIPAA / BAA** — Microsoft's BAA auto-covers M365 + Azure under this tenant; configure services to stay in-scope.

> Ask Claude to generate Cursor-ready prompts for the Entra app registrations when ready to wire the connector.
