"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { SlotMarker } from "./types";
import { getSlotMarkers } from "./api";

interface SlotMarkersContextValue {
  markers: SlotMarker[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const SlotMarkersContext = createContext<SlotMarkersContextValue | null>(null);

const DEFAULT_CLINIC_NUM = 0;

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

function dateIsoPlusMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

export function SlotMarkersProvider({ children }: { children: React.ReactNode }) {
  const [markers, setMarkers] = useState<SlotMarker[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getSlotMarkers({
      startDate: todayIso(),
      endDate: dateIsoPlusMonths(6),
      clinicNum: DEFAULT_CLINIC_NUM,
    })
      .then((data) => {
        if (cancelled) return;
        setMarkers(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load slot markers";
        setError(message);
        setMarkers([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const value: SlotMarkersContextValue = { markers, loading, error, refresh };

  return (
    <SlotMarkersContext.Provider value={value}>{children}</SlotMarkersContext.Provider>
  );
}

export function useSlotMarkers(): SlotMarkersContextValue {
  const ctx = useContext(SlotMarkersContext);
  if (!ctx) {
    throw new Error("useSlotMarkers must be used within a SlotMarkersProvider");
  }
  return ctx;
}
