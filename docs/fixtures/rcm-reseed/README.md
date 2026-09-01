# The four reseed 835s — where they come from, and why they are not here yet

`rcm-reseed-835-R1.txt` … `-R4.txt` are **generated**, not committed. This
directory is where they land when you generate them, so they are one `git
status` away from being visible and one file-picker away from being uploaded.

Full runbook: [`docs/RCM_POSTING.md` §10.8](../../RCM_POSTING.md).

## Why they cannot be checked in ahead of the run

Each file carries the **real `ClaimNum`** in `CLP01` and the **chart's own
patient name** in `NM1*QC`. Neither exists until `reseed-prep.js` has created
the claims in Open Dental, and neither can be guessed:

- A ClaimNum that is not a real one matches nothing, and the upload looks broken
  rather than looking wrong. Walk night 2 lost an evening to exactly that —
  regenerating two 835s from a manifest whose claims had been deleted two days
  earlier, with no complaint from anything.
- A patient name a script *believes* a test patient has is a name that is quietly
  wrong one rename later, and on the matcher's name-search lane a name
  disagreement is **disqualifying**, not merely costly.

So a placeholder file committed here would be a file that *looks* right and
cannot work. That is worse than an empty directory with instructions in it.

## Generating them

From inside the staging container, at `/app`:

```bash
# 1. Clear the old debris out of the app database. Dry run first.
RCM_RESET_ALLOW=staging RCM_RESET_DB_URL=<staging tenant url> \
  node scripts/rcm/reset-staging-fixtures.js
RCM_RESET_ALLOW=staging RCM_RESET_DB_URL=<staging tenant url> \
  node scripts/rcm/reset-staging-fixtures.js --execute

# 2. Create the seven claims. Dry run prints the baseline the execute needs.
PROBE_OFFICE=roland node scripts/rcm/reseed-prep.js
PROBE_OFFICE=roland RESEED_EXPECTED_CLAIMS=<n> \
  node scripts/rcm/reseed-prep.js --execute

# 3. Emit the four 835s. No Open Dental access at all.
PROBE_OFFICE=roland node scripts/rcm/reseed-835.js
```

Step 3 writes them to `/data/rcm-reseed/roland/` **and** prints each body to
stdout between `8<` markers. Copy each body into a `.txt` file in this directory
and upload it from **/rcm → Bring in**, signed in as `admin` or `office`.

> **Uploading cannot be scripted.** `POST /api/rcm/era` needs the SSO session:
> the shared `DASHBOARD_API_TOKEN` carries no user identity, so `tenantContext`
> fails it closed with `403 TENANT_UNRESOLVED` before the handler is reached.

If you are running the generator somewhere it can see this repository,
`--out <dir>` writes the four files straight here as well:

```bash
PROBE_OFFICE=roland node scripts/rcm/reseed-835.js --out docs/fixtures/rcm-reseed
```

## What each file is for

| File | Payer | What it exercises |
| --- | --- | --- |
| `R1` | Delta Dental of Oklahoma | The clean check. Three claims across both test patients, so the Patient column changes row to row. One line pays 80% of allowed, leaving the patient owing **$9.20** — so the verdict line has a non-zero remainder to project. This is the walk runbook's **CC-5** fixture. |
| `R2` | MetLife Dental | One line that is contractual-only (`R = 0`, no decision to make, renders without the control) beside one leaving **$480.00** for the office to absorb on the `office_writeoff` path — where a reason is **required** and the gate refuses without one. |
| `R3` | Cigna Dental | The takeback. `CLP02 = 22`, every amount negated, the CAS mirrored. |
| `R4` | Cigna Dental | **The dead end, on purpose** — see below. |

### Upload order

R1, R2 and R4 can go up in any order. **R3 goes last, and only after its claim
has actually posted.** A takeback pairs to the *paid* line, so matched before the
drain the eligible set is empty and the approve refuses `NO_REVERSIBLE_LINES` —
correctly. If you match it early, re-match after the drain.

### R4 is supposed to fail

R4 will report `no_candidate` with nothing offered, and there will be no way to
tell CareIN which claim it should have found. That is
[`RCM_POSTING.md` §15.1c](../../RCM_POSTING.md) — a known limit that **6d.2
owes a fix for**, not a broken fixture:

- The claim is **real**. `reseed-prep.js` created it on a designated test
  patient, and it is visible in Open Dental from the other window.
- `CLP01` carries the **real ClaimNum**. Candidates are gathered by *patient* and
  never by claim number, so the right number being in the file changes nothing —
  which is what makes the dead end sharp rather than soft.
- `NM1*QC` carries a **transposed surname**, so the only route to a patient — a
  prefix search on `LName` and `FName` — returns nobody, and the matcher returns
  before it ever looks at a claim.

**Do not loosen the matcher to make R4 pass.** `reseed-835.js` refuses to write
the file at all if the transposed tokens could prefix-match any test patient in
either direction, and `test/rcmReseedFixtures.test.js` pins that R4 resolves to
exactly zero candidates while the two real names still resolve through the same
fake. If R4 ever starts matching, the limit it demonstrates has stopped being
reachable and nothing else would say so.

## No real patient data

Every payer, check number, claim number and amount is invented. The only
identifying strings are the two designated synthetic test patients' own chart
names — `12827` and `12828`, already documented in `CLAUDE.md` — which is what
makes the match work at all. There is no `DMG` (so no date of birth), no
subscriber id, no group number and no NPI: an invented 10-digit NPI is a number
that belongs to somebody.
