module.exports = {
  apps: [
    {
      name: 'carein-backend',
      cwd: './backend',
      script: 'server.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      // new-dashboard is a Vite + Express app (not Next.js).
      // The build script in new-dashboard/package.json bundles
      // server/index.ts → dist/index.js with esbuild.
      // Run `npm --prefix new-dashboard run build` before pm2 reload.
      name: 'carein-dashboard',
      cwd: './new-dashboard',
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3005,
      },
      error_file: './logs/dashboard-error.log',
      out_file: './logs/dashboard-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    }
  ]
};
