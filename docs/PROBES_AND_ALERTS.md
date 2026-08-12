# Health probes and Azure Monitor alerts

Infrastructure state, not code. Nothing in this document is deployed by CI — these are
Container Apps and Azure Monitor resources configured directly against Azure. This file
exists so the settings are discoverable and so the next person does not have to re-derive
the thresholds.

Applied 2026-08-12. Verified against the live resources on the same day.

---

## 1. Why the probes were defined

Both backend Container Apps ran with `properties.template.containers[0].probes: null`.
That is not "no probes" — it means the platform substitutes its own defaults, and the
default readiness probe has a **5-second timeout**. `GET /api/health` occasionally takes
longer than that, so the platform logged a readiness failure roughly seven times an hour,
every hour, for a month:

```
Probe of Readiness failed with timeout in 5 seconds.
```

A readiness failure pulls the replica out of rotation until the next successful probe.
With `maxReplicas: 1` there is no second replica to absorb that, so each failure is a
short window in which the app is unreachable through ingress with **no deploy and no
restart to explain it**. That is the shape the availability investigation was chasing.

The fix is to state the probes explicitly with a timeout that matches how the endpoint
actually behaves.

> The underlying question — *why does `/api/health` sometimes take more than 5 seconds* —
> is **not** answered here. The handler awaits `getConnectedClientCount()`
> ([`backend/server.js`](../backend/server.js)), which is the only I/O on that path and the
> obvious suspect. Widening the timeout stops the false alarm; it does not make the
> endpoint fast. Treat that as open.

### `/api/health` is a safe probe target

Two exemptions have to hold, and both do:

- **Auth** — `requireDashboardToken` is mounted with
  `exempt: [/^\/webhooks/, /^\/health$/]`
  ([`backend/middleware/auth.js`](../backend/middleware/auth.js)).
- **Rate limiting** — `/^\/api\/health\/?$/` is in the exempt list in
  [`backend/middleware/rateLimit.js`](../backend/middleware/rateLimit.js) as of PR #58.
  Before that fix a probe could in principle have been throttled, and *"a throttled health
  check reports an outage that isn't happening."*

---

## 2. The probe settings

Identical on both backend apps. Target is `GET /api/health` on the ingress `targetPort`
(**5403**), scheme HTTP.

| Probe | initialDelay | period | timeout | failureThreshold | Worst-case budget |
| --- | --- | --- | --- | --- | --- |
| **Startup** | 5s | 20s | 10s | 10 | ~205s to finish booting |
| **Readiness** | 5s | 30s | 10s | 5 | ~150s out-of-rotation before it matters |
| **Liveness** | 20s | 60s | 15s | 5 | ~300s of solid failure before a restart |

Reasoning, in the order it matters:

- **Timeout 10–15s, not 5s.** This is the whole point. 5s was the failing value.
- **`failureThreshold: 5`, not 3.** Five consecutive failures at a 30s period is 2.5
  minutes of genuine unreadiness. One slow response no longer takes the app out of
  rotation.
- **A Startup probe was added even though only readiness and liveness were asked for.**
  Defining probes replaces the platform defaults, and the backend replays the whole
  `unified_calls.json` store through `addCallInternal` on boot — a cold start is not
  instant. Without a startup probe the liveness probe would begin counting against a
  process that is still legitimately loading. The startup probe holds the other two off
  until the app answers once.
- **Liveness is the slowest and most forgiving on purpose.** It is the only probe that can
  *restart* the container. At `maxReplicas: 1` a restart is a real outage for the practice,
  so it takes five consecutive 60s-period failures — five solid minutes of a dead
  endpoint — before the platform acts.

Azure caps `failureThreshold` and `successThreshold` at 10 and `initialDelaySeconds` at 60,
which is why the startup budget is expressed as period × threshold rather than a long delay.

### Applying a probe change

`az containerapp update` has no probe flags, so this is a YAML round-trip — which walks
straight into the trap documented in
[DEV_PROD_WORKFLOW.md](../DEV_PROD_WORKFLOW.md#az-containerapp-yaml-export-pins-the-image-tag):
**an exported YAML pins the image tag that was live at export time**, so applying a stale
export silently reverts a newer deploy.

The guard used here was to parse rather than hand-edit, and to assert the image:

```python
c = doc["properties"]["template"]["containers"][0]
assert c["image"] == expected_image, f"image drift: {c['image']} != {expected_image}"
c["probes"] = [...]
# then diff every other container key against a pre-edit deepcopy
```

Sequence that is safe:

1. Confirm no CD run is in flight — `gh run list --limit 5`. A concurrent
   `az containerapp update` and a CD deploy will fight, and the loser is silent.
2. Export live: `az containerapp show -n <app> -g <rg> -o yaml > live.yaml`.
3. Edit **only** `template.containers[0].probes`; assert the image tag equals the tag
   currently deployed.
4. `az containerapp update -n <app> -g <rg> --yaml probes.yaml`.
5. Verify the **running revision**, not the template: `az containerapp revision list` until
   the new revision reads `Healthy` / `RunningAtMaxScale` with the expected image.

Step 5 is not optional. Template ≠ running replica.

---

## 3. Alert inventory

All rules live in **`rg-carein-prod`** and notify one action group.

**Action group `ag-carein-prod-email`** (short name `careinprod`) → email
`dds.sparkman@gmail.com`. This is alerting v1. Slack and a connected-agent channel are a
later phase; when they land they attach as extra receivers on this same action group, and
the six rules below do not change.

### Metric rules (scope: the Container App resource)

| Rule | Condition | Window / freq | Sev | Why that threshold |
| --- | --- | --- | --- | --- |
| `alert-prod-backend-restart` | `max RestartCount > 0` | 5m / 5m | 1 | Steady state is zero. Any restart is news. |
| `alert-prod-caddy-restart` | `max RestartCount > 0` | 5m / 5m | 1 | Same, for the ingress container. |
| `alert-prod-backend-cpu-high` | `avg CpuPercentage > 80` | 15m / 5m | 2 | Observed average is ~0.4% of the 0.5-core limit. 80% sustained for 15 min is nothing like normal. |
| `alert-prod-backend-memory-high` | `avg MemoryPercentage > 80` | 15m / 5m | 2 | Observed average is ~9% of the 1Gi limit. |

`CpuPercentage` and `MemoryPercentage` are percentages **of the configured limit**, so the
thresholds do not need rewriting if the container is resized.

> Restart is **two rules, not one**. Azure rejects multi-resource metric alerts for
> `Microsoft.App/containerapps`:
> *"Alerts are currently not supported with multi resource level."* Every new Container App
> needs its own restart rule.

### Log rules (scope: workspace `log-carein-prod`)

All three are `count > N` over a 15-minute window evaluated every 15 minutes. Each query
returns raw rows; the rule counts them.

| Rule | Threshold | Sev | Measured baseline before the rule existed |
| --- | --- | --- | --- |
| `alert-prod-probe-failure-burst` | `> 10` | 2 | ~7/hr ⇒ ~1.75 expected per window |
| `alert-prod-429-storm` | `> 25` | 2 | 0 since prod rev 28 |
| `alert-prod-sync-failure` | `> 0` | 1 | 0 in the preceding 7 days |

```kusto
// alert-prod-probe-failure-burst
ContainerAppSystemLogs_CL
| where ContainerAppName_s startswith "ca-carein-prod-"
| where Reason_s == "ProbeFailed"

// alert-prod-429-storm
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'ca-carein-prod-backend'
| where Log_s contains 'HTTP/1.1" 429 '

// alert-prod-sync-failure
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "ca-carein-prod-backend"
| where Log_s has_any ("Sync job failed", "Retell sync failed",
                       "Periodic Retell sync error", "Mango sync failed",
                       "Invalid cron schedule")
```

Threshold notes worth keeping:

- **Probe burst is deliberately survivable in both states.** At the pre-hardening rate of
  ~7/hr the expected count per 15-minute window is under 2, so 10 does not page on the old
  background noise; after hardening the expected count is ~0, so 10 is an unambiguous
  burst. The same number is correct before and after, which is why it was not retuned once
  prod was hardened.
- **`HTTP/1.1" 429 ` includes the closing quote of the morgan request field on purpose.**
  Matching a bare `" 429 "` also matches a *response body size* of 429 bytes. That
  mistake inflated the apparent 429 count by roughly an order of magnitude during
  investigation. The status code is the token immediately after the quoted request line.
- **The sync markers are the exact strings the scheduler writes** — see
  [`backend/services/syncScheduler.js`](../backend/services/syncScheduler.js). They had
  zero hits in the preceding 7 days, which is what justifies a `> 0` threshold. If a
  marker's wording changes, this rule goes quietly blind; it is a string match, not a
  contract.

### What is deliberately *not* alerted

`[OD API] Response Error: The office's eConnector is not running` fired **899 times in 7
days** in prod, alongside ~360 `timeout of 30000ms exceeded` and several hundred related
`[OD Sync]` / `[OD Patient]` failures. That is a real operational problem, but it is a
*standing* one — an alert on it would email continuously and train the inbox to ignore
this action group. It needs fixing first, then alerting. Do not wire it up as-is.

---

## 4. Cost

| Item | Unit | Monthly |
| --- | --- | --- |
| 4 metric alert rules × 1 time series | ~$0.10 / series | ~$0.40 |
| 3 log-search alert rules @ 15-min | ~$0.50 / rule | ~$1.50 |
| Action group email | first 1,000 free | $0.00 |
| **Total** | | **~$2 / month** |

Log-alert pricing scales with evaluation frequency. Moving any of the three log rules from
15-minute to 5-minute evaluation roughly triples that rule's cost and is the main way this
number grows.

---

## 5. Reading the evidence

**Why `az monitor log-analytics query` must not be used, the proof that it silently drops
the KQL, the workspace GUIDs, and the PowerShell form of the `az rest` recipe all live in
[DEV_PROD_WORKFLOW.md § Reading staging and prod logs](../DEV_PROD_WORKFLOW.md#reading-staging-and-prod-logs).**
That is the canonical copy — this section does not repeat it.

The bash flavour used for every measurement in this document, for anyone not on PowerShell:

```bash
# q.sh <prod|staging> <timespan> <kql-file>
python -c "import json,sys; json.dump({'query': open(sys.argv[1]).read(), 'timespan': sys.argv[2]}, open(sys.argv[3],'w'))" q.kql P7D body.json

az rest --method post \
  --url "https://api.loganalytics.io/v1/workspaces/<customerId>/query" \
  --resource "https://api.loganalytics.io" \
  --headers "Content-Type=application/json" \
  --body @body.json
```

Read the result as `.tables[0]`, zipping `columns[].name` against `rows[][]`.

One extra trap specific to building alert rules, which the workflow doc does not cover:
`az monitor scheduled-query` is a **preview CLI extension** and is not installed by
default. Without it the CLI blocks on an interactive install prompt and dies with
`EOFError` in a non-interactive shell. Install it up front:

```bash
az extension add --name scheduled-query --yes
```

---

## 6. Result

Probe failures on the backend apps, before and after the explicit probes.

### Staging — `ca-carein-backend`

Applied 2026-08-12 16:01Z (revision `--0000083`).

| | Before | After |
| --- | --- | --- |
| Window | 7 days to 16:05Z | 16:05Z → 18:18Z |
| `ProbeFailed` events | **903** | **0** |
| Rate | ~5.4/hr (101–125/day) | 0/hr |
| Expected at old rate | — | ~12 |

Every "before" event read `Probe of Readiness failed with timeout in 5 seconds.` The message
text is the check that matters: the new readiness probe has a **10-second** timeout, so a
post-change failure still reporting *5 seconds* would mean the config never took effect.
None appeared.

Two things strengthen this beyond a quiet-window fluke:

- **It survived a real deploy.** A `staging-cd` run at 16:50Z rolled the app to image
  `d3d3a51` (revision `--0000084`). The probes came through intact — CD calls
  `az containerapp update --image`, which patches only the image and leaves the rest of the
  template alone. **Probe config is not clobbered by CI/CD**, so this does not need
  re-applying after every release.
- The zero-failure run therefore spans **two revisions and one deploy**, not a single
  undisturbed container.

Restarts over the same period: **0**.

### Production — `ca-carein-prod-backend`

Baseline measured, change **not yet applied** — deliberately deferred to an off-hours
window rather than applied mid-practice-day.

| | Before |
| --- | --- |
| Window | 7 days to 2026-08-12 |
| `ProbeFailed` events | **716** |
| Rate | ~4.3/hr average; 137–174/day recently (~5.7–7.3/hr) |

Prod carries ~360 requests/hour through the practice day and drops to ~15–20/hour before
07:00 Central, which is the window to use. Update this section with the after-count once
applied.

---

## 7. Open items

- **`/api/health` latency is unexplained.** The probes no longer cry wolf, but the endpoint
  still sometimes exceeds 5 seconds. `getConnectedClientCount()` is the only I/O on that
  path.
- **`maxReplicas: 1` on both apps.** Every restart and every readiness dip is a full
  outage because there is nothing to fail over to. Raising it is not free — the call store
  is a process-local JSON file (see [../CLAUDE.md](../CLAUDE.md) §2.8), so a second replica
  needs the Postgres cutover first.
- **The OD eConnector error volume** described in §3 needs fixing before it can be alerted
  on.
- **Alerting v1 is email only** and single-recipient. There is no escalation and no
  on-call rotation; if the one inbox is not being read, nothing is.
