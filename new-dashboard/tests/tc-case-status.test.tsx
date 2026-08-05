/**
 * StatusTransitionDialog — component test (jsdom).
 *
 * Covers the three confirmed-save behaviors:
 *  (a) picking "lost" without a lostReason blocks submit with an inline error
 *      and never calls the API,
 *  (b) a successful transition posts the right body and fires onSuccess with
 *      the server's case,
 *  (c) an API rejection keeps the dialog open with values intact and the
 *      submit button re-enabled.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform (tsconfig has
// jsx: "preserve"), while the app's Vite build uses the automatic runtime —
// so component modules never import React. Provide the classic-runtime global
// so their JSX renders under vitest (same pattern as tc-followups-queue).
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

import { TcApiError, transitionCase } from "../client/src/features/tc/api";
import { toast } from "sonner";

const transitionMock = vi.mocked(transitionCase);

// ── jsdom gaps Radix Select needs ───────────────────────────────────────────

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

// ── Fixture ─────────────────────────────────────────────────────────────────

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
    doctorName: "Dr. Sparkman",
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

/** Open the status select via keyboard (jsdom-reliable) and pick an option. */
function pickStatus(optionLabel: string) {
  const trigger = screen.getByRole("combobox", { name: "New status" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = screen.getByRole("option", { name: optionLabel });
  fireEvent.keyDown(option, { key: "Enter" });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StatusTransitionDialog", () => {
  it("blocks submitting 'lost' without a lostReason and does not call the API", async () => {
    renderDialog(makeCase());

    pickStatus("Lost");
    // The lost-reason select appears but is deliberately left empty.
    expect(screen.getByRole("combobox", { name: "Lost reason" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("A lost reason is required");
    expect(transitionMock).not.toHaveBeenCalled();
    // Dialog is still open.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("submits a valid transition and fires onSuccess with the server case", async () => {
    const tcCase = makeCase();
    const serverCase = makeCase({ status: "accepted", statusChangedAt: "2026-08-03T12:00:00Z" });
    transitionMock.mockResolvedValue({ changed: true, case: serverCase });

    const { onOpenChange, onSuccess } = renderDialog(tcCase);

    pickStatus("Accepted");
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "Verbal yes at consult" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(serverCase));
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).toHaveBeenCalledWith("roland", tcCase.caseId, {
      status: "accepted",
      lostReason: null,
      note: "Verbal yes at consult",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it("keeps the dialog open with values intact when the API rejects", async () => {
    transitionMock.mockRejectedValue(
      new TcApiError("Module not entitled", 403, "MODULE_NOT_ENTITLED", null, []),
    );

    const { onOpenChange, onSuccess } = renderDialog(makeCase());

    pickStatus("Accepted");
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "keep me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    // Still open, values intact, submit re-enabled — nothing succeeded.
    expect(screen.getByRole("dialog")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect((screen.getByLabelText("Note (optional)") as HTMLTextAreaElement).value).toBe("keep me");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
