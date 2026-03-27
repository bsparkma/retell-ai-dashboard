/**
 * Socket.IO context for live calls
 * Connects to the same host as VITE_API_URL (without /api) for real-time updates
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { BackendLiveCall } from "@/lib/api";
import { normalizeLiveCall } from "@/lib/api";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";
const SOCKET_BASE = BASE.replace(/\/api\/?$/, "");

const SOCKET_OPTIONS = {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ["websocket", "polling"] as string[],
};

export type LiveCall = ReturnType<typeof normalizeLiveCall>;

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
  liveCalls: LiveCall[];
  subscribe: (event: string, callback: (...args: unknown[]) => void) => () => void;
  emit: (event: string, data?: unknown) => void;
  requestLiveCalls: () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);

  useEffect(() => {
    const s = io(SOCKET_BASE, SOCKET_OPTIONS);

    s.on("connect", () => {
      setIsConnected(true);
      setConnectionError(null);
      s.emit("live-calls:get");
    });

    s.on("disconnect", () => setIsConnected(false));
    s.on("connect_error", (err: Error) => {
      setConnectionError(err.message);
      setIsConnected(false);
    });

    s.on("live-calls:update", (payload: BackendLiveCall[] | { calls?: BackendLiveCall[] }) => {
      const list = Array.isArray(payload) ? payload : (payload as { calls?: BackendLiveCall[] }).calls ?? [];
      setLiveCalls(list.map(normalizeLiveCall));
    });

    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, []);

  const subscribe = useCallback(
    (event: string, callback: (...args: unknown[]) => void) => {
      if (!socket) return () => {};
      socket.on(event, callback);
      return () => socket.off(event, callback);
    },
    [socket]
  );

  const emit = useCallback(
    (event: string, data?: unknown) => {
      if (socket && isConnected) socket.emit(event, data);
    },
    [socket, isConnected]
  );

  const requestLiveCalls = useCallback(() => {
    emit("live-calls:get");
  }, [emit]);

  const value: SocketContextValue = {
    socket,
    isConnected,
    connectionError,
    liveCalls,
    subscribe,
    emit,
    requestLiveCalls,
  };

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error("useSocket must be used within SocketProvider");
  return ctx;
}

export function useLiveCalls(): LiveCall[] {
  const { liveCalls } = useSocket();
  return liveCalls;
}
