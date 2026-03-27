"use client";

import type { Schedule } from "../types";

const PIXELS_PER_HOUR = 64;
const BASE_HOUR = 8;

function timeToTop(startTime: string): number {
  const [h, m] = startTime.split(":").map(Number);
  return ((h - BASE_HOUR) * 60 + (m || 0)) * (PIXELS_PER_HOUR / 60);
}

function durationPx(startTime: string, stopTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = stopTime.split(":").map(Number);
  const min = (eh - sh) * 60 + (em || 0) - (sm || 0);
  return Math.max(min * (PIXELS_PER_HOUR / 60), 4);
}

interface ScheduleOverlayProps {
  schedules: Schedule[];
  operatoryId: number;
  schedType: "blockout" | "provider" | "practice";
}

export function ScheduleOverlay({ schedules, operatoryId, schedType }: ScheduleOverlayProps) {
  if (schedules.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {schedules.map((s) => (
        <div
          key={s.scheduleNum}
          className="absolute left-0 right-0 rounded-sm opacity-20"
          style={{
            top: `${timeToTop(s.startTime)}px`,
            height: `${durationPx(s.startTime, s.stopTime)}px`,
            backgroundColor:
              schedType === "blockout"
                ? "var(--destructive)"
                : schedType === "provider"
                  ? "var(--primary)"
                  : "var(--muted-foreground)",
          }}
          title={s.note ?? `${s.schedType} ${s.startTime}-${s.stopTime}`}
        />
      ))}
    </div>
  );
}

interface PracticeBannerProps {
  schedules: Schedule[];
}

export function PracticeBanner({ schedules }: PracticeBannerProps) {
  if (schedules.length === 0) return null;
  return (
    <div className="rounded-md bg-muted/50 border border-border px-3 py-2 text-sm text-muted-foreground mb-2">
      Practice schedule: {schedules.length} block(s) today
    </div>
  );
}
