/**
 * The hygienist's ortho screening, as the TC reads it (queue item 33).
 *
 * WHERE IT SITS. Between the command bar and the working tabs — the slot for
 * "what hygiene handed over". Queue item 22 (the hygiene treatment list on the
 * case, not built yet) renders in this same slot, so a case that carries both
 * shows them together rather than one in a tab and one above it.
 *
 * WHAT IT SHOWS. Every ANSWERED field as a label → value row, the shared
 * summary line, and the hygienist's note. Unanswered fields are omitted rather
 * than shown blank. The rows and the line come from shared/hyg/orthoScreening —
 * the same functions the hygiene screen built its "What the TC will get" line
 * with — so the two can never disagree about what was sent.
 *
 * A case WITHOUT a screening renders nothing here: the page is exactly what it
 * was before this slice.
 */
import { Smile } from "lucide-react";

import type { TcCase } from "@shared/tc/contract";
import {
  orthoScreeningRows,
  orthoScreeningSummary,
  type OrthoScreening,
} from "@shared/hyg/orthoScreening";
import { Badge } from "@/components/ui/badge";

/** The board/inbox signal: a hygiene_review case that came with a screening. */
export function OrthoWorkupChip() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-transparent bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300 text-[10px]"
      data-testid="tc-ortho-workup-chip"
    >
      <Smile className="w-3 h-3" aria-hidden />
      Ortho · needs work-up
    </Badge>
  );
}

export function OrthoScreeningCard({
  screening,
  hygienistName,
}: {
  screening: OrthoScreening;
  hygienistName: string;
}) {
  const rows = orthoScreeningRows(screening);
  const summary = orthoScreeningSummary(screening);
  const note = screening.noteForTc.trim();
  return (
    <section
      className="rounded-xl border border-border bg-card p-4 space-y-3"
      data-testid="tc-ortho-screening"
      aria-label="Ortho screening"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2
          className="text-sm font-semibold text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          Ortho screening
        </h2>
        <span className="text-[11px] text-muted-foreground">
          From hygiene{hygienistName ? ` · ${hygienistName}` : ""}
        </span>
      </div>

      {summary ? (
        <p className="text-sm text-foreground" data-testid="tc-ortho-summary">
          {summary}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
          {rows.map((r) => (
            <div key={r.label} className="contents" data-testid="tc-ortho-row">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="text-foreground">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {note ? (
        <div className="rounded-lg bg-muted/40 p-3 text-sm" data-testid="tc-ortho-note">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Note from the hygienist
          </div>
          <p className="mt-1 text-foreground whitespace-pre-wrap">{note}</p>
        </div>
      ) : null}
    </section>
  );
}

/** The case-detail slot: renders only when the case's intake carries a screening. */
export function OrthoScreeningSection({ tcCase }: { tcCase: TcCase }) {
  const intake = tcCase.hygieneIntake;
  if (!intake || !intake.orthoScreening) return null;
  return (
    <OrthoScreeningCard
      screening={intake.orthoScreening}
      hygienistName={intake.hygienistName || intake.submittedByName}
    />
  );
}
