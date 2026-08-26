# Dev / Prod Workflow

**Production runs on Azure Container Apps.** Deploys happen through GitHub Actions, not by
pulling on a workstation. The two-folder PM2 arrangement below still exists on the Windows
box, but its role has changed: the prod folder is now a local mirror and rollback path, not
the thing serving the team.

Verified against `origin/develop`, August 2026.

---

## 1. The deploy pipeline

| | **Staging** | **Production** |
| --- | --- | --- |
| Workflow | `.github/workflows/staging.yml` | `.github/workflows/prod.yml` |
| Trigger | push to `develop` (+ `workflow_dispatch`) | push to `main` (+ `workflow_dispatch`) |
| Path filters | none — every push builds | none |
| Approval | **none — auto-deploys** | **required reviewer on the `production` environment** |
| Concurrency | `staging-${{ github.ref }}`, `cancel-in-progress: true` | `prod-${{ github.ref }}`, **`cancel-in-progress: false`** — never cancel a half-done prod rollout |
| Auth | secretless OIDC (`azure/login@v2`, GitHub *variables*, no client secret) | same |

Jobs run in the same order in both:

1. **`build-test`** — the gate. No Azure access.
2. **`publish`** — `az acr build` for the backend and Caddy images, tagged
   `${GITHUB_SHA::7}`. On prod this job deliberately carries **no** `environment:`, because
   it only builds into the shared ACR and mutates nothing in prod, so it runs pre-gate.
3. **`migrate`** — starts the Container Apps migrate job and polls 60 × 10 s (10 min
   ceiling), failing on `Failed | Degraded | Canceled`. **This is the gated job on prod**
   (`environment: production`). It is a no-op when the release carries no new migrations.
4. **`deploy`** — `az containerapp update --image ...` for backend and Caddy, then a
   management-plane verify that `provisioningState == Provisioned` and the running image
   ends in the expected SHA. Prod's `deploy` also carries no `environment:` — the single
   approval on `migrate` already gated the whole prod-mutating sequence, and re-prompting
   would stall a rollout mid-flight.

CI does not curl the app after deploying: staging's Caddy ingress is IP-restricted to the
admin workstation, so a runner curl would correctly get a 403.

> **The prod gate is a reference, not a rule.** `environment: production` in the YAML only
> names a GitHub environment. The "required reviewers" protection lives in repo Settings →
> Environments and is **not** in this repository. If that environment has no reviewers
> configured, every push to `main` deploys to prod unattended. Check it if you have not
> recently.

`staging.yml` also contains a `deploy-prod` job that is permanently disabled
(`if: ${{ false }}`) — a Step-5 placeholder superseded by `prod.yml`. It can be deleted.

### The gate, exactly

```
actions/checkout@v4
actions/setup-node@v4          node-version: 22
corepack enable
pnpm install --frozen-lockfile          (cwd new-dashboard)
pnpm run check                          tsc --noEmit
pnpm run test                           vitest run, whole suite
npm ci                                  (cwd backend)
node --check server.js                  syntax only
node --test                             backend unit tests
psql                                    ephemeral DB: role carein_app, db carein_t_carein
node scripts/migrate.js up
node scripts/migrate-tenant.js up --tenant carein
node scripts/smoke-spine.js             12/12
```

Note the asymmetry: **the dashboard uses pnpm, the backend uses npm.** There is no lint
step anywhere — no lint script, no eslint dependency.

---

## 2. Branching

```bash
git fetch origin
git checkout -b feature/my-thing origin/develop
```

- Branch off **`origin/develop`**, always. Not off `main`, not off a branch you already
  merged.
- **A merged branch is dead.** Once its PR lands, delete it locally and cut a fresh one.
  Continuing to commit onto a merged branch is how work ends up rebased on top of itself.
- **One clone, one session.** Two agents sharing a working tree will fight over the index
  and the branch pointer. For parallel work use a worktree:
  ```bash
  git worktree add ../carein-<slice> -b feature/<slice> origin/develop
  ```
- Prefixes: `feature/`, `fix/`, `docs/`. Commit messages in imperative present tense.

Ship path: `feature/*` → PR → `develop` → staging auto-deploys → merge `develop` → `main`
→ prod deploys after approval.

---

## 3. Local development

Run everything locally against local Postgres. Do not point a dev box at Azure.

```bash
# backend
cd backend && npm ci && npm run dev        # :5103

# dashboard
cd new-dashboard && pnpm install --frozen-lockfile && pnpm run dev   # :3005
```

Before pushing:

```bash
cd new-dashboard && pnpm run check && pnpm run test
cd ../backend && node --check server.js && node --test
```

The typecheck script is **`check`**, not `typecheck`. There is no `npm test` in `backend/` —
`node --test` is invoked directly.

`dev/local/README.md` describes the local Docker Postgres hosting `carein_control`,
`carein_t_carein`, and the least-privilege `carein_app` role. That is still the dev model.

### Safety flags — set these in the dev `.env`

| Flag | Blocks |
| --- | --- |
| `OPENDENTAL_WRITE_DISABLED=true` | Every OD mutation → 403 `OD_WRITE_DISABLED` |
| `RETELL_AGENT_PUBLISH_DISABLED=true` | `PATCH /api/agents/:id`, which would push a prompt to the live phone-answering agent → 403 `AGENT_PUBLISH_DISABLED` |
| `MANGO_SYNC_DISABLED=true` | The Mango cron **and** manual `runSync` — prevents a dev box contending for the shared portal session |

Verify:

```powershell
curl -X PATCH -H "Content-Type: application/json" -d "{\"agent_name\":\"x\"}" http://localhost:5103/api/agents/test
# Expect: 403 AGENT_PUBLISH_DISABLED
```

### Still shared between dev and prod

- **Retell API key** — same account. Dev pulls the same call data read-only. Don't hammer it.
- **Open Dental** — dev reads the same practice data. Writes are blocked by the flag above.
- **Azure OpenAI / Azure Speech** — same subscription, same bill.
- **Mango portal credentials** — same login; the flag is what keeps dev from logging in
  concurrently.
- **Retell webhooks** point at prod only. Dev never receives live webhook events — test
  with synthetic payloads.

Isolated per folder: `data/`, `backend/recordings/`, `node_modules/`, `logs/`, and git
state.

---

## 4. The Windows workstation folders

| | PROD folder | DEV folder |
| --- | --- | --- |
| Path | `c:\Users\beau\carein cursor dashboard` | `c:\Users\beau\carein cursor dashboard-dev` |
| Backend / dashboard port | 5003 / 3005 | 5103 / 3105 |
| Process manager | PM2 (`ecosystem.config.cjs`) | none — start manually |
| Branch | should track `main` | feature branches |
| Edit here? | **NEVER** | Yes |

Open the editor in the **dev** folder. Treat the prod folder as read-only.

Two live gotchas on this box:

- **`ecosystem.config.js` is stale and conflicts with `ecosystem.config.cjs`.** Both define
  `carein-backend` and `carein-dashboard`, but the `.js` sets `PORT 5000` and
  `NODE_ENV=production`, neither of which matches anything else in the repo. Caddy proxies
  to `:5003`. Always `pm2 start ecosystem.config.cjs`. The `.js` should be deleted.
- **The `.cjs` deliberately does not set `NODE_ENV=production`** — that keeps secrets coming
  from `backend/.env` (no Key Vault certificate dependency) and cookies at `Secure=false`,
  which is safe only because Caddy terminates TLS and is the only ingress. PM2 injects env
  *before* `dotenv.config()` runs, so these override `backend/.env`. It is a documented,
  dated deviation with a "harden later" note — not the intended end state.

`carein-dashboard` runs the esbuild bundle at `new-dashboard/dist/index.js`, so
`pnpm build` must precede `pm2 reload`.

### PM2 cheat sheet

```powershell
pm2 status
pm2 logs carein-backend --lines 50
pm2 restart carein-backend
pm2 save
```

Logs also land in `logs/backend-*.log` and `logs/dashboard-*.log`.

---

## 5. Gotchas

### Deploy races — do not mutate a container app during an in-flight CD run

`prod.yml` sets `cancel-in-progress: false`, so a prod rollout always runs to completion.
Meanwhile several runbooks in this repo tell you to fix things with a manual
`az containerapp update --set-env-vars ...` against the same apps the `deploy` job mutates.
Running both at once produces interleaved revisions: your env change can land on a revision
the pipeline immediately supersedes, or the pipeline's image can land on a revision that
loses your env change.

**Rule: check Actions for a running workflow before any `az containerapp` mutation, and
don't push to `develop`/`main` while you're hand-editing an app.** After a manual mutation,
confirm the active revision carries both your change and the expected image SHA.

> Not previously documented in this repo — added here as operating guidance, not as a
> recovered fact.

### `az containerapp` YAML export pins the image tag

`az containerapp show -o yaml` captures the image reference that was live at export time.
Feeding that file back with `az containerapp update --yaml` re-applies that tag — silently
reverting a newer deploy. If you edit an app via a YAML round-trip, re-check the `image:`
line against the SHA you actually want before applying, or prefer targeted
`--set-env-vars` / `--image` flags over whole-file updates.

> Operator-supplied guidance. Not documented elsewhere in this repo and not verifiable from
> the code — treat it as a caution, not a citation.

### Reading staging and prod logs

No log-reading procedure is documented anywhere in this repo — every existing log
instruction is PM2-based and applies to the retired on-prem box.

For Container Apps, prefer a **Log Analytics history query** over a live tail. A live tail
(`az containerapp logs show --follow`) only shows what arrives after you attach, so on an
app that restarted or on a low-traffic staging environment you will sit and watch nothing
while the evidence you need is already several minutes in the past. Query the workspace for
a time window instead.

Workspaces: staging is `log-carein-staging` (GUID `8474c8cc-8a77-4da3-aac2-4e06636e07ee`),
prod is **`log-carein-prod`** (GUID `7e97dcf4-17f9-42b7-84cd-6329f79ecfbf`, 30-day
retention). Confirm with
`az monitor log-analytics workspace list -g rg-carein-prod --query "[].{name:name,customerId:customerId}"`.

Only three tables carry data: `ContainerAppConsoleLogs_CL` (stdout/stderr),
`ContainerAppSystemLogs_CL` (platform events — probes, restarts, revisions), and `Usage`.

#### ⚠️ Do NOT use `az monitor log-analytics query` — it silently drops your KQL

On the CLI build in use here, `az monitor log-analytics query --analytics-query "<KQL>"`
**ignores everything after the table name and returns an unfiltered dump.** No error, no
warning — just plausible-looking rows that do not match what you asked for. Proven
2026-08-12 while investigating a prod incident:

| What was asked | What came back |
| --- | --- |
| `ContainerAppSystemLogs_CL \| summarize n=count()` | raw rows, every column |
| `… \| where TimeGenerated > ago(48h)` | rows from a month earlier |
| `… \| where ContainerAppName_s == 'ca-carein-prod-backend'` | every app in the environment |

Its `--timespan` help even says it defaults to querying *all available* data. Between that
and the arg-quoting layer mangling embedded quotes, parentheses and `!in(...)`, an
investigation run this way reads unfiltered history and draws confident wrong conclusions.

**Use the REST API instead.** The query travels in a JSON body file, so nothing is
arg-parsed:

```powershell
$body = @{ query = "<KQL>"; timespan = "PT48H" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("$env:TEMP\q.json", $body)
az rest --method post `
  --url "https://api.loganalytics.io/v1/workspaces/7e97dcf4-17f9-42b7-84cd-6329f79ecfbf/query" `
  --resource "https://api.loganalytics.io" `
  --headers "Content-Type=application/json" `
  --body "@$env:TEMP\q.json" -o json
```

The response is `.tables[0]` with `columns[].name` and `rows[][]` — zip them into objects.
Verified: the same `summarize n=count()` returns **816** (true 48h) via REST versus **5398**
(a month, all apps) via the CLI.

Two adjacent traps in the same workflow:

- **Escaped regex breaks the JSON body.** `extract('Probe of (\\w+)',1,Log_s)` fails to
  round-trip; filter client-side instead of using regex in KQL.
- **Timestamp conversion double-shifts.** `[datetime]::Parse($s)` on a `…Z` string yields
  a local `DateTime`, and converting it again lands an hour or five off. Either use
  `[Globalization.DateTimeStyles]::RoundtripKind` before `ConvertTimeFromUtc`, or do it in
  KQL with `datetime_utc_to_local(TimeGenerated,'America/Chicago')`. **Sanity-check one
  known anchor before trusting a whole converted timeline** — e.g. a replica's
  `createdTime` from `az containerapp replica list`.

A refinement on the regex trap, from exercising this against both workspaces on
2026-08-12: the blocker is the **backslash**, not KQL string matching in general. A
single-quoted KQL literal containing a double quote round-trips through the JSON body
intact — `where Log_s contains 'HTTP/1.1" 429 '` survives verbatim, and is what
`alert-prod-429-storm` runs on. So prefer `contains` / `has_any` over `matches regex`
rather than pulling the filter client-side; you only lose the filter when you need an
escape sequence.

The probe settings, the alert inventory with its thresholds, and a bash flavour of the
same `az rest` recipe are in
[docs/PROBES_AND_ALERTS.md](docs/PROBES_AND_ALERTS.md).

### Deploys wipe the call store where there is no volume

Prod mounts an AzureFile volume at `/data` with `CALLSTORE_DIR=/data`. **Staging has no
volume by design**, so `unified_calls.json` rides the ephemeral container layer and is wiped
on every image deploy. That is why staging must stay `MANGO_INGEST_MODE=off` except for a
bounded test session — otherwise each deploy triggers a full re-ingest and re-transcription
of the lookback window, which is a real Azure Speech bill.

### The closed-hours deploy rule is still in force

`backend/services/COST_FIX_RUNBOOK.md` states the rule stays in force *"until
deploy-survival is demonstrated, NOT assumed"* — and the three-step proof it asks for still
has blank fields. **Deploy to prod when the team is not on calls.**

### Git-Bash mangles `az` subscription paths

Any `az` argument starting with `/subscriptions/...` gets rewritten by MSYS path
conversion. Prefix with `MSYS_NO_PATHCONV=1`. This is what caused the early
`MissingSubscription` and `--registry-identity` failures.

### CI: a required check shows "Expected — waiting for status" forever

A PR sits `BLOCKED` on `build-test`, the check never appears, and
`gh run list --branch <branch>` returns **nothing**. Empty commits do not help.

**Check the platform before the repo.** This happened to PR #112 on 2026-08-26 and looked
exactly like a broken branch: the workflow file was right, the branch was up to date with
develop, and a second repo of Beau's had the same symptom. It was a **GitHub Actions
outage** — githubstatus.com had a *critical* "Incident with Actions" open. Nothing in the
repo or the account would have fixed it.

One command answers it:

```bash
curl -s https://www.githubstatus.com/api/v2/components.json | grep -B3 -i '"name":"Actions"'
# then, if degraded:
curl -s https://www.githubstatus.com/api/v2/incidents/unresolved.json
```

The diagnosis order worth walking, cheapest first:

| # | Check | Command | What "fine" looks like |
| --- | --- | --- | --- |
| 0 | **Actions is up** | the curl above | `"status":"operational"` |
| 1 | **Other branches still run** | `gh run list --repo bsparkma/retell-ai-dashboard --limit 10` | recent `build-test` runs on other PRs |
| 2 | **Actions enabled for the repo** | `gh api repos/bsparkma/retell-ai-dashboard/actions/permissions` | `enabled: true`, `allowed_actions: "all"` |
| 3 | **The workflow is active** | `gh api repos/bsparkma/retell-ai-dashboard/actions/workflows` | `state: active`, not `disabled_inactivity` |
| 4 | **The required context matches the job name** | `gh api repos/bsparkma/retell-ai-dashboard/branches/develop/protection/required_status_checks` | `contexts: ["build-test"]` |

Step 1 is the one that ends most searches: if another PR ran `build-test` in the last hour,
the repo and the account are both fine and the problem is this branch or this moment.

**Billing is a red herring on this repo.** `retell-ai-dashboard` is **public**, and public
repos get unlimited GitHub-hosted Actions minutes — a spending limit cannot stop them. The
`gh api users/<user>/settings/billing/actions` endpoint also needs the `user` OAuth scope
(`gh auth refresh -h github.com -s user`, which is interactive); do not spend time on it
before confirming the repo is private.

**Do not strip the required check to get a merge through an outage.** An outage is
transient and self-resolving; branch protection is what stopped PRs being merged blind
(PR #106). Wait, then push an empty commit to re-fire `pull_request`:

```bash
git commit --allow-empty -m "ci: retrigger" && git push
```

If a merge genuinely cannot wait, run the gate locally first — `pnpm run check` and
`pnpm run test` in `new-dashboard/`, then `node --check server.js` and
`node --test --test-concurrency=1` in `backend/` — so the merge is at least not blind, and
say plainly in the PR that it merged without CI, so the next promotion runs `build-test`
in staging-cd first.

### The prod LAN certificate

`deploy/Caddyfile` loads externally-managed Posh-ACME PEM files (Caddy does not run ACME
itself) valid through **2026-09-01**, renewed manually via DNS-01. It only matters if the
LAN box is used as a rollback target — but if it is, check the cert first.

---

## 6. Rollback

- **Prod:** reactivate the prior Container Apps revision, or redeploy the previous image
  tag. `prod.yml` names this as the rollback path.
- **On-prem fallback (only if the LAN box is still current):** flip `dashboard.carein.ai`
  DNS back to an A record at `10.20.30.160`. Note the repo contains **two** live
  definitions of that hostname — confirm real DNS before relying on either.

---

## 7. When something goes wrong

**Chart notes stopped appearing but calls still show in the dashboard.**
Pull and push are independent. The 15-minute poll fills the dashboard; only the
`call_analyzed` webhook writes a commlog. Check whether `call_started` reached the backend
at the real call-start timestamp. Historic causes, in order of frequency: the Retell API key
lacked the webhook badge (401), the wrong agent was edited, the fix landed on an
unpublished draft (live calls run the published version; the Test button uses the draft), or
the inbound number was pinned to an older agent version.

**The Mango sync reports success but nothing new arrives.**
Check `MANGO_INGEST_MODE`. Only the literal `api` enables ingestion — every other value,
including `scraper` and typos, silently resolves to `off`. Then check
`MANGO_SYNC_SCHEDULE`: an invalid cron makes the scheduler return without scheduling, with
no further complaint.

**Transcription refuses.**
Read the `status` in the response, not the HTTP code. `budget_exhausted` carries `resetsAt`;
the daily cap defaults to 120 minutes on an `America/Chicago` day boundary and is persisted,
so a container restart does not reset it.

**An OD operation 409s or 503s.**
`OFFICE_UNKNOWN` means the Mango DID is not in the office map. `OFFICE_NOT_OD_CONNECTED`
means the office is switched off. `OFFICE_OD_KEY_MISSING` means the per-office customer key
is absent — the system will not fall back to another office's key. `OFFICE_MISMATCH` means
`assertOfficeMatch` refused a cross-office operation, which is working as designed.

**`tc-contract-bundle` fails locally.**
Local toolchain drift, not a code bug. Reinstall with `--frozen-lockfile` and regenerate
the bundle with the pinned esbuild — see [CLAUDE.md](CLAUDE.md) §5.
