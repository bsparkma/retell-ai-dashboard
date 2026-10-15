/**
 * Settings → Referrals (queue item 52, R1).
 *
 * Two things, for the front desk:
 *  - the SPECIALIST DIRECTORY: the 15–20 offices this practice refers to. Add,
 *    edit, mark inactive, delete one nobody has referred to yet. A simple
 *    form; the email is checked before it is sent and again by the server.
 *  - the two REFERRAL POLICIES for this office: Dr. sign-off required, and
 *    auto-send on approval. A practice admin changes them; everyone else sees
 *    what is in force and why.
 *
 * NOTHING SENDS from here, and nothing here reads or writes Open Dental.
 * Every row shown is what the server returned after it stored the change.
 * The section only appears when referrals is switched on for the office
 * (TcSettings asks /status first).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import {
  createDirectoryEntry,
  deleteDirectoryEntry,
  getReferralSettings,
  listDirectory,
  updateDirectoryEntry,
  updateReferralSettings,
} from "@/features/tc/referrals/referralsApi";
import type { OfficeId } from "@shared/tc/contract";
import {
  TcReferralDirectoryInput,
  type TcReferralDirectoryEntry,
  type TcReferralPolicy,
  type TcReferralSettingsResponse,
} from "@shared/tc/referrals";

// ── The form ────────────────────────────────────────────────────────────────

interface Draft {
  practiceName: string;
  specialistName: string;
  specialty: string;
  contactPerson: string;
  email: string;
  phone: string;
  fax: string;
  notes: string;
  preferredFormatNotes: string;
  active: boolean;
}

const EMPTY: Draft = {
  practiceName: "",
  specialistName: "",
  specialty: "",
  contactPerson: "",
  email: "",
  phone: "",
  fax: "",
  notes: "",
  preferredFormatNotes: "",
  active: true,
};

function draftOf(e: TcReferralDirectoryEntry): Draft {
  return {
    practiceName: e.practiceName,
    specialistName: e.specialistName,
    specialty: e.specialty,
    contactPerson: e.contactPerson,
    email: e.email,
    phone: e.phone,
    fax: e.fax,
    notes: e.notes,
    preferredFormatNotes: e.preferredFormatNotes,
    active: e.active,
  };
}

type FieldErrors = Partial<Record<keyof Draft, string>>;

/** The same schema the server applies, so a typo is caught before the round trip. */
function validate(d: Draft): { ok: true; input: TcReferralDirectoryInput } | { ok: false; errors: FieldErrors } {
  const parsed = TcReferralDirectoryInput.safeParse(d);
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && key in EMPTY && !errors[key as keyof Draft]) {
      errors[key as keyof Draft] = issue.message;
    }
  }
  return { ok: false, errors };
}

const TEXT_FIELDS: { key: Exclude<keyof Draft, "active" | "notes" | "preferredFormatNotes">; label: string; type?: string; required?: boolean }[] = [
  { key: "practiceName", label: "Practice name", required: true },
  { key: "specialistName", label: "Specialist" },
  { key: "specialty", label: "Specialty" },
  { key: "contactPerson", label: "Contact person" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "fax", label: "Fax", type: "tel" },
];

function EntryDialog({
  open,
  editing,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  editing: TcReferralDirectoryEntry | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: TcReferralDirectoryInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (open) {
      setDraft(editing ? draftOf(editing) : EMPTY);
      setErrors({});
    }
  }, [open, editing]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit() {
    const v = validate(draft);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    onSave(v.input);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent className="max-w-xl" data-testid="tc-referral-entry-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit specialist" : "Add a specialist"}</DialogTitle>
          <DialogDescription>Only the practice name is required. Fill in what you know.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TEXT_FIELDS.map(({ key, label, type, required }) => (
            <div key={key} className={key === "practiceName" ? "sm:col-span-2 space-y-1" : "space-y-1"}>
              <Label htmlFor={`ref-${key}`}>
                {label}
                {required ? " *" : ""}
              </Label>
              <Input
                id={`ref-${key}`}
                type={type ?? "text"}
                value={draft[key]}
                onChange={(e) => set(key, e.target.value)}
                aria-invalid={errors[key] ? true : undefined}
              />
              {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
            </div>
          ))}
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="ref-preferredFormatNotes">How they like referrals</Label>
            <Textarea
              id="ref-preferredFormatNotes"
              rows={2}
              placeholder="e.g. PDF with the periapical X-ray"
              value={draft.preferredFormatNotes}
              onChange={(e) => set("preferredFormatNotes", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="ref-notes">Notes</Label>
            <Textarea id="ref-notes" rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>
          <div className="sm:col-span-2 flex items-center gap-2">
            <Switch
              id="ref-active"
              checked={draft.active}
              onCheckedChange={(v) => set("active", v)}
            />
            <Label htmlFor="ref-active">Active (shows up when choosing a specialist)</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? "Save changes" : "Add specialist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The policies ────────────────────────────────────────────────────────────

function policyNote(p: TcReferralPolicy): string {
  if (p.source === "env") return "Locked by a safety setting";
  if (p.source === "office") return "Set for this office";
  return "Default";
}

function PolicyRow({
  id,
  label,
  help,
  policy,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  policy: TcReferralPolicy;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{help}</p>
        <p className="text-[11px] text-muted-foreground">{policyNote(policy)}</p>
      </div>
      <Switch
        id={id}
        checked={policy.value}
        disabled={disabled || policy.source === "env"}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

// ── The section ─────────────────────────────────────────────────────────────

export function ReferralsSection({ office }: { office: OfficeId }) {
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[] | null>(null);
  const [settings, setSettings] = useState<TcReferralSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TcReferralDirectoryEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<TcReferralDirectoryEntry | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([listDirectory(office, showInactive), getReferralSettings(office)])
      .then(([list, s]) => {
        setEntries(list);
        setSettings(s);
      })
      .catch((e: unknown) => setError(tcErrorMessage(e)));
  }, [office, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(input: TcReferralDirectoryInput) {
    setSaving(true);
    try {
      if (editing) {
        await updateDirectoryEntry(office, editing.entryId, input);
        toast.success("Specialist saved");
      } else {
        await createDirectoryEntry(office, input);
        toast.success("Specialist added");
      }
      setDialogOpen(false);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await deleteDirectoryEntry(office, deleting.entryId);
      toast.success("Specialist deleted");
      setDeleting(null);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function changePolicy(change: { signoffRequired?: boolean; autosendOnApproval?: boolean }) {
    setPolicyBusy(true);
    try {
      setSettings(await updateReferralSettings(office, change));
      toast.success("Referral settings saved");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setPolicyBusy(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="tc-referrals-section">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-4 h-4 mr-1" aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  if (!entries || !settings) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground" data-testid="tc-referrals-section">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="text-sm">Loading referrals…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="tc-referrals-section">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Referral settings</CardTitle>
          <p className="text-xs text-muted-foreground">
            {settings.canEdit
              ? "For this office."
              : "For this office. Only a practice admin can change these."}{" "}
            Nothing is sent from here yet.
          </p>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <PolicyRow
            id="ref-signoff"
            label="Doctor signs off before a referral goes out"
            help="A referral waits for the doctor's approval before it can be sent."
            policy={settings.signoffRequired}
            disabled={!settings.canEdit || policyBusy}
            onChange={(v) => void changePolicy({ signoffRequired: v })}
          />
          <PolicyRow
            id="ref-autosend"
            label="Send automatically once approved"
            help="Off: someone presses Send after approval. (Sending ships in a later update.)"
            policy={settings.autosendOnApproval}
            disabled={!settings.canEdit || policyBusy}
            onChange={(v) => void changePolicy({ autosendOnApproval: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">Specialist directory</CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch id="ref-show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
                <Label htmlFor="ref-show-inactive" className="text-xs">
                  Show inactive
                </Label>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="w-4 h-4" />
                Add specialist
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">The offices this practice refers patients to.</p>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No specialists yet. Add the offices you refer to, one at a time.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Practice</TableHead>
                  <TableHead>Specialist</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.entryId} data-testid="tc-referral-entry">
                    <TableCell className="font-medium">{e.practiceName}</TableCell>
                    <TableCell>{e.specialistName || "—"}</TableCell>
                    <TableCell>{e.specialty || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[e.contactPerson, e.phone, e.email].filter(Boolean).join(" · ") || "—"}
                    </TableCell>
                    <TableCell>
                      {e.active ? (
                        <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${e.practiceName}`}
                        onClick={() => {
                          setEditing(e);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${e.practiceName}`}
                        onClick={() => setDeleting(e)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <EntryDialog
        open={dialogOpen}
        editing={editing}
        saving={saving}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={(input) => void save(input)}
      />

      <Dialog open={deleting !== null} onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}>
        <DialogContent data-testid="tc-referral-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.practiceName}?</DialogTitle>
            <DialogDescription>
              This removes the specialist from the directory. If a referral already names them, it
              can't be deleted. Mark them inactive instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={saving}>
              Keep
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={saving}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
