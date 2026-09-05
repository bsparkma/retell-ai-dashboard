/**
 * THE SEND, ON SCREEN — the confirm step, and what the results may claim.
 *
 * Four things this screen must never do:
 *
 *   1. Confirm a SUMMARY. The dialog shows the exact lines, because those are
 *      the lines that will be written.
 *   2. Send a payload. What goes back is the FINGERPRINT of what was on screen;
 *      the server holds the words.
 *   3. Show one verdict for a visit. Partial success is the normal case, so
 *      each write carries its own state and its own reason.
 *   4. Say a note was signed.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { emptySlip, type HygAppointment, type StagedWrite } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  staged: [] as StagedWrite[],
  /** Every send call, verbatim — so a test can prove what crossed the wire. */
  sends: [] as unknown[],
  /** Set to make the next send refuse the way a stale preview would. */
  sendRefusal: null as { status: number; message: string } | null,
  /** What the send turns each kind into. */
  outcome: {} as Record<string, Partial<StagedWrite>>,
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  patientName: "Kiwi, Sam",
  start: "2026-09-08 08:00:00",
  lengthMin: 60,
  opNum: 2,
  opName: "Hygiene 1",
  isHygiene: true,
  opIsHygiene: true,
  provNum: 1,
  provHyg: 7,
  providerName: "HYG1",
  apptTypeLabel: "Prophy Adult",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

function stagedWrite(kind: StagedWrite["kind"], over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: `staged-${kind}`,
    kind,
    state: "Staged",
    title: kind === "note" ? "Visit note" : "Routing slip",
    summary: "The slip for 2026-09-08",
    preview: [
      "Done today: Prophy",
      "Recare scheduled: not answered",
      ...(kind === "note" ? ["Entered in CareIN by hygienist@carein.ai. Unsigned."] : []),
    ],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
    ...over,
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const contract = await import("@shared/hyg/contract");

  const visit = () => ({
    visitId: "visit-0001",
    office: "roland" as const,
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip: contract.emptySlip(),
    items: [],
    stagedWrites: server.staged,
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  });

  const mutation = () => ({
    success: true as const,
    visit: visit(),
    recordsNeeded: [],
    handoffCategory: "Restorative" as const,
  });

  return {
    ...real,
    fetchVisit: vi.fn(async () => ({
      success: true as const,
      office: "roland" as const,
      officeName: "Roland Family Dental",
      date: "2026-09-08",
      appointment: APPOINTMENT,
      flagSources: { premed: "od" as const },
      visit: visit(),
      recordsNeeded: [],
      handoffCategory: "Restorative" as const,
    })),
    openVisit: vi.fn(async () => mutation()),
    sendVisit: vi.fn(async (_o: string, _a: number, _d: string, confirm: unknown) => {
      server.sends.push(confirm);
      if (server.sendRefusal) {
        throw new real.HygApiError(server.sendRefusal.message, server.sendRefusal.status, "PREVIEW_CHANGED");
      }
      server.staged = server.staged.map((w) => ({ ...w, ...(server.outcome[w.kind] ?? {}) }));
      const outcomes = server.staged.map((w) => ({
        kind: w.kind,
        state: w.state,
        writtenRef: w.writtenRef,
        errorMessage: w.errorMessage,
        code: w.state === "Failed" ? "OD_WRITE_FAILED" : null,
      }));
      return {
        ...mutation(),
        outcomes,
        written: outcomes.filter((o) => o.state === "Written").length,
        failed: outcomes.filter((o) => o.state === "Failed").length,
      };
    }),
    retryStagedWrite: vi.fn(async (_o: string, _a: number, kind: StagedWrite["kind"]) => {
      server.staged = server.staged.map((w) =>
        w.kind === kind ? { ...w, state: "Staged", errorMessage: null } : w,
      );
      return mutation();
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderVisit() {
  const memory = memoryLocation({
    path: "/hyg/visit/900001?office=roland&date=2026-09-08",
    record: true,
  });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path="/hyg/visit/:aptNum" component={HygVisit} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

beforeEach(() => {
  server.staged = [];
  server.sends = [];
  server.sendRefusal = null;
  server.outcome = {};
});
afterEach(cleanup);

describe("the confirm step", () => {
  it("shows the exact lines that will be written, not a summary of them", async () => {
    server.staged = [stagedWrite("note"), stagedWrite("router")];
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-send-all"));
    const body = await screen.findByTestId("hyg-confirm-send-body");

    // The patient's name, so it is obvious whose chart this is.
    expect(body.textContent).toContain("Kiwi, Sam");
    // Every line of every write.
    expect(screen.getByTestId("hyg-confirm-note").textContent).toContain(
      "Recare scheduled: not answered",
    );
    expect(screen.getByTestId("hyg-confirm-router")).toBeTruthy();
    // And what happens if it changes underneath her.
    expect(body.textContent).toMatch(/if any of it changes before you confirm, nothing is sent/i);

    // Nothing has been sent by opening the dialog.
    expect(server.sends).toHaveLength(0);
  });

  it("sends FINGERPRINTS, never words", async () => {
    server.staged = [stagedWrite("note"), stagedWrite("router")];
    server.outcome = {
      note: { state: "Written", writtenRef: "GroupNote on 2 procedures (5001, 5002)" },
      router: { state: "Written", writtenRef: "Document 4711 in Routers" },
    };
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    await waitFor(() => expect(server.sends).toHaveLength(1));
    expect(server.sends[0]).toEqual([
      { kind: "note", previewFingerprint: "fp-note" },
      { kind: "router", previewFingerprint: "fp-router" },
    ]);
  });

  it("a stale preview stops everything, and says so beside the Send button", async () => {
    server.staged = [stagedWrite("note")];
    server.sendRefusal = {
      status: 409,
      message: "The note write changed since you read it. Nothing was sent.",
    };
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    const refusal = await screen.findByTestId("hyg-send-refused");
    expect(refusal.textContent).toMatch(/Nothing was sent/);
    // A refusal about the SEND, not about one row — it stopped the batch.
    expect(screen.queryByTestId("hyg-failed-note")).toBeNull();
    // And it is not a page-level error that hides the visit.
    expect(screen.getByTestId("hyg-visit")).toBeTruthy();
  });
});

describe("what the results may claim", () => {
  it("shows WHERE each write landed, per write", async () => {
    server.staged = [stagedWrite("note"), stagedWrite("router")];
    server.outcome = {
      note: { state: "Written", writtenRef: "GroupNote on 2 procedures (5001, 5002)", sentBy: "hygienist@carein.ai" },
      router: { state: "Written", writtenRef: "Document 4711 in Routers", sentBy: "hygienist@carein.ai" },
    };
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    // "It was sent" and "here it is" are different claims; this screen makes
    // the second one, with who made it.
    const landed = await screen.findByTestId("hyg-written-router");
    expect(landed.textContent).toContain("Document 4711 in Routers");
    expect(landed.textContent).toContain("hygienist@carein.ai");
    expect(screen.getByTestId("hyg-written-note").textContent).toContain("GroupNote on 2");
  });

  it("PARTIAL SUCCESS: one written, one failed, and no single verdict anywhere", async () => {
    server.staged = [stagedWrite("note"), stagedWrite("router")];
    server.outcome = {
      note: { state: "Written", writtenRef: "GroupNote on 2 procedures (5001, 5002)" },
      router: { state: "Failed", errorMessage: "Open Dental refused the routing slip: storage full" },
    };
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));

    await screen.findByTestId("hyg-written-note");
    const failed = screen.getByTestId("hyg-failed-router");
    expect(failed.textContent).toMatch(/storage full/);

    // No "sent" banner for the VISIT. A visit is never sent; its writes are.
    const page = screen.getByTestId("hyg-visit").textContent ?? "";
    expect(page).not.toMatch(/visit sent|all sent|everything is written/i);

    // The failed one offers a retry; the written one does not.
    expect(screen.getByTestId("hyg-retry-router")).toBeTruthy();
    expect(screen.queryByTestId("hyg-retry-note")).toBeNull();
  });

  it("a retry puts the SAME words back on the list", async () => {
    const words = stagedWrite("router").preview;
    server.staged = [stagedWrite("router", { state: "Failed", errorMessage: "storage full" })];
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-retry-router"));
    await waitFor(() => expect(screen.getByTestId("hyg-staged-state-Staged")).toBeTruthy());
    // Not re-composed — a retry that rebuilt the preview would send something
    // she never read.
    expect(screen.getByTestId("hyg-staged-preview-router").textContent).toContain(words[0]);
  });

  it("never says a note is signed, before or after sending", async () => {
    server.staged = [stagedWrite("note")];
    server.outcome = { note: { state: "Written", writtenRef: "GroupNote on 1 procedure (5001)" } };
    renderVisit();
    await screen.findByTestId("hyg-visit");

    const before = screen.getByTestId("hyg-visit").textContent ?? "";
    expect(before).toMatch(/Unsigned/);
    expect(before).not.toMatch(/(?<!un)\bsigned\b/i);

    fireEvent.click(screen.getByTestId("hyg-send-all"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-send-accept"));
    await screen.findByTestId("hyg-written-note");

    const after = screen.getByTestId("hyg-visit").textContent ?? "";
    expect(after).not.toMatch(/(?<!un)\bsigned\b/i);
  });
});
