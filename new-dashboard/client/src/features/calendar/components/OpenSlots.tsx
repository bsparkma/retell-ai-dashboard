/**
 * OpenSlots — Shows available scheduling blocks for the selected date.
 * Uses the backend find-slots endpoint to display where patients can be booked.
 * Color-coded by duration: 30min, 60min, 90min blocks.
 */
"use client";

import { useState, useEffect } from "react";
import { useCalendarState } from "../store/CalendarContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, CalendarPlus, RefreshCw, Info } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface AvailableSlot {
  date: string;
  time: string;
  providerId?: number;
  operatoryId?: number;
}

interface ScheduleMetrics {
  totalAppointments: number;
  totalSlots: number;
  bookedSlots: number;
  availabilityPercentage: number;
  hasAvailability: boolean;
}

const DURATION_OPTIONS = [
  { label: "30 min", value: 30, color: "oklch(0.55 0.18 210)", bgColor: "oklch(0.55 0.18 210 / 0.1)" },
  { label: "60 min", value: 60, color: "oklch(0.55 0.18 155)", bgColor: "oklch(0.55 0.18 155 / 0.1)" },
  { label: "90 min", value: 90, color: "oklch(0.55 0.15 280)", bgColor: "oklch(0.55 0.15 280 / 0.1)" },
];

const TIME_PREFERENCES = [
  { label: "All Day", value: [] as string[] },
  { label: "Morning (8-12)", value: ["08:00-12:00"] },
  { label: "Afternoon (12-5)", value: ["12:00-17:00"] },
];

export function OpenSlots() {
  const state = useCalendarState();
  const selectedDate = state.ui.selectedDate;
  const providers = Object.values(state.data.providersById) as import("../types").Provider[];

  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [metrics, setMetrics] = useState<ScheduleMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [selectedTimeFilter, setSelectedTimeFilter] = useState(0); // index into TIME_PREFERENCES

  const fetchSlots = () => {
    setLoading(true);
    setError(null);

    const endDate = new Date(selectedDate);
    endDate.setDate(endDate.getDate() + 4); // Show 5 days of availability
    const endDateStr = endDate.toISOString().split("T")[0];

    const preferredTimes = TIME_PREFERENCES[selectedTimeFilter].value;

    Promise.all([
      api
        .findAvailableSlots({
          appointmentData: { duration: selectedDuration },
          startDate: selectedDate,
          endDate: endDateStr,
          preferredTimes: preferredTimes.length > 0 ? preferredTimes : undefined,
          maxResults: 50,
        })
        .catch(() => ({ slots: [] as AvailableSlot[] })),
      api
        .getScheduleOverview({ date: selectedDate })
        .catch(() => ({
          appointments: [],
          providers: [],
          operatories: [],
          metrics: {
            totalAppointments: 0,
            totalSlots: 0,
            bookedSlots: 0,
            availabilityPercentage: 0,
            hasAvailability: false,
          },
        })),
    ])
      .then(([slotsRes, overviewRes]) => {
        setSlots(
          Array.isArray(slotsRes.slots) ? slotsRes.slots : []
        );
        setMetrics(overviewRes.metrics);
      })
      .catch((err) => {
        setError(err?.message ?? "Failed to load open slots");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSlots();
  }, [selectedDate, selectedDuration, selectedTimeFilter]);

  // Group slots by date
  const slotsByDate: Record<string, AvailableSlot[]> = {};
  for (const slot of slots) {
    const dateKey = slot.date;
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];
    slotsByDate[dateKey].push(slot);
  }

  const durationOption = DURATION_OPTIONS.find((d) => d.value === selectedDuration) ?? DURATION_OPTIONS[1];

  const formatDateHeader = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    const today = new Date(selectedDate + "T12:00:00");
    const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
    const dayLabel = diffDays === 0 ? "Today" : diffDays === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "long" });
    return `${dayLabel} — ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  };

  const getProviderName = (providerId?: number) => {
    if (!providerId) return "";
    const prov = providers.find((p) => p.id === providerId);
    return prov?.abbr ?? prov?.name ?? "";
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Duration selector */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSelectedDuration(opt.value)}
              className="px-3 py-1.5 rounded text-xs font-medium transition-all"
              style={{
                backgroundColor: selectedDuration === opt.value ? "white" : "transparent",
                color: selectedDuration === opt.value ? opt.color : "oklch(0.52 0.015 240)",
                boxShadow: selectedDuration === opt.value ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Time preference */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {TIME_PREFERENCES.map((pref, i) => (
            <button
              key={pref.label}
              onClick={() => setSelectedTimeFilter(i)}
              className="px-3 py-1.5 rounded text-xs font-medium transition-all"
              style={{
                backgroundColor: selectedTimeFilter === i ? "white" : "transparent",
                color: selectedTimeFilter === i ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                boxShadow: selectedTimeFilter === i ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {pref.label}
            </button>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={fetchSlots} disabled={loading}>
          <RefreshCw size={14} className="mr-1.5" /> Refresh
        </Button>
      </div>

      {/* Metrics overview */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                {metrics.totalAppointments}
              </div>
              <div className="text-xs text-muted-foreground">Booked Today</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div
                className="text-2xl font-bold"
                style={{
                  fontFamily: "Outfit, sans-serif",
                  color: metrics.availabilityPercentage > 30 ? "oklch(0.55 0.18 155)" : "oklch(0.62 0.22 25)",
                }}
              >
                {Math.round(metrics.availabilityPercentage)}%
              </div>
              <div className="text-xs text-muted-foreground">Available</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                {slots.filter((s) => s.date === selectedDate).length}
              </div>
              <div className="text-xs text-muted-foreground">Open Slots Today</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                {slots.length}
              </div>
              <div className="text-xs text-muted-foreground">Open Slots (5 days)</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          Finding available slots...
        </div>
      )}

      {/* Slots by date */}
      {!loading && slots.length === 0 && !error && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          <Info size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm font-medium">No open {selectedDuration}-minute slots found</p>
          <p className="text-xs mt-1">Try a different duration or time preference, or check that Open Dental is connected.</p>
        </div>
      )}

      {!loading &&
        Object.entries(slotsByDate).map(([dateKey, dateSlots]) => (
          <Card key={dateKey}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                {formatDateHeader(dateKey)}
                <Badge variant="secondary" className="text-xs">
                  {dateSlots.length} slots
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {dateSlots.map((slot, i) => (
                  <button
                    key={`${slot.date}-${slot.time}-${i}`}
                    className="flex items-center gap-2 p-2.5 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
                    onClick={() =>
                      toast.info(`${slot.time} on ${dateKey} — ${selectedDuration}min block available${slot.providerId ? ` (${getProviderName(slot.providerId)})` : ""}`)
                    }
                  >
                    <div
                      className="w-1.5 h-8 rounded-full flex-shrink-0"
                      style={{ backgroundColor: durationOption.color }}
                    />
                    <div>
                      <div className="text-sm font-medium text-foreground">{slot.time}</div>
                      <div className="text-xs text-muted-foreground">
                        {selectedDuration}min
                        {slot.providerId ? ` · ${getProviderName(slot.providerId)}` : ""}
                      </div>
                    </div>
                    <CalendarPlus
                      size={14}
                      className="ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}

      {/* Voice agent info */}
      <div className="rounded-lg border border-border bg-muted/10 p-4 flex items-start gap-3">
        <Info size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Voice Agent Scheduling</span> — The CareIN voice agent uses
          these same open slots when booking patients. It follows the 2-question script (morning/afternoon +
          early/late week) and offers matching time blocks from this availability data.
        </div>
      </div>
    </div>
  );
}
