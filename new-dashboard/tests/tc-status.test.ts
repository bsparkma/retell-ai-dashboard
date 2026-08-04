import { describe, expect, it } from "vitest";
import { CaseStatus, PreauthStatus } from "../shared/tc/contract";
import {
  ALL_CASE_STATUSES,
  BOARD_STATUSES,
  CASE_STATUSES,
  PREAUTH_BOARD_STATUSES,
  PREAUTH_STATUSES,
  validateTransition,
} from "../client/src/features/tc/status";

describe("case status metadata", () => {
  it("covers every contract status exactly", () => {
    expect(ALL_CASE_STATUSES).toEqual(CaseStatus.options);
    for (const s of CaseStatus.options) {
      expect(CASE_STATUSES[s].id).toBe(s);
      expect(CASE_STATUSES[s].label.length).toBeGreaterThan(0);
    }
  });

  it("board columns are the legacy 9-stage kanban in order", () => {
    expect(BOARD_STATUSES).toEqual([
      "diagnosed",
      "pending_tc",
      "pending_pt",
      "presented",
      "considering",
      "financing_pending",
      "accepted",
      "partially_accepted",
      "scheduled",
    ]);
  });

  it("hygiene_review is not a board column (it lives in the inbox)", () => {
    expect(BOARD_STATUSES).not.toContain("hygiene_review");
  });
});

describe("validateTransition (mirrors backend guards)", () => {
  it("lost requires a lostReason", () => {
    expect(validateTransition("lost", null).ok).toBe(false);
    expect(validateTransition("lost", "moved").ok).toBe(true);
  });

  it("lostReason is rejected on non-lost statuses", () => {
    expect(validateTransition("accepted", "moved").ok).toBe(false);
    expect(validateTransition("accepted", null).ok).toBe(true);
  });
});

describe("preauth status metadata", () => {
  it("covers every contract preauth status, board-ordered", () => {
    for (const s of PreauthStatus.options) {
      expect(PREAUTH_STATUSES[s].id).toBe(s);
    }
    expect(PREAUTH_BOARD_STATUSES).toEqual([
      "pending",
      "submitted",
      "in_review",
      "approved",
      "denied",
      "appealing",
      "expired",
    ]);
  });
});
