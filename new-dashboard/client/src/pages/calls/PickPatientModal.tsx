/**
 * Pick Patient modal (Slice B) — resolve a needs-review call to an Open Dental
 * patient, or close it out as "not a patient".
 *
 * Stored match candidates (from Slice A) are shown first for one-click linking;
 * an OD patient search covers everything else. Confirming a patient calls the
 * idempotent resolve endpoint (writes the CareIN commlog exactly once).
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, UserCheck, Ban, Loader2 } from "lucide-react";
import { api, type UnifiedCall, type OdPatient, type NotAPatientReason } from "@/lib/api";
import { toast } from "sonner";

const NOT_A_PATIENT_REASONS: { value: NotAPatientReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "solicitor", label: "Solicitor" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "other", label: "Other" },
];

interface PickPatientModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  /** Called after a successful resolve/close-out so the row can update optimistically. */
  onResolved: (result: { kind: "patient"; patientId: number } | { kind: "not_patient"; reason: NotAPatientReason }) => void;
}

export function PickPatientModal({ open, onOpenChange, call, onResolved }: PickPatientModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OdPatient[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingId, setSubmittingId] = useState<number | "not_patient" | null>(null);
  const [reason, setReason] = useState<NotAPatientReason>("spam");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset transient state whenever the modal opens for a (possibly different) call.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSearching(false);
      setSubmittingId(null);
      setReason("spam");
    }
  }, [open, call.id]);

  // Debounced OD patient search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const patients = await api.searchPatients(query);
      setResults(patients);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const resolveToPatient = async (patientId: number, label: string) => {
    setSubmittingId(patientId);
    try {
      const res = await api.resolvePatient(call.id, { patientId });
      if (res.success) {
        toast.success(res.alreadySynced ? `Already linked to ${label}` : `Linked to ${label} · commlog written`);
        onResolved({ kind: "patient", patientId });
        onOpenChange(false);
      } else {
        toast.error("Could not link patient");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link patient");
    } finally {
      setSubmittingId(null);
    }
  };

  const closeAsNotPatient = async () => {
    setSubmittingId("not_patient");
    try {
      const res = await api.resolvePatient(call.id, { notAPatient: true, reason });
      if (res.success) {
        toast.success("Closed out — not a patient");
        onResolved({ kind: "not_patient", reason });
        onOpenChange(false);
      } else {
        toast.error("Could not close out call");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close out call");
    } finally {
      setSubmittingId(null);
    }
  };

  const candidates = call.odMatchCandidates ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match patient</DialogTitle>
          <DialogDescription>
            {call.patientName} · <span className="font-mono">{call.fromNumber}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Stored candidates — one-click pick */}
          {candidates.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Suggested ({candidates.length})
              </div>
              <div className="space-y-1.5">
                {candidates.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{c.name}</div>
                      <div className="text-xs font-mono text-muted-foreground">PatNum {c.id}</div>
                    </div>
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 text-xs flex-shrink-0"
                      disabled={submittingId !== null}
                      onClick={() => resolveToPatient(c.id, c.name)}
                    >
                      {submittingId === c.id ? <Loader2 size={12} className="animate-spin" /> : <UserCheck size={12} />}
                      Use
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* OD patient search */}
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Search Open Dental
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Last name, first name, or phone…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
            </div>

            <div className="mt-2 max-h-56 overflow-y-auto space-y-1.5">
              {searching ? (
                <div className="text-center py-4 text-xs text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 size={13} className="animate-spin" /> Searching…
                </div>
              ) : query.trim().length >= 2 && results.length === 0 ? (
                <div className="text-center py-4 text-xs text-muted-foreground">No patients found.</div>
              ) : (
                results.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{p.fullName}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        <span className="font-mono">PatNum {p.id}</span>
                        {p.dateOfBirth && <> · DOB {p.dateOfBirth}</>}
                        {p.phone && <> · <span className="font-mono">{p.phone}</span></>}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs flex-shrink-0"
                      disabled={submittingId !== null}
                      onClick={() => resolveToPatient(p.id, p.fullName)}
                    >
                      {submittingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <UserCheck size={12} />}
                      Use
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Not-a-patient close-out */}
          <div className="border-t pt-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Not a patient?
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label="Not-a-patient reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as NotAPatientReason)}
                className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {NOT_A_PATIENT_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5 text-xs"
                disabled={submittingId !== null}
                onClick={closeAsNotPatient}
              >
                {submittingId === "not_patient" ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
                Close out
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
