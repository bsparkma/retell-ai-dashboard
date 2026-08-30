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
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
