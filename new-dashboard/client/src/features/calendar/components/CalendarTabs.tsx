"use client";

import { useCalendarState } from "../store/CalendarContext";
import { useCalendarActions } from "../store/CalendarContext";
import { CalendarGrid } from "./CalendarGrid";
import { OpenSlots } from "./OpenSlots";

const TABS = [
  { id: "day" as const, label: "Day" },
  { id: "asap" as const, label: "ASAP" },
  { id: "unscheduled" as const, label: "Unscheduled" },
  { id: "openSlots" as const, label: "Open Slots" },
];

export function CalendarTabs() {
  const state = useCalendarState();
  const actions = useCalendarActions();
  const activeTab = state.ui.activeTab;

  return (
    <div className="space-y-3">
      <div className="flex rounded-lg bg-muted/50 p-1 gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => actions.setActiveTab(tab.id)}
            className="px-4 py-2 rounded-md text-sm font-medium transition-colors"
            style={{
              backgroundColor: activeTab === tab.id ? "var(--background)" : "transparent",
              color: activeTab === tab.id ? "var(--foreground)" : "var(--muted-foreground)",
              boxShadow: activeTab === tab.id ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "day" && <CalendarGrid />}
      {activeTab === "asap" && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          ASAP list — Phase 3
        </div>
      )}
      {activeTab === "unscheduled" && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          Unscheduled / Planned — Phase 3
        </div>
      )}
      {activeTab === "openSlots" && <OpenSlots />}
    </div>
  );
}
