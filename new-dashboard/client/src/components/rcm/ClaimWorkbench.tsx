/**
 * The workbench — one claim, the EOB beside the chart, and the patient's number.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller works one claim with the EOB beside Open Dental and decides the
 * write-offs. The number that must reconcile is PATIENT RESPONSIBILITY: what the
 * EOB says the patient owes must equal what Open Dental will say they owe once
 * this posts — with one legitimate exception, a write-off the office chose to
 * make, which lowers the patient's number on purpose and is recorded as a
 * decision. Anything else is a real problem and cannot post.
 *
 * So the screen is three columns of one argument:
 *
 *   LEFT    what the carrier said — billed, allowed, paid, the contractual
 *           write-off it took, and what it says the patient owes
 *   CENTRE  the decision, per line, about that last number only
 *   RIGHT   what Open Dental holds — the patient it is about, and the claim
 *
 * and one verdict line across the top of them saying where the patient's number
 * lands.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING HERE COMPUTES MONEY
 * ═════════════════════════════════════════════════════════════════════════════
 * Every figure is rendered from the server: `contractualWriteOffCents` and
 * `patientRemainderCents` per line, and the whole verdict — including its
 * SENTENCE, already written and already formatted. The approval gate's
 * "The patient's number matches the EOB" check is produced by the same server
 * function, so a green line here beside a refusal there is not a shape this code
 * can reach.
 *
 * That is not fussiness. A client that formats cents itself is a client that
 * shows `$54.8` while the server means `$54.08` — which is exactly the defect
 * D-6's typed confirmation was rewritten to avoid.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONTROL READS AS THREE THINGS AND STORES ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller reads: the carrier took $X off by contract (a fact), and then either
 * bill the patient $R or write $R off. The first is not a choice — this slice
 * always accepts the carrier's contractual figure — so only the second is
 * stored, as one enum.
 *
 * There is NO amount field anywhere on this screen. A line is written off whole
 * or billed whole; the Roland biller has never split one, and an amount box
 * would invite a shape nothing downstream can express.
 *
 * A line whose patient remainder is zero has nothing to decide and renders
 * without the control at all.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  FileText,
  Info,
  Loader2,
  ScanLine,
  Search,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { Link } from "wouter";
import {
  type ClaimDetailResponse,
  type ClaimIdentity,
  type ClaimLine,
  type ClaimVerdict,
  type LineDecision,
  type MatchCandidate,
  type MatchSnapshot,
  type WorkbenchClaim,
} from "@/features/rcm/api";
import {
  day,
  evidenceTone,
  lineFlagLabel,
  lineFlagTone,
  money,
  NO_ACTION_REASONS,
  reviewReasonLabel,
  stamp,
} from "@/features/rcm/format";
import { provenanceLabel, provenanceNote } from "@/features/rcm/labels";
import { approveHref } from "@/features/rcm/flow";
import DisabledReason from "@/components/rcm/DisabledReason";

/**
 * `claim` is the DETAIL claim, not `WorkbenchClaim`.
 *
 * The verdict, the identity comparison and the chart-as-read only exist on the
 * detail read — the list shape deliberately carries none of them, because they
 * are assembled from the match snapshot and would put the module's largest PHI
 * object on the cheapest screen once per row.
 */
export interface ClaimWorkbenchProps {
  data: ClaimDetailResponse;
  claim: ClaimDetailResponse["claim"];
  snapshot: MatchSnapshot | null;
  note: string;
  setNote: (value: string) => void;
  busy: "match" | "confirm" | "review" | "decide" | null;
  mayRerun: boolean;
  /**
   * May this person record a decision, and if not, WHY NOT.
   *
   * Two causes, and they are different sentences: the claim is frozen because
   * somebody approved it (D-14), or this tier does not do the reviewing. A
   * single boolean collapsed them and told an approver that an approved claim
   * was a permission problem, which sends her to ask somebody for access she
   * already has.
   */
  mayDecide: boolean;
  decideBlockedBy: "approved" | "permission" | null;
  fromBatchId: string | null;
  /** Which claim on the check this is, and how to walk to the next one. */
  siblings: { index: number; total: number; prevId: string | null; nextId: string | null } | null;
  onRunMatch: (force: boolean) => void;
  onReview: () => void;
  onConfirm: (odClaimNum: number) => void;
  onDecide: (lineId: string, decision: LineDecision, reason: string | null) => void;
  /** The document this claim's numbers were read from, when there is one. */
  documentHref: string | null;
}

export default function ClaimWorkbench({
  data,
  claim,
  snapshot,
  note,
  setNote,
  busy,
  mayRerun,
  mayDecide,
  decideBlockedBy,
  fromBatchId,
  siblings,
  onRunMatch,
  onReview,
  onConfirm,
  onDecide,
  documentHref,
}: ClaimWorkbenchProps) {
  const verdict = claim.verdict ?? null;
  const identity = claim.identity ?? null;
  // B2. Null until this claim has posted and its chart has been read back.
  const confirmedAt = claim.confirmedAt ?? null;
  const chart = claim.chart ?? null;

  return (
    <div className="mt-4" data-testid="claim-workbench">
      {/*
        ── THE VERDICT, ACROSS THE TOP ─────────────────────────────────────────
        First, because it is the answer every other panel is evidence for. A
        biller who reads nothing else on this screen should still be able to tell
        whether the patient's number is right.
      */}
      <VerdictLine
        verdict={verdict}
        identityBlocking={identity?.blocking ?? false}
        confirmedAt={confirmedAt}
      />

      {siblings && siblings.total > 1 && (
        <ClaimPager siblings={siblings} fromBatchId={fromBatchId} />
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CarrierPanel
          claim={claim}
          provenance={data.claim.provenance}
          documentHref={documentHref}
          verdict={verdict}
          reasons={data.writeoffReasons}
          busy={busy}
          mayDecide={mayDecide}
          decideBlockedBy={decideBlockedBy}
          onDecide={onDecide}
        />

        <div className="space-y-4">
          <IdentityPanel identity={identity} matchStatus={claim.odMatchStatus} />
          <ChartPanel
            claim={claim}
            chart={chart}
            snapshot={snapshot}
            busy={busy}
            mayRerun={mayRerun}
            fromBatchId={fromBatchId}
            onRunMatch={onRunMatch}
            onConfirm={onConfirm}
            rules={data.matchRules}
          />
          <ReviewBox
            claim={claim}
            note={note}
            setNote={setNote}
            busy={busy === "review"}
            onSave={onReview}
          />
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE VERDICT LINE
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Where the patient's number lands, in one sentence the server wrote.
 *
 * Three states, and the copy for each says something different about WHY:
 * green means the two agree, amber means they differ on purpose and names the
 * lines, red means they differ and nobody has said why.
 *
 * The sentence is rendered VERBATIM. Nothing here re-derives it, chooses between
 * tenses, or formats a cent — the server owns which register it is in
 * (a projection before posting, a confirmation after) and this cannot get that
 * wrong by having no opinion about it.
 */
function VerdictLine({
  verdict,
  identityBlocking,
  confirmedAt,
}: {
  verdict: ClaimVerdict | null;
  /**
   * A separate question with a separate answer, and the verdict has to admit it.
   *
   * The verdict is about the NUMBER; identity is about WHO. They can disagree
   * honestly — the arithmetic can be perfect on the wrong person's chart — but
   * "Patient will owe $480.00 once posted" over a panel saying nothing can post
   * is a projection stated with more confidence than it has earned, and the
   * trust anchor is the one line on this screen that must never do that.
   */
  identityBlocking: boolean;
  /**
   * When the chart was read back, on a claim that has posted (B2). Null before
   * that, and the verdict's own register is what actually decides the wording —
   * this only says WHEN the reading happened.
   */
  confirmedAt: string | null;
}) {
  if (!verdict) {
    return (
      <div
        className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-testid="verdict-unknown"
      >
        The patient's number cannot be worked out until this claim is matched to Open Dental.
      </div>
    );
  }

  const TONE: Record<ClaimVerdict["state"], string> = {
    green:
      "border-emerald-300 bg-emerald-50/70 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
    amber:
      "border-amber-300 bg-amber-50/70 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
    red: "border-rose-300 bg-rose-50/70 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200",
  };
  const Icon =
    verdict.state === "green" ? CheckCircle2 : verdict.state === "amber" ? Info : AlertTriangle;

  return (
    <div
      className={`rounded-xl border-2 px-4 py-3 ${TONE[verdict.state]}`}
      data-testid="verdict-line"
      data-verdict={verdict.state}
    >
      <div className="flex items-start gap-2">
        <Icon size={17} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          {/* The server's own words. Never re-derived here — see the header. */}
          <p className="text-sm font-medium" data-testid="verdict-sentence">
            {verdict.sentence}
          </p>

          {/*
            AMBER LISTS WHAT WAS DECIDED. The whole point of amber is that the
            difference is deliberate, and "deliberate" is only true if somebody
            can read who decided it and why, months later, without opening a
            second screen.
          */}
          {verdict.state === "amber" && verdict.decisions.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs" data-testid="verdict-decisions">
              {verdict.decisions.map((d, i) => (
                <li key={d.lineId ?? i} className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-mono font-medium">{d.code || "—"}</span>
                  <span className="font-mono tabular-nums">{money(d.amountCents)}</span>
                  <span>· {d.reasonLabel ?? d.reason ?? "no reason recorded"}</span>
                  <span className="opacity-75">
                    · {d.decidedBy ?? "unattributed"}
                    {d.decidedAt ? ` ${stamp(d.decidedAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            RED NAMES THE LINES. A verdict that says the numbers disagree and
            leaves a biller to find where is a verdict she will learn to skip.
          */}
          {verdict.state === "red" && verdict.problems.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs" data-testid="verdict-problems">
              {verdict.problems.map((p, i) => (
                <li key={`${p.kind}-${p.lineId ?? i}`}>· {p.detail}</li>
              ))}
            </ul>
          )}

          {/*
            THE SAME RED, TWO DIFFERENT FACTS.
 
            Before posting, red is a claim that cannot be approved and nothing
            has happened. After posting, money is already in the chart — telling
            her it "cannot be approved" would be describing a step that is behind
            her, and would read as though nothing had moved.
          */}
          {verdict.state === "red" && (
            <p className="mt-2 text-xs font-medium" data-testid="verdict-cannot-approve">
              {verdict.register === "confirmed"
                ? "The payment is already in the chart. Nothing more posts on this check until this is sorted out."
                : "This claim cannot be approved until that is resolved."}
            </p>
          )}

          {identityBlocking && (
            <p className="mt-2 text-xs font-medium" data-testid="verdict-identity-caveat">
              …but nothing will post until the patient below is sorted out.
            </p>
          )}
        </div>
      </div>

      {/* The three figures behind the sentence, always, in the same order. */}
      <dl
        className="mt-3 grid grid-cols-3 gap-3 border-t border-current/20 pt-2 text-xs"
        data-testid="verdict-figures"
      >
        {/*
          THE PAIR THAT HAS TO MATCH, AND IT IS NOT THE SAME PAIR IN BOTH
          REGISTERS.

          Before posting: the EOB's own figure beside what the patient will be
          billed. After posting the EOB's raw total is the WRONG left-hand
          number — the office's write-offs are meant to differ from it — so the
          strip would print $480 beside $480 under a red banner whose sentence
          names $450, and a biller reading the figures could not find the number
          she was being told about. The shot caught exactly that.

          So the confirmed register shows what this check SAID (the EOB less
          what the office absorbed) beside what Open Dental now holds. Those two
          are the ones that must agree, and the third column still says where
          the difference from the EOB went.
        */}
        <Figure
          label={
            verdict.register === "confirmed"
              ? "This check said the patient would owe"
              : "EOB says the patient owes"
          }
          value={money(
            verdict.register === "confirmed"
              ? verdict.eobPatientCents - verdict.decidedWriteOffCents
              : verdict.eobPatientCents,
          )}
        />
        <Figure
          /*
            A tense, not a label. Before posting this figure is what the patient
            WILL be billed; afterwards it is what Open Dental was read back as
            holding, and the two must never be worded the same way.
          */
          label={
            verdict.register === "confirmed"
              ? "Open Dental says the patient owes"
              : "Patient will be billed"
          }
          value={money(verdict.projectedPatientCents)}
          strong
        />
        <Figure label="Office is absorbing" value={money(verdict.decidedWriteOffCents)} />
      </dl>

      {verdict.register === "confirmed" && confirmedAt && (
        <p className="mt-2 text-[11px] opacity-80" data-testid="verdict-confirmed-at">
          As Open Dental had it {stamp(confirmedAt)}.
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="opacity-80">{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? "text-sm font-semibold" : "text-sm"}`}>
        {value}
      </dd>
    </div>
  );
}

/** Which claim on this check, and the way to the next one. */
function ClaimPager({
  siblings,
  fromBatchId,
}: {
  siblings: NonNullable<ClaimWorkbenchProps["siblings"]>;
  fromBatchId: string | null;
}) {
  const href = (id: string) =>
    `/rcm/claims/${encodeURIComponent(id)}${fromBatchId ? `?from=${encodeURIComponent(fromBatchId)}` : ""}`;
  return (
    <div
      className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs"
      data-testid="claim-pager"
    >
      <span className="text-muted-foreground">
        Claim {siblings.index + 1} of {siblings.total} on this check
      </span>
      <span className="flex items-center gap-2">
        {siblings.prevId ? (
          <Link
            href={href(siblings.prevId)}
            data-testid="claim-prev"
            className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded border border-border px-2 py-1 text-muted-foreground/60">
            Previous
          </span>
        )}
        {siblings.nextId ? (
          <Link
            href={href(siblings.nextId)}
            data-testid="claim-next"
            className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted"
          >
            Next
          </Link>
        ) : (
          <span className="rounded border border-border px-2 py-1 text-muted-foreground/60">
            Next
          </span>
        )}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   LEFT — WHAT THE CARRIER SAID, AND THE DECISION ABOUT IT
   ══════════════════════════════════════════════════════════════════════════════ */

function CarrierPanel({
  claim,
  provenance,
  documentHref,
  verdict,
  reasons,
  busy,
  mayDecide,
  decideBlockedBy,
  onDecide,
}: {
  claim: ClaimDetailResponse["claim"];
  provenance: ClaimDetailResponse["claim"]["provenance"];
  documentHref: string | null;
  verdict: ClaimVerdict | null;
  reasons: { slug: string; label: string }[];
  busy: ClaimWorkbenchProps["busy"];
  mayDecide: boolean;
  decideBlockedBy: ClaimWorkbenchProps["decideBlockedBy"];
  onDecide: ClaimWorkbenchProps["onDecide"];
}) {
  /*
   * IS THERE A CHART BEHIND THIS DECISION YET? — Stage C-3, item 4.
   *
   * Deciding a write-off is allowed on an unmatched claim and STAYS allowed: the
   * decision is about the remittance's own line, it writes four columns on one of
   * our rows, and the approval gate refuses to post an unmatched claim anyway. So
   * this is not a lock. Nothing here disables anything.
   *
   * It is a caution, because on 2026-08-31 a $480 office write-off was recorded
   * against a claim with no chart behind it and not one thing on the screen
   * remarked on it. "The office absorbs this" is a sentence about a PATIENT, and
   * until this claim is linked nobody has said which patient that is.
   */
  const notLinked = claim.odMatchStatus !== "confirmed";

  return (
    <section data-testid="claim-parsed">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What the carrier said
        </h2>
        {/*
          ONE CLICK TO THE PAPER. The reason a biller checks a figure is that she
          doubts it, and the thing that settles it is the image the numbers were
          read from. Rendered only when there IS one — an 835 was parsed, not
          scanned, and offering a document that does not exist is worse than
          offering none.
        */}
        {documentHref && (
          <a
            href={documentHref}
            target="_blank"
            rel="noreferrer"
            data-testid="open-source-document"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            <FileText size={13} />
            Open the EOB
          </a>
        )}
      </div>

      <div className="mt-2 rounded-xl border border-border bg-card">
        {provenanceLabel(provenance) && (
          <div
            className="flex items-start gap-2 border-b border-border px-4 py-2.5 text-xs text-muted-foreground"
            data-testid="claim-provenance"
          >
            <ScanLine size={13} className="mt-0.5 shrink-0" />
            <span>
              {provenanceLabel(provenance)}
              {provenanceNote(provenance) && <> · {provenanceNote(provenance)}</>}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 border-b border-border p-4 sm:grid-cols-4">
          <Fact label="Billed" value={money(claim.totalBilledCents)} />
          <Fact label="Allowed" value={money(claim.totalAllowedCents)} />
          <Fact label="Carrier paid" value={money(claim.totalPaidCents)} strong />
          <Fact
            label="Patient owes"
            value={money(verdict ? verdict.eobPatientCents : claim.patientBalanceCents)}
          />
        </div>

        {claim.needsReviewReasons.length > 0 && (
          <div className="border-b border-border p-4" data-testid="claim-review-reasons">
            <div className="flex flex-wrap gap-1.5">
              {claim.needsReviewReasons.map((reason) => (
                <span
                  key={reason}
                  className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                >
                  <AlertTriangle size={11} />
                  {reviewReasonLabel(reason)}
                </span>
              ))}
            </div>
            {claim.needsReviewReasons.some((r) => NO_ACTION_REASONS.has(r)) && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <CircleSlash size={12} className="mt-0.5 shrink-0" />
                CareIN will not post this one. Handle it in Open Dental directly — a takeback
                cannot be reversed once written.
              </p>
            )}
          </div>
        )}

        <ul className="divide-y divide-border" data-testid="carrier-lines">
          {claim.lines.map((line) => (
            <CarrierLine
              key={line.lineId}
              line={line}
              reasons={reasons}
              busy={busy}
              mayDecide={mayDecide}
              decideBlockedBy={decideBlockedBy}
              notLinked={notLinked}
              onDecide={onDecide}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * One line of the carrier's adjudication, and the decision about its remainder.
 *
 * The four numbers read left to right the way a biller reads a remittance:
 * billed, allowed, paid, and what that leaves the patient. The contractual
 * write-off sits under them as a FACT — labelled as the carrier's, with no
 * control beside it, because this slice always accepts it.
 */
function CarrierLine({
  line,
  reasons,
  busy,
  mayDecide,
  decideBlockedBy,
  notLinked,
  onDecide,
}: {
  line: ClaimLine;
  reasons: { slug: string; label: string }[];
  busy: ClaimWorkbenchProps["busy"];
  mayDecide: boolean;
  decideBlockedBy: ClaimWorkbenchProps["decideBlockedBy"];
  /** No Open Dental claim behind this one yet — a caution, never a lock. */
  notLinked: boolean;
  onDecide: ClaimWorkbenchProps["onDecide"];
}) {
  const remainder = line.patientRemainderCents;
  const writtenOff = line.decision === "office_writeoff";

  return (
    <li className="p-4" data-testid={`carrier-line-${line.lineId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-sm text-foreground">{line.billedCode}</div>
          {line.paidCode && line.paidCode !== line.billedCode && (
            <div className="font-mono text-xs text-amber-700 dark:text-amber-400">
              submitted as {line.paidCode}
            </div>
          )}
          <div className="text-xs text-muted-foreground">{line.description}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {line.flags.map((flag) => (
              <span
                key={flag}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${lineFlagTone(flag)}`}
              >
                {lineFlagLabel(flag)}
              </span>
            ))}
          </div>
          {line.adjustments.map((adj) => (
            <div key={adj.adjustmentId} className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono" title={adj.groupDescription ?? undefined}>
                {adj.groupCode}-{adj.reasonCode}
              </span>{" "}
              {money(adj.amountCents)}
              {adj.reasonDescription ? ` — ${adj.reasonDescription}` : ""}
            </div>
          ))}
        </div>

        <dl className="grid shrink-0 grid-cols-4 gap-x-3 text-right text-xs">
          <Amount label="Billed" cents={line.billedCents} />
          <Amount label="Allowed" cents={line.allowedCents} />
          <Amount label="Paid" cents={line.paidCents} strong />
          <Amount label="Patient" cents={remainder} />
        </dl>
      </div>

      {/*
        THE CARRIER'S OWN WRITE-OFF, AS A FACT.
        No control, and labelled as the carrier's rather than as "write-off" on
        its own — the whole screen turns on the difference between the one the
        contract took and the one this office chose.
      */}
      <p className="mt-2 text-xs text-muted-foreground" data-testid={`contractual-${line.lineId}`}>
        Contract write-off {money(line.contractualWriteOffCents)} — the carrier's, already
        accepted.
      </p>

      {line.odClaimProcNum !== null && (
        <p className="mt-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
          → ClaimProc {line.odClaimProcNum}
        </p>
      )}

      {/*
        THE DECISION — about the patient's remainder, and nothing else.
        A line where the patient owes nothing has nothing to decide, so the
        control is not rendered rather than rendered disabled: a disabled control
        invites somebody to look for a way to enable it.
      */}
      {remainder === 0 ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid={`decision-none-${line.lineId}`}
        >
          Nothing left for the patient on this line.
        </p>
      ) : (
        <LineDecisionControl
          line={line}
          remainder={remainder}
          writtenOff={writtenOff}
          reasons={reasons}
          busy={busy}
          mayDecide={mayDecide}
          decideBlockedBy={decideBlockedBy}
          notLinked={notLinked}
          onDecide={onDecide}
        />
      )}
    </li>
  );
}

/**
 * Bill the patient, or write it off — and the reason, which is not optional.
 *
 * The reason list only appears once the write-off is the choice, and choosing a
 * reason IS what commits it: there is no separate save, because a write-off
 * sitting on screen with no reason attached is a state the server refuses to
 * store and the verdict would call red. Picking a reason and recording the
 * decision are one act, so they are one click.
 */
function LineDecisionControl({
  line,
  remainder,
  writtenOff,
  reasons,
  busy,
  mayDecide,
  decideBlockedBy,
  notLinked,
  onDecide,
}: {
  line: ClaimLine;
  remainder: number;
  writtenOff: boolean;
  reasons: { slug: string; label: string }[];
  busy: ClaimWorkbenchProps["busy"];
  mayDecide: boolean;
  decideBlockedBy: ClaimWorkbenchProps["decideBlockedBy"];
  notLinked: boolean;
  onDecide: ClaimWorkbenchProps["onDecide"];
}) {
  const [picking, setPicking] = useState(false);
  const disabled = busy !== null || !mayDecide;

  return (
    <div className="mt-2" data-testid={`decision-${line.lineId}`}>
      {/*
        THE CAUTION, ABOVE THE BUTTONS — Stage C-3, item 4.

        Above and not below, because it is a thing to know BEFORE pressing. In
        plain words, naming the consequence rather than the mechanism: absorbing
        money is done on behalf of a patient, and an unlinked claim has not said
        which one. It reads as amber, never rose — this is a caution about an
        allowed act, not a refusal, and colouring it as a block would teach a
        biller to expect a button that does not work.
      */}
      {notLinked && (
        <p
          className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-300"
          data-testid={`decision-unlinked-${line.lineId}`}
        >
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            This claim isn&rsquo;t linked to an Open Dental claim yet — match it up first, so the
            office is absorbing for the right patient.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setPicking(false);
            onDecide(line.lineId, "bill_patient", null);
          }}
          data-testid={`bill-patient-${line.lineId}`}
          aria-pressed={!writtenOff}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            !writtenOff
              ? "border-foreground bg-foreground text-background"
              : "border-border text-foreground hover:bg-muted"
          }`}
        >
          {!writtenOff && <Check size={12} />}
          Bill the patient {money(remainder)}
        </button>

        <button
          type="button"
          disabled={disabled}
          onClick={() => setPicking((v) => !v)}
          data-testid={`write-off-${line.lineId}`}
          aria-pressed={writtenOff}
          aria-expanded={picking}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            writtenOff
              ? "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
              : "border-border text-foreground hover:bg-muted"
          }`}
        >
          {writtenOff && <Check size={12} />}
          Write it off
        </button>

        {busy === "decide" && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
      </div>

      {/*
        WHAT WAS DECIDED, AND BY WHOM. Printed under the control rather than only
        in the verdict, because the person checking a line six weeks from now is
        looking AT THE LINE.
      */}
      {writtenOff && (
        <p
          className="mt-1 text-xs text-amber-800 dark:text-amber-300"
          data-testid={`decision-stamp-${line.lineId}`}
        >
          The office is absorbing {money(remainder)}
          {line.decisionReason
            ? ` — ${reasons.find((r) => r.slug === line.decisionReason)?.label ?? line.decisionReason}`
            : " — no reason recorded"}
          {line.decidedBy ? ` · ${line.decidedBy}` : ""}
          {line.decidedAt ? ` ${stamp(line.decidedAt)}` : ""}
        </p>
      )}

      {picking && (
        <div
          className="mt-2 rounded-lg border border-border bg-muted/40 p-2"
          data-testid={`reasons-${line.lineId}`}
        >
          <p className="text-xs font-medium text-foreground">Why is the office absorbing this?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <button
                key={r.slug}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setPicking(false);
                  onDecide(line.lineId, "office_writeoff", r.slug);
                }}
                data-testid={`reason-${r.slug}-${line.lineId}`}
                className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  line.decisionReason === r.slug
                    ? "border-amber-400 bg-amber-100 font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
                    : "border-border text-foreground hover:bg-background"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            A reason is required — it is the only account of why the practice absorbed this.
          </p>
        </div>
      )}

      {/*
        TWO CAUSES, TWO SENTENCES.

        An approved check is FROZEN, and telling the person who approved it that
        she lacks permission sends her to ask for access she already holds. What
        she needs to know is what approving did, and what undoing it would cost
        today: a correction in Open Dental, because a retired check cannot be
        approved again (RCM_POSTING 2.2.0).

        And it names the RULE, not just this instance: a decision can be changed
        any number of times right up until Approve, and Approve is the step that
        freezes it. That is the only part of this sentence she can act on -- next
        time. A dead end with no rule attached teaches nothing.
      */}
      {decideBlockedBy === "approved" ? (
        <DisabledReason testId={`decision-reason-${line.lineId}`}>
          This check has been approved, and approving is what freezes a decision — up until then
          any of them can be changed. A wrong write-off on an approved check has to be fixed in
          Open Dental.
        </DisabledReason>
      ) : decideBlockedBy === "permission" ? (
        <DisabledReason testId={`decision-reason-${line.lineId}`}>
          Deciding write-offs needs review permission. Ask a biller.
        </DisabledReason>
      ) : null}
    </div>
  );
}

function Amount({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`font-mono tabular-nums ${strong ? "font-semibold text-foreground" : "text-muted-foreground"}`}
      >
        {money(cents)}
      </dd>
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-mono text-sm tabular-nums ${strong ? "font-semibold text-foreground" : "text-muted-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   RIGHT — IS THIS THE PATIENT, AND WHAT DOES THE CHART HOLD
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Three identity facts, side by side, each with its own answer.
 *
 * NAME and DATE OF BIRTH block an approval when they disagree, and the remedy is
 * to match this claim up again — never an override. A claim posted onto the
 * wrong patient's chart is the worst outcome this module has, and no amount of
 * "I checked" from a busy afternoon is worth a control that lets somebody past
 * it.
 *
 * SUBSCRIBER ID is reported and does not block. Carriers reformat member numbers
 * constantly, so refusing on one would refuse most of a normal day's work for no
 * safety gained.
 */
function IdentityPanel({
  identity,
  matchStatus,
}: {
  identity: ClaimIdentity | null;
  matchStatus: WorkbenchClaim["odMatchStatus"];
}) {
  if (!identity || matchStatus !== "confirmed") {
    return (
      <section
        className="rounded-xl border border-dashed border-border bg-card p-4"
        data-testid="identity-unknown"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Is this the right patient?
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing to compare yet — link this claim to a chart claim below and the two sets of
          details appear here side by side.
        </p>
      </section>
    );
  }

  return (
    <section
      className={`rounded-xl border-2 bg-card ${
        identity.blocking
          ? "border-rose-300 dark:border-rose-800"
          : identity.matched
            ? "border-emerald-200 dark:border-emerald-900"
            : "border-border"
      }`}
      data-testid="identity-panel"
      data-identity={identity.blocking ? "blocking" : identity.matched ? "agrees" : "partial"}
    >
      <div className="flex items-start gap-2 border-b border-border px-4 py-2.5">
        {identity.blocking ? (
          <Ban size={15} className="mt-0.5 shrink-0 text-rose-700 dark:text-rose-400" />
        ) : (
          <UserCheck size={15} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        )}
        <div>
          <p className="text-sm font-medium text-foreground">
            {identity.blocking ? "This may not be the same person" : "This is the patient on the EOB"}
          </p>
          {identity.blocking && (
            <p className="mt-0.5 text-xs text-rose-700 dark:text-rose-400">
              Nothing can post until this is sorted out. Run the match again and pick the right
              chart claim — there is no way to say "post it anyway", and there should not be.
            </p>
          )}
        </div>
      </div>

      <table className="w-full text-xs" data-testid="identity-fields">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-4 py-1.5 font-medium"> </th>
            <th className="px-4 py-1.5 font-medium">On the EOB</th>
            <th className="px-4 py-1.5 font-medium">In Open Dental</th>
          </tr>
        </thead>
        <tbody>
          {identity.fields.map((f) => (
            <tr
              key={f.field}
              className="border-t border-border"
              data-testid={`identity-${f.field}`}
              data-status={f.status}
            >
              <td className="px-4 py-1.5 text-muted-foreground">{f.label}</td>
              <td className="px-4 py-1.5 text-foreground">{f.eob ?? "—"}</td>
              <td
                className={`px-4 py-1.5 ${
                  f.status === "differs"
                    ? f.blocking
                      ? "font-medium text-rose-700 dark:text-rose-400"
                      : "font-medium text-amber-700 dark:text-amber-400"
                    : "text-foreground"
                }`}
              >
                {f.od ?? "not recorded"}
                {/*
                  "differs" and "not recorded" are different answers and must not
                  read the same. A field Open Dental never sent is not a
                  disagreement, and calling it one would manufacture a mismatch
                  out of an absence.
                */}
                {f.status === "differs" && (
                  <span className="ml-1.5 rounded bg-current/10 px-1 py-0.5 text-[10px] font-semibold uppercase">
                    {f.blocking ? "does not match" : "different format"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * What Open Dental holds for the claim a human linked this to.
 *
 * Everything here is AS READ at match time and says so. The chart may have moved
 * since — a second EOB, a zeroed line, a check attached — and the drain
 * re-verifies against the live chart before it writes. Labelling this as a
 * reading rather than as the present is the difference between a comparison and
 * a claim.
 */
function ChartPanel({
  claim,
  chart,
  snapshot,
  busy,
  mayRerun,
  fromBatchId,
  onRunMatch,
  onConfirm,
  rules,
}: {
  claim: ClaimDetailResponse["claim"];
  chart: ClaimDetailResponse["claim"]["chart"];
  snapshot: MatchSnapshot | null;
  busy: ClaimWorkbenchProps["busy"];
  mayRerun: boolean;
  fromBatchId: string | null;
  onRunMatch: (force: boolean) => void;
  onConfirm: (odClaimNum: number) => void;
  rules: ClaimDetailResponse["matchRules"];
}) {
  return (
    <section data-testid="claim-od-match">
      {/*
        `items-start` and a non-shrinking heading, not `flex-wrap items-center`.

        With wrap on, the two buttons are wider than the space beside the
        heading at 1280 and jump ABOVE it — so the controls read as belonging to
        the panel above them rather than to this one. They now sit beside the
        heading and stack under themselves if they must.
      */}
      <div className="flex items-start justify-between gap-3">
        <h2 className="shrink-0 pt-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What Open Dental has
        </h2>
        {/*
          EVERY DISABLED CONTROL SAYS WHY, IN THE FLOW OF THE PAGE.
          Not a `title` — the practice reads these screens on a tablet, and there
          is no hover on a tablet. §15.2, finding 4.
        */}
        <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1">
          <div className="flex flex-col items-start gap-1">
            <button
              onClick={() => onRunMatch(claim.odMatchStatus === "confirmed")}
              disabled={busy !== null || !mayRerun}
              data-testid="run-match"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "match" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Search size={14} />
              )}
              {claim.odMatchStatus === "not_run"
                ? "Match it up"
                : claim.odMatchStatus === "confirmed"
                  ? "Match it up again"
                  : "Look again"}
            </button>
            {!mayRerun ? (
              <DisabledReason testId="run-match-reason">
                Releasing a confirmed match needs posting permission. Ask an approver.
              </DisabledReason>
            ) : busy !== null ? (
              <DisabledReason testId="run-match-reason">
                Waiting for the {busy === "match" ? "match" : busy} to finish.
              </DisabledReason>
            ) : null}
          </div>

          {/*
            ── NO APPROVE BUTTON HERE, AND NOT A DISABLED ONE EITHER ───────────
            Stage C-3, item 2. This was a control that could never be pressed on
            any claim, in any state, by anybody — approving is a WHOLE-CHECK act
            and always has been. A permanently disabled button is not an honest
            "not yet": it is a promise the screen has no intention of keeping,
            and a biller who tries it learns that controls here sometimes lie.

            What she actually needed was the way to the one screen that approves.
            So that is what this is: a link, with one target, that goes there.

            Without `?from=` there is no batch id to link to, so the sentence
            still names WHERE approving happens and points at the check list
            rather than inventing an id.
          */}
          <p
            className="max-w-[16rem] pt-1.5 text-right text-xs text-muted-foreground"
            data-testid="approve-lives-elsewhere"
          >
            Approving happens on the check — the whole check at once.{" "}
            {fromBatchId ? (
              <Link
                href={approveHref(fromBatchId)}
                className="font-medium text-foreground underline underline-offset-2"
                data-testid="approve-link"
              >
                Review and approve
              </Link>
            ) : (
              <Link
                href="/rcm/remittances"
                className="font-medium text-foreground underline underline-offset-2"
                data-testid="approve-link-list"
              >
                Find the check
              </Link>
            )}
          </p>
        </div>
      </div>

      {claim.odMatchStatus === "confirmed" && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="reconfirm-warning">
          {/* WHAT THE BUTTON BESIDE IT WOULD DO — not what state the claim is
              in. The state is said once, at the top of the page, on
              `claim-state-line`; a panel that repeats it is a panel a biller has
              to read to learn nothing. */}
          {mayRerun
            ? "Matching it up again replaces this match and un-links the claim. The confirmation stays in the audit trail."
            : "Releasing this match un-links the claim, which needs posting permission — ask an approver."}
        </p>
      )}

      {claim.odMatchStatus === "confirmed" && chart && (
        <div className="mt-2 rounded-xl border border-border bg-card" data-testid="chart-panel">
          <div className="grid grid-cols-2 gap-3 border-b border-border p-4 sm:grid-cols-4">
            <Fact label="Chart claim" value={chart.odClaimNum ? `#${chart.odClaimNum}` : "—"} />
            <Fact label="Status" value={chart.claimStatus || "—"} />
            <Fact
              label="Billed in chart"
              value={chart.billedCents == null ? "—" : money(chart.billedCents)}
              strong
            />
            <Fact
              label="Already paid"
              value={chart.insPaidCents == null ? "—" : money(chart.insPaidCents)}
            />
          </div>

          <table className="w-full text-xs" data-testid="chart-lines">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-4 py-1.5 font-medium">Line</th>
                <th className="px-4 py-1.5 text-right font-medium">Fee billed</th>
                <th className="px-4 py-1.5 text-right font-medium">Insurance estimate</th>
                <th className="px-4 py-1.5 text-right font-medium">Paid so far</th>
              </tr>
            </thead>
            <tbody>
              {chart.lines.map((l) => (
                <tr
                  key={l.odClaimProcNum}
                  className="border-t border-border"
                  data-testid={`chart-line-${l.odClaimProcNum}`}
                >
                  <td className="px-4 py-1.5">
                    <span className="font-mono text-foreground">{l.code || "—"}</span>
                    <span className="ml-1.5 text-muted-foreground">{l.status}</span>
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums text-foreground">
                    {money(l.feeBilledCents)}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {/*
                      NULL IS NOT ZERO. Open Dental writes -1 into InsEstTotal to
                      mean "not calculated", so printing $0.00 here would state a
                      number nobody computed.
                    */}
                    {l.insEstCents == null ? "not calculated" : money(l.insEstCents)}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {money(l.insPayAmtCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            Read from Open Dental {chart.fetchedAt ? stamp(chart.fetchedAt) : "at match time"}. The
            chart is re-checked again before anything is written to it.
          </p>

          {/*
            ── THE LEDGER SLOT — FOUND, NOT BUILT ───────────────────────────────
            A slice of this patient's ledger belongs here: what they have already
            been billed, what they have paid, and what this posting will add. It
            is NOT rendered as an empty panel pretending to be one.

            Every Open Dental read this module makes today is about a CLAIM —
            `GET /claims`, `GET /claimprocs`, `GET /procedurelogs`. A ledger needs
            the patient's payments and adjustments, which is a new verb, and B1
            adds no Open Dental verbs of any kind. It is listed as found-not-built
            in the PR rather than mocked here.
          */}
          <div
            className="border-t border-dashed border-border px-4 py-2 text-[11px] text-muted-foreground"
            data-testid="ledger-slot"
          >
            The patient's ledger is not shown here yet — reading it needs a kind of Open Dental
            request this screen does not make. Open the patient in Open Dental to see it.
          </div>
        </div>
      )}

      {/*
        THE CANDIDATES STAY VISIBLE AFTER A CONFIRMATION.
        "Why did I pick this one" is a question asked weeks later, and the
        evidence that answered it is in the snapshot. Hiding the list once a
        choice is made would make the record of the choice unreachable from the
        screen where the choice was made.
      */}
      {/*
        AND NOTHING AT ALL WHEN A CONFIRMED CLAIM HAS NO READABLE RECORD.

        `MatchPicker`'s empty state says "nobody has looked yet", which is the
        right sentence for an unmatched claim and a flat contradiction beneath a
        chart panel and a header chip that both say this claim IS linked. The
        stale-snapshot case is already reported by the chip and by the run
        button's own copy.
      */}
      {(claim.odMatchStatus !== "confirmed" || snapshot !== null) && (
        <MatchPicker
          claim={claim}
          snapshot={snapshot}
          busy={busy}
          fromBatchId={fromBatchId}
          onConfirm={onConfirm}
          rules={rules}
        />
      )}
    </section>
  );
}

/**
 * Before a human has linked a claim, the right-hand side is the candidate list.
 *
 * Unchanged in substance from Slice 6a: every candidate shows the evidence that
 * produced its score, ambiguity is displayed rather than resolved, and
 * "we found nothing" is rendered differently from "we found things and offered
 * none of them". Confirming is a click a person makes.
 */
function MatchPicker({
  claim,
  snapshot,
  busy,
  fromBatchId,
  onConfirm,
  rules,
}: {
  claim: ClaimDetailResponse["claim"];
  snapshot: MatchSnapshot | null;
  busy: ClaimWorkbenchProps["busy"];
  fromBatchId: string | null;
  onConfirm: (odClaimNum: number) => void;
  rules: ClaimDetailResponse["matchRules"];
}) {
  if (!snapshot) {
    return (
      <div
        className="mt-2 rounded-xl border border-dashed border-border bg-card p-8 text-center"
        data-testid={claim.matchSnapshotStale ? "match-stale" : "match-not-run"}
      >
        <Search size={20} className="mx-auto text-muted-foreground/50" />
        {claim.matchSnapshotStale ? (
          <p className="mt-2 text-sm text-muted-foreground">
            A match was run against this claim, but under an earlier version of the record — its
            contents cannot be read here, and confirming from it is refused. Run it again to get a
            current answer. Nothing has been un-linked.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Nobody has looked yet. Matching it up READS Open Dental — it writes nothing to any
            chart.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <MatchMeta snapshot={snapshot} rules={rules} />
      {snapshot.candidates.length === 0 ? (
        <div
          className="mt-3 rounded-xl border border-border bg-card p-6 text-center"
          data-testid="no-candidate"
        >
          <Ban size={20} className="mx-auto text-muted-foreground/60" />
          {snapshot.rejectedCandidates > 0 ? (
            <>
              <p className="mt-2 text-sm font-medium text-foreground">
                Nothing here is safe to offer
              </p>
              {/* The office at heading weight, for the same reason the panel
                  above says it that way: the likeliest cause of this screen is
                  that the wrong practice was searched. */}
              <p className="mt-1 text-sm text-foreground" data-testid="no-candidate-office">
                Searched <strong className="font-semibold">{snapshot.officeName}</strong>&rsquo;s
                Open Dental.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {snapshot.rejectedCandidates} Open Dental claim
                {snapshot.rejectedCandidates === 1 ? " was" : "s were"} examined and set aside —{" "}
                {rejectionSummary(snapshot)}.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                That is not the same as the chart having no such claim. If one of them is right,
                link the patient first and run this again.
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm font-medium text-foreground">
                No matching claim in Open Dental
              </p>
              <p className="mt-1 text-sm text-foreground" data-testid="no-candidate-office">
                Searched <strong className="font-semibold">{snapshot.officeName}</strong>&rsquo;s
                Open Dental.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing was found and nothing was set aside. This is a recorded outcome, not a
                missing one.
              </p>
            </>
          )}
        </div>
      ) : (
        <CandidateList
          candidates={snapshot.candidates}
          confirmedClaimNum={claim.odClaimNum}
          disabled={busy !== null || claim.odMatchStatus === "confirmed"}
          onConfirm={onConfirm}
        />
      )}
    </>
  );
}

/**
 * THE CANDIDATE LIST, WITH ONE CARD OPEN AT A TIME — Stage C-3, item 1.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE LIST COLLAPSES
 * ═════════════════════════════════════════════════════════════════════════════
 * Every candidate carried its full evidence — chips with weights, blockers, line
 * pairings, a confirm button and its disabled reason — whether or not anybody
 * was still choosing. Four of those stacked under a claim that was ALREADY
 * LINKED is four screens of an argument that has been settled, and it is most of
 * why the three states of this page looked alike: the part that changed was
 * three lines high and the part that did not was two thousand pixels of it.
 *
 * So exactly one card is open, and which one says what the page is for:
 *
 *   BEFORE LINKING   the leader is open — she is choosing, and the top of the
 *                    ranking is where choosing starts. The rest are one line
 *                    each and open on a click, because "why not that one" is a
 *                    question with an answer and the answer must stay reachable.
 *   AFTER LINKING    the LINKED one is open and everything else is one line.
 *                    The record of the choice is still on this screen — hiding
 *                    it would make "why did I pick this one", asked six weeks
 *                    later, unanswerable from the screen where it was picked.
 *
 * NOTHING IS HIDDEN, and that is the whole design: a collapsed row still names
 * the claim, its score and what Open Dental billed, and one click restores the
 * card exactly as it was. This is a fold, not a filter.
 */
function CandidateList({
  candidates,
  confirmedClaimNum,
  disabled,
  onConfirm,
}: {
  candidates: MatchCandidate[];
  confirmedClaimNum: number | null;
  disabled: boolean;
  onConfirm: (odClaimNum: number) => void;
}) {
  /*
   * WHICH ONE IS OPEN, as an override of the default rather than as the state
   * itself. Null means "whatever the claim's own state implies", so confirming a
   * match moves the open card WITHOUT the component having to notice: the
   * default recomputes from the new `confirmedClaimNum` on the next render. A
   * `useState(defaultOpen)` would have frozen the pre-link answer and left the
   * leader expanded under a claim that had just been linked to something else.
   */
  const [openOverride, setOpenOverride] = useState<number | null>(null);
  const defaultOpen =
    confirmedClaimNum !== null && candidates.some((c) => c.odClaimNum === confirmedClaimNum)
      ? confirmedClaimNum
      : (candidates[0]?.odClaimNum ?? null);
  const open = openOverride ?? defaultOpen;

  return (
    <div className="mt-3 space-y-2" data-testid="candidate-list">
      {candidates.map((c) =>
        c.odClaimNum === open ? (
          <CandidateCard
            key={c.odClaimNum}
            candidate={c}
            confirmedClaimNum={confirmedClaimNum}
            disabled={disabled}
            onConfirm={() => onConfirm(c.odClaimNum)}
            onCollapse={candidates.length > 1 ? () => setOpenOverride(-1) : undefined}
          />
        ) : (
          <CandidateRow
            key={c.odClaimNum}
            candidate={c}
            linked={confirmedClaimNum === c.odClaimNum}
            onOpen={() => setOpenOverride(c.odClaimNum)}
          />
        ),
      )}
    </div>
  );
}

/**
 * A candidate folded to one line: which claim, how it scored, what it billed.
 *
 * Those three are the ones a biller scans a list by, so the fold costs her
 * nothing at scanning distance and gives back the page. Everything else is one
 * click away and identical to what it was.
 */
function CandidateRow({
  candidate: c,
  linked,
  onOpen,
}: {
  candidate: MatchCandidate;
  linked: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`candidate-row-${c.odClaimNum}`}
      aria-expanded={false}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-4 py-2 text-left transition-colors hover:bg-muted/50"
    >
      <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
      <span className="font-mono text-sm font-medium text-foreground">ClaimNum {c.odClaimNum}</span>
      <span className="rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground">
        {c.confidence} · {c.score}
      </span>
      {linked && (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 size={11} /> Linked
        </span>
      )}
      <span className="font-mono text-sm tabular-nums text-muted-foreground">
        {money(c.od.billedCents)} billed
      </span>
      <span className="ml-auto text-xs text-muted-foreground">Open it</span>
    </button>
  );
}

function rejectionSummary(snapshot: MatchSnapshot): string {
  const { nameMismatch, belowScore } = snapshot.rejectedReasons;
  const parts: string[] = [];
  if (nameMismatch > 0) parts.push(`${nameMismatch} on a different patient's name`);
  if (belowScore > 0) parts.push(`${belowScore} scoring below ${snapshot.minScore}`);
  return parts.length > 0 ? parts.join(", ") : "no reason recorded";
}

/**
 * HOW THE SEARCH RAN — the facts, folded away — Stage C-3, item 8(a).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING IS REMOVED. THE DEFAULT CHANGED.
 * ═════════════════════════════════════════════════════════════════════════════
 * "9 Open Dental reads", "3 patients considered", "amounts match within $5.00",
 * a prefix-match note, a search-limit warning — every one of these is TRUE and
 * every one of them is worth having when a biller is asking why a match came out
 * the way it did. None of them is worth reading on the way to *"is this the
 * right patient"*, and they sat above the candidates in full, every time.
 *
 * So they are a `<details>`. The block is one line closed and byte-identical
 * open, and it is the ONLY thing on this screen that hides anything by default.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO THINGS DO NOT FOLD, AND THAT IS THE POINT OF FOLDING THE REST
 * ─────────────────────────────────────────────────────────────────────────────
 * AMBIGUITY and a TRUNCATED SEARCH are not diagnostics. Ambiguity says the
 * ranking below is not a recommendation; truncation says the right answer may
 * not be on the screen at all. Both change what a biller should DO with the list
 * she is about to read, so both stay outside the fold where they were. A summary
 * that folded a warning away would be the noise-reduction that costs an answer.
 */
function MatchMeta({
  snapshot,
  rules,
}: {
  snapshot: MatchSnapshot;
  rules: ClaimDetailResponse["matchRules"];
}) {
  return (
    <div className="mt-2 space-y-2" data-testid="match-meta">
      {snapshot.ambiguous && (
        <div
          className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-2.5 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/15 dark:text-amber-300"
          data-testid="match-ambiguous"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            The top candidates are within {rules.ambiguityMargin} points of each other. The ranking
            below is not a recommendation — read the evidence and decide.
          </span>
        </div>
      )}

      {snapshot.truncated && (
        <div
          className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/15 dark:text-amber-300"
          data-testid="match-truncated"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>A search limit was reached — some Open Dental claims were not examined.</span>
        </div>
      )}

      <details className="rounded-xl border border-border bg-card" data-testid="match-how-it-ran">
        <summary className="cursor-pointer list-none px-4 py-2 text-xs text-muted-foreground marker:content-none hover:text-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight size={12} className="shrink-0 transition-transform" />
            How the search ran — searched {stamp(snapshot.fetchedAt)} against{" "}
            {snapshot.officeName}
          </span>
        </summary>

        <div className="border-t border-border px-4 py-3 text-xs">
          <div className="text-muted-foreground">
            {snapshot.odCalls} Open Dental read
            {snapshot.odCalls === 1 ? "" : "s"} · {snapshot.patientsConsidered.length} patient
            {snapshot.patientsConsidered.length === 1 ? "" : "s"} considered
          </div>

          {snapshot.rejectedCandidates > 0 && (
            <div className="mt-2 text-muted-foreground" data-testid="match-rejected">
              {snapshot.rejectedCandidates} Open Dental claim
              {snapshot.rejectedCandidates === 1 ? "" : "s"} examined and not offered —{" "}
              {rejectionSummary(snapshot)}.
            </div>
          )}

          {!snapshot.nameRuleApplied && (
            <div className="mt-2 text-muted-foreground" data-testid="match-name-rule-off">
              This patient is already linked, so claims were read from their chart directly and a
              name disagreement was shown as evidence rather than used to disqualify.
            </div>
          )}

          {snapshot.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-muted-foreground" data-testid="match-notes">
              {snapshot.notes.map((n, i) => (
                <li key={i}>· {n}</li>
              ))}
            </ul>
          )}

          <div className="mt-2 text-muted-foreground/80">
            Amounts match within {money(rules.amountNearCents)}; dates within {rules.dateNearDays}{" "}
            days.
          </div>
        </div>
      </details>
    </div>
  );
}

function CandidateCard({
  candidate: c,
  confirmedClaimNum,
  disabled,
  onConfirm,
  onCollapse,
}: {
  candidate: MatchCandidate;
  confirmedClaimNum: number | null;
  disabled: boolean;
  onConfirm: () => void;
  /** Fold this card back to a line. Absent when it is the only candidate. */
  onCollapse?: () => void;
}) {
  const isConfirmed = confirmedClaimNum === c.odClaimNum;
  const lockedByOther =
    confirmedClaimNum !== null && confirmedClaimNum !== c.odClaimNum ? confirmedClaimNum : null;
  const blocking = c.blockers.filter((b) => b.blocking);
  const cautions = c.blockers.filter((b) => !b.blocking);

  return (
    <div
      className={`rounded-xl border bg-card ${isConfirmed ? "border-emerald-300 dark:border-emerald-800" : "border-border"}`}
      data-testid={`candidate-${c.odClaimNum}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              ClaimNum {c.odClaimNum}
            </span>
            <span
              className="rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground"
              title="A score, not a decision. Read the evidence below."
            >
              {c.confidence} · {c.score}
            </span>
            {isConfirmed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                <CheckCircle2 size={11} /> Linked
              </span>
            )}
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                data-testid={`candidate-collapse-${c.odClaimNum}`}
                aria-expanded
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Fold this away
              </button>
            )}
          </div>
          {/*
            THE THREE IDENTITY FACTS, ON THE CARD, BEFORE ANYTHING IS LINKED.
            The identity panel above can only compare once a human has chosen —
            so the choosing itself has to be able to see a date of birth, which
            is what separates two people with one name.
          */}
          <div className="mt-0.5 text-xs text-muted-foreground">
            {c.od.patientName ?? "Unknown patient"} · PatNum {c.odPatNum ?? "—"} · born{" "}
            {c.od.patientBirthdate ? day(c.od.patientBirthdate) : "not recorded"}
          </div>
          <div className="text-xs text-muted-foreground">
            subscriber {c.od.subscriberId ?? "not recorded"} · service {day(c.od.dateService)} ·
            status {c.od.claimStatus || "—"}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm tabular-nums text-foreground">
            {money(c.od.billedCents)}
          </div>
          <div className="font-mono text-xs tabular-nums text-muted-foreground">billed in chart</div>
          {c.od.unknownDeletedLineCount > 0 && (
            <div
              className="font-mono text-[11px] tabular-nums text-amber-700 dark:text-amber-400"
              data-testid={`unknown-lines-${c.odClaimNum}`}
            >
              {c.od.unknownDeletedLineCount} line
              {c.od.unknownDeletedLineCount === 1 ? "" : "s"} unread
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border px-4 py-3" data-testid={`evidence-${c.odClaimNum}`}>
        <div className="flex flex-wrap gap-1.5">
          {c.evidence.map((e) => (
            <span
              key={e.tag}
              title={e.detail}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${evidenceTone(e.weight)}`}
            >
              {e.label}
              {e.note ? ` (${e.note})` : ""}
              <span className="ml-1 font-mono opacity-70">
                {e.weight >= 0 ? `+${e.weight}` : e.weight}
              </span>
            </span>
          ))}
        </div>
      </div>

      {(blocking.length > 0 || cautions.length > 0) && (
        <div className="border-t border-border px-4 py-3" data-testid={`blockers-${c.odClaimNum}`}>
          <ul className="space-y-1">
            {[...blocking, ...cautions].map((b) => (
              <li
                key={b.code}
                className={`flex items-start gap-1.5 text-xs ${
                  b.blocking ? "text-rose-700 dark:text-rose-400" : "text-muted-foreground"
                }`}
                title={b.detail}
              >
                {b.blocking ? (
                  <Ban size={12} className="mt-0.5 shrink-0" />
                ) : (
                  <Info size={12} className="mt-0.5 shrink-0" />
                )}
                <span>
                  {b.label}
                  {b.count ? ` (${b.count})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border px-4 py-3" data-testid={`pairs-${c.odClaimNum}`}>
        <div className="text-xs font-medium text-muted-foreground">Line pairing</div>
        <ul className="mt-1 space-y-0.5">
          {c.linePairs.map((p, i) => (
            <li key={p.lineId ?? i} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-foreground">{p.code || "—"}</span>
              <span className="text-muted-foreground">→</span>
              {p.odClaimProcNum !== null ? (
                <span className="font-mono text-muted-foreground">
                  ClaimProc {p.odClaimProcNum}
                  {p.billedDeltaCents ? ` · ${money(p.billedDeltaCents)} apart` : ""}
                </span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">{p.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col items-start gap-1 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            onClick={onConfirm}
            disabled={disabled || isConfirmed}
            data-testid={`confirm-${c.odClaimNum}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCircle2 size={14} />
            {isConfirmed ? "Confirmed" : "This is the one"}
          </button>
          {!disabled && !isConfirmed && (
            <span className="text-xs text-muted-foreground">
              Links the claim. Still writes nothing to the chart.
            </span>
          )}
        </div>

        {isConfirmed ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            This is the linked claim. Match it up again to change it.
          </DisabledReason>
        ) : lockedByOther !== null ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            This claim is already linked to {lockedByOther}. Match it up again to change it.
          </DisabledReason>
        ) : disabled ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            Waiting for the last action to finish.
          </DisabledReason>
        ) : null}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE REVIEW MARKER — unchanged from 6a
   ══════════════════════════════════════════════════════════════════════════════ */

function ReviewBox({
  claim,
  note,
  setNote,
  busy,
  onSave,
}: {
  claim: WorkbenchClaim;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="review-box">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Reviewed</h3>
        {claim.reviewedAt && (
          <span className="text-xs text-muted-foreground" data-testid="reviewed-stamp">
            Reviewed {stamp(claim.reviewedAt)} by {claim.reviewedBy ?? "—"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Worklist hygiene only — this changes nothing in Open Dental. A claim with no chart match can
        still be finished work.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        rows={2}
        data-testid="review-note"
        placeholder="What did you find? e.g. carrier owes a corrected EOB — nothing to post."
        className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-2 flex flex-col items-start gap-1">
        <button
          onClick={onSave}
          disabled={busy}
          data-testid="mark-reviewed"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          {claim.reviewedAt ? "Update this" : "Mark it reviewed"}
        </button>
        {busy && <DisabledReason testId="mark-reviewed-reason">Saving the review…</DisabledReason>}
      </div>
    </div>
  );
}
