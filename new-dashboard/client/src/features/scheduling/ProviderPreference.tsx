/**
 * ProviderPreference — Shows preferred provider's next available slot first,
 * then offers alternatives from other providers.
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { User, Clock, ArrowRight } from "lucide-react";
import type { TimeSlot } from "./types";

interface ProviderPreferenceProps {
  slots: TimeSlot[];
  preferredProviderId?: string;
  onSelectSlot: (slot: TimeSlot) => void;
}

function formatDateTime(isoString: string): { date: string; time: string } {
  const d = new Date(isoString);
  const date = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return { date, time };
}

function SlotCard({
  slot,
  isPreferred,
  onSelect,
}: {
  slot: TimeSlot;
  isPreferred: boolean;
  onSelect: () => void;
}) {
  const { date, time } = formatDateTime(slot.dateTime);
  return (
    <div
      className={
        "flex items-center justify-between rounded-lg border p-3 gap-3 " +
        (isPreferred
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-card")
      }
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{date}</span>
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Clock className="size-3.5" />
            {time}
          </span>
          {isPreferred && (
            <Badge variant="outline" className="text-xs border-primary/40 text-primary">
              Preferred provider
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5 text-sm text-muted-foreground">
          <User className="size-3.5 shrink-0" />
          <span className="truncate">{slot.providerName}</span>
          <span className="text-xs">· {slot.operatoryName}</span>
        </div>
      </div>
      <Button size="sm" variant={isPreferred ? "default" : "outline"} onClick={onSelect} className="cursor-pointer shrink-0">
        Select
        <ArrowRight className="size-3.5 ml-1" />
      </Button>
    </div>
  );
}

export function ProviderPreference({
  slots,
  preferredProviderId,
  onSelectSlot,
}: ProviderPreferenceProps) {
  const preferred = preferredProviderId
    ? slots.filter((s) => String(s.providerId) === preferredProviderId)
    : [];
  const others = preferredProviderId
    ? slots.filter((s) => String(s.providerId) !== preferredProviderId)
    : slots;

  if (slots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No slots available for the selected preferences.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {preferred.length > 0 && (
        <>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Preferred provider
          </p>
          {preferred.map((slot, i) => (
            <SlotCard
              key={`pref-${i}`}
              slot={slot}
              isPreferred
              onSelect={() => onSelectSlot(slot)}
            />
          ))}
        </>
      )}
      {others.length > 0 && (
        <>
          {preferred.length > 0 && (
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-1">
              Next available with other providers
            </p>
          )}
          {others.map((slot, i) => (
            <SlotCard
              key={`other-${i}`}
              slot={slot}
              isPreferred={false}
              onSelect={() => onSelectSlot(slot)}
            />
          ))}
        </>
      )}
    </div>
  );
}
