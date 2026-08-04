/**
 * /tc/financing — DentaFlow FinancingModule port (TC-app
 * client/src/pages/FinancingModule.tsx) on platform conventions.
 *
 * Platform adaptations vs DentaFlow:
 *  - Provider catalog + enable/override map come from the SERVER library
 *    (calc/libraryAdapter over getLibrary), not localStorage.
 *  - Cash discount defaults from the library financing config — the legacy
 *    hardcoded "5" is dead; unset ⇒ 0 with a hint to configure it in Library.
 *  - Rate details are READ-ONLY here (the legacy page edited localStorage
 *    inline); rate editing stays in Library → Financing, one write path.
 *
 * DOLLARS DOMAIN: pure scratchpad — nothing on this page persists anything.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, DollarSign, Info, Percent } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { getLibrary, tcErrorMessage } from "@/features/tc/api";
import type { TcLibrary } from "@/features/tc/api";
import {
  TcOfficeGate,
  TcPageHeader,
  useTcOffice,
} from "@/features/tc/components/TcShell";
import { amortize, fmtUSD0 } from "@/features/tc/calc/calcFinance";
import {
  getEffectiveApr,
  getProviderRateDetails,
} from "@/features/tc/calc/financingRates";
import {
  financingViewFromLibrary,
  type AdaptedFinancingProvider,
  type FinancingLibraryView,
} from "@/features/tc/calc/libraryAdapter";

const TERM_OPTIONS = [6, 12, 18, 24, 36, 48, 60, 72, 84];

function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function TcFinancing() {
  const office = useTcOffice();

  const [library, setLibrary] = useState<TcLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [treatmentTotal, setTreatmentTotal] = useState("8500");
  const [insurance, setInsurance] = useState("2000");
  const [downPaymentInput, setDownPaymentInput] = useState("0");
  const [downPaymentType, setDownPaymentType] = useState<"flat" | "percent">("flat");
  const [selectedTerm, setSelectedTerm] = useState(24);
  /** null = untouched → follow the library's configured default. */
  const [cashDiscountDraft, setCashDiscountDraft] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!office) return;
    let cancelled = false;
    setLibrary(null);
    setLoadError(null);
    getLibrary(office)
      .then((lib) => {
        if (!cancelled) setLibrary(lib);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const view = useMemo(() => financingViewFromLibrary(library), [library]);

  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  const libraryDefaultDiscount = view.cashDiscountEnabled ? view.cashDiscountPercent : 0;
  const cashDiscountNum =
    cashDiscountDraft === null ? libraryDefaultDiscount : parseFloat(cashDiscountDraft) || 0;

  const treatmentTotalNum = parseFloat(treatmentTotal) || 0;
  const insuranceNum = parseFloat(insurance) || 0;
  const downPaymentInputNum = parseFloat(downPaymentInput) || 0;

  const patientPortion = Math.max(0, treatmentTotalNum - insuranceNum);
  const downPayment =
    downPaymentType === "percent"
      ? Math.round((patientPortion * downPaymentInputNum) / 100)
      : downPaymentInputNum;
  const serviceFee = view.serviceFeeEnabled
    ? Math.round(((patientPortion - downPayment) * view.serviceFeePercent) / 100)
    : 0;
  const financeAmount = Math.max(0, patientPortion - downPayment + serviceFee);
  const cashPayment = patientPortion * (1 - cashDiscountNum / 100);

  const eligibleProviders = view.providers.filter((p) => financeAmount >= p.minAmount);
  const scriptProvider = eligibleProviders[0] ?? view.providers[0];

  return (
    <div className="p-6 space-y-6">
      <TcPageHeader
        title="Financing Calculator"
        subtitle="Build and compare payment options for any case"
      />

      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      )}

      {!library && !loadError ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full lg:col-span-2" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ── Case details ── */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
              <h2 className="text-sm font-semibold mb-4 text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                Case Details
              </h2>
              <div className="space-y-4">
                <MoneyInput
                  label="Total Treatment Fee"
                  value={treatmentTotal}
                  onChange={setTreatmentTotal}
                />
                <MoneyInput
                  label="Estimated Insurance"
                  value={insurance}
                  onChange={setInsurance}
                />

                {/* Down payment with $/% toggle */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                    Down Payment
                  </label>
                  <div className="flex gap-1.5">
                    <div className="relative flex-1">
                      {downPaymentType === "flat" ? (
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      ) : (
                        <Percent className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      )}
                      <input
                        type="number"
                        min={0}
                        value={downPaymentInput}
                        onChange={(e) => setDownPaymentInput(e.target.value)}
                        className="w-full pl-9 pr-4 py-2.5 text-sm bg-background rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/30 text-foreground"
                      />
                    </div>
                    <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
                      {(["flat", "percent"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setDownPaymentType(t)}
                          className={`px-2.5 py-2 text-xs font-medium transition-colors ${
                            downPaymentType === t
                              ? "bg-primary text-primary-foreground"
                              : "bg-transparent text-foreground"
                          }`}
                        >
                          {t === "flat" ? "$" : "%"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {downPaymentType === "percent" && downPaymentInputNum > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      = {formatCurrency(downPayment)} of {formatCurrency(patientPortion)}
                    </p>
                  )}
                </div>

                {/* Cash discount — library default, never a hardcoded 5 */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                    Cash Discount %
                  </label>
                  <div className="relative">
                    <Percent className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={cashDiscountDraft ?? String(libraryDefaultDiscount)}
                      onChange={(e) => setCashDiscountDraft(e.target.value)}
                      className="w-full pl-9 pr-4 py-2.5 text-sm bg-background rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/30 text-foreground"
                    />
                  </div>
                  {libraryDefaultDiscount === 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Set a cash discount in Library → Financing to default this
                      for every case.
                    </p>
                  )}
                </div>

                {/* Summary */}
                <div className="pt-2 border-t border-border space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Patient Portion</span>
                    <span className="font-bold text-foreground tabular-nums">
                      {formatCurrency(patientPortion)}
                    </span>
                  </div>
                  {downPayment > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Down Payment</span>
                      <span className="font-medium text-foreground tabular-nums">
                        -{formatCurrency(downPayment)}
                      </span>
                    </div>
                  )}
                  {serviceFee > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        Service Fee ({view.serviceFeePercent}%)
                      </span>
                      <span className="font-medium text-amber-600 dark:text-amber-400 tabular-nums">
                        +{formatCurrency(serviceFee)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Finance Amount</span>
                    <span className="font-bold text-primary tabular-nums">
                      {formatCurrency(financeAmount)}
                    </span>
                  </div>
                  {cashDiscountNum > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        Cash Payment ({cashDiscountNum}% off)
                      </span>
                      <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {formatCurrency(cashPayment)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ── Payment comparison ── */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  Payment Comparison
                </h2>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground" htmlFor="tc-financing-term">
                    Term:
                  </label>
                  <select
                    id="tc-financing-term"
                    value={selectedTerm}
                    onChange={(e) => setSelectedTerm(Number(e.target.value))}
                    className="text-xs px-2 py-1 bg-background rounded border border-border focus:outline-none text-foreground"
                  >
                    {TERM_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t} months
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Pay in Full */}
              <div className="rounded-xl border-2 border-primary bg-primary/5 p-4 mb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-primary">
                      Pay in Full
                    </div>
                    <div className="text-2xl font-bold mt-0.5 text-foreground tabular-nums" style={{ fontFamily: "Sora, sans-serif" }}>
                      {formatCurrency(cashDiscountNum > 0 ? cashPayment : patientPortion)}
                    </div>
                    {cashDiscountNum > 0 && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Saves {formatCurrency(patientPortion - cashPayment)} with{" "}
                        {cashDiscountNum}% cash discount
                      </div>
                    )}
                  </div>
                  {cashDiscountNum > 0 && (
                    <div className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Best value
                    </div>
                  )}
                </div>
              </div>

              {/* Disclaimer */}
              <p className="text-[11px] text-muted-foreground mb-3 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Monthly payment estimates are for illustration purposes only and
                are subject to lender approval. Actual terms may vary based on
                creditworthiness.
              </p>

              {/* Provider rows */}
              {view.providers.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  {view.configured
                    ? "No financing providers enabled — enable them in Library → Financing."
                    : "No financing providers configured — set them up in Library → Financing."}
                </div>
              ) : eligibleProviders.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No providers available for this amount — every enabled provider
                  has a higher minimum.
                </p>
              ) : (
                <div className="space-y-3">
                  {eligibleProviders.map((provider) => (
                    <ProviderRow
                      key={provider.key}
                      provider={provider}
                      view={view}
                      financeAmount={financeAmount}
                      downPayment={downPayment}
                      selectedTerm={selectedTerm}
                      expanded={expandedProvider === provider.key}
                      onToggle={() =>
                        setExpandedProvider(
                          expandedProvider === provider.key ? null : provider.key,
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </div>

            {/* TC script */}
            <div className="tc-script-card">
              <div className="text-xs font-semibold mb-2 text-primary">
                TC SCRIPT — PRESENTING FINANCING
              </div>
              <p className="text-sm italic text-foreground/80">
                &quot;Here are a few ways we can make this work for you. Most of
                our patients choose a monthly payment option — it lets you start
                your treatment right away without waiting.
                {scriptProvider &&
                  ` For example, with ${scriptProvider.name}, you're looking at about ${formatCurrency(
                    amortize(financeAmount, 0, selectedTerm).monthly,
                  )} a month —`}
                {!scriptProvider && " —"} that&apos;s less than a car payment for
                a healthy smile that lasts a lifetime.&quot;
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1.5">{label}</label>
      <div className="relative">
        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm bg-background rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/30 text-foreground"
        />
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  view,
  financeAmount,
  downPayment,
  selectedTerm,
  expanded,
  onToggle,
}: {
  provider: AdaptedFinancingProvider;
  view: FinancingLibraryView;
  financeAmount: number;
  downPayment: number;
  selectedTerm: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { promoEnabled, promoApr, regularApr } = getProviderRateDetails(
    provider,
    view.overrides,
  );
  const isPromo = promoEnabled && provider.promoTerms.includes(selectedTerm);
  const apr = getEffectiveApr(provider, selectedTerm, view.overrides);
  const { monthly } = amortize(financeAmount, apr, selectedTerm);
  const total = monthly * selectedTerm + downPayment;

  return (
    <div
      className={`financing-option-card p-0 overflow-hidden ${
        expanded ? "border-primary/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-4 hover:bg-muted/30 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
              style={{ background: provider.color }}
            >
              {provider.logo}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">{provider.name}</div>
              <div className="text-xs text-muted-foreground truncate">{provider.description}</div>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xl font-bold text-foreground tabular-nums" style={{ fontFamily: "Sora, sans-serif" }}>
              {formatCurrency(monthly)}
              <span className="text-xs font-normal text-muted-foreground">/mo</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {selectedTerm} mo · {apr === 0 ? "0% APR" : `${apr}% APR`}
              {isPromo && promoApr === 0 && (
                <span className="text-emerald-600 dark:text-emerald-400 ml-1">✓ Promo</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              Total: {formatCurrency(total)}
            </div>
          </div>
        </div>
        {downPayment > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Down: {formatCurrency(downPayment)} + {formatCurrency(monthly)}/mo × {selectedTerm}
          </div>
        )}
      </button>

      {/* Read-only rate details — editing lives in Library → Financing */}
      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border bg-muted/20">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Promotional Rate</div>
              {promoEnabled && provider.promoTerms.length > 0 ? (
                <>
                  <div className="text-sm font-semibold text-foreground">{promoApr}% APR</div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Applies to: {provider.promoTerms.map((t) => `${t}mo`).join(", ")}
                  </p>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">Not offered</div>
              )}
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Regular Rate</div>
              <div className="text-sm font-semibold text-foreground">{regularApr}% APR</div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Applies to:{" "}
                {provider.terms
                  .filter((t) => !(promoEnabled && provider.promoTerms.includes(t)))
                  .map((t) => `${t}mo`)
                  .join(", ") || "—"}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground mt-3">
            Minimum amount: {fmtUSD0(provider.minAmount)} · Rates are managed in
            Library → Financing.
          </p>
        </div>
      )}
    </div>
  );
}
