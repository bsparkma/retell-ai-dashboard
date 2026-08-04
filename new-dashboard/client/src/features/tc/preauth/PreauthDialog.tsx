/**
 * Create / edit dialog for pre-auth cases.
 *
 * Status is NEVER edited here — transitions go through the board's "Move to…"
 * menu so the server stamps submittedDate/decisionDate. Confirmed-save:
 * toast.success only after the API resolves; failures keep the dialog open
 * with values intact and toast tcErrorMessage(e).
 */
import { useEffect, useState } from "react";
import type { z } from "zod";
import { toast } from "sonner";
import type { OfficeId, PreauthType, TcPreauthCase } from "@shared/tc/contract";
import {
  createPreauth,
  patchPreauth,
  tcErrorMessage,
  type TcPreauthCreate,
  type TcPreauthPatch,
} from "../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Loader2 } from "lucide-react";
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
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens (create) or the target changes.
  useEffect(() => {
    if (open) setForm(editing ? fromCase(editing) : EMPTY);
  }, [open, editing]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

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
