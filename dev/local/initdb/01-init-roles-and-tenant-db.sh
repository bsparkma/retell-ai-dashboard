#!/bin/bash
# Runs ONCE on first cluster init (empty data volume), as the superuser
# carein_owner, connected to POSTGRES_DB (carein_control).
#
# Creates the two things the migration runners can't create for themselves:
#   - carein_app        : least-privilege LOGIN role for the app runtime. Owns
#                         nothing, so the audit_log append-only grants
#                         (INSERT,SELECT only) are genuinely enforced against it.
#   - carein_t_carein   : CareIN's per-tenant data-plane database, owned by the
#                         migration/admin role (carein_owner).
#
# carein_control itself is created by Postgres from POSTGRES_DB. No application
# schema is created here — that is the job of:
#   npm run migrate:up                      (control plane -> carein_control)
#   npm run migrate:tenant up -- --tenant carein   (data plane -> carein_t_carein)
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
  -- Least-privilege app role (matches AUDIT_APP_ROLE default 'carein_app').
  CREATE ROLE carein_app LOGIN PASSWORD '${CAREIN_APP_PASSWORD}';

  -- CareIN's per-tenant data-plane DB, owned by the admin/migration role.
  CREATE DATABASE carein_t_carein OWNER ${POSTGRES_USER};
EOSQL

echo "[initdb] created role 'carein_app' and database 'carein_t_carein'"
