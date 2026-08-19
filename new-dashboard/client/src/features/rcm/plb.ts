/**
 * Provider Level Balance adjustments, as the screen prints them (Slice 6b).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DOLLAR TOTAL WAS NOT ENOUGH
 * ─────────────────────────────────────────────────────────────────────────────
 * A PLB moves money at the PROVIDER level rather than on any claim, which is
 * why it makes a check total legitimately disagree with the sum of its claims.
 * Slice 6a showed the total and stopped — but which KIND of provider-level
 * movement it is decides whether a biller does anything at all: `L6` interest
 * is the carrier paying for its own delay, `FB` is a forward balance that
 * belongs to the NEXT remittance, and `WO` or `72` is the carrier recovering an
 * earlier overpayment and needs a person. "Three hundred dollars of PLB"
 * answers none of that.
 *
 * The per-adjustment rows have been stored in
 * `rcm_payment_batches.plb_adjustments` since Slice 5 and nothing rendered them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DESCRIPTIONS COME FROM THE ROW, NOT FROM A SECOND COPY OF THE LIST
 * ─────────────────────────────────────────────────────────────────────────────
 * `eraParser.js` already holds the published PLB03-1 reason list and writes the
 * description into each stored adjustment. Mirroring that list here would be
 * exactly the mistake this slice removed from `format.ts` — two maps for one
 * vocabulary, one of which silently goes stale.
 *
 * So this module reads what the parser stored. Its ONE piece of judgement is
 * recognising the parser's own placeholder (`Provider adjustment (XX)`, written
 * when a payer sends a code that is not in the published list) and rendering
 * such a row BARE — the code and the amount, with no gloss. Same rule as a CARC
 * with no published description: an admitted gap beats a guessed meaning
 * attached to a number a biller acts on.
 */

export interface PlbAdjustmentView {
  code: string;
  amountCents: number;
  /**
   * The payer-independent published wording, or null when the code is not in
   * the published list. Null renders as nothing rather than as a guess.
   */
  description: string | null;
  /** PLB03-2 — the claim, patient account or check the movement refers to. */
  reference: string | null;
}

/** The parser's stand-in for a code it has no published description for. */
const PLACEHOLDER = /^Provider adjustment \(/i;

/** Read a cents amount off a stored PLB row, whatever key it landed under. */
function cents(row: Record<string, unknown>): number {
  for (const key of ["amountCents", "amount_cents"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function text(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * One stored PLB row → what the screen prints.
 *
 * Takes `unknown` because `plbAdjustments` crosses the wire as the parser's
 * verbatim jsonb — detect-and-flag means it is stored as read, and a shape this
 * function does not recognise must degrade to "a code and an amount" rather
 * than throwing inside a render.
 */
export function describePlbAdjustment(raw: unknown): PlbAdjustmentView {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stored = text(row, ["description"]);
  return {
    code: (text(row, ["reasonCode", "reason_code", "code"]) || "—").toUpperCase(),
    amountCents: cents(row),
    description: stored && !PLACEHOLDER.test(stored) ? stored : null,
    reference: text(row, ["referenceId", "reference_id", "reference"]),
  };
}
