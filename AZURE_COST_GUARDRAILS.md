# Azure Cost Guardrails

_How to keep the CareIN Azure footprint near-zero through Phase 1 and avoid bill surprises. Drafted 2026-06-02._

## The reassuring reality

Your current Azure footprint is almost free:
- **Entra ID Free** — $0
- **Key Vault** — per-operation pennies (~$0.03 per 10k ops; your cert/secret reads are negligible)
- **M365 Business Basic** — the ~$6/user you already pay (not really "Azure project" cost)
- **The CareIN app** — runs on-prem on your workstation → $0 Azure

The only things that cost real money: **Azure Postgres** once provisioned, and (Phase 3) Container Apps / Front Door / APIM. None are running yet.

## Rule 1 — Dev uses LOCAL Docker Postgres, not Azure

CC tested every Phase 1 slice against ephemeral Docker Postgres. Keep doing that. Local Postgres = $0 and removes the #1 surprise (a forgotten running cloud DB). **Provision Azure Postgres only for PROD.**

## Rule 2 — There is no hard cap; budgets only alert

Pay-as-you-go Azure has NO automatic spending ceiling. Budgets email alerts (which can lag ~24h) but don't stop resources. So protection = cheap tiers + discipline + alerts, not enforcement.

## One-time guardrails to set today

1. **Budget + alerts** — Azure portal → Cost Management → Budgets → Add: scope = your subscription, amount = e.g. **$25/mo**, alert thresholds at **50% / 80% / 100%**, email `admin@carein.ai`. Free. Do this even before provisioning anything.
2. **Anomaly alerts** — Cost Management → Cost alerts → enable anomaly detection (free; flags unexpected spikes).
3. **Tag resources** `env=dev` / `env=prod` so cost is attributable in Cost analysis.

## When you DO provision PROD Azure Postgres

- **Tier: Burstable B1ms** (~$12/mo) — fine for early tenants. Do NOT pick General Purpose.
- **One server, multiple databases** (control + per-tenant), per the same-server decision. Don't spin a server per DB.
- **Disable geo-redundant backups** for now (locally/zone-redundant is cheaper); keep ~7-day retention.
- **Stop any non-prod/staging server when idle** (you pay storage, not compute, while stopped).
- **Storage**: start at 32GB, grows as needed.

## Stay out of Phase-3 cost until Phase 3

Container Apps, Front Door, APIM, and Log Analytics ingestion all carry real monthly cost and none are needed for Phase 1 (on-prem hosting). Don't stand them up speculatively.

## Surprise watch-list

- A forgotten **running Postgres server** (the big one) → use local Docker for dev.
- **Geo-redundant backups** / high storage tiers.
- **Log Analytics ingestion** if you later route logs there — you're using a Postgres `audit_log`, so you're fine.
- **Egress bandwidth** — minimal for your usage.

## Monthly 2-minute habit

Open Cost Management → Cost analysis once a month. Expected Phase 1 bill: **Key Vault pennies now → ~$12–15/mo once prod Postgres is up.** That's the whole story until Phase 3.
