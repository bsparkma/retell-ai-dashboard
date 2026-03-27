"use client";

import { Button } from "@/components/ui/button";
import { CheckCircle2, MessageSquare, Phone, Calendar, AlertCircle, FileCheck, User, ClipboardCheck } from "lucide-react";

/** Phase 1: placeholder action buttons; no handlers. */
export function DrawerActions() {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Actions</h4>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <CheckCircle2 size={14} /> Confirm
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <MessageSquare size={14} /> Remind
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <Phone size={14} /> Call
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <MessageSquare size={14} /> Text
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <Calendar size={14} /> Reschedule
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <AlertCircle size={14} /> Move to ASAP
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <FileCheck size={14} /> Verify insurance
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <User size={14} /> Escalate
        </Button>
        <Button variant="outline" size="sm" disabled className="gap-1.5">
          <ClipboardCheck size={14} /> Prep complete
        </Button>
      </div>
    </section>
  );
}
