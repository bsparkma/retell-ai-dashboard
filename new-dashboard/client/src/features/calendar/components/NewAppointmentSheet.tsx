/**
 * NewAppointmentSheet — wraps the BookingWizard in a right-side sheet.
 * Triggered from CalendarTopBar's "New Appointment" button.
 */

"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { BookingWizard } from "@/features/scheduling/BookingWizard";
import { useCalendarState } from "../store/CalendarContext";
import { useCalendarActions } from "../store/CalendarContext";
import type { BookingWizardState } from "@/features/scheduling/types";

interface NewAppointmentSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewAppointmentSheet({ open, onOpenChange }: NewAppointmentSheetProps) {
  const state = useCalendarState();
  const actions = useCalendarActions();

  // Derive clinicNum from any loaded appointment, or fall back to env/default
  const clinicNum =
    Object.values(state.data.appointmentsById)[0]?.clinicNum ??
    Object.values(state.data.operatoriesById)[0]?.clinicNum ??
    parseInt(import.meta.env.VITE_CLINIC_NUM ?? "1", 10);

  function handleBooked(booked: NonNullable<BookingWizardState["booked"]>) {
    // Refresh the calendar so the new appointment appears
    actions.refresh();
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
        <SheetHeader className="p-4 border-b shrink-0">
          <SheetTitle>New Appointment</SheetTitle>
          <SheetDescription>
            CareIN scheduling engine — 2-question preference script
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-hidden">
          <BookingWizard
            clinicNum={clinicNum}
            onClose={() => onOpenChange(false)}
            onBooked={handleBooked}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
