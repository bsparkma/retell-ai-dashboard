/**
 * Create / edit dialog for pre-auth cases.
 *
 * Status is NEVER edited here — transitions go through the board's "Move to…"
 * menu so the server stamps submittedDate/decisionDate. Confirmed-save:
 * toast.success only after the API resolves; failures keep the dialog open
 * with values intact and toast tcErrorMessage(e).
 *
 * An optional Open Dental patient link sits at the top, the same picker the
 * New Case dialog uses. It PREFILLS name/phone/email and then gets out of the
 * way — every field stays editable, because the link is a convenience, not a
 * lock, and a pre-auth for someone not yet in Open Dental is a normal pre-auth.
 */
import { useEffect, useState } from "react";
import type { z } from "zod";
import { toast } from "sonner";
import type { OfficeId, PreauthType, TcPreauthCase } from "@shared/tc/contract";
import {
  createPreauth,
  patchPreauth,
  tcErrorMessage,
  type OdPatient,
  type TcPreauthCreate,
  type TcPreauthPatch,
} from "../api";
import { OdPatientSearch } from "../od/OdShell";
import { fieldsFromOdPatient } from "../od/odPatient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, X } from "lucide-react";
import { PREAUTH_TYPE_LABELS } from "./PreauthBoard";

type PreauthTypeId = z.infer<typeof PreauthType>;

interface FormState {
  patientName: string;
  preauthType: PreauthTypeId;
  insuranceCarrier: string;
  doctorName: string;
  phone: string;
  email: string;
  description: string;
  referenceNumber: string;
  notes: string;
  caseId: string;
}

const EMPTY: FormState = {
  patientName: "",
  preauthType: "treatment",
  insuranceCarrier: "",
  doctorName: "",
  phone: "",
  email: "",
  description: "",
  referenceNumber: "",
  notes: "",
  caseId: "",
};

/**
 * The Open Dental link, if any.
 *
 * `patient` is the full record ONLY when it was picked in this dialog. A link
 * loaded from an existing case carries the PatNum alone: we do not fetch Open
 * Dental just to print a name, so that case renders an honest PatNum badge
 * rather than a name we have not actually read back.
 */
interface OdLink {
  patNum: number;
  patient: OdPatient | null;
}

function fromCase(c: TcPreauthCase): FormState {
  return {
    patientName: c.patientName,
    preauthType: c.preauthType,
    insuranceCarrier: c.insuranceCarrier,
    doctorName: c.doctorName,
    phone: c.phone ?? "",
    email: c.email ?? "",
    description: c.description,
    referenceNumber: c.referenceNumber,
    notes: c.notes,
    caseId: c.caseId ?? "",
  };
}

export function PreauthDialog({
  office,
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  office: OfficeId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create mode; a case = edit mode. */
  editing: TcPreauthCase | null;
  onSaved: (saved: TcPreauthCase, mode: "created" | "updated") => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [odLink, setOdLink] = useState<OdLink | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens (create) or the target changes.
  useEffect(() => {
    if (!open) return;
    setForm(editing ? fromCase(editing) : EMPTY);
    setOdLink(editing?.odPatientId ? { patNum: editing.odPatientId, patient: null } : null);
  }, [open, editing]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Prefill from a linked OD patient. Name is overwritten; phone and email are
   * only filled when Open Dental actually has them, so a number typed here does
   * not get blanked by a field the server does not serve. Age is ignored — a
   * pre-auth has no age field. All of it stays editable afterwards.
   */
  const linkOdPatient = (p: OdPatient) => {
    const fields = fieldsFromOdPatient(p);
    setOdLink({ patNum: p.patNum, patient: p });
    setForm((f) => ({
      ...f,
      patientName: fields.patientName,
      ...(fields.phone ? { phone: fields.phone } : {}),
      ...(fields.email ? { email: fields.email } : {}),
    }));
  };

  const requiredMissing =
    !form.patientName.trim() || !form.insuranceCarrier.trim() || !form.doctorName.trim();

  const handleSave = async () => {
    if (requiredMissing) {
      toast.error("Patient name, insurance carrier, and doctor are required.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // Only send odPatientId when the link actually changed — a patch that
        // restates it would rewrite the column on every save for no reason.
        const originalOdPatientId = editing.odPatientId ?? null;
        const nextOdPatientId = odLink?.patNum ?? null;
        const patch: TcPreauthPatch = {
          patientName: form.patientName.trim(),
          preauthType: form.preauthType,
          insuranceCarrier: form.insuranceCarrier.trim(),
          doctorName: form.doctorName.trim(),
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          description: form.description,
          referenceNumber: form.referenceNumber.trim(),
          notes: form.notes,
          caseId: form.caseId.trim() || null,
          ...(nextOdPatientId !== originalOdPatientId
            ? { odPatientId: nextOdPatientId }
            : {}),
        };
        const saved = await patchPreauth(office, editing.preauthId, patch);
        toast.success(`${saved.patientName} updated`);
        onSaved(saved, "updated");
      } else {
        const input: TcPreauthCreate = {
          patientName: form.patientName.trim(),
          preauthType: form.preauthType,
          insuranceCarrier: form.insuranceCarrier.trim(),
          doctorName: form.doctorName.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
          ...(form.description ? { description: form.description } : {}),
          ...(form.referenceNumber.trim() ? { referenceNumber: form.referenceNumber.trim() } : {}),
          ...(form.notes ? { notes: form.notes } : {}),
          ...(form.caseId.trim() ? { caseId: form.caseId.trim() } : {}),
          ...(odLink ? { odPatientId: odLink.patNum } : {}),
        };
        const saved = await createPreauth(office, input);
        toast.success(`Pre-auth created for ${saved.patientName}`);
        onSaved(saved, "created");
      }
      onOpenChange(false);
    } catch (e) {
      // Keep the dialog open with values intact.
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit pre-authorization" : "New pre-authorization"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the case details. Use the board's Move to… menu to change status."
              : "Track a new insurance pre-authorization on the board."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {odLink && !odLink.patient && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  Linked to Open Dental
                  <Badge variant="outline" className="text-[10px]">
                    PatNum {odLink.patNum}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  Search below to link a different patient.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOdLink(null)}
                aria-label="Unlink this patient"
              >
                <X size={14} />
              </Button>
            </div>
          )}
          <OdPatientSearch
            office={office}
            selected={odLink?.patient ?? null}
            onSelect={linkOdPatient}
            onClear={() => setOdLink(null)}
            label="Link an Open Dental patient (optional)"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Patient name *</span>
            <Input
              value={form.patientName}
              maxLength={200}
              onChange={(e) => set("patientName", e.target.value)}
              placeholder="Jane Doe"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Type</span>
            <Select value={form.preauthType} onValueChange={(v) => set("preauthType", v as PreauthTypeId)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PREAUTH_TYPE_LABELS) as PreauthTypeId[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {PREAUTH_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Insurance carrier *</span>
            <Input
              value={form.insuranceCarrier}
              maxLength={200}
              onChange={(e) => set("insuranceCarrier", e.target.value)}
              placeholder="Delta Dental"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Doctor *</span>
            <Input
              value={form.doctorName}
              maxLength={200}
              onChange={(e) => set("doctorName", e.target.value)}
              placeholder="Dr. Sparkman"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Reference #</span>
            <Input
              value={form.referenceNumber}
              maxLength={200}
              onChange={(e) => set("referenceNumber", e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Phone</span>
            <Input value={form.phone} maxLength={200} onChange={(e) => set("phone", e.target.value)} />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Email</span>
            <Input value={form.email} maxLength={200} onChange={(e) => set("email", e.target.value)} />
          </label>

          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Linked case ID</span>
            <Input
              value={form.caseId}
              placeholder="TC case UUID (optional)"
              onChange={(e) => set("caseId", e.target.value)}
            />
          </label>

          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Description</span>
            <Textarea
              value={form.description}
              rows={2}
              maxLength={8000}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Procedures being pre-authorized"
            />
          </label>

          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            <span>Notes</span>
            <Textarea
              value={form.notes}
              rows={2}
              maxLength={8000}
              onChange={(e) => set("notes", e.target.value)}
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || requiredMissing}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? "Save changes" : "Create pre-auth"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
