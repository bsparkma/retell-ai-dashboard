"use client";

import { useState } from "react";
import { Square } from "lucide-react";
import type { SlotMarker } from "@/features/slotMarkers";
import { SLOT_CATEGORIES } from "@/features/slotMarkers";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { SlotMarkerTooltip } from "./SlotMarkerTooltip";

const PIXELS_PER_HOUR = 64;
const TIME_RAIL_START = 8;

interface SlotMarkerCardProps {
  marker: SlotMarker;
}

export function SlotMarkerCard({ marker }: SlotMarkerCardProps) {
  const [open, setOpen] = useState(false);
  const meta = SLOT_CATEGORIES[marker.category];
  const color = meta.color;

  const [hour, min] = marker.startTime.split(":").map(Number);
  const top = ((hour - TIME_RAIL_START) * 60 + (min || 0)) * (PIXELS_PER_HOUR / 60);
  const height = Math.max(marker.duration * (PIXELS_PER_HOUR / 60), 28);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-label={`${meta.label} slot marker at ${marker.startTime}`}
          className="absolute rounded-md px-2 py-1 cursor-pointer transition-all overflow-hidden"
          style={{
            top: `${top}px`,
            left: "4px",
            right: "4px",
            height: `${height}px`,
            backgroundColor: `${color}66`,
            borderLeft: `3px solid ${color}`,
            borderRadius: "6px",
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
        >
          <div className="flex items-start justify-between gap-1">
            <span
              className="text-xs font-semibold truncate flex-1 min-w-0"
              style={{ color: "var(--foreground)" }}
            >
              {meta.label} Block
            </span>
            <Square size={10} style={{ color }} aria-label="Slot marker" className="shrink-0 mt-0.5" />
          </div>
          {height > 48 && (
            <div className="text-[10px] mt-0.5 truncate" style={{ color: "var(--muted-foreground)" }}>
              {marker.startTime} · {marker.duration}min
            </div>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <SlotMarkerTooltip marker={marker} />
      </PopoverContent>
    </Popover>
  );
}
