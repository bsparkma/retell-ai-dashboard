"use client";

import { UserPlus, Stethoscope, Lock, LogIn, CircleDot, LogOut } from "lucide-react";
import type { AppointmentCardViewModel } from "../types";

const PIXELS_PER_HOUR = 64;

interface AppointmentCardProps {
  viewModel: AppointmentCardViewModel;
  onClick: () => void;
  isSelected?: boolean;
}

export function AppointmentCard({ viewModel, onClick, isSelected }: AppointmentCardProps) {
  const { appointment, providerAbbr, statusLabel, typeLabel, color } = viewModel;
  const [hour, min] = appointment.time.split(":").map(Number);
  const top = ((hour - 8) * 60 + (min || 0)) * (PIXELS_PER_HOUR / 60);
  const height = Math.max(appointment.duration * (PIXELS_PER_HOUR / 60), 28);

  return (
    <div
      role="button"
      tabIndex={0}
      className="absolute left-1 right-1 rounded-md px-2 py-1 cursor-pointer transition-all overflow-hidden border"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        backgroundColor: color.bg,
        borderColor: isSelected ? "var(--ring)" : color.border,
        borderLeftWidth: "3px",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs font-semibold truncate flex-1 min-w-0" style={{ color: color.text }}>
          {appointment.patient ?? "Patient"}
        </span>
        <span className="text-[10px] font-mono shrink-0" style={{ color: color.text, opacity: 0.9 }}>
          {appointment.time}
        </span>
      </div>
      {height > 32 && (
        <div className="text-xs truncate mt-0.5" style={{ color: color.text, opacity: 0.85 }}>
          {appointment.type ?? typeLabel}
        </div>
      )}
      {height > 48 && (
        <div className="flex items-center gap-1 flex-wrap mt-1">
          <span className="text-[10px] px-1 rounded shrink-0" style={{ backgroundColor: color.border + "30", color: color.text }}>
            {providerAbbr}
          </span>
          <span className="text-[10px] px-1 rounded shrink-0" style={{ backgroundColor: color.border + "30", color: color.text }}>
            {typeLabel}
          </span>
          <span className="text-[10px] px-1 rounded shrink-0" style={{ backgroundColor: color.border + "30", color: color.text }}>
            {statusLabel}
          </span>
          {appointment.confirmed && (
            <span className="text-[10px] text-green-600 dark:text-green-400 shrink-0">✓</span>
          )}
        </div>
      )}
      <div className="absolute top-1 right-1 flex items-center gap-0.5">
        {appointment.isNewPatient && <UserPlus size={10} style={{ color: color.text }} aria-label="New patient" />}
        {appointment.isHygiene && <Stethoscope size={10} style={{ color: color.text }} aria-label="Hygiene" />}
        {appointment.timeLocked && <Lock size={10} style={{ color: color.text }} aria-label="Time locked" />}
        {appointment.dateTimeArrived && <LogIn size={10} style={{ color: color.text }} aria-label="Arrived" />}
        {appointment.dateTimeSeated && <CircleDot size={10} style={{ color: color.text }} aria-label="Seated" />}
        {appointment.dateTimeDismissed && <LogOut size={10} style={{ color: color.text }} aria-label="Dismissed" />}
      </div>
    </div>
  );
}
