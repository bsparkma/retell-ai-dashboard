"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, RefreshCw, Calendar as CalIcon, CheckCircle2, Clock } from "lucide-react";
import { useCalendarState } from "../store/CalendarContext";
import { useCalendarActions } from "../store/CalendarContext";
import { topBarMetrics } from "../store/calendarSelectors";
import { useMemo } from "react";

const TIME_RAIL_START = 8;
const TIME_RAIL_END = 18;

export function CalendarTopBar() {
  const state = useCalendarState();
  const actions = useCalendarActions();
  const metrics = topBarMetrics(state);
  const providers = useMemo(() => (Object.values(state.data.providersById) as import("../types").Provider[]).filter((p) => !p.isHidden), [state.data.providersById]);

  const selectedDate = state.ui.selectedDate;
  const dateObj = useMemo(() => new Date(selectedDate + "T12:00:00"), [selectedDate]);
  const dateLabel = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const goPrev = () => {
    const d = new Date(selectedDate + "T12:00:00");
    d.setDate(d.getDate() - 1);
    actions.setSelectedDate(d.toISOString().split("T")[0]);
  };
  const goNext = () => {
    const d = new Date(selectedDate + "T12:00:00");
    d.setDate(d.getDate() + 1);
    actions.setSelectedDate(d.toISOString().split("T")[0]);
  };
  const goToday = () => {
    actions.setSelectedDate(new Date().toISOString().split("T")[0]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={goPrev} aria-label="Previous day">
            <ChevronLeft size={14} />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={goNext} aria-label="Next day">
            <ChevronRight size={14} />
          </Button>
        </div>
        <span className="text-sm font-semibold text-foreground min-w-[200px]">{dateLabel}</span>

        {providers.length > 0 && (
          <select
            className="text-sm border rounded-md px-2 py-1.5 bg-background"
            value={state.ui.providerFilter[0] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              actions.setProviderFilter(v ? [Number(v)] : []);
            }}
          >
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.abbr}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-4 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => actions.refresh()} className="gap-1.5">
            <RefreshCw size={14} /> Sync OD
          </Button>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle2 size={14} className="text-green-500" />
              <span className="font-medium text-foreground">{metrics.confirmed}</span>
              confirmed
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock size={14} className="text-amber-500" />
              <span className="font-medium text-foreground">{metrics.unconfirmed}</span>
              unconfirmed
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CalIcon size={14} className="text-primary" />
              <span className="font-medium text-foreground">{metrics.total}</span>
              total
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export { TIME_RAIL_START, TIME_RAIL_END };
