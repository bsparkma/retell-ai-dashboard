/**
 * Hygiene intake form — the ~60-second chairside handoff (legacy
 * HygieneIntake.tsx restyled onto the platform).
 *
 * Submits POST /tc/hygiene-intakes which creates the case in hygiene_review.
 * Identity (submittedBy) comes from the platform SSO session server-side —
 * this form never sends it. Dictation (Slice 7) is omitted entirely.
 *
 * Slice 5 brings the legacy "Search Open Dental" prefill live, READ-ONLY: it
 * links a real PatNum to the case at entry and fills the name/DOB-derived age/
 * phone/email fields, which is what makes every later OD read on the case
 * (treatment plan, COB, next appointment) possible without a second lookup.
 * The chairside path still works with no OD at all — the fields stay typed by
 * hand, and every prefilled field remains editable.
 */
import { useEffect, useId, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  CheckCircle2,
  ClipboardList,
  Flame,
  Loader2,
  Send,
  Stethoscope,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import {
  CaseCategory,
  PatientInterestLevel,
  PerioStatus,
  Radiograph,
  RecallType,
  Urgency,
  type OfficeId,
} from "@shared/tc/contract";
import {
  hygienistRoster,
  odAttachSearch,
  submitHygieneIntake,
  tcErrorMessage,
  type OdPatient,
  type TcHygienistOption,
  type TcIntakeSubmit,
} from "../api";
import { URGENCY_LABELS, type UrgencyId } from "../status";
import { OdPatientSearch } from "../od/OdShell";
import { fieldsFromOdPatient } from "../od/odPatient";
import { todayIsoDate } from "../lib/followups";

type CaseCategoryId = (typeof CaseCategory.options)[number];
type PerioStatusId = (typeof PerioStatus.options)[number];
type RecallTypeId = (typeof RecallType.options)[number];
type RadiographId = (typeof Radiograph.options)[number];
type InterestId = (typeof PatientInterestLevel.options)[number];

const CATEGORY_LABELS: Record<CaseCategoryId, string> = {
  single_tooth: "Single tooth",
  quadrant: "Quadrant",
  implant: "Implant",
  full_mouth_rehab: "Full mouth rehab",
  full_arch: "Full arch (All-on-X)",
  cosmetic: "Cosmetic",
  ortho: "Orthodontics",
};

const PERIO_LABELS: Record<PerioStatusId, string> = {
  healthy: "Healthy",
  gingivitis: "Gingivitis",
  early_perio: "Early perio",
  moderate_perio: "Moderate perio",
  advanced_perio: "Advanced perio",
  unknown: "Unknown",
};

const RECALL_LABELS: Record<RecallTypeId, string> = {
  prophy: "Prophy",
  perio_maint: "Perio maintenance",
  srp_needed: "SRP needed",
  d4346: "D4346 (gingivitis scaling)",
  fmd: "FMD (full mouth debridement)",
  none: "None",
};

const INTEREST_LABELS: Record<InterestId, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  unknown: "Unknown",
};

interface IntakeDraft {
  patientName: string;
  patientAge: string;
  phone: string;
  email: string;
  diagnosingProvider: string;
  /**
   * WHO DID THE VISIT (Roles PR B). Distinct from the SSO identity the server
   * stamps: temp@carein.ai is one shared account, so without this every temp's
   * work would be indistinguishable. Free text, pre-filled from the picker.
   */
  hygienistName: string;
  category: CaseCategoryId;
  urgency: UrgencyId;
  caseType: string;
  operatory: string;
  visitDate: string;
  providerSeen: string;
  chiefConcern: string;
  perioStatus: PerioStatusId;
  recallType: RecallTypeId;
  radiographs: RadiographId[];
  intraoralPhotosTaken: boolean;
  areasOfConcern: string;
  suspectedTreatment: string;
  hygienistRecommendation: string;
  insuranceNoted: string;
  patientInterestLevel: InterestId;
  flagUrgent: boolean;
  /** Set only by the Open Dental link — never typed. */
  odPatientId: number | null;
}

function emptyDraft(): IntakeDraft {
  return {
    patientName: "",
    patientAge: "",
    phone: "",
    email: "",
    odPatientId: null,
    diagnosingProvider: "",
    hygienistName: "",
    category: "single_tooth",
    urgency: "medium",
    caseType: "",
    operatory: "",
    visitDate: todayIsoDate(),
    providerSeen: "",
    chiefConcern: "",
    perioStatus: "unknown",
    recallType: "prophy",
    radiographs: [],
    intraoralPhotosTaken: false,
    areasOfConcern: "",
    suspectedTreatment: "",
    hygienistRecommendation: "",
    insuranceNoted: "",
    patientInterestLevel: "unknown",
    flagUrgent: false,
  };
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-muted text-foreground flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div>
          <h2
            className="text-base font-semibold text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            {title}
          </h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export interface IntakeFormProps {
  office: OfficeId;
}

export function IntakeForm({ office }: IntakeFormProps) {
  const auth = useAuth();
  const submitterName = auth.status === "authenticated" ? auth.user.name : null;
  const idPrefix = useId();
  const fid = (name: string) => `${idPrefix}-${name}`;

  const [draft, setDraft] = useState<IntakeDraft>(emptyDraft);
  const [odPatient, setOdPatient] = useState<OdPatient | null>(null);
  // The picker's suggestions. A failed roster fetch is not an error worth
  // showing: the field is free text, so an empty list costs the user nothing.
  const [roster, setRoster] = useState<TcHygienistOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);

  // Default the attribution to the signed-in user, and load the roster the
  // datalist offers. Both are conveniences; neither blocks the form.
  useEffect(() => {
    if (submitterName) {
      setDraft((d) => (d.hygienistName ? d : { ...d, hygienistName: submitterName }));
    }
  }, [submitterName]);

  useEffect(() => {
    let active = true;
    hygienistRoster(office)
      .then((list) => {
        if (active) setRoster(list);
      })
      .catch(() => {
        if (active) setRoster([]);
      });
    return () => {
      active = false;
    };
  }, [office]);

  const set = <K extends keyof IntakeDraft>(key: K, value: IntakeDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Link an Open Dental patient. Prefills the identity fields but does NOT lock
   * them — a chairside correction (a preferred name, a better phone number) is a
   * normal thing to make, and the PatNum link survives it.
   *
   * PREFILL, NOT OVERWRITE. The hygiene-safe search returns only PatNum, name
   * and DOB, so phone and email come back blank. A blank means "not fetched",
   * never "not on file" — writing it over a number the hygienist just typed
   * would silently destroy chairside work. Only non-empty OD values are applied.
   */
  const linkOdPatient = (p: OdPatient) => {
    setOdPatient(p);
    setDraft((prev) => {
      const next = { ...prev, odPatientId: p.patNum };
      for (const [key, value] of Object.entries(fieldsFromOdPatient(p))) {
        if (typeof value === "string" && value !== "") {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      return next;
    });
  };

  const unlinkOdPatient = () => {
    setOdPatient(null);
    // Leave the typed fields alone — unlinking removes the OD reference, not
    // the intake the hygienist has already filled in.
    setDraft((prev) => ({ ...prev, odPatientId: null }));
  };

  // "none" is exclusive of the actual film types (legacy behaviour preserved).
  const toggleRadiograph = (r: RadiographId) => {
    setDraft((prev) => {
      if (r === "none") {
        return { ...prev, radiographs: prev.radiographs.includes("none") ? [] : ["none"] };
      }
      const withoutNone = prev.radiographs.filter((x) => x !== "none");
      return {
        ...prev,
        radiographs: withoutNone.includes(r)
          ? withoutNone.filter((x) => x !== r)
          : [...withoutNone, r],
      };
    });
  };

  const handleSubmit = async () => {
    const patientName = draft.patientName.trim();
    const diagnosingProvider = draft.diagnosingProvider.trim();
    if (!patientName) {
      toast.error("Patient name is required.");
      return;
    }
    if (!diagnosingProvider) {
      toast.error("Diagnosing provider is required.");
      return;
    }
    let patientAge: number | null = null;
    if (draft.patientAge.trim() !== "") {
      const parsed = Number.parseInt(draft.patientAge.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 130) {
        toast.error("Age must be a number between 0 and 130.");
        return;
      }
      patientAge = parsed;
    }

    const payload: TcIntakeSubmit = {
      patientName,
      patientAge,
      phone: draft.phone.trim() || null,
      email: draft.email.trim() || null,
      odPatientId: draft.odPatientId,
      diagnosingProvider,
      category: draft.category,
      urgency: draft.urgency,
      caseType: draft.caseType.trim() || CATEGORY_LABELS[draft.category],
      operatory: draft.operatory.trim(),
      visitDate: draft.visitDate || null,
      providerSeen: draft.providerSeen.trim(),
      chiefConcern: draft.chiefConcern.trim(),
      perioStatus: draft.perioStatus,
      recallType: draft.recallType,
      radiographs: draft.radiographs,
      intraoralPhotosTaken: draft.intraoralPhotosTaken,
      areasOfConcern: draft.areasOfConcern.trim(),
      suspectedTreatment: draft.suspectedTreatment.trim(),
      hygienistRecommendation: draft.hygienistRecommendation.trim(),
      insuranceNoted: draft.insuranceNoted.trim(),
      patientInterestLevel: draft.patientInterestLevel,
      flagUrgent: draft.flagUrgent,
      // Empty is fine — the server falls back to the signed-in display name.
      hygienistName: draft.hygienistName.trim(),
    };

    setSubmitting(true);
    try {
      await submitHygieneIntake(office, payload);
      toast.success("Sent to TC inbox");
      setLastSubmitted(patientName);
      // Keep the hygienist across submissions: it's the same person seeing the
      // next patient, and re-picking it every time is the kind of friction that
      // makes people stop filling a field in.
      setDraft({ ...emptyDraft(), hygienistName: draft.hygienistName });
      setOdPatient(null);
    } catch (e) {
      // Keep the form values so nothing typed chairside is lost.
      toast.error(tcErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {lastSubmitted && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-3 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {lastSubmitted} sent to the TC inbox.
          </span>
          <Link
            href="/tc/hygiene/submissions"
            className="text-sm font-medium underline text-emerald-800 dark:text-emerald-300 shrink-0"
          >
            My Submissions
          </Link>
        </div>
      )}

      {/* ── Patient ── */}
      <Section
        icon={<User className="w-5 h-5" />}
        title="Patient"
        subtitle={submitterName ? `Submitting as ${submitterName}` : undefined}
      >
        {/* Read-only OD link. Optional: the chairside path works without it.
            `odAttachSearch` rather than the tc.full search — this form is the
            hygiene surface, and it resolves the OD client per office so Riley
            works as well as Roland. */}
        <OdPatientSearch
          office={office}
          selected={odPatient}
          onSelect={linkOdPatient}
          onClear={unlinkOdPatient}
          search={odAttachSearch}
          label="Link an Open Dental patient (optional)"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("name")}>Patient name *</Label>
            <Input
              id={fid("name")}
              value={draft.patientName}
              onChange={(e) => set("patientName", e.target.value)}
              placeholder="First Last"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("age")}>Age</Label>
            <Input
              id={fid("age")}
              type="number"
              inputMode="numeric"
              value={draft.patientAge}
              onChange={(e) => set("patientAge", e.target.value)}
              placeholder="42"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("phone")}>Phone</Label>
            <Input
              id={fid("phone")}
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="(479) 555-0100"
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("email")}>Email</Label>
            <Input
              id={fid("email")}
              value={draft.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="patient@email.com"
            />
          </div>
        </div>
      </Section>

      {/* ── Case entry ── */}
      <Section icon={<ClipboardList className="w-5 h-5" />} title="Case entry">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("provider")}>Diagnosing provider *</Label>
            <Input
              id={fid("provider")}
              value={draft.diagnosingProvider}
              onChange={(e) => set("diagnosingProvider", e.target.value)}
              placeholder="Dr. …"
            />
          </div>
          {/* Who did the hygiene visit. Its own field because the signed-in
              account is not always the person — temp@ is shared. */}
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("hygienist")}>Hygienist</Label>
            <Input
              id={fid("hygienist")}
              list={fid("hygienist-roster")}
              value={draft.hygienistName}
              onChange={(e) => set("hygienistName", e.target.value)}
              placeholder="Who saw this patient?"
              data-testid="intake-hygienist"
            />
            {/* A datalist, not a <select>: it offers the roster AND accepts a
                name that isn't on it, which is exactly the temp case. */}
            <datalist id={fid("hygienist-roster")}>
              {roster.map((h) => (
                <option key={h.email} value={h.label} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Defaults to you. If you&apos;re on a shared login, type your own name so your
              handoffs are yours.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Category *</Label>
            <Select
              value={draft.category}
              onValueChange={(v) => set("category", v as CaseCategoryId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CaseCategory.options.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Urgency *</Label>
            <Select
              value={draft.urgency}
              onValueChange={(v) => set("urgency", v as UrgencyId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Urgency.options.map((u) => (
                  <SelectItem key={u} value={u}>
                    {URGENCY_LABELS[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("casetype")}>Case type</Label>
            <Input
              id={fid("casetype")}
              value={draft.caseType}
              onChange={(e) => set("caseType", e.target.value)}
              placeholder="Defaults to the category label"
            />
          </div>
        </div>
      </Section>

      {/* ── Visit ── */}
      <Section icon={<ClipboardList className="w-5 h-5" />} title="Visit">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={fid("operatory")}>Operatory</Label>
            <Input
              id={fid("operatory")}
              value={draft.operatory}
              onChange={(e) => set("operatory", e.target.value)}
              placeholder="OP 3"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("visitdate")}>Visit date</Label>
            <Input
              id={fid("visitdate")}
              type="date"
              value={draft.visitDate}
              onChange={(e) => set("visitDate", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("seen")}>Provider seen</Label>
            <Input
              id={fid("seen")}
              value={draft.providerSeen}
              onChange={(e) => set("providerSeen", e.target.value)}
              placeholder="Doctor who saw the patient today"
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label htmlFor={fid("concern")}>Chief concern / reason for handoff</Label>
            <Textarea
              id={fid("concern")}
              value={draft.chiefConcern}
              onChange={(e) => set("chiefConcern", e.target.value)}
              placeholder="What did you see? Why hand off to the TC?"
              className="resize-none h-20"
            />
          </div>
        </div>
      </Section>

      {/* ── Clinical ── */}
      <Section icon={<Stethoscope className="w-5 h-5" />} title="Clinical findings">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Perio status</Label>
            <Select
              value={draft.perioStatus}
              onValueChange={(v) => set("perioStatus", v as PerioStatusId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PerioStatus.options.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PERIO_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Recall type</Label>
            <Select
              value={draft.recallType}
              onValueChange={(v) => set("recallType", v as RecallTypeId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RecallType.options.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RECALL_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Radiographs taken</Label>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {Radiograph.options.map((r) => (
              <div key={r} className="flex items-center gap-2">
                <Checkbox
                  id={fid(`radiograph-${r}`)}
                  checked={draft.radiographs.includes(r)}
                  onCheckedChange={() => toggleRadiograph(r)}
                />
                <Label htmlFor={fid(`radiograph-${r}`)} className="font-normal">
                  {r === "none" ? "None" : r}
                </Label>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <Label htmlFor={fid("photos")} className="font-normal">
            Intraoral photos taken
          </Label>
          <Switch
            id={fid("photos")}
            checked={draft.intraoralPhotosTaken}
            onCheckedChange={(v) => set("intraoralPhotosTaken", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("areas")}>Areas / teeth of concern</Label>
          <Input
            id={fid("areas")}
            value={draft.areasOfConcern}
            onChange={(e) => set("areasOfConcern", e.target.value)}
            placeholder="#14, #30, lower right quad…"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("suspected")}>Suspected treatment</Label>
          <Textarea
            id={fid("suspected")}
            value={draft.suspectedTreatment}
            onChange={(e) => set("suspectedTreatment", e.target.value)}
            placeholder="Your read — the TC will refine into phases"
            className="resize-none h-20"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("recommendation")}>Hygienist recommendation</Label>
          <Textarea
            id={fid("recommendation")}
            value={draft.hygienistRecommendation}
            onChange={(e) => set("hygienistRecommendation", e.target.value)}
            placeholder="What you'd recommend the TC do next"
            className="resize-none h-20"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={fid("insurance")}>Insurance noted</Label>
          <Input
            id={fid("insurance")}
            value={draft.insuranceNoted}
            onChange={(e) => set("insuranceNoted", e.target.value)}
            placeholder="What the patient mentioned about insurance"
          />
        </div>
      </Section>

      {/* ── Assessment ── */}
      <Section icon={<Flame className="w-5 h-5" />} title="Assessment">
        <div className="space-y-1.5">
          <Label>Patient interest</Label>
          <div className="grid grid-cols-4 gap-2">
            {PatientInterestLevel.options.map((level) => (
              <Button
                key={level}
                type="button"
                variant={draft.patientInterestLevel === level ? "default" : "outline"}
                aria-pressed={draft.patientInterestLevel === level}
                className="gap-1.5"
                onClick={() => set("patientInterestLevel", level)}
              >
                {level === "hot" && <Flame className="w-3.5 h-3.5" />}
                {INTEREST_LABELS[level]}
              </Button>
            ))}
          </div>
        </div>
        <div
          className={`flex items-center justify-between rounded-lg border p-3 ${
            draft.flagUrgent
              ? "border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950"
              : "border-border"
          }`}
        >
          <Label htmlFor={fid("urgent")} className="font-normal">
            Flag urgent — jumps to the top of the TC inbox
          </Label>
          <Switch
            id={fid("urgent")}
            checked={draft.flagUrgent}
            onCheckedChange={(v) => {
              set("flagUrgent", v);
              if (v && draft.urgency !== "high") set("urgency", "high");
            }}
          />
        </div>
      </Section>

      {/* Submit */}
      <div className="sticky bottom-0 py-3 bg-background/90 backdrop-blur border-t border-border">
        <Button
          className="w-full py-6 text-base font-semibold gap-2"
          disabled={submitting || !draft.patientName.trim() || !draft.diagnosingProvider.trim()}
          onClick={() => void handleSubmit()}
        >
          {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          Submit handoff to TC
        </Button>
      </div>
    </div>
  );
}
