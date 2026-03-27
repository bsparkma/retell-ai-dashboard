/**
 * RulesDisplay — Shows why a particular appointment type was determined.
 * Provides transparency to front desk staff and patients.
 */

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Clock, User, Stethoscope, AlertCircle, Info } from "lucide-react";
import type { AppointmentEvaluation } from "./types";

const CATEGORY_LABELS: Record<string, string> = {
  NEW_PATIENT_EXAM: "New Patient Exam",
  NEW_PATIENT_HYGIENE: "New Patient Hygiene (90 min)",
  NEW_CHILD_HYGIENE: "New Child Hygiene",
  EXISTING_ADULT_CLEANING: "Adult Cleaning",
  EXISTING_CHILD_CLEANING: "Child Cleaning",
  EMERGENCY: "Emergency Visit",
  ORTHO_ADJUSTMENT: "Ortho Adjustment",
  EXAM: "General Exam",
  OTHER: "Other",
};

const PROVIDER_LABELS: Record<string, string> = {
  DENTIST: "Dentist",
  HYGIENIST: "Hygienist",
  ANY: "Any Provider",
};

const CATEGORY_COLORS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  NEW_PATIENT_EXAM: "default",
  NEW_PATIENT_HYGIENE: "default",
  NEW_CHILD_HYGIENE: "default",
  EXISTING_ADULT_CLEANING: "secondary",
  EXISTING_CHILD_CLEANING: "secondary",
  EMERGENCY: "destructive",
  ORTHO_ADJUSTMENT: "secondary",
  EXAM: "outline",
  OTHER: "outline",
};

interface RulesDisplayProps {
  evaluation: AppointmentEvaluation;
}

export function RulesDisplay({ evaluation }: RulesDisplayProps) {
  return (
    <div className="space-y-3">
      {/* Appointment type badge + duration */}
      <div className="flex flex-wrap gap-2 items-center">
        <Badge variant={CATEGORY_COLORS[evaluation.category] ?? "default"}>
          {CATEGORY_LABELS[evaluation.category] ?? evaluation.category}
        </Badge>
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <Clock className="size-3.5" />
          {evaluation.durationMinutes} minutes
        </span>
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <Stethoscope className="size-3.5" />
          {PROVIDER_LABELS[evaluation.providerType] ?? evaluation.providerType}
        </span>
        {evaluation.requiresHygieneRoom && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground border rounded px-1.5 py-0.5">
            Hygiene room required
          </span>
        )}
      </div>

      {/* Rationale */}
      <Alert className="py-2">
        <Info className="size-4" />
        <AlertDescription className="text-sm">{evaluation.rationale}</AlertDescription>
      </Alert>

      {/* Deferred cleaning notice */}
      {evaluation.cleaningDeferred && evaluation.deferredCleaningMessage && (
        <Alert className="py-2 border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
          <AlertCircle className="size-4 text-amber-600" />
          <AlertDescription className="text-sm text-amber-800 dark:text-amber-200">
            <strong>Cleaning deferred: </strong>
            {evaluation.deferredCleaningMessage}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
