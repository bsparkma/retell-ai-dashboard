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
import { REVIEW_LABELS, FLAG_LABELS, FAILURE_LABELS, reviewLabel, label } from "../client/src/features/rcm/labels";

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
