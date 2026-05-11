// PM2 process manifest for CareIN dashboard.
// Start with:   pm2 start ecosystem.config.cjs
// Persist:      pm2 save
// Boot on logon: pm2-startup install   (see README / setup notes)

const path = require('path');

const ROOT = __dirname;
const BACKEND_DIR = path.join(ROOT, 'backend');
const DASHBOARD_DIR = path.join(ROOT, 'new-dashboard');
const VITE_BIN = path.join(DASHBOARD_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

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
        NODE_ENV: 'development',
      },
    },
    {
      name: 'carein-dashboard',
      cwd: DASHBOARD_DIR,
      script: VITE_BIN,
      args: '--host',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      out_file: path.join(ROOT, 'logs', 'dashboard-out.log'),
      error_file: path.join(ROOT, 'logs', 'dashboard-err.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
