/**
 * "NEXT CHECK" — forward motion out of a finished check (S7, Phase 1.2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEAD END THIS CLOSES
 * ═════════════════════════════════════════════════════════════════════════════
 * The 2026-09-11 inventory walked a check from arrival to posted and found that
 * a FINISHED check offers nothing. Its one solid button read *Review and
 * approve* — a verb for a check that is already approved and already posted —
 * and the only genuine ways onward were the breadcrumb and the left-hand nav.
 *
 * The owner's bar for this slice is a new hire completing the day's posting work
 * untrained, and a person who has to open the nav between every check is a
 * person navigating a filing cabinet rather than working a queue. So a check
 * that is done offers exactly one thing: the next one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT ASKS THE SERVER WHICH CHECK, AND ASKS THE SAME QUESTION TODAY ASKS
 * ─────────────────────────────────────────────────────────────────────────────
 * `view=attention` is server-paged and server-counted over the WHOLE office
 * (`REMITTANCE_VIEWS` in `routes/rcm/remittances.js`), so "next" here and the
 * count on Today's Start card cannot disagree about what is waiting. The read
 * happens only on a finished check — it is mounted by the one branch that
 * renders it — so an ordinary working check pays nothing for it.
 *
 * Oldest waiting first, for `oldestWaitingFirst`'s own reason: a queue is worked
 * from the end that has been waiting longest, and money ages.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE ANSWERS, AND WHY NONE OF THEM IS A SPINNER FOREVER
 * ─────────────────────────────────────────────────────────────────────────────
 *   loading   a quiet line. Never a button that might be about to change.
 *   a check   ONE primary: *Next check*, naming the payer it will open.
 *   nothing   *You're done for today.* — the same sentence Today's Start card
 *             uses when its queue is empty, because it is the same fact.
 *
 * A read that FAILS renders nothing at all rather than an error. This is a
 * convenience on top of a finished check; a red banner over it would spend the
 * reader's attention on something that has not gone wrong for her.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, PartyPopper } from "lucide-react";

import { listRemittances, type RcmOfficeId, type Remittance } from "@/features/rcm/api";
import { remittanceHref } from "@/features/rcm/flow";
import { money } from "@/features/rcm/format";
import { oldestWaitingFirst } from "@/features/rcm/worklist";

/** The server's own cap, and far more than a practice works in a day. */
const SCAN_LIMIT = 200;

type State =
  | { kind: "loading" }
  | { kind: "next"; check: Remittance }
  | { kind: "done" }
  | { kind: "quiet" };

export default function NextCheck({
  office,
  /** The check being read right now — it is never its own next one. */
  currentBatchId,
}: {
  office: RcmOfficeId;
  currentBatchId: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listRemittances(office, { view: "attention", limit: SCAN_LIMIT })
      .then((page) => {
        if (cancelled) return;
        const next = oldestWaitingFirst(
          page.remittances.filter(
            (r) => r.batchId !== currentBatchId && r.setAsideAt == null && r.parkedAt == null,
          ),
        )[0];
        setState(next ? { kind: "next", check: next } : { kind: "done" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "quiet" });
      });
    return () => {
      cancelled = true;
    };
  }, [office, currentBatchId]);

  if (state.kind === "quiet") return null;

  if (state.kind === "loading") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rcm-next-check-loading">
        Looking for the next check…
      </p>
    );
  }

  if (state.kind === "done") {
    return (
      <p
        className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
        data-testid="rcm-next-check-done"
      >
        <PartyPopper size={14} className="text-emerald-700 dark:text-emerald-400" />
        You&rsquo;re done for today.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Link
        href={remittanceHref(state.check.batchId)}
        data-testid="rcm-next-check"
        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
      >
        Next check
        <ArrowRight size={14} />
      </Link>
      <span className="text-xs text-muted-foreground" data-testid="rcm-next-check-names">
        {state.check.payer} · {money(state.check.totalAmountCents)}
      </span>
    </div>
  );
}
