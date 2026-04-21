/**
 * Scheduling — AI Scheduling Rules + Open Dental Calendar
 * Tab 1: Rules engine for controlling how the AI voice agent schedules patients
 * Tab 2: Read-only Open Dental calendar view
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  CalendarClock, Settings2, Clock, Users, Stethoscope,
  AlertTriangle, Plus, Trash2, Edit3, Save, ChevronDown, ChevronUp,
  CalendarDays, RefreshCw
} from "lucide-react";
import { CalendarProvider, useCalendarState, useCalendarActions } from "@/features/calendar";
import { CalendarTopBar, CalendarTabs, AppointmentDrawer } from "@/features/calendar";
import { calendarApi } from "@/features/calendar";
import { toast } from "sonner";
import {
  type SlotCategory,
  SLOT_CATEGORIES,
  useSlotMarkerSummary,
} from "@/features/slotMarkers";

type ActiveTab = "rules" | "calendar";

// ------------------------------------------------------------------
// Scheduling rules data model
// ------------------------------------------------------------------

interface AppointmentTypeRule {
  id: string;
  name: string;
  duration: number;
  requiresProvider: boolean;
  providerTypes: string[];
  description: string;
  enabled: boolean;
}

interface AvailabilityRule {
  id: string;
  name: string;
  type: "block" | "priority" | "buffer";
  description: string;
  enabled: boolean;
}

const DEFAULT_APPOINTMENT_RULES: AppointmentTypeRule[] = [
  {
    id: "new-adult-no-recall",
    name: "New Adult Patient (No Recent Cleaning)",
    duration: 60,
    requiresProvider: true,
    providerTypes: ["Doctor"],
    description: "Last cleaning > 12 months ago. Doctor exam + X-rays only — NO cleaning same day.",
    enabled: true,
  },
  {
    id: "new-adult-recall",
    name: "New Adult Patient (On Recall)",
    duration: 90,
    requiresProvider: true,
    providerTypes: ["Hygienist"],
    description: "Last cleaning < 12 months, on recall. Exam + X-rays + cleaning.",
    enabled: true,
  },
  {
    id: "new-child",
    name: "New Child Patient (Under 18)",
    duration: 60,
    requiresProvider: true,
    providerTypes: ["Hygienist"],
    description: "Exam + X-rays + cleaning for patients under 18.",
    enabled: true,
  },
  {
    id: "existing-adult-cleaning",
    name: "Existing Adult Cleaning",
    duration: 60,
    requiresProvider: true,
    providerTypes: ["Hygienist"],
    description: "Standard hygiene appointment for existing adult patients.",
    enabled: true,
  },
  {
    id: "existing-child-cleaning",
    name: "Existing Child Cleaning",
    duration: 30,
    requiresProvider: true,
    providerTypes: ["Hygienist"],
    description: "Standard hygiene appointment for existing child patients.",
    enabled: true,
  },
  {
    id: "emergency",
    name: "Emergency / Limited Exam",
    duration: 60,
    requiresProvider: true,
    providerTypes: ["Doctor"],
    description: "Emergency limited exam. AI offers priority slots first, then falls back to 2-question script.",
    enabled: true,
  },
  {
    id: "ortho-adjustment",
    name: "Ortho Adjustment",
    duration: 30,
    requiresProvider: true,
    providerTypes: ["Doctor"],
    description: "Orthodontic adjustment visit.",
    enabled: true,
  },
];

const DEFAULT_AVAILABILITY_RULES: AvailabilityRule[] = [
  {
    id: "2q-script",
    name: "2-Question Scheduling Script",
    type: "priority",
    description: "Non-emergency: Ask (1) mornings or afternoons? (2) early week or later? Then offer 2 matching slots.",
    enabled: true,
  },
  {
    id: "emergency-priority",
    name: "Emergency Priority Slots",
    type: "priority",
    description: "For emergencies, offer specific priority times first before falling back to the 2-question script.",
    enabled: true,
  },
  {
    id: "lunch-block",
    name: "Lunch Block",
    type: "block",
    description: "Block 12:00 PM - 1:00 PM from AI scheduling. Staff can override manually.",
    enabled: true,
  },
  {
    id: "buffer-time",
    name: "Appointment Buffer",
    type: "buffer",
    description: "10-minute buffer between AI-scheduled appointments for room turnover.",
    enabled: false,
  },
];

// ------------------------------------------------------------------
// Slot Marker Scheduling card (read-only)
// ------------------------------------------------------------------

const SLOT_MARKER_RULES: { id: string; text: string }[] = [
  {
    id: "marker-required",
    text: "Voice agent only offers times where a matching CareIN slot marker exists",
  },
  {
    id: "no-marker-transfer",
    text: "No matching marker = no booking — caller is transferred to a team member",
  },
  {
    id: "lookahead",
    text: "Agent looks up to 6 months ahead across all scheduled markers",
  },
  {
    id: "staff-control",
    text: "Staff control all capacity by adding or removing markers in Open Dental",
  },
];

function SlotMarkerSchedulingCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <CalendarClock size={16} style={{ color: "oklch(0.55 0.18 210)" }} />
          Slot Marker Scheduling
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The CareIN voice agent uses slot markers to determine what appointments are
          available. Markers are placed by staff in Open Dental using the "CareIN Block"
          patient.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {SLOT_MARKER_RULES.map((rule) => (
          <div
            key={rule.id}
            className="flex items-start gap-3 px-4 py-3 rounded-lg border border-border bg-card"
          >
            <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
            <p className="text-sm text-foreground leading-snug">{rule.text}</p>
          </div>
        ))}
        <div className="rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground leading-snug">
          <span className="font-medium text-foreground">To add availability:</span> open
          Open Dental → schedule → place an appointment for the CareIN Block patient →
          select the correct CareIN appointment type.
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------
// 30-day Slot Marker Summary
// ------------------------------------------------------------------

function SlotMarkerSummarySection() {
  const summary = useSlotMarkerSummary();
  const categoryKeys = Object.keys(SLOT_CATEGORIES) as SlotCategory[];
  const totalMarkers = categoryKeys.reduce((sum, key) => sum + summary[key], 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">
          Next 30 Days — Slot Marker Availability
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Live count of CareIN slot markers placed in Open Dental for the next 30 days.
        </p>
      </CardHeader>
      <CardContent>
        {totalMarkers === 0 ? (
          <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground text-center">
            <p className="font-medium">No slot markers found for the next 30 days.</p>
            <p className="text-xs mt-1">
              Ask your team to add availability blocks in Open Dental.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {categoryKeys.map((key) => {
              const meta = SLOT_CATEGORIES[key];
              const count = summary[key];
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-card"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: meta.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">
                      {meta.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {count} {count === 1 ? "marker" : "markers"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------
// Rules Tab
// ------------------------------------------------------------------

function SchedulingRules() {
  const [appointmentRules, setAppointmentRules] = useState(DEFAULT_APPOINTMENT_RULES);
  const [availabilityRules, setAvailabilityRules] = useState(DEFAULT_AVAILABILITY_RULES);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  const toggleRule = (rules: AppointmentTypeRule[], setRules: typeof setAppointmentRules, id: string) => {
    setRules(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const toggleAvail = (id: string) => {
    setAvailabilityRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  return (
    <div className="space-y-6">
      {/* Appointment Type Rules */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Stethoscope size={16} style={{ color: "oklch(0.55 0.18 210)" }} />
              Appointment Types
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {appointmentRules.filter(r => r.enabled).length} of {appointmentRules.length} active
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Define appointment types the AI voice agent can schedule. Duration, provider requirements, and routing rules.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {appointmentRules.map((rule) => (
            <div
              key={rule.id}
              className={`rounded-lg border transition-all ${rule.enabled ? "border-border bg-card" : "border-border/50 bg-muted/20 opacity-60"}`}
            >
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
              >
                <button
                  className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${rule.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                  onClick={(e) => { e.stopPropagation(); toggleRule(appointmentRules, setAppointmentRules, rule.id); }}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.enabled ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{rule.name}</div>
                </div>
                <Badge variant="outline" className="text-xs flex-shrink-0">
                  <Clock size={10} className="mr-1" />
                  {rule.duration} min
                </Badge>
                <Badge variant="outline" className="text-xs flex-shrink-0">
                  <Users size={10} className="mr-1" />
                  {rule.providerTypes.join(", ")}
                </Badge>
                {expandedRule === rule.id ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
              </div>
              {expandedRule === rule.id && (
                <div className="px-4 pb-3 border-t border-border/50 pt-3">
                  <p className="text-sm text-muted-foreground">{rule.description}</p>
                  <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                    <span>Duration: <strong className="text-foreground">{rule.duration} minutes</strong></span>
                    <span>Provider: <strong className="text-foreground">{rule.providerTypes.join(", ")}</strong></span>
                    <span>Status: <strong className={rule.enabled ? "text-green-600" : "text-muted-foreground"}>{rule.enabled ? "Active" : "Disabled"}</strong></span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Availability & Scheduling Rules */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Settings2 size={16} style={{ color: "oklch(0.55 0.18 210)" }} />
              Scheduling Rules
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {availabilityRules.filter(r => r.enabled).length} of {availabilityRules.length} active
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Control how the AI offers time slots, blocks, buffers, and scheduling preferences.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {availabilityRules.map((rule) => {
            const typeColors: Record<string, { bg: string; text: string }> = {
              block: { bg: "oklch(0.62 0.22 25 / 0.12)", text: "oklch(0.55 0.22 25)" },
              priority: { bg: "oklch(0.55 0.18 210 / 0.12)", text: "oklch(0.45 0.18 210)" },
              buffer: { bg: "oklch(0.65 0.17 75 / 0.12)", text: "oklch(0.50 0.17 75)" },
            };
            const tc = typeColors[rule.type];
            return (
              <div
                key={rule.id}
                className={`flex items-start gap-3 px-4 py-3 rounded-lg border transition-all ${rule.enabled ? "border-border bg-card" : "border-border/50 bg-muted/20 opacity-60"}`}
              >
                <button
                  className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 mt-0.5 ${rule.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                  onClick={() => toggleAvail(rule.id)}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.enabled ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{rule.name}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded font-medium capitalize"
                      style={{ backgroundColor: tc.bg, color: tc.text }}
                    >
                      {rule.type}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{rule.description}</p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Slot Marker Scheduling — block-driven voice agent rules (read-only) */}
      <SlotMarkerSchedulingCard />

      {/* 30-day Marker Summary */}
      <SlotMarkerSummarySection />

      {/* Honesty banner — these rules are reference-only until the agent is wired to function-call tools */}
      <div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700/40 p-3 flex items-start gap-3">
        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-amber-900 dark:text-amber-100 leading-snug">
          <strong>Reference rules only — not yet enforced by the AI.</strong>{" "}
          These rules describe how the AI <em>should</em> schedule, but the live Retell
          agent does not yet call into this dashboard for slot lookup or booking. Until
          the booking tool surface is wired up, treat this page as documentation and
          paste relevant rules into the agent prompt via{" "}
          <a href="/agents" className="underline font-medium">Agent Builder</a>.
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Calendar Tab (wraps existing calendar feature)
// ------------------------------------------------------------------

function CalendarView() {
  const state = useCalendarState();
  const actions = useCalendarActions();

  useEffect(() => {
    actions.setLoading(true);
    actions.setError(null);
    calendarApi
      .getCalendar({
        date: state.ui.selectedDate,
        providerIds: state.ui.providerFilter.length > 0 ? state.ui.providerFilter : undefined,
      })
      .then(({ appointments, operatories, providers }) => {
        actions.setCalendarData({ appointments, operatories, providers });
      })
      .catch((err) => {
        actions.setError(err?.message ?? "Open Dental unavailable");
        actions.setCalendarData({ appointments: [], operatories: [], providers: [] });
      })
      .finally(() => actions.setLoading(false));
  }, [state.ui.selectedDate, state.ui.refreshKey]);

  return (
    <div className="space-y-4">
      {state.ui.error && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {state.ui.error} Ensure the backend is running and Open Dental is configured.
        </div>
      )}
      <CalendarTopBar />
      <CalendarTabs />
      <AppointmentDrawer />
    </div>
  );
}

// ------------------------------------------------------------------
// Main Scheduling Page
// ------------------------------------------------------------------

export default function Scheduling() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("rules");

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Scheduling
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            AI scheduling rules and Open Dental calendar
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit">
        {([
          { key: "rules" as const, label: "AI Rules", icon: Settings2 },
          { key: "calendar" as const, label: "OD Calendar", icon: CalendarDays },
        ]).map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
              style={{
                backgroundColor: activeTab === tab.key ? "white" : "transparent",
                color: activeTab === tab.key ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                boxShadow: activeTab === tab.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "rules" && <SchedulingRules />}
      {activeTab === "calendar" && (
        <CalendarProvider>
          <CalendarView />
        </CalendarProvider>
      )}
    </div>
  );
}
