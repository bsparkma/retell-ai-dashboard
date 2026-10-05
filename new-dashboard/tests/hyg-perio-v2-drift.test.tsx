/**
 * DRIFT SEES THE v2 ROWS — the contract and the two surfaces that render a
 * change (H4 item 31).
 *
 * The server half (an edit in Open Dental → `changed` / `unknown`) is
 * backend/routes/hyg/hygPerioV2Drift.test.js. This file holds the rest:
 *
 *   - `PerioSiteChange.kind` is widened, and `perioChartChanges` lets the v2
 *     families through — every one but `duplicate`.
 *   - A change line NAMES its family, so a changed recession never reads as a
 *     changed depth; mobility names the TOOTH. The v1 lines are unchanged.
 *   - The drift notice renders a v2 `changed` with NO Send again, and its
 *     left/right sentence matches the line's actual direction (CareIN → OD).
 *   - The correction confirm renders a v2 change by family too.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The one name below is synthetic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { type StagedWrite } from "@shared/hyg/contract";
import {
  PerioDriftSchema,
  PerioSiteChangeSchema,
  emptyPerioChart,
  normalizePerioChart,
  withPerioMobility,
  withPerioSite,
  type PerioDrift,
  type PerioSiteChange,
} from "@shared/hyg/perio";
import { comparePerioReadback, perioChangeLine, perioChartChanges } from "@shared/hyg/perioSend";
import { PerioDriftNotice } from "@/features/hyg/perio/PerioDriftNotice";
import { PerioSendConfirm } from "@/features/hyg/perio/PerioSendConfirm";

afterEach(() => cleanup());

/** What CareIN wrote: one of each v2 value beside a depth, on a molar. */
function wrote() {
  let chart = withPerioSite(emptyPerioChart(), 3, "B", { depth: 4, gm: 2 });
  chart = withPerioSite(chart, 3, "ML", { furcation: 2 });
  return normalizePerioChart(withPerioMobility(chart, 3, 1));
}

const V2_CHANGES: PerioSiteChange[] = [
  { tooth: 3, surface: "B", kind: "gm", from: "2 mm recession", to: "3 mm recession" },
  { tooth: 3, surface: "ML", kind: "furcation", from: "class 2", to: "class 3" },
  { tooth: 3, surface: null, kind: "mobility", from: "grade 1", to: "grade 2" },
  { tooth: 4, surface: "B", kind: "gm", from: "2 mm recession", to: "102 (unrecognised margin)" },
];

describe("the contract: drift compares every family a send writes", () => {
  it("an edited recession, furcation and mobility each come through as their own kind", () => {
    let od = withPerioSite(wrote(), 3, "B", { gm: 3 });
    od = withPerioSite(od, 3, "ML", { furcation: 3 });
    od = normalizePerioChart(withPerioMobility(od, 3, 2));
    const changes = perioChartChanges(wrote(), od);
    expect(changes.map((c) => [c.tooth, c.surface, c.kind])).toEqual([
      [3, null, "mobility"],
      [3, "B", "gm"],
      [3, "ML", "furcation"],
    ]);
    for (const c of changes) expect(PerioSiteChangeSchema.safeParse(c).success).toBe(true);
  });

  it("a margin in the OTHER family is a change, never normalised to a match", () => {
    const od = normalizePerioChart(withPerioSite(wrote(), 3, "B", { gm: 102 }));
    const changes = perioChartChanges(wrote(), od);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "gm", from: "2 mm recession", to: "102 (unrecognised margin)" });
  });

  it("an identical v2 chart has nothing to say", () => {
    expect(perioChartChanges(wrote(), wrote())).toEqual([]);
  });

  it("only `duplicate` is dropped — every other read-back kind is a change kind", () => {
    const kinds = PerioSiteChangeSchema.shape.kind.options;
    expect([...kinds].sort()).toEqual(["depth", "flags", "furcation", "gm", "mobility", "skipped"]);
    // The read-back still knows `duplicate`; drift deliberately does not.
    expect(comparePerioReadback(wrote(), wrote())).toEqual([]);
  });

  it("a `changed` answer with v2 kinds validates, and still cannot carry an exam list", () => {
    const parsed = PerioDriftSchema.safeParse({
      status: "changed",
      examNum: 7001,
      changes: V2_CHANGES,
      sameDateExams: [{ examNum: 7002, examDate: "2026-09-08", provNum: 7, careinWrote: false }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("sameDateExams" in parsed.data).toBe(false);
  });
});

describe("the change line names the family", () => {
  it("v2 lines name tooth, site and type; mobility names the tooth only", () => {
    expect(V2_CHANGES.map(perioChangeLine)).toEqual([
      "#3 B gingival margin: 2 mm recession → 3 mm recession",
      "#3 ML furcation: class 2 → class 3",
      "#3 mobility: grade 1 → grade 2",
      "#4 B gingival margin: 2 mm recession → 102 (unrecognised margin)",
    ]);
  });

  it("v1 lines are exactly what they were", () => {
    expect(perioChangeLine({ tooth: 14, surface: "B", kind: "depth", from: "3 mm", to: "4 mm" })).toBe(
      "#14 B: 3 mm → 4 mm",
    );
    expect(perioChangeLine({ tooth: 2, surface: null, kind: "skipped", from: "not skipped", to: "skipped" })).toBe(
      "#2: not skipped → skipped",
    );
  });
});

describe("surface 1: the drift notice", () => {
  const changed: PerioDrift = { status: "changed", examNum: 7001, changes: V2_CHANGES };

  it("names every v2 change by family, and offers NO Send again", () => {
    const onResend = vi.fn();
    render(<PerioDriftNotice drift={changed} onResend={onResend} busy={false} />);
    const notice = screen.getByTestId("hyg-perio-drift-changed");
    expect(notice.textContent).toContain("#3 B gingival margin: 2 mm recession → 3 mm recession");
    expect(notice.textContent).toContain("#3 ML furcation: class 2 → class 3");
    expect(notice.textContent).toContain("#3 mobility: grade 1 → grade 2");
    expect(notice.textContent).toContain("102 (unrecognised margin)");
    // Item 14's blocks, for v2: no button, no dialog, nothing pressed.
    expect(screen.queryByTestId("hyg-perio-drift-resend")).toBeNull();
    expect(screen.queryByTestId("hyg-perio-resend-confirm")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(onResend).not.toHaveBeenCalled();
  });

  it("says which side is which the way the line actually runs: CareIN left, Open Dental right", () => {
    render(<PerioDriftNotice drift={changed} onResend={() => {}} busy={false} />);
    const text = screen.getByTestId("hyg-perio-drift-changed").textContent ?? "";
    expect(text).toMatch(/CareIN wrote the readings on the left; Open Dental holds the ones on the right/);
    expect(text).not.toMatch(/Open Dental holds the readings on the left/);
  });

  it("`unknown` and `matches` draw nothing — an unreadable v2 value is not a banner", () => {
    const { container } = render(
      <>
        <PerioDriftNotice drift={{ status: "unknown", examNum: 7001 }} onResend={() => {}} busy={false} />
        <PerioDriftNotice drift={{ status: "matches", examNum: 7001 }} onResend={() => {}} busy={false} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("surface 2: the correction confirm", () => {
  const write: StagedWrite = {
    id: "staged-perio",
    kind: "perio",
    state: "Staged",
    title: "Perio chart",
    summary: "Correction",
    preview: ["Correction"],
    previewFingerprint: "fp",
    errorMessage: null,
    writtenRef: null,
    stagedBy: null,
    stagedAt: null,
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
  };

  it("lists a v2 correction by family, and counts readings rather than sites", () => {
    render(
      <PerioSendConfirm
        open
        write={write}
        chart={wrote()}
        patientName="Kiwi, Sam"
        examDate="2026-09-08"
        providerLabel="HYG1"
        busy={false}
        replacesExamNum={7001}
        changes={V2_CHANGES.slice(0, 3)}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const box = screen.getByTestId("hyg-perio-confirm-changes");
    expect(box.textContent).toMatch(/What changes \(3 readings\)/);
    expect(box.textContent).toContain("#3 B gingival margin: 2 mm recession → 3 mm recession");
    expect(box.textContent).toContain("#3 mobility: grade 1 → grade 2");
  });
});
