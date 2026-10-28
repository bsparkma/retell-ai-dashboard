/**
 * Hygienist feedback round 1, on screen.
 *
 *   A2. One tooth mapping: the picker stores B as 102 and every screen prints
 *       it as "B" (permanent teeth as "#30") — the same function the server's
 *       composer uses, not a second copy.
 *   B.  Done today offers ADD PMT, the four Laser quadrants and OFI, and no
 *       longer offers Polish — but a slip that already has Polish still shows it
 *       as picked. Restorative offers SSC on primary and permanent teeth.
 *       Draft visit types say "(draft)" on their chip.
 *   C.  The handoff card is stageable with no treatment items when an existing
 *       answer is TC work, and says so.
 *
 * NO NETWORK, NO PHI.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { emptySlip, type HygSlip, type TreatmentItemInput } from "@shared/hyg/contract";
import * as sharedTeeth from "@shared/hyg/teeth";
import { DRAFT_VISIT_TYPES, VISIT_TYPE_LABELS } from "@shared/hyg/noteTemplates";
import * as picker from "@/features/hyg/visit/ToothPicker";
import { teethLabel } from "@/features/tc/referrals/ReferralsPanel";
import { RouterSlip } from "@/features/hyg/visit/RouterSlip";
import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import { StagedWritesTray } from "@/features/hyg/visit/StagedWritesTray";

(globalThis as Record<string, unknown>).React = React;
afterEach(cleanup);

describe("A2: one tooth mapping, everywhere", () => {
  it("the picker's functions ARE the shared ones — no second copy", () => {
    expect(picker.toothLabel).toBe(sharedTeeth.toothLabel);
    expect(picker.primaryToNumber).toBe(sharedTeeth.primaryToNumber);
    expect(picker.PRIMARY_OFFSET).toBe(sharedTeeth.PRIMARY_OFFSET);
  });

  it("primary only, permanent only, mixed", () => {
    const B = sharedTeeth.primaryToNumber("B");
    const I = sharedTeeth.primaryToNumber("I");
    expect([B, I]).toEqual([102, 109]);
    expect(sharedTeeth.teethText([B, I])).toBe("B, I");
    expect(sharedTeeth.teethText([3, 30])).toBe("#3, #30");
    expect(sharedTeeth.teethText([30, B])).toBe("#30, B");
    // TC's referral chip reads the same way.
    expect(teethLabel([30, B])).toBe("#30, B");
  });

  it("picking primary B and adding SSC stores 102 and shows B", () => {
    const adds: TreatmentItemInput[] = [];
    render(
      <TreatmentItems items={[]} busy={false} onAdd={(i) => adds.push(i)} onPatch={() => {}} onRemove={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("hyg-dentition-primary"));
    fireEvent.click(screen.getByTestId("hyg-tooth-B"));
    expect(screen.getByTestId("hyg-add-selection").textContent).toMatch(/^B — pick the work/);
    fireEvent.click(screen.getByTestId("hyg-add-SSC"));
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ code: "SSC", category: "Restorative", teeth: [102] });
  });

  it("SSC is a tooth item on permanent teeth too, never whole-mouth", () => {
    const adds: TreatmentItemInput[] = [];
    render(
      <TreatmentItems items={[]} busy={false} onAdd={(i) => adds.push(i)} onPatch={() => {}} onRemove={() => {}} />,
    );
    // Not addable with no tooth picked: it is not a whole-mouth item.
    expect((screen.getByTestId("hyg-add-SSC") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-SSC"));
    expect(adds[0].teeth).toEqual([30]);
  });
});

describe("B: the Done-today vocabulary", () => {
  function slip(doneToday: string[]): HygSlip {
    return { ...emptySlip(), doneToday };
  }

  it("offers the new chips and no longer offers Polish", () => {
    render(<RouterSlip slip={slip([])} recordsNeeded={[]} onChange={() => {}} />);
    for (const id of ["add-pmt", "laser-ur", "laser-ul", "laser-ll", "laser-lr", "ofi"]) {
      expect(screen.getByTestId(`hyg-slip-done-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("hyg-slip-done-add-pmt").textContent).toBe("ADD PMT");
    expect(screen.queryByTestId("hyg-slip-done-polish")).toBeNull();
  });

  it("a slip saved with Polish still shows it picked, and un-picking it is a normal save", () => {
    const onChange = vi.fn();
    render(<RouterSlip slip={slip(["prophy", "polish"])} recordsNeeded={[]} onChange={onChange} />);
    const chip = screen.getByTestId("hyg-slip-done-polish");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onChange.mock.calls[0][0].doneToday).toEqual(["prophy"]);
  });

  it("every draft visit type is labelled a draft", () => {
    expect(DRAFT_VISIT_TYPES.size).toBe(9);
    for (const t of DRAFT_VISIT_TYPES) expect(VISIT_TYPE_LABELS[t]).toBeTruthy();
  });
});

describe("C: the handoff card without treatment items", () => {
  function tray(existingTcActionable: number) {
    render(
      <StagedWritesTray
        staged={[]}
        handoffCategory="Other"
        patientName="this patient"
        itemCount={0}
        existingTcActionable={existingTcActionable}
        busy={false}
        sending={false}
        onStage={() => {}}
        onUnstage={() => {}}
        onSend={() => {}}
        onRetry={() => {}}
        refusal={null}
        perioHref="#"
        perio={null}
        onResumePerio={() => {}}
      />,
    );
  }

  it("is stageable when an existing answer is TC work, and says why", () => {
    tray(2);
    expect((screen.getByTestId("hyg-stage-tc-handoff") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("hyg-handoff-existing-only").textContent).toMatch(/No new treatment today/);
    expect(screen.queryByTestId("hyg-handoff-no-items")).toBeNull();
  });

  it("is not stageable with neither, and names both ways it becomes stageable", () => {
    tray(0);
    expect((screen.getByTestId("hyg-stage-tc-handoff") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("hyg-handoff-no-items").textContent).toMatch(/ready to schedule/);
  });
});
