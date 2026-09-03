/**
 * The takeback panel — an ABSENCE is not a FAILURE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Stage A's review found that this panel rendered a red failure line for ANY
 * error the checklist read returned — a 404 included. A 404 from
 * `GET /remittances/:id/recoupment` means the check is not there for this office
 * (a stale id, a check retired underneath an open tab, a link followed after an
 * office switch). It does not mean anything went wrong, and it certainly does
 * not mean anything went wrong WITH A TAKEBACK.
 *
 * A false red on the one surface whose subject is money moving backwards is a
 * trust defect, not a cosmetic one: a biller who has learned that this panel
 * cries wolf is a biller who will scroll past the day it does not.
 *
 * One test per branch, which is the whole point — before the fix, both branches
 * rendered the same red line.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const state = vi.hoisted(() => ({
  error: null as unknown,
  checklist: null as unknown,
}));

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getRecoupmentChecklist: vi.fn(async () => {
      if (state.error) throw state.error;
      return (
        state.checklist ?? {
          office: "roland",
          batchId: "b-1",
          claims: [],
          recoupmentClaims: 1,
          recoupmentTotalCents: -5408,
          typedTotalExpected: "-54.08",
          paths: ["adjustment", "supplemental"],
          defaultPath: "adjustment",
          balanced: true,
          differenceCents: 0,
          canApprove: true,
          approveRequires: "rcm.write",
        }
      );
    }),
    approveRecoupment: vi.fn(async () => new Promise(() => {})),
  };
});

import { RecoupmentPanel } from "@/pages/rcm/RecoupmentPanel";
import { RcmApiError } from "@/features/rcm/api";

beforeEach(() => {
  state.error = null;
  state.checklist = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel() {
  render(<RecoupmentPanel office="roland" batchId="b-1" />);
}

it("a 404 renders NOTHING — there is no such check here, and that is not a failure", async () => {
  state.error = new RcmApiError("No such remittance for this office", 404, "REMITTANCE_NOT_FOUND");
  const { container } = render(<RecoupmentPanel office="roland" batchId="b-1" />);
  await waitFor(() => expect(container.textContent).not.toContain("Loading the takeback"));
  expect(screen.queryByTestId("recoupment-failed")).toBeNull();
  expect(screen.queryByTestId("recoupment-panel")).toBeNull();
  // The same silence a check with no takeback on it already gets. A panel that
  // appeared to say "there is no takeback here" would be an invitation to go
  // looking for one.
  expect(container.textContent).toBe("");
});

it("a 500 DOES render the failure line — that is what it is for", async () => {
  state.error = new RcmApiError("Something went wrong reading this check", 500, "INTERNAL_ERROR");
  renderPanel();
  const failed = await screen.findByTestId("recoupment-failed");
  // The server's own words, never "something went wrong".
  expect(failed.textContent).toContain("Something went wrong reading this check");
});

it("a network failure with no status still renders the failure line", async () => {
  state.error = new Error("Failed to fetch");
  renderPanel();
  const failed = await screen.findByTestId("recoupment-failed");
  expect(failed.textContent).toContain("The takeback panel could not load.");
});

it("zero takebacks on a check that DOES exist renders nothing either", async () => {
  state.checklist = {
    office: "roland",
    batchId: "b-1",
    claims: [],
    recoupmentClaims: 0,
    recoupmentTotalCents: 0,
    typedTotalExpected: "0.00",
    paths: [],
    defaultPath: "adjustment",
    balanced: true,
    differenceCents: 0,
    canApprove: true,
    approveRequires: "rcm.write",
  };
  const { container } = render(<RecoupmentPanel office="roland" batchId="b-1" />);
  await waitFor(() => expect(container.textContent).not.toContain("Loading the takeback"));
  expect(container.textContent).toBe("");
});

it("a real takeback still renders, with the server's phrase VERBATIM", async () => {
  renderPanel();
  const panel = await screen.findByTestId("recoupment-panel");
  expect(panel.textContent).toContain("The carrier is taking money back");
  // The client never formats cents into the phrase it is about to demand.
  expect(panel.textContent).toContain("-54.08");
});

/* ═══════════════════════════════════════════════════════════════════════════
   STAGE C (§9, ruling D-17) — THE EXPLANATION CAME FIRST, THE TYPING DID NOT
   MOVE
   ═══════════════════════════════════════════════════════════════════════════
   The design proposed replacing the typed confirmation with tick boxes. It was
   REFUSED, and these tests are what stops it drifting back: a takeback moves
   money in the direction nobody expects, and a tick box is a click you can make
   without reading (D-6).

   What Stage C added is an explanation ABOVE the mechanism, and one clause of it
   is the one this app cannot perform — somebody has to ring the patient.

   NO REAL PATIENT DATA. Every name and figure below is synthetic. */

/** One takeback claim on the check, in the shape the check's page passes down. */
const TAKEBACK_CLAIM = {
  claimId: "c-9",
  officeId: "roland",
  claimNumber: "53911",
  checkNumber: "830200009",
  patientName: "Reversal, Synthetic",
  odPatientId: 12827,
  odClaimNum: 53911,
  payer: "SYNTHETIC DENTAL",
  serviceDate: "2026-02-01",
  receivedDate: "2026-03-05",
  status: "pending_review",
  paymentStatus: "reversed",
  insuranceType: "PPO",
  totalBilledCents: 12000,
  totalAllowedCents: 9000,
  totalPaidCents: -5408,
  totalDeductibleCents: 0,
  patientBalanceCents: 5408,
  needsReviewReasons: ["reversal_not_postable"],
  extractionConfidence: 100,
  odMatchStatus: "confirmed",
  rejectedCandidates: 0,
  odMatchAt: null,
  odMatchConfirmedAt: null,
  odMatchedBy: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: null,
  postingQueueId: null,
  approvedAt: null,
  createdAt: null,
  lines: [
    {
      lineId: "l-9",
      position: 1,
      billedCode: "D2740",
      paidCode: null,
      code: "D2740",
      description: "Crown",
      billedCents: 12000,
      allowedCents: 9000,
      deductibleCents: 0,
      copayCents: 0,
      paidCents: -5408,
      adjustmentCents: 0,
      patientRespCents: 5408,
      writeOffCents: 0,
      adjustmentReason: null,
      isDowncoded: false,
      isBundled: false,
      isDenied: false,
      flags: [],
      odClaimProcNum: 533930,
      adjustments: [
        {
          adjustmentId: "a-1",
          groupCode: "OA",
          reasonCode: "23",
          reasonDescription: "Impact of prior payer adjudication",
          groupDescription: null,
          remarkCode: null,
          remarkDescription: null,
          amountCents: 5408,
        },
      ],
      contractualWriteOffCents: 0,
      patientRemainderCents: 5408,
      decision: null,
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
    },
  ],
} as unknown as import("@/features/rcm/api").RemittanceClaim;

function renderWithClaims() {
  render(<RecoupmentPanel office="roland" batchId="b-1" claims={[TAKEBACK_CLAIM]} />);
}

it("explains what is being reversed, off what, why, and what it does to the patient", async () => {
  renderWithClaims();

  const explainer = await screen.findByTestId("recoupment-explainer");
  // WHAT is being reversed, and how much.
  expect(explainer.textContent).toContain("one claim on this check");
  expect(explainer.textContent).toContain("$54.08");
  // WHICH payment it comes off — the chart claim, named.
  expect(explainer.textContent).toContain("Open Dental claim 53911");
  // The CARRIER's own reason, in its own code and its own words.
  expect(explainer.textContent).toContain("OA-23");
  expect(explainer.textContent).toContain("Impact of prior payer adjudication");
  // And what happens to the person.
  expect(explainer.textContent).toContain("owes more once this posts");
});

it("says out loud that somebody has to ring the patient, and that this app will not", async () => {
  /*
   * The one clause this product cannot act on. A takeback lands on a person who
   * finds out from a statement unless somebody calls them, and a screen that
   * left that implicit would be implying an outreach that does not exist.
   */
  renderWithClaims();
  const call = await screen.findByTestId("recoupment-call-them");
  expect(call.textContent).toContain("Somebody should call");
  expect(call.textContent).toContain("Reversal, Synthetic");
  expect(call.textContent).toContain("send");
});

it("degrades to a general phrase when the claims were not passed, never to a blank", async () => {
  // A caller without them still gets an honest explanation, just a less
  // specific one — the panel never renders an empty clause.
  renderPanel();
  const explainer = await screen.findByTestId("recoupment-explainer");
  expect(explainer.textContent).toContain("the claim in Open Dental");
  expect(explainer.textContent).toContain("none was sent with the file");
  expect(screen.getByTestId("recoupment-call-them").textContent).toContain("the patient");
});

it("STILL gates the approve on the typed value — no tick box, D-6 stands", async () => {
  renderWithClaims();
  await screen.findByTestId("recoupment-panel");

  // No checkbox anywhere in the panel: the confirmation is TYPED.
  expect(screen.getByTestId("recoupment-panel").querySelectorAll('input[type="checkbox"]'))
    .toHaveLength(0);

  const button = screen.getByTestId("recoupment-approve-button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByTestId("recoupment-awaiting-phrase")).toBeTruthy();
});

it("requires the SIGNED form, and the label says which form that is", async () => {
  /*
   * Beau's ruling: the existing behaviour wins — the typed value keeps its
   * signed shape. What Stage C added is that the FIELD says so, so the sign is
   * never a thing to guess at. The expected value is still rendered VERBATIM
   * from the server: a client that formats cents can show `-54.8` while the
   * server means `-54.08`.
   */
  renderWithClaims();
  const input = await screen.findByTestId("recoupment-confirm-input");

  // The unsigned amount is NOT enough.
  fireEvent.change(input, { target: { value: "54.08" } });
  expect((screen.getByTestId("recoupment-approve-button") as HTMLButtonElement).disabled).toBe(true);

  // The signed one is.
  fireEvent.change(input, { target: { value: "-54.08" } });
  expect((screen.getByTestId("recoupment-approve-button") as HTMLButtonElement).disabled).toBe(
    false,
  );

  // And the label states the form rather than leaving it to be discovered.
  expect(screen.getByText(/minus sign and all/)).toBeTruthy();
  expect(screen.getByTestId("recoupment-expected").textContent).toBe("-54.08");
});
