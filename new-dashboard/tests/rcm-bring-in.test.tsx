/**
 * BRING IN — the one upload door, and the three that are not built (§2, D-16).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE TWO CLAIMS THIS SUITE MAKES
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. ALL SIX SOURCES ARE ON THE PAGE. Hiding the three that are not built
 *      answers "can this product take what I am holding?" with silence, and
 *      silence reads as "you are holding it wrong".
 *   2. THE THREE THAT ARE NOT BUILT CANNOT BE ENTERED. Not a disabled button —
 *      a disabled button is still a control a person tabs to and presses
 *      hopefully. No button, no link, no file input, nothing behind them at all.
 *
 * The second is asserted STRUCTURALLY, over the catalogue in
 * `features/rcm/sources.ts`, so a seventh source added there without a lane
 * gets the same treatment for free — and a lane wired to a not-yet tile by
 * accident is a red test rather than a broken click.
 *
 * NO NETWORK, NO PHI. Every payer, filename and figure below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const state = vi.hoisted(() => ({
  era: [] as Record<string, unknown>[],
  eob: [] as Record<string, unknown>[],
  eraFails: false,
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => ({ status: "loading" }) };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listEraUploads: vi.fn(async (office: string) => {
      if (state.eraFails) throw new real.RcmApiError("The 835 list is down", 500, "OOPS");
      return { office, uploads: state.era, total: state.era.length, limit: 25, offset: 0 };
    }),
    listEobUploads: vi.fn(async (office: string) => ({
      office,
      uploads: state.eob,
      total: state.eob.length,
      limit: 25,
      offset: 0,
      extraction: {
        paused: false,
        usedCents: 0,
        capCents: 500,
        remainingCents: 500,
        resetsAt: "2026-03-05T06:00:00.000Z",
        timezone: "America/Chicago",
        persisted: true,
      },
    })),
  };
});

import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LIVE_SOURCES, NOT_YET_SOURCES, SOURCE_TILES } from "@/features/rcm/sources";

function renderPage(node: React.ReactElement) {
  const memory = memoryLocation({ path: "/rcm/bring-in", record: true });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{node}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.era = [];
  state.eob = [];
  state.eraFails = false;
});

afterEach(cleanup);

// ─── The catalogue itself ────────────────────────────────────────────────────

describe("the sources a check can arrive as", () => {
  it("is three live and three not-yet, and the split is explicit", () => {
    expect(SOURCE_TILES).toHaveLength(6);
    expect(LIVE_SOURCES.map((s) => s.id)).toEqual(["era", "eob", "portal"]);
    expect(NOT_YET_SOURCES.map((s) => s.id)).toEqual([
      "paper_keyed",
      "bank_file",
      "paper_check",
    ]);
  });

  it("gives every live tile a lane, and every not-yet tile none", () => {
    /*
     * `lane` is the only thing that decides which existing ingest path a tile
     * opens. A not-yet tile carrying one would be a tile that could be clicked
     * into a lane nobody built the rest of.
     */
    for (const s of LIVE_SOURCES) expect(s.lane, `${s.id} has no lane`).toBeTruthy();
    for (const s of NOT_YET_SOURCES) expect(s.lane, `${s.id} has a lane`).toBeNull();
  });

  it("uses ONE lane for both PDF tiles — a portal PDF is a scanned EOB", () => {
    // Two endpoints for one thing would be the two-doors mistake one level down.
    expect(SOURCE_TILES.find((s) => s.id === "eob")!.lane).toBe("eob");
    expect(SOURCE_TILES.find((s) => s.id === "portal")!.lane).toBe("eob");
    expect(SOURCE_TILES.find((s) => s.id === "era")!.lane).toBe("era");
  });

  it("makes every not-yet tile say what is actually true, never just 'coming soon'", () => {
    for (const s of NOT_YET_SOURCES) {
      expect(s.notYet, `${s.id} says nothing about itself`).toBeTruthy();
      expect(s.notYet!.length).toBeGreaterThan(20);
    }
    // And the one that will NEVER be built says so, rather than implying a
    // feature that has slipped.
    const cheque = SOURCE_TILES.find((s) => s.id === "paper_check")!;
    expect(cheque.notYet).toContain("never");
  });
});

// ─── The page ────────────────────────────────────────────────────────────────

describe("the Bring in page", () => {
  it("renders all six, and marks the three that are not built", async () => {
    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    await screen.findByTestId("bring-in-tiles");
    for (const s of SOURCE_TILES) {
      expect(screen.getByTestId(`bring-in-source-${s.id}`), `${s.id} is missing`).toBeTruthy();
    }
    for (const s of NOT_YET_SOURCES) {
      expect(screen.getByTestId(`bring-in-not-yet-${s.id}`)).toBeTruthy();
      expect(screen.getByTestId(`bring-in-not-yet-note-${s.id}`).textContent).toBe(s.notYet);
    }
  });

  it("cannot be clicked into a broken state — a not-yet tile holds NO control", async () => {
    /*
     * THE STRUCTURAL CLAIM, and it is stronger than "the button is disabled".
     * A disabled button is a thing a person tabs to and presses; these tiles
     * contain nothing to press at all, so there is no state to arrive in.
     */
    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);
    await screen.findByTestId("bring-in-tiles");

    for (const s of NOT_YET_SOURCES) {
      const tile = screen.getByTestId(`bring-in-source-${s.id}`);
      expect(tile.getAttribute("data-live")).toBe("false");
      // Not a button itself…
      expect(tile.tagName.toLowerCase()).not.toBe("button");
      expect(tile.tagName.toLowerCase()).not.toBe("a");
      // …and containing no control of any kind.
      expect(
        tile.querySelectorAll("button, a, input, [role='button']").length,
        `${s.id} contains something clickable`,
      ).toBe(0);
    }
  });

  it("opens the 835 lane, and only that lane, when the 835 tile is pressed", async () => {
    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    await screen.findByTestId("bring-in-tiles");
    // Nothing is open until she says which she is holding.
    expect(screen.queryByTestId("bring-in-panel-era")).toBeNull();
    expect(screen.queryByTestId("bring-in-panel-eob")).toBeNull();

    fireEvent.click(screen.getByTestId("bring-in-source-era"));
    await waitFor(() => expect(screen.getByTestId("bring-in-panel-era")).toBeTruthy());
    // ONE at a time — two drop zones on screen is the shape this page replaced.
    expect(screen.queryByTestId("bring-in-panel-eob")).toBeNull();
  });

  it("the portal tile opens the SAME lane as a scanned EOB", async () => {
    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    await screen.findByTestId("bring-in-tiles");
    fireEvent.click(screen.getByTestId("bring-in-source-portal"));
    // Its own panel heading, and the EOB lane's panel inside it.
    await waitFor(() => expect(screen.getByTestId("bring-in-panel-portal")).toBeTruthy());
    expect(screen.queryByTestId("bring-in-panel-era")).toBeNull();
  });

  it("says nothing came in rather than rendering an empty table", async () => {
    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    const empty = await screen.findByTestId("bring-in-recent-empty-roland");
    expect(empty.textContent).toContain("Nothing has come in for Roland");
    expect(empty.textContent).toContain("Pick a source above");
  });

  it("a lane that fails to load says so, and the other lane's rows still show", async () => {
    /*
     * A table that emptied because one of two reads failed would be hiding work
     * behind a fault. Half an answer LABELLED as half an answer beats a whole
     * answer that is quietly missing a lane.
     */
    state.eraFails = true;
    state.eob = [
      {
        uploadId: "u-1",
        officeId: "roland",
        filename: "synthetic-eob.pdf",
        fileSizeBytes: 1024,
        status: "processed",
        message: null,
        resultClaimId: null,
        resultBatchId: "b-9",
        uploadedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
      },
    ];

    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    const partial = await screen.findByTestId("bring-in-recent-partial-roland");
    expect(partial.textContent).toContain("The 835 list is down");
    expect(partial.textContent).toContain("What is below is the rest.");
    // …and the EOB row is there anyway.
    expect(screen.getByTestId("bring-in-recent-row-eob-u-1").textContent).toContain(
      "synthetic-eob.pdf",
    );
  });

  it("gives one row per CHECK on an 835, not one per file", async () => {
    // A five-check transmission is five pieces of work, and a row per file
    // would make it look like one.
    state.era = [
      {
        uploadId: "u-2",
        filename: "synthetic-835.txt",
        fileHash: "abc",
        fileSizeBytes: 2048,
        contentType: "text/plain",
        status: "processed",
        uploadedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
        remittances: [
          {
            batchId: "b-1",
            checkNumber: "830200001",
            eftNumber: null,
            traceNumber: "830200001",
            paymentMethod: "check",
            payer: "SYNTHETIC DENTAL",
            paymentDate: "2026-03-02",
            totalAmountCents: 15000,
            plbTotalCents: 0,
            claimCount: 2,
            status: "ready",
            notes: "",
            remittanceKey: "k-1",
            dedupeStatus: null,
          },
          {
            batchId: "b-2",
            checkNumber: "830200002",
            eftNumber: null,
            traceNumber: "830200002",
            paymentMethod: "check",
            payer: "SYNTHETIC DENTAL",
            paymentDate: "2026-03-02",
            totalAmountCents: 9900,
            plbTotalCents: 0,
            claimCount: 1,
            status: "needs_review",
            notes: "",
            remittanceKey: "k-2",
            dedupeStatus: null,
          },
        ],
      },
    ];

    const BringIn = (await import("@/pages/rcm/BringIn")).default;
    renderPage(<BringIn />);

    await waitFor(() =>
      expect(screen.getByTestId("bring-in-recent-row-era-u-2-b-1")).toBeTruthy(),
    );
    expect(screen.getByTestId("bring-in-recent-row-era-u-2-b-2")).toBeTruthy();
    expect(screen.getByTestId("bring-in-recent-row-era-u-2-b-1").textContent).toContain(
      "Ready to work",
    );
    expect(screen.getByTestId("bring-in-recent-row-era-u-2-b-2").textContent).toContain(
      "Needs a person",
    );
  });
});
