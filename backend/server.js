const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { apiRateLimiter } = require('./middleware/rateLimit');
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
  const retentionScheduler = require('./services/retentionScheduler');
  const retentionConfig = require('./config/retention');
  const { requireDashboardAuth, socketAuth } = require('./middleware/auth');
  const { tenantContext, requireModule } = require('./middleware/tenantContext');
  const { requirePermission, requireReadWrite, requireSuperAdmin } = require('./config/permissions');

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

  // Trust proxy — how many hops sit in front of this process.
  //
  // Prod is Container Apps ingress → Caddy → backend, i.e. TWO proxies, and the old
  // value of 1 was one short: req.ip resolved to Caddy's internal address, so every
  // user in the practice shared one rate-limit bucket (see middleware/rateLimit.js).
  // Env-overridable because this is a deployment topology detail, not a code constant —
  // if a proxy is added or removed, that should not need a release.
  const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '2', 10);
  app.set('trust proxy', Number.isFinite(trustProxyHops) ? trustProxyHops : 2);

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

  // Rate limiting. Mounted AFTER cookieParser — it buckets per signed-in user, and the
  // identity lives in the SSO session cookie. Mounted BEFORE /auth and /api so sign-in
  // traffic is covered too; it exempts webhooks, health and the live Retell tools path
  // itself (see middleware/rateLimit.js), rather than relying on where it sits.
  app.use(apiRateLimiter);

  // Entra SSO routes (sign-in/callback/logout/me). Mounted OUTSIDE the /api
  // bearer gate so unauthenticated users can reach the sign-in flow.
  app.use('/auth', authRouter);

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
      // /mango/dev/seed is a staging-only synthetic seeder (ALLOW_MANGO_DEV_SEED-gated,
      // 403 in prod). It still requires the shared bearer token (auth gate above) but
      // carries no user identity and needs no tenant, so it's tenant-exempt like webhooks.
      exempt: [/^\/webhooks(\/|$)/, /^\/health$/, /^\/retell-tools(\/|$)/, /^\/mango\/dev\/seed$/],
    })
  );

  // Routes.
  //
  // Module entitlement (LOGICAL gating, no URL changes): every tenant-scoped
  // route group belongs to a module and is guarded by requireModule(). The
  // guard runs after tenantContext, so req.tenant.modules is populated; it
  // fails closed (403 MODULE_NOT_ENTITLED) when the module isn't enabled OR
  // when tenant context is missing entirely.
  //
  // NEVER guarded (no tenant context by design — a module guard would 403 them):
  //   /api/webhooks/*     Retell/Mango webhooks (HMAC-verified)
  //   /api/retell-tools/* LIVE voice-agent tools (Retell HMAC-verified)
  //   /api/health         monitors
  //   /auth/*             SSO sign-in flow (mounted outside /api entirely)
  //   /api/mango/dev/seed staging-only seeder (tenant-exempt upstream)
  const voiceModule = requireModule('voice');

  // Role gating (Roles PR A). Module entitlement answers "does this PRACTICE
  // buy the product?"; permissions answer "may this PERSON do this?". Both are
  // fail-closed and both run before any handler.
  //
  // The voice surface is gated read-vs-write at the mount so the 'tc' role is
  // genuinely read-only across all of it rather than on the routes someone
  // remembered to decorate. Routes that cost money (sync, transcribe), write to
  // Open Dental, or cross into TC carry their OWN stronger gate inside their
  // router — the specific gate narrows this one, never the reverse.
  //
  // Action names live in ONE map (backend/config/permissions.js). No role
  // literal appears in this file or in any route file.
  const voiceSurface = requireReadWrite('voice.read', 'voice.write');

  // Legacy on-disk Mango recordings (MP3, scraper-era; current playback uses the
  // proxy GET /api/mango/calls/:callId/recording). Recordings are PHI audio, so
  // this static mount sits BELOW the auth gate + tenant context and carries the
  // voice module guard like the rest of /api/mango. It must never be registered
  // above the auth gate — that served recordings unauthenticated on the public
  // hostname (see backend/test/recordingsAuthGate.test.js).
  app.use(
    '/api/mango/recordings',
    voiceModule,
    voiceSurface,
    express.static(path.join(__dirname, 'recordings', 'mango'))
  );

  app.use('/api/calls', voiceModule, voiceSurface, callsRouter);
  app.use('/api/agents', voiceModule, voiceSurface, agentsRouter);
  app.use('/api/opendental', voiceModule, voiceSurface, openDentalRouter);
  // Triggering an OD sync is a sync action, not ordinary bookkeeping.
  app.use(
    '/api/opendental-sync',
    voiceModule,
    requireReadWrite('voice.read', 'voice.sync'),
    openDentalSyncRouter
  );
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/live-calls', voiceModule, voiceSurface, liveCallsRouter);
  // The Admin page: scheduler start/stop, cost ceilings, queues, config. Tenant
  // 'admin' only — this is the one surface 'office' does not get.
  app.use('/api/admin', voiceModule, requirePermission('admin.all'), adminRouter);
  // Tenant user management (Roles PR B). Deliberately NOT behind the voice
  // module guard: managing who works here is a property of the practice, not
  // of any product they bought. A TC-only tenant still needs a Users page.
  app.use('/api/users', requirePermission('admin.all'), require('./routes/users'));
  // The Platform Console (PR C): the tenant catalog, module entitlements, and
  // the call-store retention policy. NO module guard, deliberately — entitlement
  // answers "did this practice buy the product?", and this is the surface that
  // decides the answer, so gating it on a module would be circular. Tenant
  // 'admin' is not enough: requireSuperAdmin() is the platform tier, and it does
  // not admit the shared machine token either.
  app.use('/api/platform', requireSuperAdmin(), require('./routes/platform'));
  // /dev/seed is tenant-exempt upstream, so it has no req.userRole to check and
  // must be permission-exempt for the same reason (it is ALLOW_MANGO_DEV_SEED-
  // gated and 403s in prod on its own).
  app.use(
    '/api/mango',
    requireModule('voice', { exempt: [/^\/dev\/seed$/] }),
    requireReadWrite('voice.read', 'voice.write', { exempt: [/^\/dev\/seed$/] }),
    mangoRouter
  );
  app.use('/api/callbacks', voiceModule, voiceSurface, callbacksRouter);
  // Two exempt paths, both SHELL CONFIG rather than call data:
  //
  //   /sync-status  the "last synced" caption, polled by every signed-in shell.
  //   /offices      the office roster (key, display name, odConnected). Every
  //                 office-scoped surface in the product has to know the
  //                 practice's offices before it can render a picker — including
  //                 the TC and hygiene pages, whose users hold no voice
  //                 permission at all. Gating this on voice.read is what made
  //                 every hygiene page show the zero-office dead end.
  //
  // Neither carries PHI. Everything else here is gated, and the paid/PHI-writing
  // routes carry stronger gates inside the router. The MODULE guard still applies
  // to both: this opens the roster to every USER, not to every tenant.
  app.use(
    '/api/unified-calls',
    voiceModule,
    requireReadWrite('voice.read', 'voice.write', { exempt: [/^\/sync-status$/, /^\/offices$/] }),
    unifiedCallsRouter
  );
  app.use('/api/analytics', voiceModule, voiceSurface, analyticsRouter);
  app.use('/api/retell-tools', retellToolsRouter);
  app.use('/api/retell-tools-config', voiceModule, voiceSurface, retellToolsConfigRouter);
  app.use('/api/agent-config', voiceModule, voiceSurface, agentConfigRouter);
  app.use('/api/notifications-config', voiceModule, voiceSurface, notificationsConfigRouter);
  app.use('/api/slot-markers', voiceModule, voiceSurface, slotMarkersRouter);

  // TC (Treatment Coordinator) module — Slice 3 backend port. ONE mount for
  // the whole /api/tc/* surface, behind its own module guard. Ships DARK: no
  // tenant is entitled to 'tc' yet, so everything under it 403s until the
  // entitlement flips (intentional — see routes/tc/index.js).
  app.use('/api/tc', requireModule('tc'), require('./routes/tc'));

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

    // 2. Periodic Retell sync every 15 minutes. Same cadence as before; the timer now
    //    lives in the scheduler so it can report when the next automatic pull lands
    //    (the worklist's "next auto …" caption reads it via /unified-calls/sync-status).
    syncScheduler.startRetellAutoSync();

    // 3. Start Mango sync scheduler (cron-based, default: every hour at :15)
    syncScheduler.start();

    // 4. Start the nightly retention prune (default 3:30am America/Chicago).
    //    Kept separate from syncScheduler on purpose — see services/retentionScheduler.js.
    //    NOT run at startup: a container restart must never be the thing that
    //    destroys records, and the store has just finished loading.
    //
    //    The stored window is read from the control plane BEFORE start(), which
    //    decides whether to schedule at all: with a stored window of 60 and
    //    CALL_RETENTION_DAYS=0 in the environment, starting first would read the
    //    environment's kill switch and never arm the job. Awaited for the same
    //    reason. A failure here is not fatal — refreshFromDb() never throws, and
    //    runNow() refuses to prune on an unknown policy.
    await retentionConfig.refreshFromDb();
    retentionScheduler.start();

    // (M3) The startup `transcribeUntranscribedMango` backfill was removed: it keyed on
    // `recording_path`, which the API ingest path never sets, so it found zero candidates
    // on every run (diagnosis H2). Re-transcribing an already-ingested call is M4's
    // on-demand button over the store, not an automatic startup sweep.

  }).catch(error => {
    console.error('Failed to initialize unified call store:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    retentionScheduler.stop();
    await unifiedCallStore.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    retentionScheduler.stop();
    await unifiedCallStore.shutdown();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err && err.message ? err.message : err);
  process.exit(1);
});
