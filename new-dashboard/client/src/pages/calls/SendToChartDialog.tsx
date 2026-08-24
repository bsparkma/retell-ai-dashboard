/**
 * Send to Chart dialog (Slice B.1 — review-then-send, with editable notes).
 *
 * The single "review/edit → send" surface for EVERY path to the chart: an
 * auto-matched call (patient known) and the Pick Patient flow (patient just
 * chosen) both land here. The generated note is pre-filled into an editable
 * textarea; what the user sends is exactly what's written (server sanitizes for
 * OD). "Reset to generated" restores the original. Nothing is written until Send.
 *
 * CROSS-OFFICE TARGET
 * -------------------
 * The chart this note lands in is normally the office the call rang at, and for
 * almost every send it still is. But a call about one practice's patient can ring
 * at the other, and welding the chart to the call's office meant those calls could
 * not be charted at all. So the office is a choice here, with three rules that make
 * it safe to be one:
 *
 *   1. A PatNum belongs to exactly ONE Open Dental database. 7115 is the valley
 *      test patient and a different real person in Roland. So changing the office
 *      CLEARS the patient — carrying a PatNum across practices would file the note
 *      on whoever happens to hold that number over there. The dialog then searches
 *      the new office for the patient instead of guessing.
 *   2. When the target differs from the call's office, the dialog says so in words,
 *      persistently, and the confirm button names the practice being written to.
 *   3. The call's own office is never touched. It is the call's identity — the
 *      worklists, the filters and the analytics all still read it, unchanged.
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Send, Loader2, RotateCcw, Search, UserCheck, AlertTriangle } from "lucide-react";
import {
  api, normalizeUnifiedCall,
  type UnifiedCall, type OfficeConfig, type CommlogTypeCatalogue, type OdPatient,
} from "@/lib/api";
import {
  ChartOfficeSelect, CrossOfficeNotice, SameOfficeLine, officeNameOf,
} from "./ChartOfficeSelect";
import { toast } from "sonner";

interface SendToChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  /** The patient to write to (matched patient, or the one just picked). */
  patientId: number;
  patientName: string;
  /**
   * The send succeeded. `updated` is the server's COMPLETE post-send call record
   * (normalized), or null when the response carried none. Render from it rather
   * than patching the fields you think changed: the send also sets
   * od_patient_name, which "Send to TC" visibility depends on, and a hand-rolled
   * patch that forgets it leaves that button disabled until a page refresh.
   */
  onSent: (updated: UnifiedCall | null) => void;
  /**
   * What to write (item 4): 'summary' (compact block, default) or 'transcript'
   * (full transcript — a large note, the user's deliberate choice). The contextual
   * buttons on the call-detail page set this; the worklist-row Send omits it (summary).
   */
  contentType?: "summary" | "transcript";
}

/** A patient chosen inside this dialog, tagged with the office they were found in. */
type PickedPatient = { id: number; name: string; office: string };

export function SendToChartDialog({ open, onOpenChange, call, patientId, patientName, onSent, contentType = "summary" }: SendToChartDialogProps) {
  const [generated, setGenerated] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);
  // Which practice's chart this note is headed for, per the server.
  const [office, setOffice] = useState<OfficeConfig | null>(null);
  // The chart-note types THIS office offers, and which one is selected. Both
  // come from the server's preview response, so the list belongs to the same
  // office the note is headed for — a DefNum from anywhere else is meaningless.
  const [types, setTypes] = useState<CommlogTypeCatalogue | null>(null);
  const [typeDefNum, setTypeDefNum] = useState<number | null>(null);

  // ── The chart target ──────────────────────────────────────────────────────
  // `chosenTarget` stays null until the user picks: the SERVER owns the default
  // (the office the linked patient is in, else the call's own) and the dialog
  // renders whatever it says. Keeping "nothing chosen yet" distinct from "chose
  // the default" is what stops the preview fetch from re-triggering itself, and
  // saves the client from re-deriving a default the server already decided.
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  const [offices, setOffices] = useState<OfficeConfig[]>([]);
  // The office the PROP patient's PatNum lives in — learned from the first preview,
  // since the server resolves it from the stored link.
  const [propPatientOffice, setPropPatientOffice] = useState<string | null>(null);
  // A patient found by searching inside this dialog, after switching offices.
  const [picked, setPicked] = useState<PickedPatient | null>(null);

  // ── The in-dialog patient search (only reachable after switching offices) ──
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OdPatient[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const callOfficeId = call.officeId ?? null;
  const target = chosenTarget ?? office?.officeId ?? null;

  /**
   * WHO this send writes to, right now.
   *
   * A PatNum is only meaningful in the database it came from, so the prop patient
   * counts only while the target is still their office. Switch away and there is
   * genuinely no patient selected until one is found over there; switch back and
   * they return, because nothing about them changed.
   */
  const activePatient: { id: number; name: string } | null =
    picked && picked.office === target
      ? { id: picked.id, name: picked.name }
      : propPatientOffice && target === propPatientOffice && patientId
        ? { id: patientId, name: patientName }
        : null;
  const activePatientId = activePatient?.id ?? null;

  useEffect(() => {
    if (!open) return;
    setChosenTarget(null);
    setPropPatientOffice(null);
    setPicked(null);
    setQuery("");
    setResults([]);
    setSearchError(null);
    // The roster the selector offers. Its own request rather than a field on the
    // preview: it is tenant configuration, identical for every call, and failing to
    // load it must leave the dialog fully usable on the server's default office.
    api.getOffices().then(setOffices).catch(() => setOffices([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setGenerated(null);
    setText("");
    setOffice(null);
    setTypes(null);
    setTypeDefNum(null);
    setLoadingPreview(true);
    let cancelled = false;
    api.getCommlogPreview(call.id, contentType, chosenTarget ?? undefined)
      .then((res) => {
        if (cancelled) return;
        setGenerated(res.note);
        setText(res.note);
        setOffice(res.office ?? null);
        setTypes(res.commlogTypes ?? null);
        // Preselect the office default: the picker changes nothing unless the
        // user deliberately picks something else.
        setTypeDefNum(res.commlogTypes?.defaultDefNum ?? null);
        // The first preview (nothing chosen yet) is what tells us which office the
        // STORED patient link belongs to. Recorded once: a later preview answers a
        // question about some other office, not about the stored patient.
        setPropPatientOffice((prev) => prev ?? res.office?.officeId ?? null);
      })
      .catch(() => { if (!cancelled) { setGenerated(null); setText(""); } })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [open, call.id, contentType, chosenTarget]);

  // Debounced patient search in the CHOSEN office. Only runs while there is no
  // patient — the moment one is picked the list is beside the point.
  //
  // Depends on the patient's ID, never on the object: activePatient is derived
  // fresh on every render, so using it as a dependency re-runs this effect every
  // render, and `setResults([])` hands React a new array each time — a genuine
  // infinite update loop rather than a slow one. Same reason the clears below are
  // functional: they must be no-ops when there is nothing to clear.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open || activePatientId != null || !target || query.trim().length < 2) {
      setResults((prev) => (prev.length ? [] : prev));
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const { patients, error } = await api.searchPatientsForCall(call.id, query, target);
      setResults(patients);
      setSearchError(error ?? null);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, call.id, query, target, activePatientId]);

  /**
   * Switch which practice's chart this note is headed for.
   *
   * Clearing the search state is not tidiness: results from the previous office are
   * rows from a different database, and leaving one on screen under a new office
   * name is exactly how the wrong PatNum gets picked.
   */
  const changeTarget = (officeId: string) => {
    if (officeId === target) return;
    setChosenTarget(officeId);
    setQuery("");
    setResults([]);
    setSearchError(null);
    setSearching(false);
  };

  // Offer the list when there is one; otherwise the default alone, so the row
  // still says which type will be written instead of hiding the fact.
  const defaultDefNum = types?.defaultDefNum ?? null;
  const typeOptions =
    types?.available && types.options.length > 0
      ? types.options
      : defaultDefNum != null
        ? [{ defNum: defaultDefNum, name: types?.defaultName ?? "Office default" }]
        : [];
  // Nothing to choose between = nothing to choose. Disabled, not hidden.
  const typePickerDisabled = typeOptions.length < 2;

  const edited = generated != null && text.trim() !== generated.trim();
  const crossOffice = !!target && !!callOfficeId && target !== callOfficeId;
  // The practice being written to, in words — null while the server's default is
  // still in flight. Named separately from the label below so that "we don't know
  // yet" reads as the old, unqualified copy rather than as a placeholder office.
  const targetName = office?.officeName ?? (target ? officeNameOf(offices, target) : null);
  const confirmLabel = targetName ? `Send to ${targetName} chart` : "Send to chart";

  const send = async () => {
    if (!activePatient) { toast.error("No patient selected to send to", { duration: 8000 }); return; }
    if (!text.trim()) { toast.error("Note is empty", { duration: 8000 }); return; }
    setSending(true);
    try {
      const res = await api.resolvePatient(call.id, {
        patientId: activePatient.id,
        note: text,
        content_type: contentType,
        // Send the type the user is looking at, so what was confirmed is what is
        // written. Omitted only when the server offered no default at all — then
        // the server picks, exactly as it did before this dialog had a picker.
        ...(typeDefNum != null ? { commTypeDefNum: typeDefNum } : {}),
        // The office chosen for THIS write, plus an assertion that the server
        // resolves the same one. target_office selects; office_id can only refuse.
        // Sending both means a request that loses the choice in transit is rejected
        // rather than quietly filed at whichever office the server defaulted to.
        ...(target ? { target_office: target, office_id: target } : {}),
      });
      if (res.success) {
        const where = `${activePatient.name}'s chart at ${res.office?.officeName ?? targetName ?? "Open Dental"}`;
        toast.success(res.alreadySynced ? `Already on ${where}` : `Sent to ${where}`);
        // Hand back what the SERVER says the call now is — including the matched
        // patient's name, which is what makes "Send to TC" become usable without
        // a reload.
        onSent(res.call ? normalizeUnifiedCall(res.call) : null);
        onOpenChange(false);
      } else {
        toast.error("Could not send to chart", { duration: 8000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send to chart", { duration: 8000 });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{contentType === "transcript" ? "Send full transcript to chart" : "Send summary to chart"}</DialogTitle>
          <DialogDescription>
            {activePatient ? (
              <>
                Writes this {contentType === "transcript" ? "full transcript" : "summary"} to{" "}
                <span className="font-medium text-foreground">{activePatient.name}</span>&apos;s Open Dental chart.
                Review or edit it first — nothing is written until you confirm.
              </>
            ) : (
              <>
                Find this caller in{" "}
                <span className="font-medium text-foreground">{targetName ?? "this practice"}</span>&apos;s
                Open Dental before sending. A patient number belongs to one practice only, so the
                previous selection does not carry over.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* WHICH practice's chart. PatNum numbering restarts per Open Dental database,
            so the patient name alone doesn't say where this note lands — and it is a
            choice, because the call that rang here may be about the other practice's
            patient. */}
        <ChartOfficeSelect
          offices={offices}
          value={target}
          onChange={changeTarget}
          callOfficeId={callOfficeId}
          disabled={sending}
        />

        {crossOffice ? (
          <CrossOfficeNotice offices={offices} callOfficeId={callOfficeId} targetOfficeId={target} />
        ) : (
          office && <SameOfficeLine officeName={office.officeName} patientId={activePatient?.id ?? null} />
        )}

        {/* No patient in this office yet — find one before there is anything to send.
            Deliberately here rather than sending the user back a step: the note, the
            type and the office are all already chosen in this dialog. */}
        {!activePatient && (
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Find the patient in {targetName ?? "this practice"}
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Last name, first name, or phone…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
                data-testid="cross-office-patient-search"
              />
            </div>
            <div className="mt-2 max-h-40 overflow-y-auto space-y-1.5">
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
                  No patients found in {targetName ?? "this practice"}.
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
                      onClick={() => { if (target) setPicked({ id: p.id, name: p.fullName, office: target }); }}
                    >
                      <UserCheck size={12} /> Use
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* WHICH kind of commlog this lands as, from the office's own Open Dental
            list. Preselected to the office default, so leaving it alone writes
            exactly what a send wrote before this control existed. */}
        {typeOptions.length > 0 && (
          <div className="flex items-center gap-3">
            <label
              htmlFor="commlog-type"
              className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap"
            >
              Note type
            </label>
            <Select
              value={typeDefNum != null ? String(typeDefNum) : undefined}
              onValueChange={(v) => setTypeDefNum(Number(v))}
              disabled={typePickerDisabled || loadingPreview || sending}
            >
              <SelectTrigger id="commlog-type" className="h-8 text-xs flex-1" data-testid="commlog-type-select">
                <SelectValue placeholder="Office default" />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((t) => (
                  <SelectItem key={t.defNum} value={String(t.defNum)} className="text-xs">
                    {t.name}
                    {/* Only worth marking when there is something to mark it
                        against — the fallback row is already named "Office
                        default" and would otherwise read "· default" twice. */}
                    {t.defNum === defaultDefNum && !typePickerDisabled && (
                      <span className="text-muted-foreground"> · default</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* The list is this practice's configuration, so say so plainly rather
            than leaving a disabled control unexplained. Never an error state:
            Send works throughout. */}
        {typeOptions.length > 0 && typePickerDisabled && (
          <p className="text-[11px] text-muted-foreground -mt-1">
            Open Dental's note types aren't available right now — sending with this office's default.
          </p>
        )}
        {types?.stale && !typePickerDisabled && (
          <p className="text-[11px] text-muted-foreground -mt-1">
            Showing the last note types read from Open Dental; the list may be out of date.
          </p>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Chart note {edited && <span className="text-sky-600 normal-case font-medium">· edited</span>}
          </span>
          <button
            type="button"
            onClick={() => { if (generated != null) setText(generated); }}
            disabled={!edited || loadingPreview}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <RotateCcw size={11} /> Reset to generated
          </button>
        </div>

        {loadingPreview ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
            <Loader2 size={13} className="animate-spin" /> Building note…
          </div>
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-56 max-h-72 text-[11px] leading-relaxed font-mono"
            spellCheck={false}
          />
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          {/* The confirm names the practice, not just the action. On a cross-office
              send it is the last thing read before the note exists in someone's
              chart, and "Send to chart" would not say which one. */}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={send}
            disabled={sending || loadingPreview || !text.trim() || !activePatient}
            data-testid="send-to-chart-confirm"
          >
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
