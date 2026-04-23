/**
 * Socket Context
 * 
 * Provides Socket.IO connection to all components.
 * Manages connection state, reconnection, and event handling.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import config from '../config/env';

// Create context
const SocketContext = createContext(null);

// Socket.IO connection options
const SOCKET_OPTIONS = {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ['websocket', 'polling'],
  // Backend requires DASHBOARD_API_TOKEN on every connection (when set).
  auth: config.dashboardApiToken ? { token: config.dashboardApiToken } : undefined,
};

/**
 * Socket Provider Component
 */
export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [lastPing, setLastPing] = useState(null);

  // Initialize socket connection
  useEffect(() => {
    // Get base URL from config (remove /api suffix)
    const baseUrl = config.apiUrl.replace('/api', '');
    
    console.log('🔌 Initializing Socket.IO connection to:', baseUrl);
    
    const socketInstance = io(baseUrl, SOCKET_OPTIONS);

    // Connection event handlers
    socketInstance.on('connect', () => {
      console.log('🔌 Socket.IO connected:', socketInstance.id);
      setIsConnected(true);
      setConnectionError(null);
    });

    socketInstance.on('disconnect', (reason) => {
      console.log('🔌 Socket.IO disconnected:', reason);
      setIsConnected(false);
    });

    socketInstance.on('connect_error', (error) => {
      console.error('🔌 Socket.IO connection error:', error.message);
      setConnectionError(error.message);
      setIsConnected(false);
    });

    socketInstance.on('reconnect', (attemptNumber) => {
      console.log('🔌 Socket.IO reconnected after', attemptNumber, 'attempts');
      setIsConnected(true);
      setConnectionError(null);
    });

    socketInstance.on('reconnect_attempt', (attemptNumber) => {
      console.log('🔌 Socket.IO reconnection attempt:', attemptNumber);
    });

    socketInstance.on('reconnect_failed', () => {
      console.error('🔌 Socket.IO reconnection failed');
      setConnectionError('Failed to reconnect to server');
    });

    // Pong response for health checks
    socketInstance.on('pong', (data) => {
      setLastPing(Date.now() - data.timestamp);
    });

    setSocket(socketInstance);

    // Cleanup on unmount
    return () => {
      console.log('🔌 Cleaning up Socket.IO connection');
      socketInstance.disconnect();
    };
  }, []);

  // Ping server for health check
  const ping = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('ping');
    }
  }, [socket, isConnected]);

  // Subscribe to an event
  const subscribe = useCallback((event, callback) => {
    if (socket) {
      socket.on(event, callback);
      return () => socket.off(event, callback);
    }
    return () => {};
  }, [socket]);

  // Emit an event
  const emit = useCallback((event, data) => {
    if (socket && isConnected) {
      socket.emit(event, data);
    }
  }, [socket, isConnected]);

  // Context value
  const value = {
    socket,
    isConnected,
    connectionError,
    lastPing,
    ping,
    subscribe,
    emit
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};

/**
 * Hook to use socket context
 */
export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

export default SocketContext;

