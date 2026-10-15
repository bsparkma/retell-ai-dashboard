/**
 * Referrals on a TC case, or on a checkout (queue item 53, R2).
 *
 * ONE component for both places, the way the checkout sidebar is one
 * component for the row and the toast:
 *  - on the case page: the case's referrals, "New referral", and each one's
 *    next step (Submit for sign-off / Withdraw / Cancel / Edit a draft);
 *  - in the checkout sidebar (`compact`): the chip item 50 left as a
 *    placeholder goes live — None / Staged / Pending Dr. sign-off / Approved —
 *    with "Start referral" beside it.
 *
 * The PATIENT is never chosen here: the server takes it from the case or the
 * checkout. NOTHING SENDS: an approved referral says so honestly. Every state
 * shown is what the server answered after it stored the change. Dark while
 * referrals is off for the office (compact mode keeps the old "None" line, so
 * the sidebar reads the same as before).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import {
  createReferral,
  getReferralsStatus,
  listDirectory,
  listReferrals,
  referralVerb,
  updateReferral,
} from "@/features/tc/referrals/referralsApi";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_CHIP_LABELS,
  TC_REFERRAL_STATUS_LABELS,
  TC_REFERRAL_URGENCY_LABELS,
  TcReferralInput,
  TcReferralUrgency,
  referralChipFor,
  type TcReferral,
  type TcReferralDirectoryEntry,
  type TcReferralStatus,
  type TcReferralTeeth,
} from "@shared/tc/referrals";

type Source = { caseId: string } | { handoffId: string };

const STATUS_TONE: Partial<Record<TcReferralStatus, string>> = {
  draft: "bg-muted text-foreground",
  pending_signoff: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  declined: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function ReferralStatusBadge({ status }: { status: TcReferralStatus }) {
  return (
    <Badge variant="outline" className={`border-transparent ${STATUS_TONE[status] ?? ""}`} data-testid="tc-referral-status">
      {TC_REFERRAL_STATUS_LABELS[status]}
    </Badge>
  );
}

/** "#3, #14" / "Whole mouth" / "" */
export function teethLabel(t: TcReferralTeeth): string {
  if (t === "mouth") return "Whole mouth";
  return t.length ? `#${t.join(", #")}` : "";
}

// ── The form ────────────────────────────────────────────────────────────────

interface Draft {
  directoryEntryId: string;
  referringProvider: string;
  specialty: string;
  reason: string;
  teeth: string;
  wholeMouth: boolean;
  urgency: TcReferralUrgency;
  narrative: string;
}

function draftOf(r: TcReferral | null): Draft {
  return {
    directoryEntryId: r?.directoryEntryId ?? "",
    referringProvider: r?.referringProvider ?? "",
    specialty: r?.specialty ?? "",
    reason: r?.reason ?? "",
    teeth: r && r.teeth !== "mouth" ? r.teeth.join(", ") : "",
    wholeMouth: r?.teeth === "mouth",
    urgency: r?.urgency ?? "routine",
    narrative: r?.narrative ?? "",
  };
}

/** "3, 14" → [3, 14]; anything not a tooth 1–32 is an error, not a guess. */
function parseTeeth(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).map((p) => p.replace(/^#/, "")).filter(Boolean);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 32)) return null;
  return nums;
}

function ReferralDialog({
  office,
  open,
  editing,
  onClose,
  onSave,
  saving,
}: {
  office: OfficeId;
  open: boolean;
  editing: TcReferral | null;
  onClose: () => void;
  onSave: (input: TcReferralInput, submit: boolean) => void;
  saving: boolean;
}) {
  const [d, setD] = useState<Draft>(draftOf(null));
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setD(draftOf(editing));
    setError(null);
    listDirectory(office, false)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [open, editing, office]);

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setD((x) => ({ ...x, [k]: v }));
    setError(null);
  }

  function pickEntry(id: string) {
    const e = entries.find((x) => x.entryId === id);
    setD((x) => ({ ...x, directoryEntryId: id, specialty: x.specialty || e?.specialty || "" }));
  }

  function save(submit: boolean) {
    const teeth: TcReferralTeeth | null = d.wholeMouth ? "mouth" : parseTeeth(d.teeth);
    if (teeth === null) {
      setError("Teeth are numbers 1–32, separated by commas");
      return;
    }
    const parsed = TcReferralInput.safeParse({
      directoryEntryId: d.directoryEntryId || null,
      referringProvider: d.referringProvider,
      specialty: d.specialty,
      reason: d.reason,
      teeth,
      urgency: d.urgency,
      narrative: d.narrative,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    onSave(parsed.data, submit);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-xl" data-testid="tc-referral-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit referral" : "New referral"}</DialogTitle>
          <DialogDescription>
            The patient comes from this {editing?.sourceKind === "checkout" ? "checkout" : "record"}. Nothing is sent from here.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="rf-entry">Specialist</Label>
            <select
              id="rf-entry"
              className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={d.directoryEntryId}
              onChange={(e) => pickEntry(e.target.value)}
            >
              <option value="">Choose later</option>
              {entries.map((e) => (
                <option key={e.entryId} value={e.entryId}>
                  {e.practiceName}
                  {e.specialty ? ` — ${e.specialty}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rf-specialty">Specialty</Label>
            <Input id="rf-specialty" value={d.specialty} onChange={(e) => set("specialty", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rf-urgency">How soon</Label>
            <select
              id="rf-urgency"
              className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={d.urgency}
              onChange={(e) => set("urgency", e.target.value as TcReferralUrgency)}
            >
              {TcReferralUrgency.options.map((u) => (
                <option key={u} value={u}>
                  {TC_REFERRAL_URGENCY_LABELS[u]}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="rf-reason">Reason *</Label>
            <Input id="rf-reason" value={d.reason} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. Possible cracked tooth, endo evaluation" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rf-teeth">Teeth</Label>
            <Input id="rf-teeth" value={d.teeth} disabled={d.wholeMouth} onChange={(e) => set("teeth", e.target.value)} placeholder="3, 14" />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <input
              id="rf-mouth"
              type="checkbox"
              checked={d.wholeMouth}
              onChange={(e) => set("wholeMouth", e.target.checked)}
            />
            <Label htmlFor="rf-mouth">Whole mouth</Label>
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="rf-provider">Referring provider</Label>
            <Input id="rf-provider" value={d.referringProvider} onChange={(e) => set("referringProvider", e.target.value)} />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="rf-narrative">Notes for the specialist</Label>
            <Textarea id="rf-narrative" rows={3} value={d.narrative} onChange={(e) => set("narrative", e.target.value)} />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => save(false)} disabled={saving}>
            Save draft
          </Button>
          <Button onClick={() => save(true)} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save &amp; submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

export interface ReferralsPanelProps {
  office: OfficeId;
  source: Source;
  /** The checkout sidebar: a chip line and a Start button, no full list. */
  compact?: boolean;
}

export function ReferralsPanel({ office, source, compact = false }: ReferralsPanelProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [referrals, setReferrals] = useState<TcReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TcReferral | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const sourceKey = "caseId" in source ? `case:${source.caseId}` : `checkout:${source.handoffId}`;

  const load = useCallback(() => {
    setError(null);
    listReferrals(office, source)
      .then(setReferrals)
      .catch((e: unknown) => setError(tcErrorMessage(e)));
    // `source` is described by sourceKey.
  }, [office, sourceKey]);

  useEffect(() => {
    let cancelled = false;
    getReferralsStatus(office)
      .then((s) => {
        if (cancelled) return;
        setEnabled(s.enabled);
        if (s.enabled) load();
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [office, load]);

  async function save(input: TcReferralInput, submit: boolean) {
    setSaving(true);
    try {
      const saved = editing
        ? await updateReferral(office, editing.referralId, input)
        : await createReferral(office, source, input);
      if (submit) {
        const moved = await referralVerb(office, saved.referralId, "submit");
        toast.success(moved.status === "approved" ? "Referral approved (sign-off not required)" : "Sent for the doctor's sign-off");
      } else {
        toast.success("Referral saved as a draft");
      }
      setDialogOpen(false);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
      load();
    } finally {
      setSaving(false);
    }
  }

  async function verb(r: TcReferral, v: "submit" | "withdraw" | "cancel") {
    setBusy(`${r.referralId}:${v}`);
    try {
      await referralVerb(office, r.referralId, v);
      toast.success(v === "submit" ? "Submitted" : v === "withdraw" ? "Back to draft" : "Referral cancelled");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(null);
      load();
    }
  }

  const dialog = (
    <ReferralDialog
      office={office}
      open={dialogOpen}
      editing={editing}
      saving={saving}
      onClose={() => {
        setDialogOpen(false);
        setEditing(null);
      }}
      onSave={(input, submit) => void save(input, submit)}
    />
  );

  if (compact) {
    const chip = enabled && referrals ? referralChipFor(referrals) : "none";
    return (
      <section
        className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border p-2.5 text-sm"
        data-testid="checkout-referral"
      >
        <span className="text-muted-foreground">Referral</span>
        <span className="flex items-center gap-2">
          <span data-testid="checkout-referral-chip">{TC_REFERRAL_CHIP_LABELS[chip]}</span>
          {enabled && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Send className="w-3.5 h-3.5" /> Start referral
            </Button>
          )}
        </span>
        {enabled && dialog}
      </section>
    );
  }

  if (!enabled) return null;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid="tc-case-referrals">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Referrals</h3>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="w-4 h-4" /> New referral
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {referrals && referrals.length === 0 && <p className="text-sm text-muted-foreground">No referrals for this patient yet.</p>}
      {referrals?.map((r) => (
        <div key={r.referralId} className="rounded-lg border border-border p-3 space-y-1" data-testid="tc-referral-row">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-medium text-foreground">{r.practiceName ?? "No specialist chosen yet"}</span>
            <ReferralStatusBadge status={r.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {[r.specialty, teethLabel(r.teeth), TC_REFERRAL_URGENCY_LABELS[r.urgency]].filter(Boolean).join(" · ")}
          </p>
          <p className="text-sm text-foreground">{r.reason}</p>
          {r.status === "approved" && (
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{REFERRAL_READY_TO_SEND_COPY}</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {r.status === "draft" && (
              <>
                <Button size="sm" onClick={() => void verb(r, "submit")} disabled={busy !== null}>
                  Submit for sign-off
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(r);
                    setDialogOpen(true);
                  }}
                >
                  Edit
                </Button>
              </>
            )}
            {r.status === "pending_signoff" && (
              <Button size="sm" variant="outline" onClick={() => void verb(r, "withdraw")} disabled={busy !== null}>
                Withdraw to edit
              </Button>
            )}
            {(r.status === "draft" || r.status === "pending_signoff") && (
              <Button size="sm" variant="ghost" onClick={() => void verb(r, "cancel")} disabled={busy !== null}>
                Cancel referral
              </Button>
            )}
          </div>
        </div>
      ))}
      {dialog}
    </section>
  );
}
