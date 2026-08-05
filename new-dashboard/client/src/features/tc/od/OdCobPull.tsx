/**
 * "Pull from Open Dental" for the COB calculator.
 *
 * Ported from the legacy FloatingCalc pull (TC-app client/src/components/
 * FloatingCalc.tsx ~1140–1440): find a patient, read their treatment-planned
 * procedures and both insurance plans, and pre-fill the calculator with
 * REMAINING max and REMAINING deductible rather than the plan's headline
 * numbers — which is the whole reason the pull exists.
 *
 * The OD Cloud API does expose /claimprocs, so this is a faithful port of the
 * legacy MySQL behaviour rather than an approximation: contracted allowed
 * amounts (fee − WriteOffEst) and year-to-date usage come from the same rows the
 * legacy query read, with the same DateCP basis.
 *
 * What the panel must still say out loud:
 *   - lines where Open Dental has NO write-off estimate fall back to the billed
 *     fee. The server counts them (`fallbackLines`) and the warning below is the
 *     same one the legacy app showed for its own claimproc-less lines.
 *   - remaining max and deductible do not subtract claims that are sent but not
 *     yet paid. The server's `ytdBasis` sentence is printed VERBATIM rather than
 *     paraphrased, so the caveat cannot drift away from the number it qualifies.
 *
 * The panel never hides a gap to look tidier: a pre-filled number the user
 * cannot trace is worse than a blank one, because they will quote it.
 */
import { useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Download, Loader2, RotateCcw } from "lucide-react";
import {
  isOdNotConnected,
  odCobProcedures,
  odInsurance,
  tcErrorMessage,
  type OdCobResult,
  type OdCoverage,
  type OdInsurancePlan,
  type OdInsuranceSnapshot,
  type OdPatient,
} from "../api";
import { OdCoverageNotes, OdError, OdNotConnected, OdPatientSearch } from "./OdShell";
import { describeCode } from "./odCodes";

/** Everything the calculator learns from one pull. */
export interface OdCobPullResult {
  patient: OdPatient;
  cob: OdCobResult;
  insurance: OdInsuranceSnapshot;
  /** Sum of OD's own primary+secondary estimates, for the cross-check pill. */
  odEstimateTotal: number | null;
  /** Lines whose allowed amount fell back to the billed fee. */
  fallbackCount: number;
  coverage: OdCoverage[];
  notes: string[];
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** One plan's remaining-benefit line, or an honest reason it isn't shown. */
function PlanBasis({ plan }: { plan: OdInsurancePlan }) {
  const label = plan.role === "primary" ? "Primary" : "Secondary";
  const carrier = plan.carrierName || plan.groupName || "carrier not on file";

  if (!plan.usage) {
    return (
      <p className="text-[10px] text-muted-foreground">
        <strong>{label}</strong> ({carrier}) — year-to-date usage unavailable, so remaining max and
        deductible could not be computed. Enter them by hand.
      </p>
    );
  }

  const maxLine =
    plan.annualMax != null
      ? `${money(plan.usage.paidYTD)} of ${money(plan.annualMax)} used`
      : `${money(plan.usage.paidYTD)} paid (no annual maximum on file)`;
  const dedLine =
    plan.deductible != null
      ? `${money(plan.usage.dedAppliedYTD)} of ${money(plan.deductible)} deductible met`
      : `${money(plan.usage.dedAppliedYTD)} applied to deductible (no deductible on file)`;

  return (
    <p className="text-[10px] text-muted-foreground">
      <strong>{label}</strong> ({carrier}) — {maxLine} · {dedLine}, since{" "}
      {plan.usage.benefitYearStart} ({plan.usage.basis}, {plan.usage.claimCount} claim
      {plan.usage.claimCount === 1 ? "" : "s"}).
    </p>
  );
}

export function OdCobPull({
  office,
  onPulled,
  onClear,
  pulled,
}: {
  office: OfficeId;
  onPulled: (result: OdCobPullResult) => void;
  onClear: () => void;
  pulled: OdCobPullResult | null;
}) {
  const [patient, setPatient] = useState<OdPatient | null>(pulled?.patient ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [searching, setSearching] = useState(false);

  async function pull(p: OdPatient) {
    setPatient(p);
    setSearching(false);
    setLoading(true);
    setError(null);
    try {
      // Both reads are independent; run them together so one slow leg doesn't
      // double the wait. Either failing is a real failure — a half-filled
      // calculator is worse than none.
      const [cob, insurance] = await Promise.all([
        odCobProcedures(office, p.patNum),
        odInsurance(office, p.patNum),
      ]);

      const odEstimateTotal = cob.procs.some((x) => x.hasPrimaryEstimate || x.hasSecondaryEstimate)
        ? cob.procs.reduce((sum, x) => sum + (x.primaryInsEst || 0) + (x.secondaryInsEst || 0), 0)
        : null;

      onPulled({
        patient: p,
        cob,
        insurance,
        odEstimateTotal,
        fallbackCount: cob.fallbackLines,
        coverage: [...cob.coverage, ...insurance.coverage],
        notes: [...cob.notes, ...insurance.notes],
      });
    } catch (e: unknown) {
      if (isOdNotConnected(e)) {
        setNotConnected(true);
      } else {
        setError(tcErrorMessage(e));
      }
      setPatient(null);
    } finally {
      setLoading(false);
    }
  }

  if (notConnected) {
    return (
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-xs font-bold text-foreground">Pull from Open Dental</p>
        <OdNotConnected />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-foreground">Pull from Open Dental</p>
          <p className="text-[10px] text-muted-foreground">
            Reads the patient&apos;s treatment plan and both insurance plans. Read-only — nothing is
            written back to Open Dental.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSearching((v) => !v)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-1 h-4 w-4" />
            )}
            {pulled ? "Pull another" : "Pull"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setPatient(null);
              setSearching(false);
              setError(null);
              onClear();
            }}
          >
            <RotateCcw className="mr-1 h-4 w-4" /> Clear
          </Button>
        </div>
      </div>

      {searching && !loading && (
        <OdPatientSearch
          office={office}
          autoFocus
          onSelect={(p) => void pull(p)}
          label="Find the patient in Open Dental"
        />
      )}

      {error && <OdError message={error} onRetry={patient ? () => void pull(patient) : undefined} />}

      {pulled && (
        <div className="space-y-2 border-t border-border pt-2">
          <p className="text-xs font-medium text-foreground">
            {pulled.patient.displayName}
            <span className="ml-2 font-normal text-muted-foreground">
              PatNum {pulled.patient.patNum}
              {pulled.patient.birthdate ? ` · DOB ${pulled.patient.birthdate}` : ""}
            </span>
          </p>

          {pulled.cob.procs.length > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {pulled.cob.procs.length} treatment-planned procedure
              {pulled.cob.procs.length === 1 ? "" : "s"} loaded
              {pulled.cob.procs[0]
                ? ` — first: ${describeCode(pulled.cob.procs[0].procCode, pulled.cob.procs[0].description)}`
                : ""}
              .
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              No treatment-planned procedures for this patient in Open Dental.
            </p>
          )}

          {/* The YTD basis hint — the number under Max Remaining is only as good
              as the sentence that explains where it came from. */}
          <p className="rounded-md bg-muted/40 p-2 text-[10px] text-muted-foreground">
            {pulled.insurance.ytdBasis}
          </p>
          {pulled.insurance.plans.map((p) => (
            <PlanBasis key={`${p.ordinal}-${p.patPlanNum}`} plan={p} />
          ))}
          {pulled.insurance.plans.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              No insurance plans are attached to this patient in Open Dental — enter the plan
              details by hand.
            </p>
          )}

          {pulled.fallbackCount > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-300">
              ⚠ {pulled.fallbackCount} line{pulled.fallbackCount === 1 ? "" : "s"} had no write-off
              estimate in Open Dental — the billed fee was used as the allowed amount. Override the
              per-line allowed amount for accuracy on fee-schedule contracts.
            </div>
          )}

          <OdCoverageNotes coverage={pulled.coverage} notes={pulled.notes} />
        </div>
      )}
    </div>
  );
}
