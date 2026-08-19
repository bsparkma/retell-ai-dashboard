/**
 * /rcm/sop/takeback — the manual procedure for a reversal or a recoupment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PAGE EXISTS, AND WHY IT SAYS SO LITTLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 6a's workbench told a biller "handle it in Open Dental directly,
 * following the practice's takeback procedure" — and that sentence pointed
 * nowhere. It was prose where a link belonged, in the one place where CareIN
 * deliberately does nothing: a recoupment is the single IRREVERSIBLE Open Dental
 * operation (RCM_OD_WRITES G10), so detect-and-flag is the whole product and the
 * only honest thing to offer is a route out.
 *
 * The procedure itself is the PRACTICE'S, and it does not exist as a written
 * document yet. This page therefore says what is true — the steps CareIN knows,
 * and the fact that the office's own written procedure is still to come — rather
 * than inventing one. A placeholder that admits what it is beats a dead link,
 * and beats confident instructions nobody has approved.
 */
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, CircleSlash } from "lucide-react";

export default function TakebackSop() {
  return (
    <div className="p-6" data-testid="rcm-takeback-sop">
      <Link
        href="/rcm/remittances"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        All remittances
      </Link>

      <h1
        className="mt-4 text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Reversals and recoupments — the manual procedure
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        CareIN will not post a takeback. This page says why, and what to do instead.
      </p>

      <div
        className="mt-6 flex max-w-2xl items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        data-testid="takeback-why"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-medium">A negative supplemental cannot be undone.</div>
          <p className="mt-1">
            Open Dental accepts one, and then refuses to revert it, refuses to delete it, and pins
            the claim and its procedure permanently. It is the only operation in the whole posting
            path with no way back — which is why review-then-post is not enough for it and CareIN
            declines to write it at all.
          </p>
        </div>
      </div>

      <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground">
        What CareIN has already done
      </h2>
      <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Read the takeback out of the carrier's file and stored it against the claim.</li>
        <li>Held the remittance, so the rest of the check is not posted around it silently.</li>
        <li>
          Withheld the claim at the approval gate, with <em className="not-italic">Not a recoupment</em>{" "}
          or <em className="not-italic">Not a reversal or takeback</em> as the reason.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground">
        What a person does next
      </h2>
      <ol className="mt-2 max-w-2xl list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Open the carrier's remittance and confirm the amount being taken back.</li>
        <li>Find the original payment in Open Dental on the patient's claim.</li>
        <li>
          Enter the takeback in Open Dental directly, following the practice's own procedure for
          negative supplementals.
        </li>
        <li>Mark the claim reviewed here, with a note saying what was done and when.</li>
      </ol>

      <div
        className="mt-8 flex max-w-2xl items-start gap-2 rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="takeback-placeholder"
      >
        <CircleSlash size={16} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-medium text-foreground">
            The practice's written procedure is not here yet.
          </div>
          <p className="mt-1">
            Step 3 is the office's own policy — who may enter a negative supplemental, and what has
            to be recorded alongside it. When that document exists it belongs on this page, and this
            note is what should be replaced by it.
          </p>
        </div>
      </div>
    </div>
  );
}
