/**
 * /rcm/sop/takeback — how a takeback is handled (rewritten panel-first in S5).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT WAS REWRITTEN
 * ─────────────────────────────────────────────────────────────────────────────
 * This page was written when CareIN declined to write a takeback at all, and it
 * said so: "CareIN will not post a takeback." Slice 6d made that false. A
 * takeback on a check CareIN holds now has its own panel on the check — it
 * explains what is being reversed, asks for the amount to be typed back, offers
 * the reversible adjustment by default and the permanent negative supplemental
 * only behind a confirm — and the post writes it and reads it back.
 *
 * A procedure page that contradicts the product is worse than none: the person
 * who reads it is the one about to do the thing by hand that the app would have
 * done for her. So the page now leads with the panel, and keeps the manual Open
 * Dental steps for the case the panel cannot see — a takeback that never
 * arrives through CareIN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT STILL DOES NOT PRETEND
 * ─────────────────────────────────────────────────────────────────────────────
 * The practice's own written procedure — who may choose the permanent way, what
 * has to be recorded beside a takeback entered by hand — does not exist as a
 * document yet. The page says that rather than inventing one.
 */
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, CircleSlash, Undo2 } from "lucide-react";

export default function TakebackSop() {
  return (
    <div className="p-6" data-testid="rcm-takeback-sop">
      <Link
        href="/rcm/remittances"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        All checks
      </Link>

      <h1
        className="mt-4 text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Takebacks — how they are handled
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground" data-testid="takeback-intro">
        When a carrier takes money back on a check CareIN holds, the takeback panel on that check is
        the procedure. The Open Dental steps further down are for a takeback that arrives some other
        way.
      </p>

      {/* ── 1. THE PANEL — the procedure for checks CareIN holds ─────────────── */}
      <section className="mt-8 max-w-2xl" data-testid="takeback-panel-procedure">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <Undo2 size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />
          On a check CareIN holds: use the takeback panel
        </h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-foreground">
          <li>
            Open the check. The panel headed <em className="not-italic font-medium">The carrier is
            taking money back</em> says what is being reversed, which Open Dental claim it comes off,
            the carrier&rsquo;s own reason, and what it does to the patient.
          </li>
          <li>
            Match the takeback&rsquo;s claim to its Open Dental claim first. The amount field stays
            closed until it is — a takeback comes off a payment already posted against a chart
            claim.
          </li>
          <li>
            Choose how it is written. <strong>The adjustment is the default</strong>: it is booked on
            the patient&rsquo;s ledger under &ldquo;Insurance deductions from previous
            payments&rdquo; and can be reversed by an offsetting adjustment. The negative
            supplemental is <strong>permanent</strong> — Open Dental cannot reverse or delete it —
            and the panel asks you to confirm before it will select it.
          </li>
          <li>
            Type the amount exactly as the panel shows it, minus sign and all, and approve the
            takeback.
          </li>
          <li>
            Post the check. The takeback is written after the rest of the check, and CareIN asks
            Open Dental for it afterwards to confirm it took.
          </li>
          <li>
            Call the patient. They will owe more once it posts, and this app won&rsquo;t send them
            anything.
          </li>
        </ol>
        <p className="mt-3 text-sm">
          <Link
            href="/rcm/remittances"
            className="font-medium text-foreground underline underline-offset-4"
            data-testid="takeback-find-checks"
          >
            Find the check in All checks
          </Link>
        </p>
      </section>

      <div
        className="mt-6 flex max-w-2xl items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        data-testid="takeback-why"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-medium">Why the permanent way is behind a confirm.</div>
          <p className="mt-1">
            Open Dental accepts a negative supplemental and then refuses to revert it, refuses to
            delete it, and pins the claim and its procedure for good. It is the only write in the
            whole posting path with no way back — so CareIN never chooses it for you, and asks
            before you choose it yourself.
          </p>
        </div>
      </div>

      {/* ── 2. BY HAND — for takebacks that arrive outside CareIN ───────────── */}
      <section className="mt-8 max-w-2xl" data-testid="takeback-manual-procedure">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          A takeback that arrives outside CareIN
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A carrier letter, a paper remittance nobody added here, a takeback taken out of a check
          that was never uploaded — the panel cannot see these, so they are entered in Open Dental
          directly.
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-foreground">
          <li>Confirm the amount being taken back from the carrier&rsquo;s own letter or remittance.</li>
          <li>Find the original payment in Open Dental on the patient&rsquo;s claim.</li>
          <li>
            Enter the takeback in Open Dental. The reversible way is an adjustment under
            &ldquo;Insurance deductions from previous payments&rdquo;; a negative supplemental cannot
            be undone. Which one the practice uses, and who may enter the permanent one, is the
            practice&rsquo;s own procedure.
          </li>
          <li>
            If the same remittance is later added to CareIN, do not approve its takeback there — it
            is already in the chart. Mark the claim reviewed, with a note saying it was entered by
            hand and when.
          </li>
        </ol>
      </section>

      <div
        className="mt-8 flex max-w-2xl items-start gap-2 rounded-xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="takeback-placeholder"
      >
        <CircleSlash size={16} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-medium text-foreground">
            The practice&rsquo;s own written procedure is still to come.
          </div>
          <p className="mt-1">
            Who may choose the permanent way, and what has to be recorded beside a takeback entered
            by hand, are the office&rsquo;s own policy. When that document exists it belongs on this
            page, and this note is what should be replaced by it.
          </p>
        </div>
      </div>
    </div>
  );
}
