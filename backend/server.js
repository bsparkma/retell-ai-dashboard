const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

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
const { initializeSocketHandlers } = require('./socket/socketHandler');
const unifiedCallStore = require('./services/unifiedCallStore');
const syncScheduler = require('./services/syncScheduler');
const { requireDashboardToken, socketAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;

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
      path: req.path,
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

// Serve downloaded Mango recordings (MP3) from disk
app.use('/api/mango/recordings', express.static(path.join(__dirname, 'recordings', 'mango')));

// Bearer-token auth gate for /api/*. Webhooks (HMAC-authenticated) and the
// health check are exempt so monitors and Retell can still reach them.
app.use(
  '/api',
  requireDashboardToken({
    // /retell-tools/* is authenticated via Retell's HMAC signature instead
    // of the dashboard bearer token; see backend/routes/retellTools.js.
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
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    services: {
      retell: 'connected',
      openDental: process.env.OPENDENTAL_DB_URL ? 'database configured' : 
                  process.env.OD_API_URL ? 'api configured' : 'not configured',
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
unifiedCallStore.initialize().then(async () => {
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