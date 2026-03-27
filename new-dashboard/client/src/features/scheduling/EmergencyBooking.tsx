/**
 * EmergencyBooking — Streamlined emergency flow.
 * Checks priority slots first, then falls back to the 2-question preference script.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Clock, User, Loader2, Phone } from "lucide-react";
import { schedulingApi } from "./api";
import type { EmergencyCheckResult, TimeSlot } from "./types";

interface EmergencyBookingProps {
  clinicNum: number;
  onSlotSelected: (slot: TimeSlot) => void;
  onFallbackToPreferences: () => void;
}

function formatDateTime(isoString: string): { date: string; time: string } {
  const d = new Date(isoString);
  return {
    date: d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
  };
}

export function EmergencyBooking({
  clinicNum,
  onSlotSelected,
  onFallbackToPreferences,
}: EmergencyBookingProps) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<EmergencyCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    schedulingApi
      .checkEmergency(clinicNum)
      .then(setResult)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [clinicNum]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="size-4 animate-spin" />
        Checking emergency availability…
      </div>
    );
  }

  if (error) {
    return (
      <Alert className="border-destructive/50">
        <AlertCircle className="size-4 text-destructive" />
        <AlertDescription className="text-sm">
          Could not check emergency slots: {error}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* Emergency banner */}
      <Alert className="border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800">
        <AlertCircle className="size-4 text-red-600" />
        <AlertDescription className="text-sm text-red-800 dark:text-red-200">
          <strong>Emergency visit.</strong> 60-minute limited exam with dentist.
          Priority time slots are checked first.
        </AlertDescription>
      </Alert>

      {result?.hasPrioritySlot && result.prioritySlots.length > 0 ? (
        <>
          <p className="text-sm font-medium">Priority slots available today:</p>
          <div className="space-y-2">
            {result.prioritySlots.map((slot, i) => {
              const { date, time } = formatDateTime(slot.dateTime);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50/50 dark:bg-red-950/10 p-3 gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="destructive" className="text-xs">Emergency</Badge>
                      <span className="font-medium text-sm">{time}</span>
                      <span className="text-xs text-muted-foreground">{date}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 text-sm text-muted-foreground">
                      <User className="size-3.5" />
                      {slot.providerName}
                      <span className="text-xs">· {slot.operatoryName}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onSlotSelected(slot)}
                    className="cursor-pointer shrink-0"
                  >
                    Book now
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="border-t pt-3">
            <p className="text-xs text-muted-foreground mb-2">
              None of these work? Find the next available time:
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onFallbackToPreferences}
              className="cursor-pointer"
            >
              <Phone className="size-3.5 mr-1.5" />
              Check other times
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{result?.message}</p>
          <Button
            onClick={onFallbackToPreferences}
            className="cursor-pointer"
          >
            Find next available emergency slot
          </Button>
        </div>
      )}
    </div>
  );
}
