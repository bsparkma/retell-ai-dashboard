/**
 * Socket.IO Handler
 * 
 * Manages WebSocket connections and real-time events
 * between the backend and frontend dashboard.
 */

const liveCallManager = require('../services/liveCallManager');

/**
 * Initialize Socket.IO handlers
 * @param {Server} io - Socket.IO server instance
 */
function initializeSocketHandlers(io) {
  // Pass io instance to live call manager
  liveCallManager.setSocketIO(io);

  // Connection handler
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Send current live calls on connection
    socket.emit('live-calls:update', liveCallManager.getAllCalls());

    // Send active call count
    socket.emit('live-calls:count', liveCallManager.getActiveCount());

    // Handle client requesting current state
    socket.on('live-calls:get', () => {
      socket.emit('live-calls:update', liveCallManager.getAllCalls());
    });

    // Handle client requesting specific call
    socket.on('call:get', (callId) => {
      const call = liveCallManager.getCall(callId);
      if (call) {
        socket.emit('call:data', call);
      } else {
        socket.emit('call:not-found', { call_id: callId });
      }
    });

    // Handle client subscribing to specific call updates
    socket.on('call:subscribe', (callId) => {
      socket.join(`call:${callId}`);
      console.log(`📞 Client ${socket.id} subscribed to call ${callId}`);
      
      // Send current call data
      const call = liveCallManager.getCall(callId);
      if (call) {
        socket.emit('call:data', call);
      }
    });

    // Handle client unsubscribing from call updates
    socket.on('call:unsubscribe', (callId) => {
      socket.leave(`call:${callId}`);
      console.log(`📞 Client ${socket.id} unsubscribed from call ${callId}`);
    });

    // Handle ping for connection health check
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      console.log(`🔌 Client disconnected: ${socket.id} (${reason})`);
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`❌ Socket error for ${socket.id}:`, error);
    });
  });

  // Middleware for logging (optional, for debugging)
  io.use((socket, next) => {
    const clientIP = socket.handshake.address;
    console.log(`🔌 New connection attempt from ${clientIP}`);
    next();
  });

  console.log('🔌 Socket.IO handlers initialized');
}

/**
 * Emit event to all connected clients
 */
function broadcast(event, data) {
  const io = liveCallManager.io;
  if (io) {
    io.emit(event, data);
  }
}

/**
 * Emit event to clients subscribed to a specific call
 */
function emitToCall(callId, event, data) {
  const io = liveCallManager.io;
  if (io) {
    io.to(`call:${callId}`).emit(event, data);
  }
}

/**
 * Get connected client count
 */
async function getConnectedClientCount() {
  const io = liveCallManager.io;
  if (io) {
    const sockets = await io.fetchSockets();
    return sockets.length;
  }
  return 0;
}

module.exports = {
  initializeSocketHandlers,
  broadcast,
  emitToCall,
  getConnectedClientCount
};

