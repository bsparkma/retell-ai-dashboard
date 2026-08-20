/**
 * Drop resolution for both TC kanban boards.
 *
 * These are the rules that decide whether a gesture becomes an API call, so
 * they live in a pure function per board and are tested without a DOM. What
 * matters here is the refusals: a drop that lands nowhere, or back on its own
 * column, must NOT transition — the boards issue confirmed server moves, and
 * a spurious one would stamp a real date on a real chart.
 *
 * jsdom drag simulation is deliberately out of scope; dnd-kit's own event
 * plumbing is not what these rules are about.
 */
import { describe, expect, it } from "vitest";
import {
  preauthColumnDroppableId,
  preauthStatusFromDroppableId,
  resolvePreauthDrop,
} from "../client/src/features/tc/preauth/preauthDnd";
import {
  caseColumnDroppableId,
  caseStatusFromDroppableId,
  LOST_DROPPABLE_ID,
  resolvePipelineDrop,
} from "../client/src/features/tc/cases/pipelineDnd";
import { BOARD_STATUSES, PREAUTH_BOARD_STATUSES } from "../client/src/features/tc/status";

describe("preauth drop resolution", () => {
  it("transitions when the card lands on a different column", () => {
    expect(resolvePreauthDrop("pending", preauthColumnDroppableId("submitted"))).toEqual({
      kind: "transition",
      status: "submitted",
    });
  });

  it("is a no-op when dropped back on its own column", () => {
    expect(resolvePreauthDrop("in_review", preauthColumnDroppableId("in_review"))).toEqual({
      kind: "none",
    });
  });

  it("is a no-op when the drop lands outside every column", () => {
    expect(resolvePreauthDrop("pending", null)).toEqual({ kind: "none" });
    expect(resolvePreauthDrop("pending", undefined)).toEqual({ kind: "none" });
  });

  it("refuses anything that is not one of the board's column ids", () => {
    // A card id, a bare status string, or a foreign board's column id all
    // reach the same answer: do nothing.
    expect(resolvePreauthDrop("pending", "9f1c2d64-0000-4000-8000-000000000001")).toEqual({
      kind: "none",
    });
    expect(resolvePreauthDrop("pending", "submitted")).toEqual({ kind: "none" });
    expect(resolvePreauthDrop("pending", caseColumnDroppableId("presented"))).toEqual({
      kind: "none",
    });
    expect(resolvePreauthDrop("pending", "preauth-column:not_a_status")).toEqual({ kind: "none" });
  });

  it("is a no-op when the dragged card's status is unknown", () => {
    expect(resolvePreauthDrop(null, preauthColumnDroppableId("approved"))).toEqual({ kind: "none" });
  });

  it("round-trips every board column id", () => {
    for (const status of PREAUTH_BOARD_STATUSES) {
      expect(preauthStatusFromDroppableId(preauthColumnDroppableId(status))).toBe(status);
    }
  });

  it("transitions to every other column, and only those", () => {
    const from = "pending" as const;
    const moves = PREAUTH_BOARD_STATUSES.map((to) =>
      resolvePreauthDrop(from, preauthColumnDroppableId(to)),
    );
    expect(moves.filter((m) => m.kind === "transition")).toHaveLength(
      PREAUTH_BOARD_STATUSES.length - 1,
    );
  });
});

describe("pipeline drop resolution", () => {
  it("transitions when the card lands on a different column", () => {
    expect(resolvePipelineDrop("diagnosed", caseColumnDroppableId("presented"))).toEqual({
      kind: "transition",
      status: "presented",
    });
  });

  it("is a no-op when dropped back on its own column", () => {
    expect(resolvePipelineDrop("considering", caseColumnDroppableId("considering"))).toEqual({
      kind: "none",
    });
  });

  it("treats the ghost Nurture column as a real drop target", () => {
    expect(resolvePipelineDrop("considering", caseColumnDroppableId("nurture"))).toEqual({
      kind: "transition",
      status: "nurture",
    });
  });

  it("opens the lost dialog instead of transitioning, so the reason is collected", () => {
    expect(resolvePipelineDrop("presented", LOST_DROPPABLE_ID)).toEqual({ kind: "lost" });
    // Never a transition — the backend refuses a lost move with no reason.
    expect(resolvePipelineDrop("presented", LOST_DROPPABLE_ID)).not.toEqual({
      kind: "transition",
      status: "lost",
    });
  });

  it("does not re-open the lost dialog for a card that is already lost", () => {
    expect(resolvePipelineDrop("lost", LOST_DROPPABLE_ID)).toEqual({ kind: "none" });
  });

  it("is a no-op when the drop lands outside every column", () => {
    expect(resolvePipelineDrop("diagnosed", null)).toEqual({ kind: "none" });
    expect(resolvePipelineDrop("diagnosed", undefined)).toEqual({ kind: "none" });
  });

  it("refuses anything that is not one of the board's column ids", () => {
    expect(resolvePipelineDrop("diagnosed", "3a7b91e2-0000-4000-8000-000000000002")).toEqual({
      kind: "none",
    });
    expect(resolvePipelineDrop("diagnosed", "presented")).toEqual({ kind: "none" });
    expect(resolvePipelineDrop("diagnosed", preauthColumnDroppableId("approved"))).toEqual({
      kind: "none",
    });
    expect(resolvePipelineDrop("diagnosed", "case-column:not_a_status")).toEqual({ kind: "none" });
  });

  it("is a no-op when the dragged card's status is unknown", () => {
    expect(resolvePipelineDrop(undefined, caseColumnDroppableId("scheduled"))).toEqual({
      kind: "none",
    });
  });

  it("round-trips every board column id", () => {
    for (const status of [...BOARD_STATUSES, "nurture" as const]) {
      expect(caseStatusFromDroppableId(caseColumnDroppableId(status))).toBe(status);
    }
  });

  it("the lost strip's id is the lost column id, so one rule covers both", () => {
    expect(LOST_DROPPABLE_ID).toBe(caseColumnDroppableId("lost"));
  });
});
