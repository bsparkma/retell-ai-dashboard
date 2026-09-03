/**
 * THE WAYS A CHECK GETS INTO CAREIN — Stage C, §2 (ruling D-16).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SIX SOURCES. THREE ARE BUILT. THE OTHER THREE ARE VISIBLE ANYWAY.
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller holding a piece of paper needs to know whether this product has a
 * place for it. Hiding the three that are not built yet answers that question
 * with silence, and silence reads as "you are holding it wrong" — she goes
 * looking, finds nothing, and concludes the product cannot take it at all.
 *
 * So all six are on the page and the three that are not built SAY SO, in a line
 * that names what will happen rather than a greyed-out shrug. One of them —
 * *Checks and cards* — will never be built, because a paper check needs no file
 * at all; its tile is informational for good and says that too.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `live` IS WHAT MAY BE CLICKED. NOTHING ELSE DECIDES IT.
 * ─────────────────────────────────────────────────────────────────────────────
 * The page renders a not-yet tile as a non-interactive card — no button, no
 * file input, no link — so there is no state a person can click into and find
 * broken. `tests/rcm-bring-in.test.tsx` asserts exactly that over this list, so
 * a seventh source added here without a lane gets the same treatment for free.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `lane` IS WHICH EXISTING INGEST PATH A LIVE TILE USES
 * ─────────────────────────────────────────────────────────────────────────────
 * Two lanes, and no new endpoint in this stage:
 *
 *   era  →  POST /api/rcm/era   (`uploadEra`)  — the 835 parser
 *   eob  →  POST /api/rcm/eob   (`uploadEob`)  — the PDF reader, OCR included
 *
 * *Payer portal download* is a PDF and is handled EXACTLY as a scanned EOB: it
 * is a separate tile because that is where a biller looks for it, and the same
 * lane because a PDF from a portal and a PDF from a scanner are the same file to
 * everything downstream. Giving it its own endpoint would be two code paths for
 * one thing, which is the mistake §2 exists to undo one level up.
 */

/** Which existing ingest path a live tile posts to. No new lanes in Stage C. */
export type IngestLane = "era" | "eob";

export interface SourceTile {
  /** A machine slug. Test ids and keys are built from it; it is never rendered. */
  id: string;
  /** What a biller calls the thing in her hand. */
  title: string;
  /**
   * The three-word promise about what happens to it. "Reads itself" versus
   * "Needs your eyes" is the whole difference between the two live lanes, and
   * it is the sentence that decides which tile she picks.
   */
  promise: string;
  /** One line of what it is, for somebody who has not met the word before. */
  detail: string;
  /** The file types, as a person reads them. Empty when there is no file. */
  accepts: string;
  /** Built, and clickable. */
  live: boolean;
  /** Which ingest path a live tile uses. Null on a not-yet tile. */
  lane: IngestLane | null;
  /**
   * On a NOT-YET tile, what is actually true about it today. Never "coming
   * soon" alone — that is a date nobody promised.
   */
  notYet: string | null;
}

/**
 * The six, in the order they go on the page: the two that arrive every day
 * first, then the one that arrives weekly, then the three that do not yet.
 */
export const SOURCE_TILES: readonly SourceTile[] = Object.freeze([
  {
    id: "era",
    title: "835 / ERA file",
    promise: "Reads itself.",
    detail:
      "The carrier's own electronic remittance. Every figure is parsed exactly as sent — a bad file can be malformed, it cannot be misread.",
    accepts: ".835 · .txt · .era",
    live: true,
    lane: "era",
    notYet: null,
  },
  {
    id: "eob",
    title: "Scanned EOB",
    promise: "Needs your eyes.",
    detail:
      "A paper explanation of benefits, read by a model. Every figure it produces is a proposal you check — this is the lane where a number can be read wrong.",
    accepts: ".pdf · .jpg · .png",
    live: true,
    lane: "eob",
    notYet: null,
  },
  {
    id: "portal",
    title: "Payer portal download",
    promise: "Needs your eyes.",
    detail:
      "The PDF a carrier's website gives you. Handled exactly as a scanned EOB — same reading, same checking, same lane.",
    accepts: ".pdf",
    live: true,
    lane: "eob",
    notYet: null,
  },
  {
    id: "paper_keyed",
    title: "Paper EOB, keyed by hand",
    promise: "Nothing to upload.",
    detail:
      "Typing a paper EOB straight in, for the ones nothing can read — a faint fax, a carrier who still posts a letter.",
    accepts: "",
    live: false,
    lane: null,
    notYet: "Not built yet. Until it is, scan the page and add it as a scanned EOB.",
  },
  {
    id: "bank_file",
    title: "Bank file — CSV or Excel",
    promise: "Reconcile only.",
    detail:
      "The deposit file from the bank. It carries no claims, so nothing in it can post — it exists to tie the day's deposit to the checks that made it up.",
    accepts: ".csv · .xlsx",
    live: false,
    lane: null,
    notYet: "Not built yet. It belongs with Deposit, which is the step after posting.",
  },
  {
    id: "paper_check",
    title: "Checks and cards",
    promise: "Nothing to do here.",
    detail:
      "A paper check or a card payment at the desk. There is no file to add — the money and the EOB arrive separately, and the deposit slip lives on the check's own page.",
    accepts: "",
    live: false,
    lane: null,
    /*
     * THE ONE TILE THAT IS NOT WAITING ON ANYTHING. It is here so a biller
     * holding a cheque stops looking for the button, which is a real question
     * with a real answer — not a feature that has slipped.
     */
    notYet: "There will never be an upload here, and that is the answer rather than a gap.",
  },
]);

/** The built ones, for the page and for the test that counts them. */
export const LIVE_SOURCES = SOURCE_TILES.filter((s) => s.live);

/** The ones that are visible and cannot be entered. */
export const NOT_YET_SOURCES = SOURCE_TILES.filter((s) => !s.live);
