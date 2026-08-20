/**
 * Render smoke tests for the two TC kanban boards after the drag-and-drop
 * wiring went in. Neither board had a render test before, and both now mount
 * a DndContext, register draggables/droppables and carry a DragOverlay — so
 * what is pinned here is that the NON-drag behaviour survived it:
 *
 *   - every column still renders
 *   - clicking a card opens it (edit dialog on preauth, case page on pipeline)
 *   - a click on the menu trigger does NOT also open the card behind it
 *     (the trigger stops propagation now that the whole card is clickable)
 *   - the "Move to…" fallback is still on every card
 *   - the lost drop strip is absent while nothing is being dragged
 *
 * The drop RULES live in tc-board-dnd.test.ts. dnd-kit's pointer plumbing is
 * deliberately not simulated: jsdom has no layout, so every rect measures
 * 0×0 and no drop could mean anything.
 *
 * Patients are synthetic. No real names, phones, or PatNums.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform while the app's
// Vite build uses the automatic runtime — so component modules never import
// React. Provide the classic-runtime global (same pattern as tc-case-status).
(globalThis as Record<string, unknown>).React = React;

import type { TcPreauthCase } from "../shared/tc/contract";
import type { TcCaseSummary } from "../client/src/features/tc/api";
import {
  BOARD_STATUSES,
  CASE_STATUSES,
  PREAUTH_BOARD_STATUSES,
  PREAUTH_STATUSES,
} from "../client/src/features/tc/status";
import { PreauthBoard } from "../client/src/features/tc/preauth/PreauthBoard";
import { PipelineBoard } from "../client/src/features/tc/cases/PipelineBoard";

afterEach(cleanup);

const preauthRow = (over: Partial<TcPreauthCase> = {}): TcPreauthCase => ({
  preauthId: "11111111-1111-4111-8111-111111111111",
  legacyId: null,
  officeId: "roland",
  caseId: null,
  patientName: "Testpatient, Alpha",
  phone: null,
  email: null,
  odPatientId: null,
  preauthType: "treatment",
  description: "",
  insuranceCarrier: "Fixture Dental",
  status: "pending",
  doctorName: "Dr. Fixture",
  createdAt: "2026-08-01T12:00:00.000Z",
  submittedDate: null,
  decisionDate: null,
  referenceNumber: "",
  notes: "",
  ...over,
});

const caseRow = (over: Partial<TcCaseSummary> = {}): TcCaseSummary => ({
  caseId: "22222222-2222-4222-8222-222222222222",
  legacyId: null,
  officeId: "roland",
  patientName: "Testpatient, Beta",
  patientAge: null,
  phone: null,
  email: null,
  odPatientId: null,
  caseType: "Fixture treatment",
  category: "single_tooth",
  status: "diagnosed",
  urgency: "medium",
  doctorName: "Dr. Fixture",
  diagnosingProvider: null,
  assignedTc: "",
  caseValueCents: 120_000,
  readinessScore: 50,
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
  statusChangedAt: "2026-08-01T12:00:00.000Z",
  nurtureCadence: "standard",
  inLongTailMode: false,
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurturePhase1DaysOverride: null,
  nurturePhase2DaysOverride: null,
  nurtureUnsubscribed: false,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
  ...over,
});

describe("PreauthBoard", () => {
  const renderBoard = (over: { onEdit?: () => void } = {}) => {
    const onEdit = over.onEdit ?? vi.fn();
    const onTransition = vi.fn().mockResolvedValue(undefined);
    render(
      <PreauthBoard
        cases={[preauthRow()]}
        onTransition={onTransition}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />,
    );
    return { onEdit, onTransition };
  };

  it("renders every board column", () => {
    render(
      <PreauthBoard
        cases={[]}
        onTransition={vi.fn().mockResolvedValue(undefined)}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    for (const status of PREAUTH_BOARD_STATUSES) {
      expect(screen.getAllByText(PREAUTH_STATUSES[status].label).length).toBeGreaterThan(0);
    }
  });

  it("opens the editor when the card body is clicked", () => {
    const onEdit = vi.fn();
    renderBoard({ onEdit });
    fireEvent.click(screen.getByText("Testpatient, Alpha"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("does not open the editor when the actions menu trigger is clicked", () => {
    const onEdit = vi.fn();
    renderBoard({ onEdit });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps the Move to… fallback on the card", () => {
    renderBoard();
    expect(screen.getByRole("button", { name: /Move to/ })).toBeTruthy();
  });

  it("labels the card for assistive tech", () => {
    renderBoard();
    expect(screen.getByLabelText(/Testpatient, Alpha, Pending/)).toBeTruthy();
  });
});

describe("PipelineBoard", () => {
  const renderBoard = (over: { onOpen?: (id: string) => void } = {}) => {
    const onOpen = over.onOpen ?? vi.fn();
    const onTransition = vi.fn().mockResolvedValue(true);
    render(
      <PipelineBoard cases={[caseRow()]} onOpen={onOpen} onTransition={onTransition} />,
    );
    return { onOpen, onTransition };
  };

  it("renders every board column plus the ghost Nurture column", () => {
    render(
      <PipelineBoard cases={[]} onOpen={vi.fn()} onTransition={vi.fn().mockResolvedValue(true)} />,
    );
    for (const status of [...BOARD_STATUSES, "nurture" as const]) {
      expect(screen.getAllByText(CASE_STATUSES[status].label).length).toBeGreaterThan(0);
    }
  });

  it("opens the case when the card is clicked", () => {
    const onOpen = vi.fn();
    renderBoard({ onOpen });
    fireEvent.click(screen.getByText("Testpatient, Beta"));
    expect(onOpen).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("does not open the case when the move menu trigger is clicked", () => {
    const onOpen = vi.fn();
    renderBoard({ onOpen });
    fireEvent.click(screen.getByRole("button", { name: /^Move Testpatient, Beta/ }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows no lost drop target until something is being dragged", () => {
    renderBoard();
    expect(screen.queryByText("Drop here to mark lost")).toBeNull();
  });

  it("moves nothing on render — a board never transitions on its own", () => {
    const { onTransition } = renderBoard();
    expect(onTransition).not.toHaveBeenCalled();
  });
});
