/**
 * /api/tc/opportunities — the Opportunities inbox (queue item 41).
 *
 * Its own api file (like features/tc/messaging) so the shared, CRLF,
 * many-hands `features/tc/api.ts` only had to export `tcRequest`.
 *
 * Every read here is the nightly sync's SNAPSHOT in Postgres. Nothing on this
 * page asks Open Dental anything — that is what keeps the shared 1 req/s
 * credential free for the people using it.
 */
import type { OfficeId } from "@shared/tc/contract";
import { tcRequest, type TcPhaseCreate } from "../api";
import { groupItemsIntoPhases, itemsFromOdProcedures, stripReviewFields } from "../od/odPlan";

/**
 * tc_opportunities.status. Mirrors the migration's CHECK literals; the vitest
 * `tc-opportunities.test.tsx` reads the migration file and pins the two equal.
 */
export const OPPORTUNITY_STATUSES = ["new", "claimed", "dismissed", "existing_case"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type OpportunityStatusFilter = OpportunityStatus | "all";

export interface OpportunityProcedure {
  procNum: number;
  code: string;
  description: string;
  /** Integer cents — converted from OD dollars once, by the sync. */
  feeCents: number;
  tooth: string;
  surf: string;
  plannedDate: string | null;
}

export interface TcOpportunity {
  opportunityId: string;
  officeId: OfficeId;
  /** Only meaningful WITH officeId — PatNum numbering restarts per database. */
  odPatientId: number;
  /** null until the nightly name pass reaches this patient. */
  patientName: string | null;
  patientPhone: string | null;
  procedures: OpportunityProcedure[];
  valueCents: number;
  plannedDate: string | null;
  status: OpportunityStatus;
  claimedCaseId: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  dismissedReason: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  resurrectedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface OpportunitySyncState {
  /** The last sweep that COMPLETED. A failure never moves it. */
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: "ok" | "partial" | "failed" | null;
  lastError: string | null;
  proceduresScanned: number | null;
  patients: number | null;
  namesPending: number | null;
}

export interface OpportunitiesList {
  opportunities: TcOpportunity[];
  /** Over every matching row, not just the returned page. */
  totals: { count: number; valueCents: number };
  truncated: boolean;
  /** null = this office has never been synced. */
  sync: OpportunitySyncState | null;
}

export function listOpportunities(
  office: OfficeId,
  status: OpportunityStatusFilter = "new",
): Promise<OpportunitiesList> {
  return tcRequest<OpportunitiesList>("/tc/opportunities", { office, params: { status } });
}

export interface ClaimResult {
  caseId: string;
  url: string;
  /** true = joined the patient's open case; false = a new case was created. */
  attached: boolean;
  opportunity: TcOpportunity | null;
}

/**
 * The phase tree a claim proposes, built by THE implementation of the TC
 * grouping rules (od/odPlan.ts: inferUrgency + groupItemsIntoPhases) — the
 * same path the "Pull treatment plan from Open Dental" dialog uses. The server
 * verifies it against its snapshot; it does not re-derive it.
 */
export function phasesForOpportunity(opp: Pick<TcOpportunity, "procedures">): TcPhaseCreate[] {
  const items = itemsFromOdProcedures(
    opp.procedures.map((p) => ({
      procNum: p.procNum,
      toothNum: p.tooth || "N/A",
      surf: p.surf,
      procCode: p.code,
      description: p.description,
      fee: p.feeCents / 100,
      insEst: 0,
      patAmt: p.feeCents / 100,
    })),
  );
  return groupItemsIntoPhases(stripReviewFields(items));
}

export function claimOpportunity(office: OfficeId, opp: TcOpportunity): Promise<ClaimResult> {
  return tcRequest<ClaimResult>(`/tc/opportunities/${opp.opportunityId}/claim`, {
    office,
    method: "POST",
    body: { phases: phasesForOpportunity(opp) },
  });
}

export function dismissOpportunity(
  office: OfficeId,
  opportunityId: string,
  reason: string,
): Promise<{ opportunity: TcOpportunity | null }> {
  return tcRequest<{ opportunity: TcOpportunity | null }>(
    `/tc/opportunities/${opportunityId}/dismiss`,
    { office, method: "POST", body: { reason } },
  );
}

/** "$2,300.50" from cents. */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
