/**
 * WHAT OPEN DENTAL WAS READ BACK AS HOLDING, PER CLAIM (S5).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The two endings of a post — FINISHED and STUCK — both have to say what a
 * patient owes. The only figure allowed on either is one the drain MEASURED:
 * its `confirm_patient` step reads each claim back out of Open Dental and
 * records `verdictFor`'s CONFIRMED-register result on the claim row. The claim
 * detail route already serves that verdict (`GET /claims/:id`, `verdict` +
 * `confirmedAt`), from CareIN's own database, with no Open Dental call.
 *
 * Before this, the finished panel printed the figure the check PROMISED under a
 * heading that said it had been read out of the chart. On a posted check those
 * two are equal by construction — but "equal by construction" is a projection's
 * argument, and the register on that screen claims a measurement. So the
 * figures now come from the measurement, and when the measurement is not in
 * hand the screen does not quote a patient figure at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO NEW ENDPOINT, AND NO OPEN DENTAL CALL
 * ─────────────────────────────────────────────────────────────────────────────
 * One `getClaim` per claim on the check — usually one to three — and nothing
 * else. Failure-tolerant: a read that fails leaves the screen saying less, never
 * saying something it could not stand behind.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useEffect, useState } from "react";
import { getClaim, type ClaimVerdict, type RcmOfficeId } from "./api";
import { money } from "./format";

/** One claim's measured verdict, and the chart identifiers a fix step names. */
export interface ConfirmedClaim {
  claimId: string;
  /** PHI — rendered, never logged. */
  patientName: string | null;
  odPatientId: number | null;
  odClaimNum: number | null;
  /** Always in the CONFIRMED register — anything else is not collected. */
  verdict: ClaimVerdict;
  confirmedAt: string | null;
}

export type ConfirmedRead =
  | { status: "loading" }
  /**
   * `missing` names the claims that carry NO confirmed verdict — posted before
   * B2 froze a promise, or never reached `confirm_patient`. A total over a set
   * with gaps would understate, so callers treat any gap as "not measured".
   */
  | { status: "loaded"; claims: ConfirmedClaim[]; missing: string[] }
  | { status: "failed" };

/**
 * Read each claim's confirmed verdict. `enabled: false` reads nothing — the
 * stopped branch of a stuck check must not go looking for a measurement that,
 * by definition, was never taken.
 */
export function useConfirmedClaims(
  office: RcmOfficeId,
  claimIds: readonly string[],
  enabled = true,
): ConfirmedRead {
  const [read, setRead] = useState<ConfirmedRead>({ status: "loading" });
  /** A stable key, so the effect does not re-run on every render. */
  const key = claimIds.join(",");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setRead({ status: "loading" });
    const ids = key ? key.split(",") : [];
    Promise.all(ids.map((id) => getClaim(office, id))).then(
      (responses) => {
        if (cancelled) return;
        const claims: ConfirmedClaim[] = [];
        const missing: string[] = [];
        for (const r of responses) {
          const c = r.claim;
          if (c.verdict && c.verdict.register === "confirmed") {
            claims.push({
              claimId: c.claimId,
              patientName: c.patientName ?? null,
              odPatientId: c.odPatientId ?? null,
              odClaimNum: c.odClaimNum ?? null,
              verdict: c.verdict,
              confirmedAt: c.confirmedAt ?? null,
            });
          } else {
            missing.push(c.claimId);
          }
        }
        setRead({ status: "loaded", claims, missing });
      },
      () => {
        if (!cancelled) setRead({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [office, key, enabled]);

  return read;
}

// ═══════════════════════════════════════════════════════════════════════════
// FINISHED — every claim measured, none of them red
// ═══════════════════════════════════════════════════════════════════════════

export interface MeasuredOutcome {
  /** Sum of what Open Dental says each patient owes, measured. */
  owedCents: number;
  claims: ConfirmedClaim[];
  /** First-seen order, no duplicates. PHI. */
  patients: string[];
}

/**
 * The finished check's measured figures — or null when there is not a full set
 * of green/amber confirmed verdicts to build them from. Null is an answer: the
 * screen then says what the CHECK proved and quotes no patient figure.
 */
export function measuredOutcome(read: ConfirmedRead): MeasuredOutcome | null {
  if (read.status !== "loaded") return null;
  if (read.missing.length > 0 || read.claims.length === 0) return null;
  if (read.claims.some((c) => c.verdict.state === "red")) return null;
  const patients: string[] = [];
  for (const c of read.claims) {
    if (c.patientName && !patients.includes(c.patientName)) patients.push(c.patientName);
  }
  return {
    owedCents: read.claims.reduce((n, c) => n + c.verdict.projectedPatientCents, 0),
    claims: read.claims,
    patients,
  };
}

/** "Test 2, Stedi's chart" / "each patient's chart (A, B)". PHI — rendered only. */
export function chartsPhrase(patients: readonly string[]): string {
  if (patients.length === 0) return "the patient's chart";
  if (patients.length === 1) return `${patients[0]}'s chart`;
  return `each patient's chart (${patients.join(", ")})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// STUCK, MEASURED — what came back other than promised
// ═══════════════════════════════════════════════════════════════════════════

export interface Disagreement {
  claimId: string;
  patientName: string | null;
  odPatientId: number | null;
  odClaimNum: number | null;
  /** What this check said the patient would owe: the EOB less what the office absorbed. */
  promisedCents: number;
  /** What Open Dental was read back as holding. */
  measuredCents: number;
  /** measured − promised. Positive: the patient would be billed MORE. */
  diffCents: number;
  /** The procedure codes the verdict's problems name, deduplicated. */
  codes: string[];
  decidedWriteOffCents: number;
  /**
   * The gap is exactly the write-off this office chose on this claim — the
   * chart has everything except the office's own concession. Only then may the
   * screen say "only the write-off is missing"; any other gap gets a sentence
   * that names the line and claims nothing about why.
   */
  writeOffMissing: boolean;
  /** The server's own sentence for this claim. */
  sentence: string;
}

/**
 * The red confirmed verdicts, as figures. The promise is computed exactly the
 * way the server's own sentence computes it (`verdictSentence`'s confirmed
 * branch: `eob − decided`), so the two can never quote different amounts.
 */
export function disagreementsOf(read: ConfirmedRead): Disagreement[] {
  if (read.status !== "loaded") return [];
  return read.claims
    .filter((c) => c.verdict.state === "red")
    .map((c) => {
      const v = c.verdict;
      const promisedCents = v.eobPatientCents - v.decidedWriteOffCents;
      const diffCents = v.projectedPatientCents - promisedCents;
      const codes: string[] = [];
      for (const p of v.problems) if (p.code && !codes.includes(p.code)) codes.push(p.code);
      return {
        claimId: c.claimId,
        patientName: c.patientName,
        odPatientId: c.odPatientId,
        odClaimNum: c.odClaimNum,
        promisedCents,
        measuredCents: v.projectedPatientCents,
        diffCents,
        codes,
        decidedWriteOffCents: v.decidedWriteOffCents,
        writeOffMissing: v.decidedWriteOffCents > 0 && diffCents === v.decidedWriteOffCents,
        sentence: v.sentence,
      };
    });
}

/** "the D0274 line" / "the D0274, D1110 lines" / "one of its lines". */
export function lineWords(codes: readonly string[]): string {
  if (codes.length === 0) return "one of its lines";
  return `the ${codes.join(", ")} line${codes.length === 1 ? "" : "s"}`;
}

/**
 * THE ONE SENTENCE THAT SAYS WHAT HAPPENS TO A PERSON.
 *
 * Two numbers side by side make a biller do arithmetic to find out whether
 * anybody is hurt. This says it. It names the direction and the amount, and it
 * says "only the write-off is missing" ONLY when the gap is exactly that — a
 * cause this screen can prove from the two figures, never one it guesses.
 */
export function consequenceSentence(d: Disagreement): string {
  const who = d.patientName ?? "The patient";
  const where = lineWords(d.codes);
  if (d.diffCents > 0) {
    return (
      `${who} would be billed ${money(d.diffCents)} more than they should be. ` +
      (d.writeOffMissing
        ? "The payment is fine; only the write-off is missing."
        : `The payment is fine; the difference is on ${where}.`)
    );
  }
  if (d.diffCents < 0) {
    return (
      `${who} would be billed ${money(-d.diffCents)} less than they should be. ` +
      `The payment is fine; the difference is on ${where}.`
    );
  }
  return (
    `The totals agree, but Open Dental and this check disagree about ${where} on ` +
    `${d.patientName ? `${d.patientName}'s` : "the patient's"} claim. The payment is fine.`
  );
}
