/**
 * FloatingCalc — the DentaFlow 3-mode payment calculator FAB for TC routes
 * (Simple · Full · COB), ported from TC-app FloatingCalc.tsx onto platform
 * semantic tokens. The app shell mounts this on TC pages (wired in App.tsx).
 *
 * All calculator state lives HERE, not inside the dialog: Radix unmounts
 * dialog content on close, so lifting the state (all three modes) is what
 * preserves the TC's inputs across open/close.
 *
 * Platform adaptations vs DentaFlow:
 *  - Provider lanes / APR presets / service fee come from the SERVER library
 *    (features/tc/calc/libraryAdapter.ts over getLibrary), not localStorage.
 *  - Treatment presets derive from the library's crown_pricing — the 14-item
 *    hardcoded fee list was not ported (honest empty state instead).
 *  - Save to Case appends a note event via addCaseEvent and toasts success
 *    only after the server confirms (confirmed-save rule). It does NOT write
 *    financingOptions — the platform contract dropped that derived field.
 *  - Copy text is signed with the practice name from /auth/me when we have one
 *    (falling back to "CareIN TC") — never "DentaFlow".
 *  - Library edits show up without a reload: useFinancingLibrary re-fetches on
 *    window focus and on office change (legacy re-read localStorage on focus /
 *    storage / a custom event).
 *
 * DOLLARS DOMAIN: every number in this file is scratchpad dollars — never
 * persisted as money. The only server write is the plain-text note event.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookmarkPlus,
  Calculator,
  Check,
  ChevronLeft,
  Copy,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { OfficeId } from "@shared/tc/contract";
import { addCaseEvent, listCases, tcErrorMessage } from "../api";
import type { TcCaseSummary } from "../api";
import { useAuth } from "@/contexts/AuthContext";
import { useTcOffice } from "../components/TcShell";
import {
  amortize,
  carecreditPromo,
  cherry,
  fmtUSD,
  fmtUSD0,
  inHousePlan,
  type FinanceResult,
} from "../calc/calcFinance";
import { SIMPLE_TERMS } from "../calc/calcRates";
import {
  buildAprPresets,
  getEffectiveApr,
  getProviderRateDetails,
  merchantFeeFraction,
} from "../calc/financingRates";
import {
  type AdaptedFinancingProvider,
  type FinancingLibraryView,
  type TreatmentPreset,
} from "../calc/libraryAdapter";
import { useFinancingLibrary } from "../calc/useFinancingLibrary";
import { buildCobCopyText, buildCopyText, type CalcMode } from "../calc/copyText";
import { calcCOB } from "../lib/calcCOB";
import {
  CobCalculator,
  cobInputFromState,
  defaultCobCalcState,
  type CobCalcState,
} from "./CobCalculator";

type ActiveInput = "fee" | "insuranceEst" | "downPayAmt";

interface Lane {
  key: string;
  label: string;
  sublabel: string;
  accent?: boolean;
  terms: number[];
  selected: number;
  onSelect: (t: number) => void;
  result: FinanceResult;
  /** False for providers with no merchant-fee data — NetSummary stays honest. */
  hasFeeData: boolean;
}

// ─── FloatingCalc — owns all state ───────────────────────────────────────────

export default function FloatingCalc() {
  const office = useTcOffice();
  const [open, setOpen] = useState(false);

  // ── Mode ───────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<CalcMode>("simple");

  // ── Shared inputs (integer scratchpad dollars, keypad-editable) ────────────
  const [fee, setFee] = useState(0);
  const [downPayAmt, setDownPayAmt] = useState(0);
  const [treatmentName, setTreatmentName] = useState("");
  const [activeInput, setActiveInput] = useState<ActiveInput>("fee");
  const [showInsurance, setShowInsurance] = useState(false);
  const [insuranceEst, setInsuranceEst] = useState(0);
  const [applyServiceFee, setApplyServiceFee] = useState(false);

  // ── Simple-mode state ──────────────────────────────────────────────────────
  const [apr, setApr] = useState(0);
  const [aprVisible, setAprVisible] = useState(true);
  const [simpleTerm, setSimpleTerm] = useState(12);

  // ── Full-mode state (per-provider selected term, keyed by library key) ─────
  const [laneTerms, setLaneTerms] = useState<Record<string, number>>({});

  // ── COB-mode state (lifted so inputs survive open/close) ───────────────────
  const [cobState, setCobState] = useState<CobCalcState>(defaultCobCalcState);

  // ── Server library (provider/config truth) ─────────────────────────────────
  // Fetched only while the dialog is open, and re-fetched on window focus /
  // office change so Library → Financing edits land in an open calculator.
  // A failed refresh keeps the last-known library (see the hook).
  const { view, presets } = useFinancingLibrary(office, { enabled: open });

  // Practice name for the Copy signature (falls back to "CareIN TC").
  const auth = useAuth();
  const practiceName =
    auth.status === "authenticated" ? auth.user.tenant?.displayName ?? null : null;

  const aprPresets = useMemo(
    () =>
      view.providers.length > 0
        ? buildAprPresets(view.providers, view.overrides)
        : buildAprPresets(undefined, view.overrides),
    [view],
  );
  const hasServiceFee = view.serviceFeeEnabled;
  const serviceFeePercent = view.serviceFeePercent;

  // ── Core math ──────────────────────────────────────────────────────────────
  const insuranceDeduct = showInsurance ? insuranceEst : 0;
  const patientPortion = Math.max(0, fee - insuranceDeduct);
  const downPay = Math.min(downPayAmt, patientPortion);
  const financed = Math.max(0, patientPortion - downPay);
  const serviceFeeAmt = applyServiceFee && hasServiceFee ? financed * (serviceFeePercent / 100) : 0;
  const financedWithFee = financed + serviceFeeAmt;

  // ── Keypad ─────────────────────────────────────────────────────────────────
  const setterMap: Record<ActiveInput, (v: number) => void> = {
    fee: setFee,
    insuranceEst: setInsuranceEst,
    downPayAmt: setDownPayAmt,
  };
  const valueMap: Record<ActiveInput, number> = { fee, insuranceEst, downPayAmt };

  function pressKey(k: string) {
    const setter = setterMap[activeInput];
    const current = valueMap[activeInput] ?? 0;
    if (k === "C") {
      setter(0);
      return;
    }
    if (k === "⌫") {
      setter(Math.floor(current / 10));
      return;
    }
    const n = parseInt(k, 10);
    if (!isNaN(n)) setter(current * 10 + n);
  }

  // Numpad support — ref so the listener always has the latest pressKey.
  const pressKeyRef = useRef(pressKey);
  useEffect(() => {
    pressKeyRef.current = pressKey;
  });

  useEffect(() => {
    if (!open) return;
    const NUMPAD_MAP: Record<string, string> = {
      Numpad0: "0", Numpad1: "1", Numpad2: "2", Numpad3: "3", Numpad4: "4",
      Numpad5: "5", Numpad6: "6", Numpad7: "7", Numpad8: "8", Numpad9: "9",
      Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
      Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
      Backspace: "⌫", NumpadDecimal: "⌫",
      Delete: "C", NumpadSubtract: "C",
    };
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const k = NUMPAD_MAP[e.code];
      if (k) {
        pressKeyRef.current(k);
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // ── Full-mode lanes (driven by the server library adapter) ─────────────────
  const lanes: Lane[] = view.providers.map((p) => {
    const laneTermList = laneTermsFor(p);
    const fallbackTerm = laneTermList[0] ?? 12;
    const stored = laneTerms[p.key];
    const selected = stored !== undefined && laneTermList.includes(stored) ? stored : fallbackTerm;
    const { result, sublabel, accent, hasFeeData } = laneResultFor(
      p,
      selected,
      financedWithFee,
      view,
    );
    // Library minimum always applies on top of the rate-table minimum.
    const minPurchase = Math.max(result.minPurchase, p.minAmount);
    const eligible = result.eligible && financedWithFee >= p.minAmount;
    return {
      key: p.key,
      label: laneLabelFor(p),
      sublabel,
      accent,
      terms: laneTermList,
      selected,
      onSelect: (t: number) => setLaneTerms((prev) => ({ ...prev, [p.key]: t })),
      result: { ...result, minPurchase, eligible },
      hasFeeData,
    };
  });

  // ── Copy text ──────────────────────────────────────────────────────────────
  const cobInput = cobInputFromState(cobState);
  const cobResult = calcCOB(cobInput);
  const copyText =
    mode === "cob"
      ? buildCobCopyText(cobInput, cobResult, practiceName)
      : buildCopyText({
          mode,
          practiceName,
          treatmentName,
          fee,
          showInsurance,
          insuranceEst,
          downPayAmt,
          financedWithFee,
          applyServiceFee,
          serviceFeeAmt,
          serviceFeePercent,
          apr,
          simpleTerm,
          lanes: lanes.map((l) => ({ label: l.label, result: l.result })),
        });

  const shared = {
    fee, setFee, downPayAmt, setDownPayAmt,
    activeInput, setActiveInput, pressKey,
    showInsurance, setShowInsurance, insuranceEst, setInsuranceEst,
    patientPortion, downPay, financed, financedWithFee, serviceFeeAmt,
    hasServiceFee, applyServiceFee, setApplyServiceFee, serviceFeePercent,
  };

  return (
    <>
      {/* FAB */}
      <Button
        size="icon"
        aria-label="Open payment calculator"
        title="Payment Calculator"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full shadow-lg hover:scale-105 active:scale-95 transition-transform"
      >
        <Calculator className="w-6 h-6" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="p-0 gap-0 overflow-hidden flex flex-col rounded-xl"
          style={{ maxWidth: "min(900px, 96vw)", width: "min(900px, 96vw)", maxHeight: "92vh" }}
        >
          <DialogTitle className="sr-only">Payment Calculator</DialogTitle>
          <DialogDescription className="sr-only">
            Simple, full-comparison, and COB payment scratchpad. Inputs stick
            around until cleared.
          </DialogDescription>

          {/* ── Sticky dark header (sidebar surface — dark in both themes) ── */}
          <div className="flex items-center justify-between px-4 py-3 shrink-0 bg-sidebar border-b border-sidebar-border">
            <div className="flex items-center gap-3">
              <Calculator className="w-4 h-4 shrink-0 text-sidebar-primary" />
              <div className="flex items-center rounded-lg p-0.5 gap-0.5 bg-sidebar-accent">
                {(["simple", "full", "cob"] as CalcMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
                    }`}
                  >
                    {m === "cob" ? "COB" : m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <DialogClose
              className="rounded-full p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
              aria-label="Close calculator"
            >
              <X className="w-4 h-4" />
            </DialogClose>
          </div>

          {/* ── Scrollable content ── */}
          <div className="flex-1 overflow-y-auto bg-background">
            {mode === "simple" ? (
              <SimpleView
                {...shared}
                apr={apr}
                setApr={setApr}
                aprVisible={aprVisible}
                setAprVisible={setAprVisible}
                term={simpleTerm}
                setTerm={setSimpleTerm}
                aprPresets={aprPresets}
              />
            ) : mode === "full" ? (
              <FullView
                {...shared}
                treatmentName={treatmentName}
                setTreatmentName={setTreatmentName}
                lanes={lanes}
                configured={view.configured}
                presets={presets}
              />
            ) : (
              <div className="p-4">
                <CobCalculator compact state={cobState} onStateChange={setCobState} />
              </div>
            )}
          </div>

          {/* ── Sticky action bar ── */}
          <ActionBar
            office={office}
            copyText={copyText}
            mode={mode}
            treatmentName={treatmentName}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Lane helpers ─────────────────────────────────────────────────────────────

function laneTermsFor(p: AdaptedFinancingProvider): number[] {
  if (p.key === "carecredit") {
    return p.promoTerms.length > 0 ? p.promoTerms : p.terms;
  }
  return p.terms;
}

function laneLabelFor(p: AdaptedFinancingProvider): string {
  if (p.key === "carecredit") return `${p.name} Promo`;
  return p.name;
}

/**
 * Which lane shape a provider gets is product logic (deferred-interest promo
 * vs amortized-with-fee vs practice-carried); every NUMBER inside comes from
 * the provider's catalog rate schedule (`p.rates`) with library overrides on
 * top — there is no second rate table (PM ruling 2).
 *
 * `hasFeeData` is derived from the schedule, so a provider the catalog has no
 * merchant-fee data for reports "net unknown" instead of implying the practice
 * collects in full.
 */
function laneResultFor(
  p: AdaptedFinancingProvider,
  term: number,
  financedWithFee: number,
  view: FinancingLibraryView,
): { result: FinanceResult; sublabel: string; accent?: boolean; hasFeeData: boolean } {
  const rates = p.rates;
  if (p.key === "carecredit") {
    // The office's configured regular APR is what an unpaid promo converts to.
    const ccRegularApr = getProviderRateDetails(p, view.overrides).regularApr;
    return {
      result: carecreditPromo(financedWithFee, term, ccRegularApr, rates),
      sublabel: "0% if paid in full",
      hasFeeData: merchantFeeFraction(rates?.promoMerchantFee, term) !== null,
    };
  }
  if (p.key === "cherry") {
    const aprOverride = getEffectiveApr(p, term, view.overrides);
    return {
      result: cherry(financedWithFee, term, aprOverride, rates),
      sublabel: "Soft-pull, instant decision",
      accent: true,
      hasFeeData: merchantFeeFraction(rates?.merchantFee, term) !== null,
    };
  }
  if (p.key === "in_house" || p.key === "in-house") {
    const laneApr = getEffectiveApr(p, term, view.overrides);
    return {
      result: inHousePlan(financedWithFee, term, laneApr, rates),
      sublabel: "Practice carries",
      // No lender ⇒ a known zero fee, so the net figure is real.
      hasFeeData: merchantFeeFraction(rates?.merchantFee, term) !== null,
    };
  }
  // Generic provider (Proceed, Sunbit, custom): amortize at its effective APR.
  // The catalog publishes no merchant-fee table for these, so the fee is
  // UNKNOWN — we report no net rather than claiming full collection.
  const laneApr = getEffectiveApr(p, term, view.overrides);
  const feeFraction = merchantFeeFraction(rates?.merchantFee, term);
  const { monthly, total, interest } = amortize(financedWithFee, laneApr, term);
  const merchantFee = financedWithFee * (feeFraction ?? 0);
  return {
    result: {
      product: p.name,
      variant: `${term}mo`,
      months: term,
      apr: laneApr,
      monthly,
      totalIfOnTime: total,
      interestIfOnTime: interest,
      merchantFee,
      netToPractice: financedWithFee - merchantFee,
      minPurchase: rates?.minPurchase ?? p.minAmount,
      warning: null,
      eligible: financedWithFee >= p.minAmount,
    },
    sublabel: p.description,
    hasFeeData: feeFraction !== null,
  };
}

// ─── Action bar ───────────────────────────────────────────────────────────────

function ActionBar({
  office,
  copyText,
  mode,
  treatmentName,
}: {
  office: OfficeId | null;
  copyText: string;
  mode: CalcMode;
  treatmentName: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  function handleCopy() {
    navigator.clipboard
      .writeText(copyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success("Copied to clipboard");
      })
      .catch(() => {
        // Clipboard permission denied / insecure context — say so instead of
        // leaving a silent no-op that looks like a successful copy.
        toast.error("Couldn't copy — clipboard access was blocked");
      });
  }

  return (
    <div className="shrink-0 border-t border-border bg-card">
      {showPicker && office && (
        <CasePicker
          office={office}
          copyText={copyText}
          isCob={mode === "cob"}
          onClose={() => setShowPicker(false)}
        />
      )}

      <div className="flex items-center gap-2 px-4 py-3">
        <Button variant="outline" size="sm" onClick={handleCopy} className="text-xs font-semibold">
          {copied ? <Check className="w-3.5 h-3.5 mr-1.5 text-primary" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
          {copied ? "Copied!" : "Copy"}
        </Button>

        <Button
          variant={showPicker ? "default" : "outline"}
          size="sm"
          disabled={!office}
          title={office ? undefined : "Pick an office to save to a case"}
          onClick={() => setShowPicker((v) => !v)}
          className="text-xs font-semibold"
        >
          <BookmarkPlus className="w-3.5 h-3.5 mr-1.5" />
          Save to Case
        </Button>

        <div className="ml-auto text-[10px] text-muted-foreground min-w-0">
          {treatmentName && (
            <span className="truncate max-w-[180px] block text-right">{treatmentName}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Case picker panel — confirmed-save via addCaseEvent ─────────────────────

function CasePicker({
  office,
  copyText,
  isCob,
  onClose,
}: {
  office: OfficeId;
  copyText: string;
  isCob: boolean;
  onClose: () => void;
}) {
  const [cases, setCases] = useState<TcCaseSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TcCaseSummary | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listCases(office)
      .then((rows) => {
        if (!cancelled) setCases(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const filtered = useMemo(() => {
    const all = cases ?? [];
    const q = query.trim().toLowerCase();
    const matches = q ? all.filter((c) => c.patientName.toLowerCase().includes(q)) : all;
    return matches.slice(0, 8);
  }, [cases, query]);

  async function handleSave() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      // Confirmed-save: toast success ONLY after the server persists the
      // event. On failure the picker stays open so the TC can retry.
      await addCaseEvent(office, selected.caseId, {
        type: "note_added",
        description: isCob
          ? `COB estimate saved from calculator:\n\n${copyText}`
          : `Financing scenario saved from calculator:\n\n${copyText}`,
      });
      toast.success(`Saved to ${selected.patientName}`);
      onClose();
    } catch (e: unknown) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-border px-4 py-3 space-y-2 bg-muted/30">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Close case picker"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs font-semibold text-foreground">Choose a case</span>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search patient name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          autoFocus
          className="w-full rounded-lg text-xs pl-8 pr-3 py-2 outline-none bg-background border border-border text-foreground focus:border-primary"
        />
      </div>

      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {loadError ? (
          <div className="text-xs py-2 text-center text-destructive">{loadError}</div>
        ) : cases === null ? (
          <div className="text-xs py-2 flex items-center justify-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading cases…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs py-2 text-center text-muted-foreground">No cases found</div>
        ) : (
          filtered.map((c) => (
            <button
              key={c.caseId}
              type="button"
              onClick={() => setSelected(c)}
              className={`w-full text-left flex items-center justify-between rounded-lg px-3 py-2 transition-colors text-xs ${
                selected?.caseId === c.caseId
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-primary/10"
              }`}
            >
              <span className="font-medium truncate">{c.patientName}</span>
              <span className="text-[10px] opacity-70 shrink-0 ml-2">{c.caseType}</span>
            </button>
          ))
        )}
      </div>

      <Button
        onClick={handleSave}
        disabled={!selected || saving}
        className="w-full text-xs font-semibold"
        size="sm"
      >
        {saving ? "Saving…" : selected ? `Save to ${selected.patientName}` : "Select a case above"}
      </Button>
    </div>
  );
}

// ─── Shared toggle row (DentaFlow style, semantic tokens) ────────────────────

function ToggleRow({
  label,
  on,
  onToggle,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center justify-between rounded-xl px-3.5 py-2 transition-colors border ${
          on
            ? "bg-card border-primary text-foreground"
            : "bg-muted/40 border-dashed border-border text-muted-foreground"
        }`}
      >
        <span className="text-xs font-semibold">{label}</span>
        <span
          className={`w-8 h-[18px] rounded-full relative shrink-0 transition-colors ${
            on ? "bg-primary" : "bg-border"
          }`}
        >
          <span
            className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-background shadow-sm transition-all"
            style={{ left: on ? 16 : 2 }}
          />
        </span>
      </button>
      {on && children}
    </div>
  );
}

// ─── Shared dollar field (keypad-linked) ─────────────────────────────────────

function DollarField({
  id,
  label,
  value,
  onChange,
  activeInput,
  setActiveInput,
}: {
  id: ActiveInput;
  label: string;
  value: number;
  onChange: (v: number) => void;
  activeInput: ActiveInput;
  setActiveInput: (id: ActiveInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isActive = activeInput === id;
  return (
    <label
      onClick={() => setActiveInput(id)}
      className={`block rounded-lg cursor-text transition-all px-3 py-2.5 border-[1.5px] ${
        isActive ? "bg-primary/10 border-primary" : "bg-muted/40 border-border"
      }`}
    >
      <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="flex items-baseline gap-1 mt-1">
        <span className="text-base text-muted-foreground">$</span>
        <input
          type="text"
          inputMode="numeric"
          value={editing ? draft : value.toLocaleString()}
          onFocus={() => {
            setEditing(true);
            setDraft(String(value));
            setActiveInput(id);
          }}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            setDraft(raw);
            onChange(parseInt(raw, 10) || 0);
          }}
          onBlur={() => setEditing(false)}
          className="flex-1 min-w-0 border-0 outline-none bg-transparent font-bold text-[22px] text-foreground tabular-nums"
        />
      </span>
    </label>
  );
}

// ─── Shared prop type ─────────────────────────────────────────────────────────

type SharedProps = {
  fee: number;
  setFee: (v: number) => void;
  downPayAmt: number;
  setDownPayAmt: (v: number) => void;
  activeInput: ActiveInput;
  setActiveInput: (v: ActiveInput) => void;
  pressKey: (k: string) => void;
  showInsurance: boolean;
  setShowInsurance: (v: boolean) => void;
  insuranceEst: number;
  setInsuranceEst: (v: number) => void;
  patientPortion: number;
  downPay: number;
  financed: number;
  financedWithFee: number;
  serviceFeeAmt: number;
  hasServiceFee: boolean;
  applyServiceFee: boolean;
  setApplyServiceFee: (v: boolean) => void;
  serviceFeePercent: number;
};

// ─── Simple view ──────────────────────────────────────────────────────────────

function SimpleView(props: SharedProps & {
  apr: number;
  setApr: (v: number) => void;
  aprVisible: boolean;
  setAprVisible: (v: boolean) => void;
  term: number;
  setTerm: (v: number) => void;
  aprPresets: { label: string; apr: number }[];
}) {
  const {
    fee, setFee, downPayAmt, setDownPayAmt, activeInput, setActiveInput, pressKey,
    showInsurance, setShowInsurance, insuranceEst, setInsuranceEst,
    financedWithFee, serviceFeeAmt,
    hasServiceFee, applyServiceFee, setApplyServiceFee, serviceFeePercent,
    apr, setApr, aprVisible, setAprVisible, term, setTerm, aprPresets,
  } = props;

  const { monthly, interest } = amortize(financedWithFee, apr, term);

  return (
    <div className="p-4 space-y-3 max-w-[520px] mx-auto">
      {/* Fee + Down */}
      <div className="grid grid-cols-2 gap-2.5">
        <DollarField id="fee" label="Treatment Fee" value={fee} onChange={setFee} activeInput={activeInput} setActiveInput={setActiveInput} />
        <DollarField id="downPayAmt" label="Down Payment" value={downPayAmt} onChange={setDownPayAmt} activeInput={activeInput} setActiveInput={setActiveInput} />
      </div>

      {/* Insurance */}
      <ToggleRow label="Insurance Estimate" on={showInsurance} onToggle={() => setShowInsurance(!showInsurance)}>
        <div className="mt-2">
          <DollarField id="insuranceEst" label="Insurance Est." value={insuranceEst} onChange={setInsuranceEst} activeInput={activeInput} setActiveInput={setActiveInput} />
        </div>
      </ToggleRow>

      {/* Service fee — only when the office library enables it */}
      {hasServiceFee && (
        <ToggleRow
          label={`Service Fee (+${serviceFeePercent}%)`}
          on={applyServiceFee}
          onToggle={() => setApplyServiceFee(!applyServiceFee)}
        />
      )}

      {/* APR */}
      <ToggleRow label="Interest Rate (APR)" on={aprVisible} onToggle={() => setAprVisible(!aprVisible)}>
        <div className="mt-2 rounded-xl space-y-2 px-3.5 py-3 bg-card border-[1.5px] border-border">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Rate</span>
            <span className="font-bold text-xl text-foreground tabular-nums">{apr.toFixed(2)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={35}
            step={0.25}
            value={apr}
            onChange={(e) => setApr(parseFloat(e.target.value))}
            className="w-full"
            style={{ accentColor: "var(--primary)" }}
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {aprPresets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setApr(p.apr)}
                className={`rounded-full text-[11px] font-medium px-2.5 py-1 border transition-colors ${
                  apr === p.apr
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </ToggleRow>

      {/* Monthly display — dark sidebar surface */}
      <div className="rounded-xl bg-sidebar px-5 py-5">
        <div className="text-[10px] uppercase tracking-[0.25em] text-sidebar-foreground/60">Monthly Payment</div>
        <div
          className="font-bold leading-none mt-1.5 tabular-nums text-5xl sm:text-[56px]"
          style={{ color: "var(--sidebar-primary-foreground)", letterSpacing: "-0.03em" }}
        >
          {financedWithFee > 0 ? fmtUSD(monthly) : "—"}
        </div>
        {financedWithFee > 0 && (
          <div className="mt-2 space-y-0.5 text-xs text-sidebar-foreground/70">
            <div>
              {fmtUSD0(financedWithFee)} over {term} months · {apr === 0 ? "0% APR" : `${apr.toFixed(2)}% APR`}
              {apr > 0 && ` · ${fmtUSD0(interest)} interest`}
            </div>
            {applyServiceFee && serviceFeeAmt > 0 && (
              <div className="text-sidebar-primary">
                includes {fmtUSD0(serviceFeeAmt)} service fee ({serviceFeePercent}%)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Term chips */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-widest mb-2 text-muted-foreground">Term</div>
        <div className="grid grid-cols-4 gap-1.5">
          {SIMPLE_TERMS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTerm(t)}
              className={`rounded-lg text-sm font-semibold py-2.5 border transition-colors ${
                term === t
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground border-border hover:border-primary/50"
              }`}
            >
              {t} mo
            </button>
          ))}
        </div>
      </div>

      <Keypad pressKey={pressKey} />
    </div>
  );
}

// ─── Full view ────────────────────────────────────────────────────────────────

function FullView(props: SharedProps & {
  treatmentName: string;
  setTreatmentName: (v: string) => void;
  lanes: Lane[];
  configured: boolean;
  presets: TreatmentPreset[];
}) {
  const {
    fee, setFee, downPayAmt, setDownPayAmt, treatmentName, setTreatmentName,
    activeInput, setActiveInput, pressKey,
    showInsurance, setShowInsurance, insuranceEst, setInsuranceEst,
    patientPortion, downPay, financed, financedWithFee, serviceFeeAmt,
    hasServiceFee, applyServiceFee, setApplyServiceFee, serviceFeePercent,
    lanes, configured, presets,
  } = props;

  return (
    <div className="p-4 space-y-4">
      {/* Top inputs */}
      <div className="rounded-xl p-4 border border-border bg-card">
        <input
          type="text"
          value={treatmentName}
          onChange={(e) => setTreatmentName(e.target.value)}
          placeholder="Treatment name"
          className="w-full bg-transparent border-0 border-b border-border outline-none text-lg font-medium mb-4 pb-1.5 text-foreground placeholder:text-muted-foreground focus:border-primary"
          style={{ fontFamily: "Sora, sans-serif" }}
        />

        <div className="mb-3">
          <ToggleRow label="Insurance Estimate" on={showInsurance} onToggle={() => setShowInsurance(!showInsurance)} />
        </div>

        <div className={`grid gap-2.5 ${showInsurance ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>
          <DollarField id="fee" label="Total Fee" value={fee} onChange={setFee} activeInput={activeInput} setActiveInput={setActiveInput} />
          {showInsurance && (
            <DollarField id="insuranceEst" label="Insurance Est." value={insuranceEst} onChange={setInsuranceEst} activeInput={activeInput} setActiveInput={setActiveInput} />
          )}
          <DollarField id="downPayAmt" label="Down Payment" value={downPayAmt} onChange={setDownPayAmt} activeInput={activeInput} setActiveInput={setActiveInput} />
        </div>

        {hasServiceFee && (
          <div className="mt-3">
            <ToggleRow
              label={`Service Fee (+${serviceFeePercent}%) — adds ${financed > 0 ? fmtUSD0(financed * (serviceFeePercent / 100)) : "$0"} to financed amount`}
              on={applyServiceFee}
              onToggle={() => setApplyServiceFee(!applyServiceFee)}
            />
          </div>
        )}
      </div>

      {/* Amount to finance display — dark sidebar surface */}
      <div className="rounded-xl px-5 py-4 bg-sidebar">
        <div className="text-[10px] uppercase tracking-[0.25em] text-sidebar-foreground/60">Amount to Finance</div>
        <div
          className="font-bold leading-none mt-1.5 tabular-nums text-4xl sm:text-[52px]"
          style={{ color: "var(--sidebar-primary-foreground)", letterSpacing: "-0.03em" }}
        >
          {fmtUSD(financedWithFee)}
        </div>
        <div className="mt-1.5 text-xs text-sidebar-foreground/70">
          {fmtUSD0(patientPortion)} patient portion{downPay > 0 && ` − ${fmtUSD0(downPay)} down`}
          {applyServiceFee && serviceFeeAmt > 0 && (
            <span className="text-sidebar-primary">{" + "}{fmtUSD0(serviceFeeAmt)} service fee</span>
          )}
        </div>
      </div>

      {/* Provider lanes — from the server library */}
      {lanes.length > 0 ? (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(lanes.length, 3)}, minmax(0, 1fr))` }}
        >
          {lanes.map((lane) => (
            <FinanceLane key={lane.key} lane={lane} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl p-6 text-center text-sm bg-card border border-border text-muted-foreground">
          {configured
            ? "No financing providers enabled — enable them in Library → Financing."
            : "No financing providers configured — set them up in Library → Financing."}
        </div>
      )}

      {/* Presets + keypad */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-[1.1fr_1fr]">
        <PresetsGrid presets={presets} setFee={setFee} setTreatmentName={setTreatmentName} />
        <Keypad pressKey={pressKey} />
      </div>

      {/* Net summary */}
      {financedWithFee > 0 && lanes.length > 0 && (
        <NetSummary lanes={lanes} financed={financedWithFee} />
      )}
    </div>
  );
}

// ─── Finance lane ─────────────────────────────────────────────────────────────

function FinanceLane({ lane }: { lane: Lane }) {
  const { result, selected, onSelect, terms, label, sublabel, accent } = lane;
  return (
    <div
      className={`rounded-xl flex flex-col gap-2.5 p-3.5 border-[1.5px] ${
        accent ? "bg-primary/5 border-primary" : "bg-card border-border"
      } ${result.eligible ? "" : "opacity-60"}`}
    >
      <div>
        <div className="text-xs font-bold text-foreground">{label}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</div>
      </div>
      <div className="flex flex-wrap gap-1">
        {terms.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onSelect(t)}
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium border transition-colors ${
              selected === t
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent text-foreground border-border hover:border-primary/50"
            }`}
          >
            {t}mo
          </button>
        ))}
      </div>
      <div className="rounded-lg px-3 py-2.5 bg-sidebar">
        <div className="text-[9px] uppercase tracking-[0.15em] text-sidebar-foreground/60">Monthly</div>
        <div
          className="font-bold leading-tight mt-0.5 text-[26px] tabular-nums"
          style={{ color: "var(--sidebar-primary-foreground)" }}
        >
          {result.eligible ? fmtUSD(result.monthly) : "—"}
        </div>
        <div className="text-[10px] text-sidebar-foreground/60 mt-0.5">
          {result.apr === 0 ? "0% APR" : `${result.apr}% APR`} · {result.months}mo
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground leading-relaxed">
        Total: <strong className="text-foreground tabular-nums">{fmtUSD0(result.totalIfOnTime)}</strong>
        {result.merchantFee > 0 && (
          <>
            {" "}· Fee: <strong className="text-foreground tabular-nums">{fmtUSD0(result.merchantFee)}</strong>
          </>
        )}
      </div>
      {result.warning && (
        <div className="rounded text-[10px] leading-snug px-2 py-1.5 text-muted-foreground bg-primary/10 border-l-2 border-primary">
          {result.warning}
        </div>
      )}
      {!result.eligible && (
        <div className="text-[10px] text-muted-foreground">Min {fmtUSD0(result.minPurchase)} required</div>
      )}
    </div>
  );
}

// ─── Keypad ───────────────────────────────────────────────────────────────────

function Keypad({ pressKey }: { pressKey: (k: string) => void }) {
  const rows = [["7", "8", "9"], ["4", "5", "6"], ["1", "2", "3"], ["C", "0", "⌫"]];
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2 text-muted-foreground">Keypad</div>
      <div className="grid grid-cols-3 gap-2">
        {rows.flat().map((k, i) => {
          const isOp = k === "C" || k === "⌫";
          return (
            <button
              key={i}
              type="button"
              onClick={() => pressKey(k)}
              className={`rounded-lg font-bold text-lg py-3 transition-all active:scale-95 active:translate-y-px ${
                isOp
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:bg-muted/70"
              }`}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Treatment presets — library-derived, honest empty state ─────────────────

function PresetsGrid({
  presets,
  setFee,
  setTreatmentName,
}: {
  presets: TreatmentPreset[];
  setFee: (v: number) => void;
  setTreatmentName: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-widest mb-2 text-muted-foreground">
        Treatment Presets
      </div>
      {presets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          No fee schedule in Library yet — presets appear once pricing is set up
          in Library → Pricing.
        </div>
      ) : (
        <div className="grid gap-1 overflow-y-auto pr-1 grid-cols-1 sm:grid-cols-2 max-h-[220px]">
          {presets.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => {
                setFee(Math.round(t.fee));
                setTreatmentName(t.name);
              }}
              className="text-left rounded-lg px-2.5 py-1.5 border border-border bg-transparent hover:bg-primary/10 hover:border-primary transition-colors flex justify-between items-baseline gap-1"
            >
              <span className="text-xs font-medium truncate text-foreground">{t.name}</span>
              <span className="text-[10px] shrink-0 text-muted-foreground tabular-nums">
                {fmtUSD0(t.fee)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Net-to-practice summary (TC-only) ───────────────────────────────────────

function NetSummary({ lanes, financed }: { lanes: Lane[]; financed: number }) {
  return (
    <div className="rounded-xl px-4 py-3 bg-muted/40 border border-dashed border-border">
      <div className="text-[9px] font-bold uppercase tracking-[0.25em] text-muted-foreground mb-2.5">
        TC Only · Net to Practice
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.min(lanes.length, 3)}, minmax(0, 1fr))` }}
      >
        {lanes.map((lane) => (
          <div key={lane.key}>
            <div className="text-[10px] text-muted-foreground">{lane.label}</div>
            {lane.hasFeeData ? (
              <>
                <div className="font-bold mt-0.5 text-xl text-foreground tabular-nums">
                  {fmtUSD0(lane.result.netToPractice)}
                </div>
                {lane.result.merchantFee > 0 ? (
                  <div className="text-[10px] text-muted-foreground">
                    −{fmtUSD0(lane.result.merchantFee)} ({((lane.result.merchantFee / financed) * 100).toFixed(1)}% fee)
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground">Practice collects in full</div>
                )}
              </>
            ) : (
              <div className="text-[10px] text-muted-foreground mt-1">
                Merchant fee not configured — net unknown
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
