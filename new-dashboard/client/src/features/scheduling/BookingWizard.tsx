/**
 * BookingWizard — Multi-step booking flow for the CareIN scheduling engine.
 *
 * Steps:
 *   1. patient     — Patient selection/search or new patient info
 *   2. evaluation  — Rules engine result (appointment type, duration, rationale)
 *   3. preferences — 2-question script (morning/afternoon, early/late week)
 *   4. slots       — Two concrete time slots matching preferences
 *   5. confirmation — Booking confirmation
 */

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  User,
  Calendar,
  Clock,
  Stethoscope,
} from "lucide-react";

import { schedulingApi } from "./api";
import { RulesDisplay } from "./RulesDisplay";
import { ProviderPreference } from "./ProviderPreference";
import { EmergencyBooking } from "./EmergencyBooking";
import type {
  AppointmentEvaluation,
  BookingWizardState,
  PatientInfo,
  SchedulingPreferences,
  TimeSlot,
  WizardStep,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<WizardStep, string> = {
  patient: "Patient",
  evaluation: "Appointment Type",
  preferences: "Preferences",
  slots: "Available Times",
  confirmation: "Confirmed",
};

const STEP_ORDER: WizardStep[] = [
  "patient",
  "evaluation",
  "preferences",
  "slots",
  "confirmation",
];

function stepIndex(step: WizardStep): number {
  return STEP_ORDER.indexOf(step);
}

function formatDateTime(isoString: string): string {
  const d = new Date(isoString);
  const date = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${time} on ${date}`;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

function initialState(clinicNum: number): BookingWizardState {
  return {
    step: "patient",
    clinicNum,
    patientInfo: { isNewPatient: false },
    request: { requestedType: "cleaning" },
    evaluation: null,
    preferences: {},
    availableSlots: [],
    selectedSlot: null,
    offerMessage: "",
    booked: null,
    loading: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Step: Patient
// ---------------------------------------------------------------------------

function PatientStep({
  state,
  onChange,
  onNext,
}: {
  state: BookingWizardState;
  onChange: (patch: Partial<BookingWizardState["patientInfo"]>) => void;
  onNext: () => void;
}) {
  const { patientInfo, request } = state;

  const canProceed =
    request.requestedType !== undefined;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="font-semibold">Patient Information</h3>
        <p className="text-sm text-muted-foreground">
          Enter patient details to determine the correct appointment type.
        </p>
      </div>

      {/* Patient type */}
      <div className="space-y-2">
        <Label>Patient type</Label>
        <div className="flex gap-3">
          <Button
            variant={patientInfo.isNewPatient ? "default" : "outline"}
            size="sm"
            onClick={() => onChange({ isNewPatient: true })}
            className="cursor-pointer"
          >
            New patient
          </Button>
          <Button
            variant={!patientInfo.isNewPatient ? "default" : "outline"}
            size="sm"
            onClick={() => onChange({ isNewPatient: false })}
            className="cursor-pointer"
          >
            Existing patient
          </Button>
        </div>
      </div>

      {/* Request type */}
      <div className="space-y-2">
        <Label>Reason for visit</Label>
        <Select
          value={request.requestedType ?? "cleaning"}
          onValueChange={(v) =>
            state.request &&
            Object.assign(state.request, { requestedType: v as never })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cleaning">Cleaning / Recall</SelectItem>
            <SelectItem value="exam">Exam</SelectItem>
            <SelectItem value="new_patient">New Patient Visit</SelectItem>
            <SelectItem value="emergency">Emergency / Pain</SelectItem>
            <SelectItem value="ortho">Ortho Adjustment</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Age / is minor */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Patient age (optional)</Label>
          <Input
            type="number"
            min={0}
            max={120}
            placeholder="e.g. 34"
            value={patientInfo.age ?? ""}
            onChange={(e) =>
              onChange({
                age: e.target.value ? parseInt(e.target.value, 10) : undefined,
              })
            }
          />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox
              checked={patientInfo.isMinor === true}
              onCheckedChange={(v) => onChange({ isMinor: Boolean(v) })}
            />
            Under 18
          </label>
        </div>
      </div>

      {/* Cleaning history (only for adult new patients or cleaning requests) */}
      {(patientInfo.isNewPatient || request.requestedType === "cleaning") && (
        <div className="space-y-2">
          <Label>Last cleaning</Label>
          <RadioGroup
            value={patientInfo.cleaningHistory ?? "unknown"}
            onValueChange={(v) =>
              onChange({ cleaningHistory: v as PatientInfo["cleaningHistory"] })
            }
            className="space-y-1.5"
          >
            {[
              { value: "recent", label: "Less than 6 months ago" },
              { value: "within_year", label: "6–12 months ago" },
              { value: "over_year", label: "More than a year ago" },
              { value: "ambiguous", label: "About a year ago (unsure)" },
              { value: "unknown", label: "Unknown / not asked" },
            ].map(({ value, label }) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem value={value} id={`clean-${value}`} />
                <Label htmlFor={`clean-${value}`} className="font-normal cursor-pointer">
                  {label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      )}

      {/* Emergency toggle */}
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <Checkbox
          checked={request.isEmergency === true}
          onCheckedChange={(v) =>
            Object.assign(state.request, { isEmergency: Boolean(v) })
          }
        />
        <span className="font-medium text-destructive">Emergency / dental pain</span>
      </label>

      <Button onClick={onNext} disabled={!canProceed} className="w-full cursor-pointer">
        Continue
        <ChevronRight className="size-4 ml-1" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step: Preferences
// ---------------------------------------------------------------------------

function PreferencesStep({
  state,
  onPreferenceChange,
  onNext,
  onBack,
}: {
  state: BookingWizardState;
  onPreferenceChange: (patch: Partial<SchedulingPreferences>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { preferences } = state;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="font-semibold">Scheduling Preferences</h3>
        <p className="text-sm text-muted-foreground">
          Two quick questions to find the best time.
        </p>
      </div>

      {/* Q1: Morning or afternoon */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Do you prefer mornings or afternoons?
        </Label>
        <div className="flex gap-3">
          {(
            [
              { value: "morning", label: "Mornings", sub: "8 AM – noon" },
              { value: "afternoon", label: "Afternoons", sub: "noon – 5 PM" },
            ] as const
          ).map(({ value, label, sub }) => (
            <button
              key={value}
              onClick={() => onPreferenceChange({ timeOfDay: value })}
              className={
                "flex-1 rounded-lg border p-3 text-left transition-colors cursor-pointer " +
                (preferences.timeOfDay === value
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/40")
              }
            >
              <div className="font-medium text-sm">{label}</div>
              <div className="text-xs text-muted-foreground">{sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Q2: Early or late week */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Do you prefer early in the week or later?
        </Label>
        <div className="flex gap-3">
          {(
            [
              { value: "early", label: "Early week", sub: "Mon / Tue" },
              { value: "late", label: "Later week", sub: "Wed / Thu" },
            ] as const
          ).map(({ value, label, sub }) => (
            <button
              key={value}
              onClick={() => onPreferenceChange({ dayOfWeek: value })}
              className={
                "flex-1 rounded-lg border p-3 text-left transition-colors cursor-pointer " +
                (preferences.dayOfWeek === value
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/40")
              }
            >
              <div className="font-medium text-sm">{label}</div>
              <div className="text-xs text-muted-foreground">{sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack} className="cursor-pointer">
          <ChevronLeft className="size-4 mr-1" />
          Back
        </Button>
        <Button onClick={onNext} className="flex-1 cursor-pointer">
          Find available times
          <ChevronRight className="size-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step: Confirmation
// ---------------------------------------------------------------------------

function ConfirmationStep({
  state,
  onClose,
}: {
  state: BookingWizardState;
  onClose?: () => void;
}) {
  const { booked, selectedSlot } = state;
  const slot = selectedSlot;

  return (
    <div className="space-y-4 text-center">
      <div className="flex flex-col items-center gap-2 py-4">
        <CheckCircle2 className="size-12 text-green-500" />
        <h3 className="font-semibold text-lg">Appointment Confirmed!</h3>
        {slot && (
          <p className="text-sm text-muted-foreground">
            {formatDateTime(slot.dateTime)}
          </p>
        )}
      </div>

      {slot && (
        <div className="rounded-lg border p-4 text-left space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="size-4 text-muted-foreground" />
            <span>{formatDateTime(slot.dateTime)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock className="size-4 text-muted-foreground" />
            <span>{slot.duration} minutes</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <User className="size-4 text-muted-foreground" />
            <span>{slot.providerName}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Stethoscope className="size-4 text-muted-foreground" />
            <span>{slot.operatoryName}</span>
          </div>
        </div>
      )}

      {booked?.appointmentId && (
        <p className="text-xs text-muted-foreground">
          Appointment ID: {booked.appointmentId}
        </p>
      )}

      {onClose && (
        <Button onClick={onClose} className="w-full cursor-pointer">
          Done
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function WizardProgress({ step }: { step: WizardStep }) {
  const current = stepIndex(step);
  const total = STEP_ORDER.length - 1; // exclude confirmation from progress
  const progressSteps = STEP_ORDER.slice(0, -1); // patient → slots

  return (
    <div className="flex items-center gap-1.5 mb-4">
      {progressSteps.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5 flex-1">
          <div
            className={
              "h-1.5 flex-1 rounded-full transition-colors " +
              (i <= current - (step === "confirmation" ? 0 : 0)
                ? "bg-primary"
                : "bg-muted")
            }
          />
        </div>
      ))}
      <span className="text-xs text-muted-foreground whitespace-nowrap ml-1">
        {STEP_LABELS[step]}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BookingWizard — main component
// ---------------------------------------------------------------------------

export interface BookingWizardProps {
  clinicNum: number;
  /** Called when the wizard is closed/cancelled */
  onClose?: () => void;
  /** Called after a successful booking */
  onBooked?: (booked: NonNullable<BookingWizardState["booked"]>) => void;
}

export function BookingWizard({ clinicNum, onClose, onBooked }: BookingWizardProps) {
  const [state, setState] = useState<BookingWizardState>(() =>
    initialState(clinicNum)
  );

  const patch = useCallback(
    (updates: Partial<BookingWizardState>) =>
      setState((prev) => ({ ...prev, ...updates })),
    []
  );

  const patchPatient = useCallback(
    (updates: Partial<PatientInfo>) =>
      setState((prev) => ({
        ...prev,
        patientInfo: { ...prev.patientInfo, ...updates },
      })),
    []
  );

  const patchPreferences = useCallback(
    (updates: Partial<SchedulingPreferences>) =>
      setState((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, ...updates },
      })),
    []
  );

  // ---- Step: patient → evaluation ----
  const handlePatientNext = useCallback(async () => {
    patch({ loading: true, error: null });
    try {
      const { evaluation } = await schedulingApi.evaluate({
        patientInfo: state.patientInfo,
        request: {
          requestedType: state.request.requestedType ?? "cleaning",
          isEmergency: state.request.isEmergency,
          clinicNum,
          notes: state.request.notes,
        },
      });
      patch({ evaluation, step: "evaluation", loading: false });
    } catch (e) {
      patch({ loading: false, error: String(e) });
    }
  }, [state.patientInfo, state.request, clinicNum, patch]);

  // ---- Step: evaluation → preferences or emergency ----
  const handleEvaluationNext = useCallback(() => {
    if (state.evaluation?.checkEmergencySlots) {
      patch({ step: "preferences" }); // emergency goes to preferences after check
    } else {
      patch({ step: "preferences" });
    }
  }, [state.evaluation, patch]);

  // ---- Step: preferences → slots ----
  const handlePreferencesNext = useCallback(async () => {
    if (!state.evaluation) return;
    patch({ loading: true, error: null });
    try {
      const { slots, offerMessage } = await schedulingApi.findSlots({
        evaluation: state.evaluation,
        preferences: state.preferences,
        preferredProviderId: state.patientInfo.providerPreference,
        clinicNum,
      });
      patch({ availableSlots: slots, offerMessage, step: "slots", loading: false });
    } catch (e) {
      patch({ loading: false, error: String(e) });
    }
  }, [state.evaluation, state.preferences, state.patientInfo.providerPreference, clinicNum, patch]);

  // ---- Step: slots → book → confirmation ----
  const handleSlotSelected = useCallback(
    async (slot: TimeSlot) => {
      if (!state.evaluation) return;
      patch({ selectedSlot: slot, loading: true, error: null });
      try {
        const { appointment } = await schedulingApi.book({
          slot,
          patientId: state.patientInfo.patientId,
          evaluation: state.evaluation,
          clinicNum,
          source: "front_desk",
        });
        patch({ booked: appointment, step: "confirmation", loading: false });
        onBooked?.(appointment);
      } catch (e) {
        patch({ loading: false, error: String(e) });
      }
    },
    [state.evaluation, state.patientInfo.patientId, clinicNum, patch, onBooked]
  );

  const goBack = useCallback(() => {
    const current = stepIndex(state.step);
    if (current > 0) {
      patch({ step: STEP_ORDER[current - 1]!, error: null });
    }
  }, [state.step, patch]);

  // ---- Render ----
  const { step, loading, error, evaluation, availableSlots } = state;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4">
        <WizardProgress step={step} />
        {error && (
          <Alert className="mb-3 border-destructive/50 py-2">
            <AlertCircle className="size-4 text-destructive" />
            <AlertDescription className="text-sm">{error}</AlertDescription>
          </Alert>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 px-4 pb-4">
        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <>
            {step === "patient" && (
              <PatientStep
                state={state}
                onChange={patchPatient}
                onNext={handlePatientNext}
              />
            )}

            {step === "evaluation" && evaluation && (
              <div className="space-y-5">
                <div className="space-y-1">
                  <h3 className="font-semibold">Appointment Determined</h3>
                  <p className="text-sm text-muted-foreground">
                    Here's what the scheduling engine determined.
                  </p>
                </div>
                <RulesDisplay evaluation={evaluation} />

                {/* Emergency flow — check priority slots first */}
                {evaluation.checkEmergencySlots && (
                  <>
                    <Separator />
                    <EmergencyBooking
                      clinicNum={clinicNum}
                      onSlotSelected={handleSlotSelected}
                      onFallbackToPreferences={handleEvaluationNext}
                    />
                  </>
                )}

                {!evaluation.checkEmergencySlots && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={goBack}
                      className="cursor-pointer"
                    >
                      <ChevronLeft className="size-4 mr-1" />
                      Back
                    </Button>
                    <Button
                      onClick={handleEvaluationNext}
                      className="flex-1 cursor-pointer"
                    >
                      Choose a time
                      <ChevronRight className="size-4 ml-1" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {step === "preferences" && (
              <PreferencesStep
                state={state}
                onPreferenceChange={patchPreferences}
                onNext={handlePreferencesNext}
                onBack={goBack}
              />
            )}

            {step === "slots" && (
              <div className="space-y-4">
                <div className="space-y-1">
                  <h3 className="font-semibold">Available Times</h3>
                  {state.offerMessage && (
                    <p className="text-sm text-muted-foreground">
                      {state.offerMessage}
                    </p>
                  )}
                </div>
                <ProviderPreference
                  slots={availableSlots}
                  preferredProviderId={state.patientInfo.providerPreference}
                  onSelectSlot={handleSlotSelected}
                />
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={goBack}
                    className="cursor-pointer"
                  >
                    <ChevronLeft className="size-4 mr-1" />
                    Back
                  </Button>
                  {availableSlots.length === 0 && (
                    <Button
                      variant="outline"
                      onClick={() => patch({ step: "preferences" })}
                      className="flex-1 cursor-pointer"
                    >
                      Try different preferences
                    </Button>
                  )}
                </div>
              </div>
            )}

            {step === "confirmation" && (
              <ConfirmationStep state={state} onClose={onClose} />
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
