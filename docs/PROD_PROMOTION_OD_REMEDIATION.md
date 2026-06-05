# Prod Promotion — OD Client Remediation (develop @ ebf1883 → LAN prod)

Promote the OD cloud client remediation slice to the **live LAN office system**
(`carein-backend` under PM2). Backend-only, reversible. Authored from Beau's task runbook
(no separate doc was pasted); committed to `develop` first, worked from here.

## Hard rules
- **Never read or edit any `.env` file.** Determine prod's OD facts via the RUNNING backend,
  not by reading `.env`. Any env change (e.g. a CommType DefNum) is **Beau's** to make.
- **Pushing `main` triggers NO Azure deploy** (`staging.yml` is develop-only; the main→prod job
  is disabled). The only thing that changes prod is the manual `git pull` + `pm2 restart` on the
  LAN box — and ONLY on Beau's go.
- Do not touch the prod folder until Beau's explicit go + off-hours window.

## Rollback point
- **prod `main` = `71ace13`** (pre-promotion HEAD). Fast rollback: `git reset --hard 71ace13`
  in the prod folder + `pm2 restart carein-backend`.

---

## PHASE A — pre-checks (read-only) → report + STOP

**A. Prod OD practice + CommType DefNum.** Beau states which practice prod's OD points at.
Verify the "CareIN AI Call" CommType DefNum for THAT database via the running prod backend
(no `.env` read).
- Roland → **486** ("CareIN AI Call") already confirmed live on staging (same cloud OD).
- Valley → find its DefNum; Beau sets `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM` if it isn't 486.
- Empirical proof regardless: the PHASE B controlled commlog must land with CommType
  "CareIN AI Call".

**B. `allowMock()` gating — must be explicit opt-in, not NODE_ENV-derived.**
- Code (`backend/config/openDental.js`): `allowMock()` =
  `process.env.OPENDENTAL_ALLOW_MOCK === 'true' && process.env.NODE_ENV !== 'production'`.
- This is an **explicit opt-in**: the `NODE_ENV` clause only *further disables* mock in
  production; it never *enables* mock. With `OPENDENTAL_ALLOW_MOCK` unset → mock OFF even under
  `NODE_ENV=development`. `OPENDENTAL_ALLOW_MOCK` is **new in this slice**, so prod's existing
  `.env` predates it → mock OFF by default. Prod must simply NOT set it to `true`.

**C. Diff scope.** `git diff --stat 71ace13..ebf1883` → backend + docs only (no SPA /
new-dashboard). No `package.json`/lock change → **`npm ci` NOT needed**; no SPA rebuild.

**D. Rollback point** recorded: `71ace13`.

### PHASE A results (filled in)
- **OD mode:** prod `/api/health` → `openDental: "api configured"` → **api mode** (remediation
  applies; `allowMock()` is the relevant mock control).
- **B:** gate is explicit opt-in (verified in code). `OPENDENTAL_ALLOW_MOCK` is new this slice →
  not in prod's pre-existing `.env` → mock OFF. (Confirmed empirically in PHASE B step 3.)
- **C:** 8 files, `backend/*` + `docs/*` only; no SPA; no dep change → **no `npm ci`**, no SPA rebuild.
- **D:** rollback = `71ace13`.
- **A:** PENDING Beau's practice confirmation. If Roland → 486 confirmed. PHASE B commlog is the
  prod proof. (Prod OD endpoint is auth-gated; practice not independently determinable without a
  `.env` read, which is forbidden.)

---

## PHASE B — promote (after Beau's go, in the off-hours window)
1. **Git-only:** FF `main` → `ebf1883`; `git push origin main`. (No deploy triggered.)
2. **Prod folder:** `git pull origin main`; `npm ci` only if (C) said so (**it does not**);
   `pm2 restart carein-backend`; confirm clean boot (pm2 online, no crash loop).
3. **Smoke test** (Beau signed in on the LAN):
   - `pm2` all online; `/api/health` 200; dashboard loads; tenant resolves.
   - **Calendar** shows real CURRENT appts (not empty / not 2012 / not mock).
   - **Patient search** returns real matches.
   - **One controlled commlog** on `*Patient Test` in prod's OD → verify it lands with CommType
     "CareIN AI Call" (proves the api-mode no-op fix works in prod).
   - Confirm **no mock-masking** (induced OD error surfaces, not mock).
4. **Rollback if anything's wrong:** `git reset --hard 71ace13` + `pm2 restart carein-backend`;
   report.

## Deliver
PHASE A report (stop) → PHASE B deploy + smoke-test results incl. the commlog proof. Tell Beau
before touching the prod folder.
