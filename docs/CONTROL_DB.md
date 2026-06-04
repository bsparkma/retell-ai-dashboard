# Control Plane Database (`carein_control`)

The control plane is a Postgres database that will hold the cross-cutting state
the current single-tenant JSON stores can't: the clinic/practice registry, the
user→clinic mapping, connector registration, and other control-plane tables.
This document covers the **migration tooling and configuration** that was
scaffolded first — the schema itself lands in later migrations.

> Today the backend persists app data in repo-root `data/*.json`
> (`unified_calls.json`, `agent-config.json`, …) and is effectively
> single-tenant. `carein_control` is the foundation for changing that.

---

## Tooling

Migrations use [**node-pg-migrate**](https://salsita.github.io/node-pg-migrate/)
(v6 — the CommonJS line, matching this CJS backend) on top of the `pg` driver.
No ORM or query builder is introduced; this is migrations only.

| Path | Purpose |
|------|---------|
| `backend/migrations/` | Migration files (`<timestamp>_<name>.js`, `exports.up`/`exports.down`) |
| `backend/scripts/migrate.js` | Runner that loads config the same way the app does, then drives node-pg-migrate programmatically |
| `pgmigrations` (table) | node-pg-migrate's bookkeeping table, auto-created in the control DB on first run |

## Configuration

The runner reads **one** value, `CONTROL_DB_URL`, through the existing
[`secrets.js`](../backend/config/secrets.js) flow:

- **Dev** (`NODE_ENV` ≠ `production`): `CONTROL_DB_URL` comes from `backend/.env`.
- **Prod** (`NODE_ENV=production`): `loadSecrets()` fetches Key Vault secret
  **`control-db-url`** and writes it onto `process.env.CONTROL_DB_URL` — the same
  mechanism every other secret uses (see [SECRETS.md](./SECRETS.md)).

For Azure Postgres, request TLS in the URL:

```
postgres://user:pass@host:5432/carein_control?sslmode=require
```

## Commands

Run from `backend/`:

```bash
npm run migrate:up        # apply all pending migrations
npm run migrate:down      # roll back the most recent migration
npm run migrate:redo      # down 1 then up 1 (re-test the latest)
npm run migrate:create -- add_clinics_table   # scaffold a new migration file
```

Lower-level forms also work: `node scripts/migrate.js down 3` rolls back three.

## Adding the first real schema

`backend/migrations/<ts>_init.js` is intentionally an empty no-op — it exists so
the tooling, the `pgmigrations` table, and CI are exercised before any schema
lands. To add control-plane tables (clinics/practices, user→clinic mapping,
connector registry, …):

1. `npm run migrate:create -- <name>` to generate a timestamped file.
2. Fill in `exports.up` / `exports.down`.
3. `npm run migrate:up`.

Keep every migration reversible (`down` must undo `up`).
