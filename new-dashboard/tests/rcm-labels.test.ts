/**
 * Every vocabulary member must have words a biller can read.
 *
 * Slice 5.5 added ten review reasons and flags to the backend and shipped them
 * with no frontend change, so they rendered as raw snake_case slugs — on
 * proposals they were also blocking. `rcmVocabulary.js` exists precisely so
 * that cannot happen, and this is the test that makes the promise enforceable
 * rather than aspirational.
 *
 * It reads the BACKEND vocabulary source, so adding a reason there without a
 * label here fails the dashboard suite. That is the point: the two files are a
 * pair, and nothing else was keeping them together.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  REVIEW_LABELS,
  FLAG_LABELS,
  FAILURE_LABELS,
  LINE_FLAG_LABELS,
  REASON_GATE,
  isBlockingReason,
  reviewLabel,
  label,
} from "../client/src/features/rcm/labels";

const VOCAB = fs.readFileSync(
  path.join(__dirname, "..", "..", "backend", "services", "rcm", "rcmVocabulary.js"),
  "utf8",
);

/**
 * Pull the string values out of one `const NAME = Object.freeze(...)` block.
 *
 * The vocabulary uses both shapes — an object of NAME: 'value' pairs for the
 * review reasons, a bare array for the flags — so this scans to whichever
 * closing token comes first rather than trying to express both in one regex.
 */
function members(name: string): string[] {
  const open = VOCAB.indexOf(`const ${name} = Object.freeze(`);
  expect(open, `rcmVocabulary.js must declare ${name}`).toBeGreaterThan(-1);

  // Scan to whichever closing token comes first. Neither sequence occurs inside
  // a vocabulary body, so a plain indexOf is enough and needs no escaping.
  const rest = VOCAB.slice(open);
  const ends = ["});", "]);"].map((t) => rest.indexOf(t)).filter((i) => i > -1);
  expect(ends.length, `${name} must be closed`).toBeGreaterThan(0);

  const body = rest.slice(0, Math.min(...ends));
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

describe("the RCM vocabulary is fully labelled", () => {
  it("labels every ERA review reason", () => {
    const unlabelled = members("ERA_REVIEW_REASONS").filter((r) => !REVIEW_LABELS[r]);
    expect(unlabelled, `unlabelled ERA review reasons: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every EOB review reason", () => {
    const unlabelled = members("EOB_REVIEW_REASONS").filter((r) => !REVIEW_LABELS[r]);
    expect(unlabelled, `unlabelled EOB review reasons: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every remittance flag", () => {
    const unlabelled = members("REMITTANCE_FLAGS").filter((f) => !FLAG_LABELS[f]);
    expect(unlabelled, `unlabelled remittance flags: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every EOB failure code", () => {
    const unlabelled = members("EOB_FAILURE_CODES").filter((c) => !FAILURE_LABELS[c]);
    expect(unlabelled, `unlabelled failure codes: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("reads the parameterised uncertain_line reason", () => {
    // The one member no lookup table can hold.
    expect(reviewLabel("uncertain_line:3")).toBe("Line 3 was read with low confidence");
    expect(reviewLabel("uncertain_line:12")).toBe("Line 12 was read with low confidence");
  });

  it("falls back to the slug rather than hiding an unknown value", () => {
    // A reason that vanished would make a proposal look cleaner than it is.
    expect(reviewLabel("something_new_from_the_backend")).toBe("something_new_from_the_backend");
    expect(label(FLAG_LABELS, "not_a_flag")).toBe("not_a_flag");
  });

  it("caught the exact members Slice 5.5 shipped unlabelled", () => {
    // Named individually so a regression points at the review that found them.
    for (const reason of [
      "unreadable_amount",
      "allowed_amount_mismatch",
      "partial_adjustment_segment",
      "claim_level_adjustments_present",
      "patient_resp_mismatch",
      "claim_line_allowed_mismatch",
      "totals_unreconciled",
    ]) {
      expect(REVIEW_LABELS[reason], reason).toBeTruthy();
      expect(reviewLabel(reason)).not.toBe(reason);
    }
    for (const flag of ["envelope_counts_mismatch", "envelope_incomplete", "multi_transaction_file"]) {
      expect(FLAG_LABELS[flag], flag).toBeTruthy();
    }
  });
});

/**
 * D-11's map is mirrored on the client so a chip can be coloured without a round
 * trip — and `labels.ts` says in its own header that a test keeps the two
 * honest. This is that test. It did not exist when the header claimed it did,
 * which is worse than no claim at all.
 *
 * A screen showing a reason in amber while the gate lets it through — or, far
 * worse, in grey while the gate withholds it — is the honest-states rule failing
 * in the most expensive place there is.
 */
describe("the D-11 gate map does not drift from the backend", () => {
  /** Pull `REASON_GATE`'s verdicts out of the backend source. */
  function backendGate(): Record<string, string> {
    const open = VOCAB.indexOf("const REASON_GATE = Object.freeze({");
    expect(open, "rcmVocabulary.js must declare REASON_GATE").toBeGreaterThan(-1);
    const body = VOCAB.slice(open, VOCAB.indexOf("});", open));
    // Strip block and line comments: half the map is prose explaining a verdict,
    // and prose is not an entry.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const out: Record<string, string> = {};
    for (const m of code.matchAll(/([a-z0-9_]+):\s*'(blocking|annotating)'/g)) out[m[1]] = m[2];
    return out;
  }

  it("agrees with the backend about every single slug", () => {
    const gate = backendGate();
    expect(Object.keys(gate).length).toBeGreaterThan(30);

    const disagreements: string[] = [];
    for (const [reason, verdict] of Object.entries(gate)) {
      const mine = REASON_GATE[reason];
      if (mine !== verdict) {
        disagreements.push(`${reason}: backend says ${verdict}, client says ${mine ?? "nothing"}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("names nothing the backend does not", () => {
    // A client-only verdict would paint a chip the gate disagrees with — a
    // screen arguing with the server about what stops a posting.
    const gate = backendGate();
    const orphans = Object.keys(REASON_GATE).filter((r) => !(r in gate));
    expect(orphans, `client verdicts the backend has none for: ${orphans.join(", ")}`).toEqual([]);
  });

  it("fails closed on an unknown slug, exactly like the backend", () => {
    expect(isBlockingReason("a_reason_nobody_has_written_yet")).toBe(true);
    expect(isBlockingReason("uncertain_line:3")).toBe(true);
    // And an annotating one really does read as not-blocking.
    expect(isBlockingReason("procedure_downcoded")).toBe(false);
    expect(isBlockingReason("allowed_amount_mismatch")).toBe(false);
  });

  it("labels every line flag, including the three Slice 5.5 added", () => {
    const unlabelled = members("LINE_FLAGS").filter((f) => !LINE_FLAG_LABELS[f]);
    expect(unlabelled, `unlabelled line flags: ${unlabelled.join(", ")}`).toEqual([]);
  });
});
