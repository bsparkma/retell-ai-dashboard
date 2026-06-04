const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const { loadSecrets } = require('./config/secrets');
const { sanitizeUrlPath } = require('./utils/scrub');

/**
 * Async startup. Secrets are loaded FIRST (Key Vault in production via the
 * connector certificate, .env in dev). Modules that read process.env at
 * construction time — notably the Open Dental connector singleton — are
 * required INSIDE bootstrap(), after loadSecrets() has populated process.env,
 * so they never see unresolved configuration.
 */
async function bootstrap() {
  // 1) Resolve secrets before anything that depends on them.
  await loadSecrets();

  // 1b) Fail-closed (COMPLY): in production, refuse to start if the per-tenant
  //     audit store is unreachable for any active tenant — PHI must never be
  //     served without a working audit trail. No-op in non-production.
  const audit = require('./platform/audit');
  await audit.assertReady();

  // 2) Require secret-dependent routers/services (these transitively construct
  //    the OD connector, Retell, and Mango config from process.env).
  const callsRouter = require('./routes/calls');
  const agentsRouter = require('./routes/agents');
  const openDentalRouter = require('./routes/openDental');
  const openDentalSyncRouter = require('./routes/openDentalSync');
  const webhooksRouter = require('./routes/webhooks');
  const liveCallsRouter = require('./routes/liveCalls');
  const adminRouter = require('./routes/admin');
  const mangoRouter = require('./routes/mango');
  const callbacksRouter = require('./routes/callbacks');
  const unifiedCallsRouter = require('./routes/unifiedCalls');
  const analyticsRouter = require('./routes/analytics');
  const retellToolsRouter = require('./routes/retellTools');
  const retellToolsConfigRouter = require('./routes/retellToolsConfig');
  const agentConfigRouter = require('./routes/agentConfig');
  const notificationsConfigRouter = require('./routes/notificationsConfig');
  const slotMarkersRouter = require('./routes/slotMarkers');
  const authRouter = require('./routes/auth');
  const { initializeSocketHandlers } = require('./socket/socketHandler');
  const unifiedCallStore = require('./services/unifiedCallStore');
  const syncScheduler = require('./services/syncScheduler');
  const { requireDashboardAuth, socketAuth } = require('./middleware/auth');
  const { tenantContext } = require('./middleware/tenantContext');

  const app = express();
  // Default ports: 5003 in production, 5103 in dev. PORT env var overrides both.
  const PORT =
    process.env.PORT || (process.env.NODE_ENV === 'production' ? 5003 : 5103);

  // Parse CORS origins (supports comma-separated list in env). Always include new dashboard (3005).
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3004', 'http://localhost:3005'];
  if (!corsOrigins.includes('http://localhost:3005')) {
    corsOrigins.push('http://localhost:3005');
  }

  const PRODUCTION_DOMAINS = [
    'https://carein-do.flamingketchup.com',
    'http://carein-do.flamingketchup.com',
  ];
  PRODUCTION_DOMAINS.forEach(domain => {
    if (!corsOrigins.includes(domain)) corsOrigins.push(domain);
  });

  // Create HTTP server for Socket.IO
  const server = http.createServer(app);

  // Initialize Socket.IO with CORS settings
  const io = new Server(server, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Require DASHBOARD_API_TOKEN on Socket.IO connections so live transcripts
  // and call events aren't readable by anyone who can reach the server.
  io.use(socketAuth);

  // Initialize Socket.IO event handlers
  initializeSocketHandlers(io);

  // Trust proxy for rate limiting
  app.set('trust proxy', 1);

  // Rate limiting - higher limits for development
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'production' ? 100 : 1000 // Higher limit for development
  });

  // Middleware (relax Helmet cross-origin so dashboard on 3005 can read API responses)
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false
  }));
  // CORS: allow new dashboard (3005) and others; explicit methods/headers so preflight succeeds
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
  }));
  // Redact PHI (query strings, name/phone path params) from request logs.
  morgan.token('url', (req) => sanitizeUrlPath(req.originalUrl || req.url));
  app.use(morgan('combined'));

  // Structured access log — append-only JSONL for HIPAA audit trail
  const _accessLogStream = fs.createWriteStream(
    path.join(__dirname, '..', 'data', 'access-log.jsonl'),
    { flags: 'a' }
  );

  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path.startsWith('/api/webhooks')) return next();
    const started = Date.now();
    res.on('finish', () => {
      const entry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: sanitizeUrlPath(req.originalUrl || req.path),
        status: res.statusCode,
        ms: Date.now() - started,
        ip: req.ip || req.socket?.remoteAddress || null,
        ua: req.headers['user-agent'] || null,
      };
      _accessLogStream.write(JSON.stringify(entry) + '\n');
    });
    next();
  });

  app.use(limiter);
  // Capture raw body for HMAC signature verification (e.g. Retell webhooks).
  // Without this, signature verification cannot use the raw body Retell signed.
  app.use(express.json({
    verify: (req, _res, buf) => {
      if (buf && buf.length) req.rawBody = buf.toString('utf8');
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  // Parse cookies so the Entra SSO session cookie is available to /auth and the gate.
  app.use(cookieParser());

  // Entra SSO routes (sign-in/callback/logout/me). Mounted OUTSIDE the /api
  // bearer gate so unauthenticated users can reach the sign-in flow.
  app.use('/auth', authRouter);

  // Serve downloaded Mango recordings (MP3) from disk
  app.use('/api/mango/recordings', express.static(path.join(__dirname, 'recordings', 'mango')));

  // Auth gate for /api/*: a valid Entra SSO session cookie OR the shared
  // dashboard bearer token. Webhooks (HMAC-authenticated) and the health check
  // are exempt so monitors and Retell can still reach them.
  app.use(
    '/api',
    requireDashboardAuth({
      // /retell-tools/* is authenticated via Retell's HMAC signature instead
      // of the dashboard bearer token; see backend/routes/retellTools.js.
      exempt: [/^\/webhooks(\/|$)/, /^\/health$/, /^\/retell-tools(\/|$)/],
    })
  );

  // Tenant context: resolve req.tenant from the authenticated user and fail
  // closed (403) if none resolves. Runs AFTER the auth gate, with the SAME
  // exempt paths — webhooks/health/retell-tools carry no user identity and
  // must not require a tenant. Prereq: carein_control reachable (CONTROL_DB_URL
  // in dev / Key Vault 'control-db-url' in prod, migrations applied).
  app.use(
    '/api',
    tenantContext({
      exempt: [/^\/webhooks(\/|$)/, /^\/health$/, /^\/retell-tools(\/|$)/],
    })
  );

  // Routes
  app.use('/api/calls', callsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/opendental', openDentalRouter);
  app.use('/api/opendental-sync', openDentalSyncRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/live-calls', liveCallsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/mango', mangoRouter);
  app.use('/api/callbacks', callbacksRouter);
  app.use('/api/unified-calls', unifiedCallsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/retell-tools', retellToolsRouter);
  app.use('/api/retell-tools-config', retellToolsConfigRouter);
  app.use('/api/agent-config', agentConfigRouter);
  app.use('/api/notifications-config', notificationsConfigRouter);
  app.use('/api/slot-markers', slotMarkersRouter);

  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    const liveCallManager = require('./services/liveCallManager');
    const { getConnectedClientCount } = require('./socket/socketHandler');

    let connectedClients = 0;
    try {
      connectedClients = await getConnectedClientCount();
    } catch (e) {
      // Ignore errors getting client count
    }

    // Open Dental status reflects the active integration mode. In 'api' mode
    // (CareIN's default) the service is configured when an API base URL is set;
    // only a direct-DB mode reports on OPENDENTAL_DB_URL.
    const odMode = (process.env.OPENDENTAL_INTEGRATION_MODE || '').trim().toLowerCase();
    const odApiBaseUrl = process.env.OPENDENTAL_API_BASE_URL || process.env.OD_API_URL;
    const odDirectDbModes = ['db', 'database', 'mysql', 'direct'];
    let openDentalStatus;
    if (odMode === 'api') {
      openDentalStatus = odApiBaseUrl ? 'api configured' : 'not configured';
    } else if (odDirectDbModes.includes(odMode)) {
      openDentalStatus = process.env.OPENDENTAL_DB_URL ? 'database configured' : 'not configured';
    } else {
      // No explicit mode: prefer API base URL, then a direct-DB URL.
      openDentalStatus = odApiBaseUrl ? 'api configured' :
                         process.env.OPENDENTAL_DB_URL ? 'database configured' : 'not configured';
    }

    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      services: {
        retell: 'connected',
        openDental: openDentalStatus,
        socketIO: 'active'
      },
      realtime: {
        connected_clients: connectedClients,
        active_calls: liveCallManager.getActiveCount(),
        emergency_calls: liveCallManager.getEmergencyCalls().length
      }
    });
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
      message: 'Something went wrong!',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  });

  // 404 handler
  app.use('*', (req, res) => {
    res.status(404).json({ message: 'Route not found' });
  });

  // Initialize unified call store and start server
  await unifiedCallStore.initialize().then(async () => {
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Dashboard API ready at http://localhost:${PORT}/api`);
      console.log(`🔌 Socket.IO ready for real-time connections`);
      console.log(`📞 Webhook endpoint: http://localhost:${PORT}/api/webhooks/retell`);
      console.log(`📁 Unified call store initialized with ${unifiedCallStore.getStats().totalCalls} calls`);
    });

    // --- Post-startup sync pipeline (non-blocking) ---

    // 1. Immediate Retell sync on startup
    console.log('🔄 Running initial Retell sync...');
    syncScheduler.runRetellSync({ limit: 1000 }).catch(err =>
      console.error('Initial Retell sync error:', err.message)
    );

    // 2. Periodic Retell sync every 15 minutes
    const RETELL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
    setInterval(() => {
      syncScheduler.runRetellSync({ limit: 1000 }).catch(err =>
        console.error('Periodic Retell sync error:', err.message)
      );
    }, RETELL_SYNC_INTERVAL_MS);
    console.log('⏰ Retell auto-sync scheduled every 15 minutes');

    // 3. Start Mango sync scheduler (cron-based, default: every hour at :15)
    syncScheduler.start();

    // 4. Transcribe any untranscribed Mango calls that have local recordings
    //    (runs once on startup, then again after each Mango sync via the scheduler)
    setTimeout(() => {
      syncScheduler.transcribeUntranscribedMango({ maxCalls: 10 }).catch(err =>
        console.error('Mango transcription backfill error:', err.message)
      );
    }, 10000); // wait 10s for Retell sync to finish first

  }).catch(error => {
    console.error('Failed to initialize unified call store:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await unifiedCallStore.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await unifiedCallStore.shutdown();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err && err.message ? err.message : err);
  process.exit(1);
});
