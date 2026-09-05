/**
 * THE VISIT WORKSPACE — what the screen must never do.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. NOTHING IS GATED ON COMPLETENESS
 * ═════════════════════════════════════════════════════════════════════════════
 * Beau's ruling, verbatim: *"the hygienist should be able to send the treatment
 * to the tc app."* The prototype's Finish tab disabled its Send until "Recare
 * scheduled" and "TX entered in OD" were answered, and drew them in destructive
 * red. Both are FRONT DESK work that happens after she has finished, so gating
 * on them makes her wait on somebody else with a patient in the chair.
 *
 * The Send affordance on this page is disabled, and it is disabled for exactly
 * one reason — sending is not built yet — which the page says in words. These
 * tests assert that reason is the ONLY one, by leaving everything unanswered
 * and checking that every staging control still works.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. THE SCREEN NEVER OWNS THE STATE
 * ═════════════════════════════════════════════════════════════════════════════
 * Every mutation renders the server's readback. A save that silently did
 * nothing must not look like a save that worked, and a staged write's state is
 * the server's word, never this page's guess.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. NOTHING SAYS "SIGNED", AND UNKNOWN IS NOT "NO"
 * ═════════════════════════════════════════════════════════════════════════════
 * CareIN writes the visit note UNSIGNED with a typed name block. And a null
 * flag renders as "unknown" — this is the last screen before somebody puts
 * instruments in a mouth.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  emptySlip,
  type HygAppointment,
  type HygVisit as HygVisitRow,
  type StagedWrite,
  type TreatmentItem,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── The fake server ─────────────────────────────────────────────────────────

const server = vi.hoisted(() => ({
  /** null = nobody has started a visit, which is what a fresh card looks like. */
  visit: null as HygVisitRow | null,
  items: [] as TreatmentItem[],
  staged: [] as StagedWrite[],
  /** Every call, so a test can prove what the page asked for. */
  calls: [] as string[],
  /** Set to make the next stage attempt refuse, the way the server would. */
  stageRefusal: null as { status: number; message: string } | null,
  seq: 0,
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
    premed: true,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();

  const ensureVisit = () => {
    if (!server.visit) {
      server.visit = {
        visitId: "visit-0001",
        office: "roland",
        aptNum: 900001,
        patNum: 12827,
        visitDate: "2026-09-08",
        slip: emptySlip(),
        items: [],
        stagedWrites: [],
        createdBy: "hygienist@carein.ai",
        createdAt: "2026-09-08T13:00:00.000Z",
        updatedBy: null,
        updatedAt: "2026-09-08T13:00:00.000Z",
      };
    }
    return server.visit;
  };

  const payload = () => {
    const visit = ensureVisit();
    const full = { ...visit, items: server.items, stagedWrites: server.staged };
    server.visit = full;
    return {
      success: true as const,
      visit: full,
      // Deliberately simple: this file is about the SCREEN. The real matrix is
      // exercised against the backend in hygVisit.test.js.
      recordsNeeded: server.items.length > 0 ? ["Pre-op PA", "Missing teeth note"] : [],
      handoffCategory: "Restorative" as const,
    };
  };

  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, aptNum: number, date: string) => {
      server.calls.push(`GET ${office}/${aptNum}/${date}`);
      return {
        success: true as const,
        office: office as "roland",
        officeName: "Roland Family Dental",
        date,
        appointment: APPOINTMENT,
        flagSources: { premed: "od" as const },
        visit: server.visit
          ? { ...server.visit, items: server.items, stagedWrites: server.staged }
          : null,
        recordsNeeded: server.items.length > 0 ? ["Pre-op PA", "Missing teeth note"] : [],
        handoffCategory: "Restorative" as const,
      };
    }),
    openVisit: vi.fn(async () => {
      server.calls.push("OPEN");
      return payload();
    }),
    saveSlip: vi.fn(async (_o: string, _a: number, slip: ReturnType<typeof emptySlip>) => {
      server.calls.push("SAVE");
      ensureVisit();
      server.visit = { ...(server.visit as HygVisitRow), slip };
      return payload();
    }),
    addTreatmentItem: vi.fn(async (_o: string, _a: number, input: Record<string, unknown>) => {
      server.calls.push("ADD " + String(input.code));
      server.seq += 1;
      server.items = [
        ...server.items,
        {
          id: `item-${server.seq}`,
          createdBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T13:05:00.000Z",
          ...input,
        } as TreatmentItem,
      ];
      return payload();
    }),
    updateTreatmentItem: vi.fn(
      async (_o: string, _a: number, itemId: string, patch: Record<string, unknown>) => {
        server.calls.push("PATCH " + itemId);
        server.items = server.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i));
        return payload();
      },
    ),
    removeTreatmentItem: vi.fn(async (_o: string, _a: number, itemId: string) => {
      server.calls.push("REMOVE " + itemId);
      server.items = server.items.filter((i) => i.id !== itemId);
      return payload();
    }),
    stageWrite: vi.fn(async (_o: string, _a: number, kind: StagedWrite["kind"]) => {
      server.calls.push("STAGE " + kind);
      if (server.stageRefusal) {
        throw new real.HygApiError(
          server.stageRefusal.message,
          server.stageRefusal.status,
          "NOTHING_TO_STAGE",
        );
      }
      server.staged = [
        ...server.staged.filter((w) => w.kind !== kind),
        {
          id: `staged-${kind}`,
          kind,
          state: "Staged",
          title: kind === "note" ? "Visit note" : "Routing slip",
          summary: "The slip for 2026-09-08",
          preview: [
            "Recare scheduled: not answered",
            ...(kind === "note" ? ["Entered in CareIN by hygienist@carein.ai. Unsigned."] : []),
          ],
          errorMessage: null,
          stagedBy: "hygienist@carein.ai",
          stagedAt: "2026-09-08T13:10:00.000Z",
          sentBy: null,
          sentAt: null,
          updatedAt: "2026-09-08T13:10:00.000Z",
        },
      ];
      return payload();
    }),
    unstageWrite: vi.fn(async (_o: string, _a: number, kind: StagedWrite["kind"]) => {
      server.calls.push("UNSTAGE " + kind);
      server.staged = server.staged.filter((w) => w.kind !== kind);
      return payload();
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderVisit(path = "/hyg/visit/900001?office=roland&date=2026-09-08") {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Route path="/hyg/visit/:aptNum" component={HygVisit} />
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  server.visit = null;
  server.items = [];
  server.staged = [];
  server.calls = [];
  server.stageRefusal = null;
  server.seq = 0;
});

// This project does not enable testing-library auto-cleanup; without this every
// test after the first renders a SECOND page and every query finds two.
afterEach(cleanup);

// ─── The header ──────────────────────────────────────────────────────────────

describe("the patient header", () => {
  it("renders what this page fetched, with unknown flags as unknown", async () => {
    renderVisit();
    const header = await screen.findByTestId("hyg-visit-header");

    expect(header.textContent).toContain("Kiwi, Sam");
    expect(header.textContent).toContain("Prophy Adult");
    // The one TRUE flag is an alert; the six nulls collapse into one chip that
    // says the word "unknown" — never drawn the way a clear flag would be.
    expect(screen.getByTestId("hyg-visit-flag-alert").textContent).toMatch(/premed/i);
    expect(screen.getByTestId("hyg-visit-flag-unknown").textContent).toMatch(/unknown/i);
  });

  it("refuses to open a visit when it does not know which office", async () => {
    renderVisit("/hyg/visit/900001");
    const page = await screen.findByTestId("hyg-visit-no-office");
    expect(page.textContent).toMatch(/which office/i);
    // And it asked the server for nothing, because it has nothing to ask about.
    expect(server.calls).toEqual([]);
  });
});

// ─── The ruling ──────────────────────────────────────────────────────────────

describe("nothing is gated on completeness", () => {
  it("stages every kind with the front-desk questions unanswered", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    // Both unanswered, and both saying so in a MUTED reminder rather than an
    // alarm — they describe work the front desk does after she has finished.
    expect(screen.getByTestId("hyg-slip-recare-reminder").textContent).toMatch(
      /does not stop you sending/i,
    );
    expect(screen.getByTestId("hyg-slip-tx-entered-reminder")).toBeTruthy();

    fireEvent.click(screen.getByTestId("hyg-stage-router"));
    await waitFor(() => expect(server.staged.length).toBe(1));
    fireEvent.click(screen.getByTestId("hyg-stage-note"));
    await waitFor(() => expect(server.staged.length).toBe(2));

    // No control anywhere was disabled by the unanswered questions.
    expect(screen.getByTestId("hyg-unstage-router").hasAttribute("disabled")).toBe(false);
  });

  it("the Send affordance is disabled ONLY because sending is not built", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    const send = screen.getByTestId("hyg-send-all");
    expect(send.hasAttribute("disabled")).toBe(true);
    // The reason is permanently visible and is about the RELEASE, not about
    // anything she has or has not filled in.
    const reason = screen.getByTestId("hyg-send-all-reason").textContent ?? "";
    expect(reason).toMatch(/not built yet/i);
    expect(reason).toMatch(/not waiting on anything you have filled in/i);
    expect(reason).not.toMatch(/recare|records|complete/i);
  });
});

// ─── The server owns the state ───────────────────────────────────────────────

describe("the server owns the visit", () => {
  it("creates nothing until she changes something", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    // A GET, and nothing else. Glancing at a card leaves no visit behind.
    expect(server.calls).toEqual(["GET roland/900001/2026-09-08"]);
    expect(server.visit).toBeNull();
    expect(screen.getByTestId("hyg-visit-save-state").textContent).toMatch(/nothing saved yet/i);
  });

  it("opens the visit on the first change, and renders the readback", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));

    await waitFor(() => expect(server.items.length).toBe(1));
    // OPEN came first, and it is idempotent server-side.
    expect(server.calls).toContain("OPEN");
    // What is on screen is what the server answered, item id and all.
    await screen.findByTestId(`hyg-item-${server.items[0].id}`);
  });

  it("renders a staged write's state and preview from the server, never its own", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-stage-router"));
    const preview = await screen.findByTestId("hyg-staged-preview-router");

    expect(screen.getByTestId("hyg-staged-state").textContent).toBe("Staged");
    // The server's words, including the honest "not answered".
    expect(preview.textContent).toContain("Recare scheduled: not answered");
  });

  it("shows a refusal to stage beside the thing that was refused", async () => {
    server.stageRefusal = { status: 422, message: "There is no treatment on this visit to hand off." };
    renderVisit();
    await screen.findByTestId("hyg-visit");

    fireEvent.click(screen.getByTestId("hyg-stage-tc-handoff"));
    const note = await screen.findByTestId("hyg-stage-refused-tc-handoff");
    expect(note.textContent).toMatch(/no treatment on this visit/i);
    // And the page is still usable — a content refusal is not a page error.
    expect(screen.getByTestId("hyg-visit")).toBeTruthy();
    expect(screen.queryByTestId("hyg-visit-inline-error")).toBeNull();
  });
});

// ─── Treatment ───────────────────────────────────────────────────────────────

describe("treatment items", () => {
  it("will not add a tooth-level item before a tooth is picked", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    // Disabled, and it says why rather than doing nothing when tapped.
    const crown = screen.getByTestId("hyg-add-Crown");
    expect(crown.hasAttribute("disabled")).toBe(true);
    expect(crown.getAttribute("title")).toMatch(/pick a tooth/i);

    // A whole-mouth item needs none, so it is available immediately.
    expect(screen.getByTestId("hyg-add-Whitening").hasAttribute("disabled")).toBe(false);
  });

  it("keeps priority and category as two separate questions", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items.length).toBe(1));
    const id = server.items[0].id;

    fireEvent.click(screen.getByTestId(`hyg-item-edit-${id}`));

    // The two words that collide have their own controls, under questions
    // written in words rather than as a noun.
    const priorityChip = screen.getByTestId(`hyg-item-${id}-priority-cosmetic`);
    const categoryChip = screen.getByTestId(`hyg-item-${id}-category-Cosmetic`);
    expect(priorityChip).not.toBe(categoryChip);
    expect(screen.getByText(/how soon\?/i)).toBeTruthy();
    expect(screen.getByText(/what kind of work\?/i)).toBeTruthy();

    // Choosing the CATEGORY does not touch the priority.
    fireEvent.click(categoryChip);
    await waitFor(() => expect(server.items[0].category).toBe("Cosmetic"));
    expect(server.items[0].priority).toBe("preventative");
  });

  it("defaults a new item to preventative, not urgent", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-tooth-14"));
    fireEvent.click(screen.getByTestId("hyg-add-Comp"));

    // A default of "urgent" would make the word mean nothing by Friday.
    await waitFor(() => expect(server.items[0].priority).toBe("preventative"));
  });

  it("removes an item on request", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-tooth-3"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(server.items.length).toBe(1));

    fireEvent.click(screen.getByTestId(`hyg-item-remove-${server.items[0].id}`));
    await waitFor(() => expect(server.items.length).toBe(0));
    expect(await screen.findByTestId("hyg-treatment-empty")).toBeTruthy();
  });
});

// ─── Compliance ──────────────────────────────────────────────────────────────

describe("what the screen may not claim", () => {
  it("never says a note is signed", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    fireEvent.click(screen.getByTestId("hyg-stage-note"));
    await screen.findByTestId("hyg-staged-preview-note");

    const page = screen.getByTestId("hyg-visit").textContent ?? "";
    // "Unsigned" is allowed; "signed" on its own is a claim only Open Dental's
    // own signature block may make.
    expect(page).toMatch(/Unsigned/);
    expect(page).not.toMatch(/(?<!un)\bsigned\b/i);
  });

  it("says perio is not built rather than offering to send an empty one", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");

    const perio = screen.getByTestId("hyg-stage-perio");
    expect(perio.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("hyg-staged-perio").textContent).toMatch(/not built yet/i);
  });

  it("gives every control a 44px tap target", async () => {
    renderVisit();
    await screen.findByTestId("hyg-visit");
    for (const id of ["hyg-stage-router", "hyg-tooth-3", "hyg-slip-recare-yes"]) {
      const el = screen.getByTestId(id);
      expect(el.className).toMatch(/min-h-11|h-11/);
    }
  });
});
