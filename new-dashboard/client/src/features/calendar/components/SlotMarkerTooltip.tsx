"use client";

import type { SlotMarker } from "@/features/slotMarkers";
import { SLOT_CATEGORIES } from "@/features/slotMarkers";

interface SlotMarkerTooltipProps {
  marker: SlotMarker;
}

function formatTime12Hour(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minPart = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour12}${minPart} ${period}`;
}

export function SlotMarkerTooltip({ marker }: SlotMarkerTooltipProps) {
  const meta = SLOT_CATEGORIES[marker.category];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: meta.color }}
        />
        <span className="text-sm font-semibold text-foreground">{meta.label} Block</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <div>
          <span className="font-medium text-foreground">Time:</span>{" "}
          {formatTime12Hour(marker.startTime)}
        </div>
        <div>
          <span className="font-medium text-foreground">Duration:</span> {marker.duration}min
        </div>
        <div>
          <span className="font-medium text-foreground">Operatory:</span> {marker.operatoryName}
        </div>
        {marker.providerName && (
          <div>
            <span className="font-medium text-foreground">Provider:</span> {marker.providerName}
          </div>
        )}
      </div>
      <div className="pt-2 border-t border-border text-[11px] text-muted-foreground italic">
        Set in Open Dental — edit there to move or remove
      </div>
    </div>
  );
}
