/**
 * Next touch in the Change-status dialog.
 *
 * Moving a case INTO an open status requires a next-touch date + owner unless
 * the case already has a pending follow-up. Defaults: owner = the signed-in
 * person, date = two business days out. The dialog sends `nextTouch` ONLY on
 * a move that needs one. Terminal moves and same-status notes are untouched.
 * A server 409 NEXT_TOUCH_REQUIRED (the case changed under the dialog) reveals
 * the fields instead of failing. Synthetic data only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase, TcFollowup } from "../shared/tc/contract";
import { defaultNextTouchDate } from "../shared/tc/nextTouch";
import { StatusTransitionDialog } from "../client/src/features/tc/caseview/StatusTransitionDialog";
import { todayIsoDate } from "../client/src/features/tc/lib/followups";

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, transitionCase: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: { name: "TC User", email: "tc@carein.ai", tenantId: "t", tenant: null, role: "tc", isSuperAdmin: false },
  }),
}));

import { TcApiError, transitionCase } from "../client/src/features/tc/api";
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
beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function pending(overrides: Partial<TcFollowup> = {}): TcFollowup {
  return {
    followupId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    kind: "followup",
    dueDate: "2026-11-20",
    channel: "phone_call",
    status: "pending",
    talkingPoint: "",
    outcomeNote: "",
    completedAt: null,
    completedBy: null,
    source: "manual",
    patientResponded: null,
    nurtureType: null,
    owner: "tc@carein.ai",
    ...overrides,
  };
}

function makeCase(overrides: Partial<TcCase> = {}): TcCase {
  return {
    caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    legacyId: null,
    officeId: "roland",
    patientName: "Test 2, Stedi",
    patientAge: 44,
    phone: "",
    email: "",
    odPatientId: null,
    caseType: "",
    category: "implant",
    status: "diagnosed",
    urgency: "medium",
    doctorName: "",
    diagnosingProvider: null,
    assignedTc: "",
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
    <StatusTransitionDialog office="roland" tcCase={tcCase} open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
  );
  return { onOpenChange, onSuccess };
}

function pickStatus(optionLabel: string) {
  const trigger = screen.getByRole("combobox", { name: "New status" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: optionLabel }), { key: "Enter" });
}

const dateInput = () => screen.getByLabelText("Next touch") as HTMLInputElement;
const ownerInput = () => screen.getByLabelText("Owner") as HTMLInputElement;

describe("StatusTransitionDialog — next touch", () => {
  it("moving into an open status with no pending follow-up shows date + owner, defaulted (me, +2 business days)", () => {
    renderDialog(makeCase());
    expect(screen.queryByLabelText("Owner")).toBeNull();
    pickStatus("Considering");
    expect(dateInput().value).toBe(defaultNextTouchDate(todayIsoDate()));
    expect(ownerInput().value).toBe("tc@carein.ai");
  });

  it("submits the move WITH nextTouch (date, owner, channel)", async () => {
    const tcCase = makeCase();
    transitionMock.mockResolvedValue({ changed: true, case: makeCase({ status: "considering" }) });
    const { onSuccess } = renderDialog(tcCase);
    pickStatus("Considering");
    fireEvent.change(dateInput(), { target: { value: "2026-11-17" } });
    fireEvent.change(ownerInput(), { target: { value: "alex.owner@carein.ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(transitionMock).toHaveBeenCalledWith("roland", tcCase.caseId, {
      status: "considering",
      lostReason: null,
      note: "",
      nextTouch: { dueDate: "2026-11-17", owner: "alex.owner@carein.ai", channel: "phone_call" },
    });
  });

  it("a blank owner or date blocks the save and calls nothing", async () => {
    renderDialog(makeCase());
    pickStatus("Presented");
    fireEvent.change(ownerInput(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("owns the next touch");

    fireEvent.change(ownerInput(), { target: { value: "tc@carein.ai" } });
    fireEvent.change(dateInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("next-touch date");
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("a case that already has a pending follow-up needs nothing: no fields, no nextTouch sent", async () => {
    const tcCase = makeCase({ followups: [pending()] });
    transitionMock.mockResolvedValue({ changed: true, case: makeCase({ status: "presented" }) });
    const { onSuccess } = renderDialog(tcCase);
    pickStatus("Presented");
    expect(screen.queryByLabelText("Owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(transitionMock).toHaveBeenCalledWith("roland", tcCase.caseId, {
      status: "presented",
      lostReason: null,
      note: "",
    });
  });

  it("a completed follow-up does not count: the fields still show", () => {
    renderDialog(makeCase({ followups: [pending({ status: "completed", completedAt: "2026-11-01T12:00:00Z" })] }));
    pickStatus("Presented");
    expect(screen.getByLabelText("Owner")).toBeTruthy();
  });

  it("terminal moves (Scheduled, Accepted) never ask", () => {
    renderDialog(makeCase());
    pickStatus("Scheduled");
    expect(screen.queryByLabelText("Owner")).toBeNull();
    pickStatus("Accepted");
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });

  it("a server NEXT_TOUCH_REQUIRED reveals the fields instead of failing; the retry carries nextTouch", async () => {
    const tcCase = makeCase({ followups: [pending()] });
    transitionMock.mockRejectedValueOnce(
      new TcApiError("Set a next touch", 409, "NEXT_TOUCH_REQUIRED", null, []),
    );
    transitionMock.mockResolvedValueOnce({ changed: true, case: makeCase({ status: "presented" }) });
    const { onSuccess } = renderDialog(tcCase);
    pickStatus("Presented");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no next step");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(ownerInput().value).toBe("tc@carein.ai");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(transitionMock).toHaveBeenLastCalledWith(
      "roland",
      tcCase.caseId,
      expect.objectContaining({ status: "presented", nextTouch: expect.objectContaining({ owner: "tc@carein.ai" }) }),
    );
  });
});
