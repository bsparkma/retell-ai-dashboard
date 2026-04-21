/**
 * OpenSlots — Shows scheduling availability driven by slot markers placed
 * in Open Dental against the CareIN Block patient. The voice agent is
 * block-driven — markers are the sole source of bookable times.
 */
"use client";

import { useState, useEffect } from "react";
import { useCalendarState } from "../store/CalendarContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { CalendarPlus, RefreshCw, Info, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  type SlotCategory,
  type SlotMarker,
  SLOT_CATEGORIES,
  useSlotMarkersForRange,
} from "@/features/slotMarkers";

interface ScheduleMetrics {
  totalAppointments: number;
  totalSlots: number;
  bookedSlots: number;
  availabilityPercentage: number;
  hasAvailability: boolean;
}

const DURATION_OPTIONS = [
  { label: "30 min", value: 30, color: "oklch(0.55 0.18 210)" },
  { label: "60 min", value: 60, color: "oklch(0.55 0.18 155)" },
  { label: "90 min", value: 90, color: "oklch(0.55 0.15 280)" },
];

const TIME_PREFERENCES = [
  { label: "All Day", value: [] as string[] },
  { label: "Morning (8-12)", value: ["08:00-12:00"] },
  { label: "Afternoon (12-5)", value: ["12:00-17:00"] },
];

const TOP_LEVEL_CATEGORIES: { key: SlotCategory; label: string }[] = [
  { key: "new-patient", label: "New Patient" },
  { key: "emergency", label: "Emergency" },
  { key: "hygiene", label: "Hygiene" },
  { key: "asap", label: "ASAP" },
];

const RESTORATIVE_CATEGORIES: SlotCategory[] = [
  "restorative-fillings",
  "restorative-production",
  "restorative-extractions",
  "restorative-pediatric",
];

const RANGE_DAYS = 30;

function plusDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export function OpenSlots() {
  const state = useCalendarState();
  const selectedDate = state.ui.selectedDate;
  const providers = Object.values(state.data.providersById) as import("../types").Provider[];

  const [selectedCategory, setSelectedCategory] = useState<SlotCategory | "all">("all");
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [selectedTimeFilter, setSelectedTimeFilter] = useState(0);
  const [metrics, setMetrics] = useState<ScheduleMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const isCategoryMode = selectedCategory !== "all";
  const startDate = selectedDate;
  const endDate = plusDays(selectedDate, RANGE_DAYS);

  const markersInRange = useSlotMarkersForRange(
    startDate,
    endDate,
    isCategoryMode ? selectedCategory : undefined
  );

  useEffect(() => {
    if (isCategoryMode) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getScheduleOverview({ date: selectedDate })
      .then((overviewRes) => {
        if (cancelled) return;
        setMetrics(overviewRes.metrics);
      })
      .catch(() => {
        if (cancelled) return;
        setMetrics(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, isCategoryMode, refreshKey]);

  const markersByDate: Record<string, SlotMarker[]> = {};
  for (const m of markersInRange) {
    if (!markersByDate[m.date]) markersByDate[m.date] = [];
    markersByDate[m.date].push(m);
  }
  for (const dateKey of Object.keys(markersByDate)) {
    markersByDate[dateKey].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  const sortedDateKeys = Object.keys(markersByDate).sort();

  const getProviderName = (providerId?: number, fallback?: string) => {
    if (providerId) {
      const prov = providers.find((p) => p.id === providerId);
      const name = prov?.abbr ?? prov?.name;
      if (name) return name;
    }
    return fallback ?? "";
  };

  const formatDateHeader = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    const today = new Date(selectedDate + "T12:00:00");
    const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
    const dayLabel =
      diffDays === 0
        ? "Today"
        : diffDays === 1
          ? "Tomorrow"
          : d.toLocaleDateString("en-US", { weekday: "long" });
    return `${dayLabel} — ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  };

  const isRestorativeSelected =
    selectedCategory !== "all" && selectedCategory.startsWith("restorative-");
  const restorativeButtonLabel = isRestorativeSelected
    ? SLOT_CATEGORIES[selectedCategory as SlotCategory].label
    : "Restorative";

  const selectedCategoryMeta =
    selectedCategory !== "all" ? SLOT_CATEGORIES[selectedCategory] : null;

  const renderCategoryButton = (key: SlotCategory | "all", label: string) => {
    const isActive = selectedCategory === key;
    return (
      <button
        key={key}
        onClick={() => setSelectedCategory(key)}
        className="px-3 py-1.5 rounded text-xs font-medium transition-all"
        style={{
          backgroundColor: isActive ? "white" : "transparent",
          color: isActive ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
          boxShadow: isActive ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {/* Category selector */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 bg-muted rounded-md p-1 flex-wrap">
          {renderCategoryButton("all", "All")}
          {TOP_LEVEL_CATEGORIES.map((c) => renderCategoryButton(c.key, c.label))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center gap-1"
                style={{
                  backgroundColor: isRestorativeSelected ? "white" : "transparent",
                  color: isRestorativeSelected
                    ? "oklch(0.18 0.02 240)"
                    : "oklch(0.52 0.015 240)",
                  boxShadow: isRestorativeSelected ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                }}
              >
                {restorativeButtonLabel}
                <ChevronDown size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {RESTORATIVE_CATEGORIES.map((cat) => (
                <DropdownMenuItem
                  key={cat}
                  onSelect={() => setSelectedCategory(cat)}
                  className="text-xs"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-2"
                    style={{ backgroundColor: SLOT_CATEGORIES[cat].color }}
                  />
                  {SLOT_CATEGORIES[cat].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
        >
          <RefreshCw size={14} className="mr-1.5" /> Refresh
        </Button>
      </div>

      {/* Duration + time-preference selectors — visible only in All mode */}
      {!isCategoryMode && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-muted rounded-md p-1">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSelectedDuration(opt.value)}
                className="px-3 py-1.5 rounded text-xs font-medium transition-all"
                style={{
                  backgroundColor: selectedDuration === opt.value ? "white" : "transparent",
                  color: selectedDuration === opt.value ? opt.color : "oklch(0.52 0.015 240)",
                  boxShadow:
                    selectedDuration === opt.value ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

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
        </div>
      )}

      {/* Metrics overview — hidden in category mode, hidden when overview fails */}
      {!isCategoryMode && metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <div
                className="text-2xl font-bold text-foreground"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
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
                  color:
                    metrics.availabilityPercentage > 30
                      ? "oklch(0.55 0.18 155)"
                      : "oklch(0.62 0.22 25)",
                }}
              >
                {Math.round(metrics.availabilityPercentage)}%
              </div>
              <div className="text-xs text-muted-foreground">Available</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div
                className="text-2xl font-bold text-foreground"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
                {markersInRange.filter((m) => m.date === selectedDate).length}
              </div>
              <div className="text-xs text-muted-foreground">Markers Today</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div
                className="text-2xl font-bold text-foreground"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
                {markersInRange.length}
              </div>
              <div className="text-xs text-muted-foreground">Markers ({RANGE_DAYS}d)</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Empty state */}
      {markersInRange.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          <Info size={32} className="mx-auto mb-2 opacity-30" />
          {isCategoryMode && selectedCategoryMeta ? (
            <>
              <p className="text-sm font-medium">
                No {selectedCategoryMeta.label} blocks scheduled for this period.
              </p>
              <p className="text-xs mt-1">
                Staff can add availability in Open Dental by placing a "CareIN —{" "}
                {selectedCategoryMeta.label}" appointment for the CareIN Block patient.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">No slot markers found for this period.</p>
              <p className="text-xs mt-1">
                Staff can add availability blocks in Open Dental.
              </p>
            </>
          )}
        </div>
      )}

      {/* Slot cards grouped by date */}
      {sortedDateKeys.map((dateKey) => {
        const dateMarkers = markersByDate[dateKey];
        return (
          <Card key={dateKey}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                {formatDateHeader(dateKey)}
                <Badge variant="secondary" className="text-xs">
                  {dateMarkers.length} {dateMarkers.length === 1 ? "block" : "blocks"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {dateMarkers.map((m) => {
                  const meta = SLOT_CATEGORIES[m.category];
                  const provName = getProviderName(m.providerId, m.providerName);
                  return (
                    <button
                      key={m.id}
                      className="flex items-center gap-2 p-2.5 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
                      onClick={() =>
                        toast.info(
                          `${m.startTime} on ${dateKey} — ${meta.label} (${m.duration}min)${
                            provName ? ` · ${provName}` : ""
                          }`
                        )
                      }
                    >
                      <div
                        className="w-1.5 h-8 rounded-full flex-shrink-0"
                        style={{ backgroundColor: meta.color }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">
                          {m.startTime}
                          <span className="text-xs text-muted-foreground ml-1.5">
                            {m.duration}min
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{
                              backgroundColor: `${meta.color}22`,
                              color: meta.color,
                            }}
                          >
                            {meta.label}
                          </span>
                          {provName && (
                            <span className="text-[10px] text-muted-foreground">
                              {provName}
                            </span>
                          )}
                        </div>
                      </div>
                      <CalendarPlus
                        size={14}
                        className="ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Voice agent info — block-driven scheduling */}
      <div className="rounded-lg border border-border bg-muted/10 p-4 flex items-start gap-3">
        <Info size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Block-Driven Scheduling</span> — The
          CareIN voice agent only offers times where a matching CareIN slot marker exists in
          Open Dental. Staff control all capacity by adding or removing markers against the
          CareIN Block patient. If no marker matches, the agent transfers the caller to a
          team member.
        </div>
      </div>
    </div>
  );
}
