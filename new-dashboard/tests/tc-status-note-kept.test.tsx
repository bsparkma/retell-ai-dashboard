/**
 * StatusTransitionDialog — same-status + note (fix/status-note-drop).
 *
 * With the case's CURRENT status selected, Save used to post and the server
 * dropped the note. Now the server keeps it, and the dialog is honest about it:
 *  - same status + a typed note → the button reads "Save note", posts the note,
 *    toasts "Note saved", closes;
 *  - same status + no note (or whitespace) → Save is disabled, nothing posts;
 *  - a different status → the button stays "Save" (existing behavior).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-case-status.test.tsx).
(globalThis as Record<string, unknown>).React = React;
import type { TcCase } from "../shared/tc/contract";
import { StatusTransitionDialog } from "../client/src/features/tc/caseview/StatusTransitionDialog";

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, transitionCase: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { transitionCase } from "../client/src/features/tc/api";
import { toast } from "sonner";

const transitionMock = vi.mocked(transitionCase);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ── Fixture (same shape as tests/tc-case-status.test.tsx; synthetic) ────────

function makeCase(overrides: Partial<TcCase> = {}): TcCase {
  return {
    caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    legacyId: null,
    officeId: "roland",
    patientName: "Test Patient",
    patientAge: 44,
    phone: "479-555-0100",
    email: "test@example.com",
    odPatientId: null,
    caseType: "",
    category: "implant",
    status: "presented",
    urgency: "medium",
    doctorName: "Dr. Example",
    diagnosingProvider: null,
    assignedTc: "tc-user",
    caseValueCents: 450_000,
    readinessScore: 60,
    financingStatus: "",
    preferredFinancingProvider: null,
    decisionMakers: "",
    financialSituation: [],
    keyMotivators: [],
    contactPreference: null,
    bestTimeToReach: "",
    notes: "",
    referralSource: null,
    lostReason: null,
    diagnosedDate: null,
    statusChangedAt: null,
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: null,
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    phases: [],
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
    ...overrides,
  };
}

function renderDialog(tcCase: TcCase) {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  render(
    <StatusTransitionDialog
      office="roland"
      tcCase={tcCase}
      open={true}
      onOpenChange={onOpenChange}
      onSuccess={onSuccess}
    />,
  );
  return { onOpenChange, onSuccess };
}

function pickStatus(optionLabel: string) {
  const trigger = screen.getByRole("combobox", { name: "New status" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = screen.getByRole("option", { name: optionLabel });
  fireEvent.keyDown(option, { key: "Enter" });
}

const typeNote = (value: string) =>
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value } });

describe("StatusTransitionDialog — same status + note", () => {
  it("with the current status and no note, Save is disabled and nothing posts", () => {
    renderDialog(makeCase()); // status: presented, preselected
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(transitionMock).not.toHaveBeenCalled();

    typeNote("   ");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with the current status and a note, the button says 'Save note' and the note is kept", async () => {
    const tcCase = makeCase();
    const serverCase = makeCase({ statusChangedAt: "2026-11-10T16:00:00Z" });
    transitionMock.mockResolvedValue({ changed: false, noteAdded: true, case: serverCase });
    const { onOpenChange, onSuccess } = renderDialog(tcCase);

    typeNote("Left a voicemail");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    const save = screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(serverCase));
    expect(transitionMock).toHaveBeenCalledWith("roland", tcCase.caseId, {
      status: "presented",
      lostReason: null,
      note: "Left a voicemail",
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Note saved");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a different status keeps the 'Save' label even with a note", () => {
    renderDialog(makeCase());
    pickStatus("Accepted");
    typeNote("Verbal yes");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save note" })).toBeNull();
  });
});
