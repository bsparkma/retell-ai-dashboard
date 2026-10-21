/**
 * The four sign-off fields — specialist, how soon, reason, teeth — and, for
 * the doctor, their own note (queue item 56, R6).
 *
 * ONE form for both edit surfaces: the hub (staff, tc.full) and the sign-off
 * card (the doctor). It hands back ONLY what changed, so the server's history
 * line names what actually moved and a no-op is a no-op. It never sends the
 * patient or the office: the server owns both.
 *
 * Saving is the caller's: this form reports `onSave(change)` and shows
 * `saving` / `error` as the caller sets them — the caller only closes it once
 * the server has answered.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  TC_REFERRAL_DOCTOR_NOTE_MAX,
  TC_REFERRAL_URGENCY_LABELS,
  TcReferralDoctorEdit,
  TcReferralUrgency,
  type TcReferral,
  type TcReferralDirectoryEntry,
  type TcReferralTeeth,
} from "@shared/tc/referrals";

export type ReferralFieldsChange = TcReferralDoctorEdit;

interface FormState {
  directoryEntryId: string;
  urgency: TcReferralUrgency;
  reason: string;
  teeth: string;
  wholeMouth: boolean;
  doctorNote: string;
}

function stateOf(r: TcReferral): FormState {
  return {
    directoryEntryId: r.directoryEntryId ?? "",
    urgency: r.urgency,
    reason: r.reason,
    teeth: r.teeth === "mouth" ? "" : r.teeth.join(", "),
    wholeMouth: r.teeth === "mouth",
    doctorNote: r.doctorNote ?? "",
  };
}

/** "3, #14" → [3, 14]; anything not a tooth 1–32 is an error, not a guess. Pure. */
export function parseTeethText(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).map((p) => p.replace(/^#/, "")).filter(Boolean);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 32)) return null;
  return nums;
}

/**
 * What the form changed against the referral it opened on — only those
 * fields. `{}` when nothing changed. Pure.
 */
export function changedFields(
  r: TcReferral,
  s: { directoryEntryId: string; urgency: TcReferralUrgency; reason: string; teeth: TcReferralTeeth; doctorNote?: string },
  withDoctorNote: boolean,
): ReferralFieldsChange {
  const out: ReferralFieldsChange = {};
  const entry = s.directoryEntryId || null;
  if (entry !== r.directoryEntryId) out.directoryEntryId = entry;
  if (s.urgency !== r.urgency) out.urgency = s.urgency;
  if (s.reason.trim() !== r.reason) out.reason = s.reason.trim();
  if (JSON.stringify(s.teeth) !== JSON.stringify(r.teeth)) out.teeth = s.teeth;
  if (withDoctorNote && (s.doctorNote ?? "").trim() !== (r.doctorNote ?? "")) {
    out.doctorNote = (s.doctorNote ?? "").trim() || null;
  }
  return out;
}

export interface ReferralFieldsFormProps {
  referral: TcReferral;
  /** The office's ACTIVE specialists, from whichever surface may read them. */
  entries: readonly TcReferralDirectoryEntry[];
  /** The doctor's surface: shows the doctor's note field. */
  withDoctorNote?: boolean;
  saving: boolean;
  /** The server's refusal, shown in words. */
  serverError?: string | null;
  saveLabel: string;
  onSave: (change: ReferralFieldsChange) => void;
  onCancel: () => void;
  /** A line under the title, e.g. "Saving sends it back for the doctor's sign-off." */
  hint?: string;
}

export function ReferralFieldsForm({
  referral,
  entries,
  withDoctorNote = false,
  saving,
  serverError,
  saveLabel,
  onSave,
  onCancel,
  hint,
}: ReferralFieldsFormProps) {
  const [s, setS] = useState<FormState>(stateOf(referral));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setS(stateOf(referral));
    setError(null);
  }, [referral]);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setS((x) => ({ ...x, [k]: v }));
    setError(null);
  }

  // The current specialist stays choosable even if it went inactive since.
  const options = entries.some((e) => e.entryId === referral.directoryEntryId) || !referral.directoryEntryId
    ? entries
    : [
        ...entries,
        { entryId: referral.directoryEntryId, practiceName: referral.practiceName ?? "Current specialist", specialty: "" } as TcReferralDirectoryEntry,
      ];

  function save() {
    const teeth: TcReferralTeeth | null = s.wholeMouth ? "mouth" : parseTeethText(s.teeth);
    if (teeth === null) {
      setError("Teeth are numbers 1–32, separated by commas");
      return;
    }
    const change = changedFields(referral, { ...s, teeth }, withDoctorNote);
    if (Object.keys(change).length === 0) {
      setError("Nothing has changed");
      return;
    }
    const parsed = TcReferralDoctorEdit.safeParse(change);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    onSave(parsed.data);
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="referral-fields-form">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2 space-y-1">
          <Label htmlFor="rff-entry">Specialist</Label>
          <select
            id="rff-entry"
            className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={s.directoryEntryId}
            onChange={(e) => set("directoryEntryId", e.target.value)}
            disabled={saving}
          >
            <option value="">Choose later</option>
            {options.map((e) => (
              <option key={e.entryId} value={e.entryId}>
                {e.practiceName}
                {e.specialty ? ` — ${e.specialty}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rff-urgency">How soon</Label>
          <select
            id="rff-urgency"
            className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={s.urgency}
            onChange={(e) => set("urgency", e.target.value as TcReferralUrgency)}
            disabled={saving}
          >
            {TcReferralUrgency.options.map((u) => (
              <option key={u} value={u}>
                {TC_REFERRAL_URGENCY_LABELS[u]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rff-teeth">Teeth</Label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              id="rff-teeth"
              value={s.teeth}
              disabled={s.wholeMouth || saving}
              onChange={(e) => set("teeth", e.target.value)}
              placeholder="3, 14"
            />
            <input
              id="rff-mouth"
              type="checkbox"
              checked={s.wholeMouth}
              disabled={saving}
              onChange={(e) => set("wholeMouth", e.target.checked)}
            />
            <Label htmlFor="rff-mouth" className="whitespace-nowrap">
              Whole mouth
            </Label>
          </div>
        </div>
        <div className="sm:col-span-2 space-y-1">
          <Label htmlFor="rff-reason">Reason *</Label>
          <Input id="rff-reason" value={s.reason} disabled={saving} onChange={(e) => set("reason", e.target.value)} />
        </div>
        {withDoctorNote && (
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="rff-dnote">Doctor's note</Label>
            <Textarea
              id="rff-dnote"
              rows={3}
              maxLength={TC_REFERRAL_DOCTOR_NOTE_MAX}
              value={s.doctorNote}
              disabled={saving}
              onChange={(e) => set("doctorNote", e.target.value)}
              placeholder="Anything the specialist should hear from you"
            />
          </div>
        )}
      </div>
      {(error || serverError) && <p className="text-sm text-destructive">{error ?? serverError}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />} {saveLabel}
        </Button>
      </div>
    </div>
  );
}
