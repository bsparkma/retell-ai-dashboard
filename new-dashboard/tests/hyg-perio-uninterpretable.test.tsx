/**
 * AN UNINTERPRETABLE v2 VALUE IS NAMED, QUIETLY (H4 item 32) — the screen half.
 *
 * The server half (the drift `reason`, and the `AMEND_BASE_UNREADABLE` refusal)
 * is backend/routes/hyg/hygPerioUninterpretable.test.js. This file holds:
 *
 *   - ACCEPTANCE 2: `unknown` for `unreadable_od` still renders NOTHING (item 14),
 *     including an answer that carries no reason at all.
 *   - ACCEPTANCE 3: `unknown` for `uninterpretable` renders ONE quiet, neutral
 *     line naming tooth + surface + family — no amber, no Send again.
 *   - ACCEPTANCE 5: the send panel counts READINGS corrected, not sites.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PerioDriftSchema, type PerioDrift } from "@shared/hyg/perio";
import { type HygPerioSendResponse, type PerioSendView } from "@shared/hyg/perioSend";
import { PerioDriftNotice } from "@/features/hyg/perio/PerioDriftNotice";
import { PerioSendPanel } from "@/features/hyg/perio/PerioSendPanel";

afterEach(() => cleanup());

const noop = () => {};

function notice(drift: PerioDrift) {
  return render(<PerioDriftNotice drift={drift} onResend={noop} busy={false} />);
}

describe("ACCEPTANCE 2: a transient Open Dental read failure still says nothing", () => {
  it("renders nothing for `unknown` / `unreadable_od`", () => {
    const { container } = notice({ status: "unknown", reason: "unreadable_od", examNum: 7001, positions: [] });
    expect(container.innerHTML).toBe("");
  });

  it("an answer with no reason parses as `unreadable_od` and stays silent", () => {
    const parsed = PerioDriftSchema.parse({ status: "unknown", examNum: 7001 });
    expect(parsed).toEqual({ status: "unknown", reason: "unreadable_od", examNum: 7001, positions: [] });
    const { container } = notice(parsed);
    expect(container.innerHTML).toBe("");
  });

  it("an unknown reason is refused by the contract, never guessed at", () => {
    expect(PerioDriftSchema.safeParse({ status: "unknown", examNum: 7001, reason: "maybe" }).success).toBe(false);
  });
});

describe("ACCEPTANCE 3: an uninterpretable value gets one quiet line", () => {
  it("names tooth + surface + family, offers no Send again, and is not the amber notice", () => {
    const { container } = notice({
      status: "unknown",
      reason: "uninterpretable",
      examNum: 7001,
      positions: [{ tooth: 3, surface: "B", kind: "gm" }],
    });
    const line = screen.getByTestId("hyg-perio-drift-uninterpretable");
    expect(line.textContent).toBe(
      "Open Dental holds a value here CareIN can’t read (#3 B gingival margin). Check it in Open Dental.",
    );
    expect(screen.queryByTestId("hyg-perio-drift-resend")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-changed")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-drift-missing")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.innerHTML).not.toMatch(/amber|destructive/);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("several positions: mobility names the tooth, and the rest are counted", () => {
    notice({
      status: "unknown",
      reason: "uninterpretable",
      examNum: 7001,
      positions: [
        { tooth: 3, surface: "ML", kind: "furcation" },
        { tooth: 30, surface: null, kind: "mobility" },
        { tooth: 4, surface: "B", kind: "gm" },
        { tooth: 5, surface: "B", kind: "gm" },
      ],
    });
    expect(screen.getByTestId("hyg-perio-drift-uninterpretable").textContent).toBe(
      "Open Dental holds values here CareIN can’t read (#3 ML furcation, #30 mobility, #4 B gingival margin and 1 more). Check them in Open Dental.",
    );
  });
});

describe("ACCEPTANCE 5: the send panel counts readings corrected", () => {
  function amended(): PerioSendView {
    return {
      sendId: "send-2",
      state: "written",
      examNum: 7002,
      examDate: "2026-09-08",
      provNum: 7,
      arches: [],
      rowsPlanned: 4,
      rowsWritten: 4,
      deepSites: 0,
      mismatches: [],
      errorMessage: null,
      requestsRemaining: 0,
      startedBy: "test-user",
      startedAt: "2026-09-08T13:00:00.000Z",
      finishedAt: "2026-09-08T13:01:00.000Z",
      deletedBy: null,
      deletedAt: null,
      canDelete: false,
      supersedesExamNum: 7001,
      supersedesDeletedAt: "2026-09-08T13:01:00.000Z",
      amendDiff: [
        { tooth: 1, surface: "DB", kind: "depth", from: "2 mm", to: "7 mm" },
        { tooth: 3, surface: "B", kind: "gm", from: "2 mm recession", to: "3 mm recession" },
        { tooth: 3, surface: null, kind: "mobility", from: "grade 1", to: "grade 2" },
      ],
      writtenChart: null,
    };
  }

  it('says "3 readings corrected" — a mobility grade is a reading, not a site', () => {
    const send = amended();
    const response: HygPerioSendResponse = {
      success: true,
      office: "roland",
      aptNum: 900001,
      stagedWrite: null,
      send,
      live: send,
      paused: null,
    };
    render(
      <PerioSendPanel
        response={response}
        running={false}
        error={null}
        canRestage={false}
        onContinue={noop}
        onDelete={noop}
        onRestage={noop}
      />,
    );
    const line = screen.getByTestId("hyg-perio-amended").textContent ?? "";
    expect(line).toMatch(/^3 readings corrected · /);
    expect(line).not.toMatch(/sites? corrected/);
  });
});
