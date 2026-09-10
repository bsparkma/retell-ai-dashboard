/**
 * MATCH ANYWAY — the named-difference confirm (W-7, ruling Q2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT STANDS IN FRONT OF
 * ═════════════════════════════════════════════════════════════════════════════
 * Confirming a match is the click that writes an Open Dental ClaimNum onto our
 * row. It reaches no chart — matching is read-only, and the footer under every
 * candidate says so — but it is the click that decides WHICH patient's ledger a
 * carrier's money will eventually be posted against. Every figure downstream is
 * right or wrong on the strength of it.
 *
 * The claim number is the one field that settles it on its own: the carrier
 * echoes the payer's claim id in CLP01, and for a claim Open Dental submitted
 * that IS the ClaimNum. When it agrees, a biller is confirming a fact. When it
 * does NOT — a different claim than the 835 names, or no claim number on the
 * remittance at all — she is making a judgement from name, date and dollars,
 * and the screen owes her the list of what is not lining up before she makes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THE RULING ASKS FOR, AND WHERE EACH ONE IS
 * ─────────────────────────────────────────────────────────────────────────────
 *   (a) THE FIELDS THAT DO NOT AGREE, CLAIM NUMBER FIRST. `disagreements()`
 *       builds the list — the same `differences()` the candidate card renders,
 *       with the claim-number line in front — so this panel and the card cannot
 *       describe one candidate two ways.
 *
 *   (b) THE BUTTON SAYS THE CONSEQUENCE, not "OK". *Match anyway — no claim
 *       number agrees* is what the press means; a button reading *Confirm*
 *       beside a list of problems asks somebody to hold the consequence in their
 *       head while they press it.
 *
 *   (c) IT DEFAULTS TO DECLINE. The decline button takes focus when the panel
 *       opens, so Enter — the reflex on any dialog — backs out. Escape backs
 *       out. Nothing about the affirmative is reachable without moving to it
 *       deliberately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO TYPED PHRASE, AND THAT IS DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────────
 * Typing a phrase back is this module's heaviest gesture and it is reserved for
 * the takeback (D-6) — the one IRREVERSIBLE Open Dental write. Spending it here
 * would flatten the difference between "you are about to link two records, which
 * you can look at again" and "you are about to take money out of a patient's
 * ledger and cannot undo it". A ceremony used everywhere stops meaning anything
 * anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IN THE FLOW, NEVER OVER IT
 * ─────────────────────────────────────────────────────────────────────────────
 * No portal, no overlay, no fixed positioning. Stage C §8's rule holds here for
 * the same reason it holds for Set aside: the evidence this decision rests on —
 * the two identity columns, the candidate cards, the line pairs — is on the page
 * underneath, and a panel that covered it would be asking somebody to decide
 * from memory. It scrolls itself into view and takes the focus instead.
 *
 * NO REAL PATIENT DATA. The lines it prints come from `matchWords.ts`, which
 * deliberately never quotes a patient's name into a sentence.
 */
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import type { Difference } from "@/features/rcm/matchWords";

export default function MatchAnywayConfirm({
  odClaimNum,
  differences,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The Open Dental claim the press would link to. */
  odClaimNum: number;
  /** What does not agree, claim number first. Never empty — see `disagreements()`. */
  differences: Difference[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const declineRef = useRef<HTMLButtonElement>(null);

  /*
   * (c) THE DEFAULT IS DECLINE.
   *
   * An explicit `focus()` rather than the autoFocus attribute: this panel is
   * mounted into a page that is already rendered, and React only honours
   * autoFocus on the initial mount of a tree in some paths. A default that works
   * only sometimes is worse than none, because the one time it does not is a
   * press somebody made on a button they never looked at.
   *
   * `preventScroll` and then an explicit `scrollIntoView` on the SECTION, so the
   * reader lands on the list of differences rather than on the button row at the
   * bottom of it.
   */
  useEffect(() => {
    declineRef.current?.focus({ preventScroll: true });
    /*
     * FEATURE-DETECTED. `scrollIntoView` is a browser affordance and jsdom does
     * not implement it; the FOCUS above is the part that matters and it must not
     * be undone by a throw from the cosmetic line under it.
     */
    const panel = declineRef.current?.closest("section");
    if (panel && typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return (
    <section
      /* Escape declines, from anywhere inside. */
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      role="group"
      aria-label="Confirm a match whose claim number does not agree"
      className="mt-4 rounded-xl border-2 border-amber-400 bg-amber-50/70 p-4 dark:border-amber-700 dark:bg-amber-950/30"
      data-testid="match-anyway"
    >
      <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
        <AlertTriangle size={15} className="shrink-0" />
        The claim number does not agree
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Linking this decides which patient&rsquo;s ledger the carrier&rsquo;s money is eventually
        posted against. Read what does not line up first.
      </p>

      {/* (a) EXACTLY the fields that do not agree, claim number first. */}
      <ul className="mt-3 space-y-1" data-testid="match-anyway-differences">
        {differences.map((d) => (
          <li
            key={d.kind}
            data-testid={`match-anyway-diff-${d.kind}`}
            className="flex items-start gap-1.5 text-sm text-amber-900 dark:text-amber-200"
          >
            <span aria-hidden className="mt-0.5 shrink-0 font-semibold">
              ·
            </span>
            <span>{d.phrase}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/*
          THE DECLINE COMES FIRST IN THE DOM as well as in the focus order, so a
          keyboard reader meets the way out before the way through.
        */}
        <button
          ref={declineRef}
          type="button"
          onClick={onCancel}
          data-testid="match-anyway-cancel"
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
        >
          Go back and look again
        </button>
        {/* (b) The label IS the consequence. */}
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid="match-anyway-confirm"
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500 px-3 py-1.5 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-40 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          Match anyway — no claim number agrees
        </button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        This links the carrier&rsquo;s claim to Open Dental claim {odClaimNum}. Nothing is written
        to Open Dental in this step — matching only tells the app which claim you mean.
      </p>
    </section>
  );
}
