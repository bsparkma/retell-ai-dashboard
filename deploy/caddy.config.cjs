// PM2 manifest for the Caddy reverse proxy (team-facing HTTPS edge for
// https://dashboard.carein.ai). Kept separate from the app ecosystem so the
// proxy can be managed independently.
//
//   Start:  pm2 start deploy/ecosystem.caddy.cjs
//   Persist (resurrect on reboot): pm2 save   (requires pm2 startup/logon hook)
//
// Args are an ARRAY so PM2 passes them verbatim to caddy.exe (avoids the CLI
// `--` parsing that mangles `--config`). Caddy loads our externally-managed
// Let's Encrypt cert from the Caddyfile and does NOT run ACME itself.

const path = require('path');

const DEPLOY = __dirname;
const ROOT = path.join(DEPLOY, '..');

module.exports = {
  apps: [
    {
      name: 'caddy',
      script: 'C:/caddy/caddy.exe',
      args: ['run', '--config', path.join(DEPLOY, 'Caddyfile'), '--adapter', 'caddyfile'],
      interpreter: 'none',
      cwd: DEPLOY,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      out_file: path.join(ROOT, 'logs', 'caddy-out.log'),
      error_file: path.join(ROOT, 'logs', 'caddy-err.log'),
      merge_logs: true,
    },
  ],
};
