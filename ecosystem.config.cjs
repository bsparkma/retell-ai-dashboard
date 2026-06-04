// PM2 process manifest for CareIN dashboard.
// Start with:   pm2 start ecosystem.config.cjs
// Persist:      pm2 save
// Boot on logon: pm2-startup install   (see README / setup notes)

const path = require('path');

const ROOT = __dirname;
const BACKEND_DIR = path.join(ROOT, 'backend');
const DASHBOARD_DIR = path.join(ROOT, 'new-dashboard');
const DASHBOARD_DIST = path.join(DASHBOARD_DIR, 'dist', 'index.js');

// Build the dashboard before reloading PM2:
//   cd new-dashboard && pnpm build
//
// `carein-dashboard` runs the bundled CareIN Express server (server/index.ts ->
// dist/index.js). That single process serves the built SPA AND handles the
// CareIN API + Retell webhook ingestion (/api/calls, /api/analytics/calls,
// /api/webhook/retell). The existing `carein-backend` on port 5003 is unchanged.

module.exports = {
  apps: [
    {
      name: 'carein-backend',
      cwd: BACKEND_DIR,
      script: 'server.js',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      out_file: path.join(ROOT, 'logs', 'backend-out.log'),
      error_file: path.join(ROOT, 'logs', 'backend-err.log'),
      merge_logs: true,
      time: true,
      env: {
        // INTERIM team-facing config (2026-06-03): backend sits behind Caddy at
        // https://dashboard.carein.ai (same-origin). Intentionally NOT
        // NODE_ENV=production tonight — that keeps secrets coming from
        // backend/.env (no Key Vault cert dependency) and cookie Secure=false,
        // which is safe because Caddy terminates TLS and is the only ingress.
        // PM2 injects these BEFORE server.js runs dotenv.config(), so they
        // OVERRIDE backend/.env (dotenv never overwrites an already-set env key).
        // Harden later: set NODE_ENV:'production' for Key Vault secrets, the
        // per-tenant audit gate, and Secure=true cookies.
        NODE_ENV: 'development',
        PORT: 5003,
        DASHBOARD_SSO_REDIRECT_URI: 'https://dashboard.carein.ai/auth/callback',
        DASHBOARD_POST_LOGIN_URL: 'https://dashboard.carein.ai',
      },
    },
    {
      name: 'carein-dashboard',
      cwd: DASHBOARD_DIR,
      script: DASHBOARD_DIST,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      out_file: path.join(ROOT, 'logs', 'dashboard-out.log'),
      error_file: path.join(ROOT, 'logs', 'dashboard-err.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3005,
        // Live mode: preserve persisted data/calls.json across restarts.
        // Set USE_SEED_DATA=true here only for demo/reset scenarios.
        // RETELL_API_KEY is read from new-dashboard/.env at startup.
      },
    },
  ],
};
