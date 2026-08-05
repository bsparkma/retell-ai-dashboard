/**
 * Minimal case creation per the backend CaseCreate contract. Required:
 * patientName, category, status (default pending_tc), urgency. Optional
 * scalars only — treatment phases/items are built on the case page.
 *
 * Confirmed-save rule: success toast + navigation happen ONLY after
 * createCase() resolves with the persisted case; failures toast and keep the
 * dialog open with values intact.
 *
 * Slice 5 adds an optional read-only Open Dental patient link at the top.
 * Linking here is what lets the case page pull the treatment plan, run the COB
 * pull and show the next appointment without a second lookup — so it is offered
 * first, but never required: a case for someone not yet in Open Dental is a
 * normal case.
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { CaseCategory, ReferralSource } from "@shared/tc/contract";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { createCase, tcErrorMessage } from "../api";
import type { OdPatient, TcCaseCreate } from "../api";
import { OdPatientSearch } from "../od/OdShell";
import { fieldsFromOdPatient } from "../od/odPatient";
import { dollarsInputToCents } from "../money";
import { ALL_CASE_STATUSES, URGENCY_LABELS, caseStatusLabel } from "../status";
import type { CaseStatusId, UrgencyId } from "../status";

export type CaseCategoryId = z.infer<typeof CaseCategory>;
type ReferralSourceId = z.infer<typeof ReferralSource>;

/** Display labels for the contract's CaseCategory vocabulary (legacy labels). */
export const CASE_CATEGORY_LABELS: Record<CaseCategoryId, string> = {
  single_tooth: "Single Tooth",
  quadrant: "Quadrant",
  implant: "Implant",
  full_mouth_rehab: "Full Mouth Rehab",
  full_arch: "Full Arch (All-on-X)",
  cosmetic: "Cosmetic",
  ortho: "Orthodontics",
};

const REFERRAL_SOURCE_LABELS: Record<ReferralSourceId, string> = {
  google: "Google",
  existing_patient: "Existing patient",
  doctor_referral: "Doctor referral",
  social_media: "Social media",
  carein_call: "CareIN call",
  walk_in: "Walk-in",
  hygiene: "Hygiene",
  other: "Other",
};

const URGENCY_IDS = Object.keys(URGENCY_LABELS) as UrgencyId[];

/**
 * Creatable statuses: everything except "lost" — marking lost requires a
 * lostReason, which is collected through the pipeline's Mark Lost dialog,
 * not at creation time.
 */
const CREATABLE_STATUSES: CaseStatusId[] = ALL_CASE_STATUSES.filter((s) => s !== "lost");

export function NewCaseDialog({
  office,
  open,
  onOpenChange,
  onCreated,
}: {
  office: OfficeId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the server persists the case (the dialog already toasted). */
  onCreated: (created: TcCase) => void;
}) {
  // Required.
  const [patientName, setPatientName] = useState("");
  const [category, setCategory] = useState<CaseCategoryId>("single_tooth");
  const [status, setStatus] = useState<CaseStatusId>("pending_tc");
  const [urgency, setUrgency] = useState<UrgencyId>("medium");
  // Optional.
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [assignedTc, setAssignedTc] = useState("");
  const [valueText, setValueText] = useState("");
  const [notes, setNotes] = useState("");
  const [referralSource, setReferralSource] = useState<ReferralSourceId | "none">("none");
  /** Optional Open Dental link — read-only, and the source of odPatientId. */
  const [odPatient, setOdPatient] = useState<OdPatient | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPatientName("");
    setCategory("single_tooth");
    setStatus("pending_tc");
    setUrgency("medium");
    setPhone("");
    setEmail("");
    setPatientAge("");
    setDoctorName("");
    setAssignedTc("");
    setValueText("");
    setNotes("");
    setReferralSource("none");
    setOdPatient(null);
    setSubmitting(false);
    setAttempted(false);
  }, [open]);

  /** Prefill from an OD patient. Every filled field stays editable. */
  const linkOdPatient = (p: OdPatient) => {
    const fields = fieldsFromOdPatient(p);
    setOdPatient(p);
    setPatientName(fields.patientName);
    setPatientAge(fields.patientAge);
    if (fields.phone) setPhone(fields.phone);
    if (fields.email) setEmail(fields.email);
  };

  // Inline validation.
  const valueCents = valueText.trim() === "" ? null : dollarsInputToCents(valueText);
  const valueInvalid = valueText.trim() !== "" && valueCents === null;
  const ageTrimmed = patientAge.trim();
  const ageNum = ageTrimmed === "" ? null : Number(ageTrimmed);
  const ageInvalid =
    ageNum !== null && (!Number.isInteger(ageNum) || ageNum < 0 || ageNum > 130);
  const nameMissing = patientName.trim() === "";

  const submit = async () => {
    setAttempted(true);
    if (nameMissing || valueInvalid || ageInvalid || submitting) return;

    const input: TcCaseCreate = {
      patientName: patientName.trim(),
      category,
      status,
      urgency,
      ...(phone.trim() !== "" ? { phone: phone.trim() } : {}),
      ...(email.trim() !== "" ? { email: email.trim() } : {}),
      ...(ageNum !== null ? { patientAge: ageNum } : {}),
      ...(doctorName.trim() !== "" ? { doctorName: doctorName.trim() } : {}),
      ...(assignedTc.trim() !== "" ? { assignedTc: assignedTc.trim() } : {}),
      ...(valueCents !== null ? { caseValueCents: valueCents } : {}),
      ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
      ...(referralSource !== "none" ? { referralSource } : {}),
      ...(odPatient ? { odPatientId: odPatient.patNum } : {}),
    };

    setSubmitting(true);
    try {
      const created = await createCase(office, input);
      toast.success(`Case created for ${created.patientName}`);
      onOpenChange(false);
      onCreated(created);
    } catch (err) {
      // Keep the dialog open with values intact for retry.
      toast.error(tcErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Case</DialogTitle>
          <DialogDescription>
            Start a case with the basics — treatment phases and items are added on
            the case page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <OdPatientSearch
            office={office}
            selected={odPatient}
            onSelect={linkOdPatient}
            onClear={() => setOdPatient(null)}
            label="Link an Open Dental patient (optional)"
          />

          <div className="space-y-1.5">
            <Label htmlFor="tc-new-name">Patient name</Label>
            <Input
              id="tc-new-name"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              placeholder="Jane Smith"
              autoComplete="off"
            />
            {attempted && nameMissing && (
              <p className="text-xs text-destructive">Patient name is required.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as CaseCategoryId)}>
                <SelectTrigger id="tc-new-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CaseCategory.options.map((c) => (
                    <SelectItem key={c} value={c}>{CASE_CATEGORY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as CaseStatusId)}>
                <SelectTrigger id="tc-new-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATABLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{caseStatusLabel(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-urgency">Urgency</Label>
              <Select value={urgency} onValueChange={(v) => setUrgency(v as UrgencyId)}>
                <SelectTrigger id="tc-new-urgency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {URGENCY_IDS.map((u) => (
                    <SelectItem key={u} value={u}>{URGENCY_LABELS[u]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-value">Case value ($)</Label>
              <Input
                id="tc-new-value"
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                placeholder="4,500"
                inputMode="decimal"
                autoComplete="off"
              />
              {valueInvalid && (
                <p className="text-xs text-destructive">
                  Enter a valid dollar amount (e.g. 4,500 or 4500.00).
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-phone">Phone</Label>
              <Input
                id="tc-new-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(479) 555-0100"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-email">Email</Label>
              <Input
                id="tc-new-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-age">Patient age</Label>
              <Input
                id="tc-new-age"
                value={patientAge}
                onChange={(e) => setPatientAge(e.target.value)}
                placeholder="42"
                inputMode="numeric"
                autoComplete="off"
              />
              {ageInvalid && (
                <p className="text-xs text-destructive">Age must be a whole number 0–130.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-referral">Referral source</Label>
              <Select
                value={referralSource}
                onValueChange={(v) => setReferralSource(v as ReferralSourceId | "none")}
              >
                <SelectTrigger id="tc-new-referral" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not recorded</SelectItem>
                  {ReferralSource.options.map((r) => (
                    <SelectItem key={r} value={r}>{REFERRAL_SOURCE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-doctor">Doctor</Label>
              <Input
                id="tc-new-doctor"
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                placeholder="Dr. Beau Sparkman"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-new-tc">Assigned TC</Label>
              <Input
                id="tc-new-tc"
                value={assignedTc}
                onChange={(e) => setAssignedTc(e.target.value)}
                placeholder="Holly Goodwin"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tc-new-notes">Notes</Label>
            <Textarea
              id="tc-new-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth capturing at intake…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || valueInvalid || ageInvalid || (attempted && nameMissing)}
          >
            {submitting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            Create Case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
