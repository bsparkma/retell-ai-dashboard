/**
 * Pick Patient modal (Slice B) — resolve a needs-review call to an Open Dental
 * patient, or close it out as "not a patient".
 *
 * Stored match candidates (from Slice A) are shown first for one-click linking;
 * an OD patient search covers everything else.
 *
 * Linking establishes WHO called and writes NOTHING to the chart. It used to be
 * welded to the chart note — the only way to set a patient was to file a commlog
 * in the same request — so every match, including one made just to identify a
 * caller or to hand the call to TC, forced a note into someone's chart. The call
 * lands in 'matched', where "Send to chart" and "Send to TC" are independent,
 * optional next steps.
 *
 * WHICH PRACTICE'S PATIENTS
 * -------------------------
 * The search used to be locked to the office the call rang at. That is right for
 * almost every call and wrong for the one that matters: the front desk at one
 * practice takes a call about the other practice's patient, the patient is simply
 * not in the list, and the call cannot be resolved to anyone at all.
 *
 * So the office is a choice. Two things keep it honest:
 *
 *   - Switching offices clears the results AND hides the stored suggestions. Those
 *     candidates were matched in the call's own database, and a PatNum means a
 *     different person in the other one — offering them under a new office name is
 *     how the wrong record gets picked.
 *   - When the office being searched is not the office the call rang at, the modal
 *     says so, in words, for as long as it is true.
 *
 * The link then stores the office alongside the PatNum, because a PatNum without
 * its database does not identify a person.
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, UserCheck, Ban, Loader2, Building2, AlertTriangle } from "lucide-react";
import { api, normalizeUnifiedCall, type UnifiedCall, type OdPatient, type NotAPatientReason, type OfficeConfig } from "@/lib/api";
import { ChartOfficeSelect, CrossOfficeNotice, officeNameOf } from "./ChartOfficeSelect";
import { toast } from "sonner";

const NOT_A_PATIENT_REASONS: { value: NotAPatientReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "solicitor", label: "Solicitor" },
  { value: "vendor", label: "Vendor" },
  { value: "lab", label: "Lab" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "other", label: "Other" },
];

interface PickPatientModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  /**
   * The patient was LINKED — the match is persisted and nothing was written to
   * any chart. `updated` is the server's complete post-link call record; the call
   * is now 'matched', where "Send to chart" and "Send to TC" are separate,
   * optional next steps.
   */
  onLinked: (updated: UnifiedCall) => void;
  /** Closed out as not-a-patient (already persisted; no OD write). */
  onNotPatient: (reason: NotAPatientReason) => void;
}

export function PickPatientModal({ open, onOpenChange, call, onLinked, onNotPatient }: PickPatientModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OdPatient[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // The office whose patient list is being searched, as reported by the server.
  const [office, setOffice] = useState<OfficeConfig | null>(null);
  // Every office this tenant has, for the search-office picker.
  const [offices, setOffices] = useState<OfficeConfig[]>([]);
  // Which office to search. Starts at the call's own — the ordinary case, and the
  // only one that needs no thought — and is changed only deliberately.
  const [searchOffice, setSearchOffice] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<number | "not_patient" | null>(null);
  const [reason, setReason] = useState<NotAPatientReason>("spam");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset transient state whenever the modal opens for a (possibly different) call.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSearching(false);
      setSearchError(null);
      setOffice(null);
      setSearchOffice(call.officeId ?? null);
      setSubmittingId(null);
      setReason("spam");
      // Tenant configuration, so its own request rather than a field on every
      // search response. Failing to load it leaves the modal working exactly as
      // it did before there was a picker: the call's own office, no choice.
      api.getOffices().then(setOffices).catch(() => setOffices([]));
    }
  }, [open, call.id, call.officeId]);

  // Debounced OD patient search, in the CHOSEN office. Still call-scoped on the
  // server — the office is validated against the registry there, so this asks for
  // one of a known set rather than naming any database it likes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const { patients, office: searchedOffice, error } = await api.searchPatientsForCall(
        call.id, query, searchOffice ?? undefined,
      );
      setResults(patients);
      setSearchError(error ?? null);
      if (searchedOffice) setOffice(searchedOffice);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, call.id, searchOffice]);

  /**
   * Search a different practice's patients.
   *
   * Everything on screen that came from the previous office goes: results are rows
   * from another database, and a PatNum shown under the wrong office name is how
   * someone links a call to a stranger who happens to hold that number.
   */
  const changeSearchOffice = (officeId: string) => {
    if (officeId === searchOffice) return;
    setSearchOffice(officeId);
    setQuery("");
    setResults([]);
    setSearchError(null);
    setSearching(false);
    setOffice(null);
  };

  /**
   * Link the call to this patient. This establishes WHO called and nothing else —
   * no chart note is written. Identifying the caller and filing a note about the
   * call are two decisions, and this modal now only makes the first one; the
   * matched row then offers "Send to chart" and "Send to TC" independently.
   */
  const linkPatient = async (patientId: number, label: string) => {
    setSubmittingId(patientId);
    try {
      const res = await api.resolvePatient(call.id, {
        patientId,
        linkOnly: true,
        // The office this PatNum was found in — both as the target the server
        // should verify and store it against, and as the assertion it checks that
        // choice against. target_office selects; office_id can only refuse. Sending
        // both means a request that loses the choice in transit is rejected rather
        // than quietly linked against whichever office the server defaulted to.
        ...(searchOffice ? { target_office: searchOffice, office_id: searchOffice } : {}),
      });
      if (res.success && res.call) {
        toast.success(`Linked to ${label}`);
        onLinked(normalizeUnifiedCall(res.call));
        onOpenChange(false);
      } else {
        toast.error("Could not link this patient", { duration: 8000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link patient", { duration: 8000 });
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
        onNotPatient(reason);
        onOpenChange(false);
      } else {
        toast.error("Could not close out call", { duration: 8000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close out call", { duration: 8000 });
    } finally {
      setSubmittingId(null);
    }
  };

  const callOfficeId = call.officeId ?? null;
  const crossOffice = !!searchOffice && !!callOfficeId && searchOffice !== callOfficeId;
  const searchOfficeName = office?.officeName ?? officeNameOf(offices, searchOffice);

  // The stored candidates were matched in the CALL's own Open Dental. Their PatNums
  // mean a different person in the other practice's database, so they are shown only
  // while that is the database being searched — hidden, not greyed out, because a
  // suggestion nobody should act on is not a suggestion.
  const candidates = crossOffice ? [] : (call.odMatchCandidates ?? []);

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
                      onClick={() => linkPatient(c.id, c.name)}
                    >
                      {submittingId === c.id
                        ? <><Loader2 size={12} className="animate-spin" /> Linking…</>
                        : <><UserCheck size={12} /> Link</>}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* OD patient search — always says WHICH practice is being searched, so a
              wrong-office moment is visible before anyone picks a patient, and lets
              that practice be changed when the caller belongs to the other one. */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Search Open Dental
              </div>
              {office && !crossOffice && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                  <Building2 size={12} className="flex-shrink-0" />
                  <span className="truncate">Searching {office.officeName} patients</span>
                </div>
              )}
            </div>

            <div className="mb-2 space-y-2">
              <ChartOfficeSelect
                offices={offices}
                value={searchOffice}
                onChange={changeSearchOffice}
                callOfficeId={callOfficeId}
                disabled={submittingId !== null}
                purpose="patients"
                testId="search-office-select"
              />
              <CrossOfficeNotice
                offices={offices}
                callOfficeId={callOfficeId}
                targetOfficeId={searchOffice}
                purpose="patients"
              />
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
              ) : searchError ? (
                // A failed search must never read as "no such patient" — that would
                // invite someone to create a duplicate, or pick the wrong record.
                <div className="flex items-start gap-2 py-3 px-2 text-xs text-destructive">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                  <span>{searchError}</span>
                </div>
              ) : query.trim().length >= 2 && results.length === 0 ? (
                <div className="text-center py-4 text-xs text-muted-foreground">
                  No patients found{searchOfficeName ? ` in ${searchOfficeName}` : ""}.
                </div>
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
                      onClick={() => linkPatient(p.id, p.fullName)}
                    >
                      {submittingId === p.id
                        ? <><Loader2 size={12} className="animate-spin" /> Linking…</>
                        : <><UserCheck size={12} /> Link</>}
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
