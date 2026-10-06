/**
 * THE ORTHO SCREENING TAB on the hygiene visit (queue item 33).
 *
 *   1  every group renders with exactly the approved labels, in order, with
 *      the question above it; single-pick groups clear on a second tap; "None"
 *      in After ortho is exclusive.
 *   3  a tap autosaves with the visit; a reload shows what was saved; an older
 *      visit with no screening key loads without error.
 *   5  Send to TC asks the server with NOTHING about who the case is for — the
 *      api call carries the office and appointment number only.
 *   6  TC down → the error in words, no "Sent", the chips still editable.
 *
 * The send FLUSHES a pending autosave first, so TC gets the sheet on screen.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The api module is faked; the patient is the
 * roland test fixture 12827 under a synthetic name.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  emptySlip,
  type HygAppointment,
  type HygSlip,
  type HygVisit as HygVisitRow,
} from "@shared/hyg/contract";
import { emptyOrthoScreening } from "@shared/hyg/orthoScreening";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  visit: null as HygVisitRow | null,
  calls: [] as string[],
  /** Arguments every sendOrthoScreening call was made with. */
  sendArgs: [] as unknown[][],
  /** Set to make the next ortho send refuse the way the server does when TC is down. */
  tcDown: false,
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  identity: "resolved",
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
    premed: false,
    medicalAlerts: false,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

function baseVisit(slip: HygSlip): HygVisitRow {
  return {
    visitId: "visit-0001",
    office: "roland",
    aptNum: 900001,
    patNum: 12827,
    visitDate: "2026-09-08",
    slip,
    items: [],
    stagedWrites: [],
    orthoSend: null,
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedBy: null,
    updatedAt: "2026-09-08T13:00:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const payload = () => ({
    success: true as const,
    visit: server.visit as HygVisitRow,
    recordsNeeded: [],
    handoffCategory: "Other" as const,
    doctorOptions: ["Beau Sparkman"],
  });
  return {
    ...real,
    fetchVisit: vi.fn(async (office: string, _aptNum: number, date: string) => {
      server.calls.push("GET");
      return {
        success: true as const,
        office: office as "roland",
        officeName: "Roland Family Dental",
        date,
        appointment: APPOINTMENT,
        flagSources: { premed: "od" as const },
        visit: server.visit,
        recordsNeeded: [],
        handoffCategory: "Other" as const,
        doctorOptions: ["Beau Sparkman"],
      };
    }),
    openVisit: vi.fn(async () => {
      server.calls.push("OPEN");
      if (!server.visit) server.visit = baseVisit(emptySlip());
      return payload();
    }),
    saveSlip: vi.fn(async (_o: string, _a: number, slip: HygSlip) => {
      server.calls.push("SAVE");
      if (!server.visit) server.visit = baseVisit(emptySlip());
      // The server's freeze, restated: a sent sheet keeps its stored screening.
      const kept = server.visit.orthoSend ? server.visit.slip.orthoScreening : slip.orthoScreening;
      server.visit = { ...server.visit, slip: { ...slip, orthoScreening: kept } };
      return payload();
    }),
    sendOrthoScreening: vi.fn(async (...args: unknown[]) => {
      server.calls.push("SEND ORTHO");
      server.sendArgs.push(args);
      if (server.tcDown) {
        throw new real.HygApiError(
          "The screening was NOT sent to the TC: The TC app did not respond. It is saved here; try again.",
          502,
          "TC_UNREACHABLE",
        );
      }
      server.visit = {
        ...(server.visit as HygVisitRow),
        orthoSend: {
          caseId: "8f3c1d20-0000-4000-8000-0000000000aa",
          sentAt: "2026-09-08T14:42:00.000Z",
          sentBy: "hygienist@carein.ai",
        },
      };
      return { ...payload(), alreadySent: false };
    }),
    fetchPerioSend: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
    fetchPerio: vi.fn(async () => {
      throw new real.HygApiError("CareIN could not be reached", 0, null);
    }),
  };
});

import HygVisit from "@/pages/hyg/HygVisit";
import { OrthoScreening } from "@/features/hyg/visit/OrthoScreening";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as hygApi from "@/features/hyg/api";

function renderVisit() {
  const memory = memoryLocation({ path: "/hyg/visit/900001?office=roland&date=2026-09-08" });
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

async function openOrthoTab() {
  renderVisit();
  fireEvent.click(await screen.findByTestId("hyg-visit-tab-ortho"));
  return screen.findByTestId("hyg-ortho-screening");
}

beforeEach(() => {
  server.visit = null;
  server.calls = [];
  server.sendArgs = [];
  server.tcDown = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The question above a group, and the chips under it, as rendered. */
function group(testId: string) {
  const el = screen.getByTestId(testId);
  return {
    question: el.getAttribute("aria-label"),
    chips: within(el)
      .getAllByRole("button")
      .map((b) => b.textContent),
  };
}

describe("1: every group, exactly as approved", () => {
  it("renders each question with exactly its labels, in order", async () => {
    await openOrthoTab();
    const expected: Array<[string, string, string[]]> = [
      ["ortho-interest", "Interested?", ["Yes", "Maybe", "Not now"]],
      ["ortho-decider", "Who decides?", ["Patient decides", "Parent decides"]],
      [
        "ortho-concerns",
        "Concerns",
        ["Crowding", "Spacing", "Overbite", "Underbite", "Crossbite", "Open bite", "Protrusion",
          "Midline off", "Bite / jaw", "Snoring / airway"],
      ],
      ["ortho-arches", "Which arches?", ["Upper", "Lower", "Comprehensive (both)"]],
      ["ortho-modality", "Aligners or braces?", ["Clear aligners", "Traditional braces", "Doctor to decide"]],
      ["ortho-months", "Estimated months", ["6", "9", "12", "15", "18", "21", "24", "30", "36"]],
      ["ortho-phase", "Phase (if staged)", ["Phase 1", "Phase 2"]],
      ["ortho-upper", "Upper", ["Expansion / RPE", "NiTi RPE", "MDA", "RMD", "Nance", "Reverse-pull HG"]],
      ["ortho-lower", "Lower", ["Expansion", "Lip bumper", "3D lingual", "FLA", "RMD", "MDA"]],
      ["ortho-myo", "Myo therapy", ["Not needed", "Before", "During", "After"]],
      ["ortho-myo-why", "Why", ["Tongue thrust", "Mouth breathing", "Low tongue", "Asymmetry", "Airway"]],
      [
        "ortho-after",
        "After ortho",
        ["None", "Peg laterals", "Anterior bonding", "Implants", "Pontic / Maryland", "Smile makeover", "FMR"],
      ],
      ["ortho-records", "Taken today", ["Photos", "Pano", "Scan", "Ceph"]],
      ["ortho-benefit", "Ortho benefit", ["Has ortho benefit", "No ortho benefit", "Not sure, TC will verify"]],
      ["ortho-consult", "Consult", ["In-office consult", "Phone consult", "TC to call"]],
    ];
    for (const [testId, question, chips] of expected) {
      expect(group(testId)).toEqual({ question, chips });
    }
    // The two text boxes and the date are there, and optional.
    expect(screen.getByTestId("ortho-after-teeth")).toHaveProperty("maxLength", 40);
    expect(screen.getByTestId("ortho-note")).toHaveProperty("maxLength", 280);
    expect(screen.getByTestId("ortho-booked-for")).toHaveProperty("type", "date");
  });

  it("every chip is a 44px+ touch target", async () => {
    await openOrthoTab();
    for (const chip of within(screen.getByTestId("hyg-ortho-screening")).getAllByRole("button")) {
      expect(chip.className).toMatch(/min-h-11/);
    }
  });

  it("a single-pick group clears on a second tap", async () => {
    await openOrthoTab();
    const yes = screen.getByTestId("ortho-interest-yes");
    fireEvent.click(yes);
    expect(yes.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("ortho-interest-maybe"));
    expect(yes.getAttribute("aria-pressed")).toBe("false");
    const maybe = screen.getByTestId("ortho-interest-maybe");
    fireEvent.click(maybe);
    expect(maybe.getAttribute("aria-pressed")).toBe("false");
  });

  it('"None" in After ortho is exclusive', async () => {
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-after-implants"));
    fireEvent.click(screen.getByTestId("ortho-after-fmr"));
    fireEvent.click(screen.getByTestId("ortho-after-none"));
    expect(screen.getByTestId("ortho-after-none").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ortho-after-implants").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ortho-after-fmr").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("ortho-after-peg_laterals"));
    expect(screen.getByTestId("ortho-after-none").getAttribute("aria-pressed")).toBe("false");
  });

  it("months are multi-select, and the live summary shows the range", async () => {
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-interest-yes"));
    fireEvent.click(screen.getByTestId("ortho-months-18"));
    expect(screen.getByTestId("ortho-summary").textContent).toBe("Interested: Yes · 18 mo");
    fireEvent.click(screen.getByTestId("ortho-months-24"));
    expect(screen.getByTestId("ortho-summary").textContent).toBe("Interested: Yes · 18–24 mo");
  });

  it("Send to TC waits for Interested? and nothing else", async () => {
    await openOrthoTab();
    const send = screen.getByTestId("ortho-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ortho-interest-not_now"));
    expect(send.disabled).toBe(false);
  });
});

describe("3: it autosaves with the visit and survives a reload", () => {
  it("a tap is stored by the slip's own autosave", async () => {
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-interest-yes"));
    await waitFor(() => expect(server.calls).toContain("SAVE"), { timeout: 3000 });
    expect(server.visit?.slip.orthoScreening?.interest).toBe("yes");
  });

  it("a reload shows the stored screening", async () => {
    server.visit = baseVisit({
      ...emptySlip(),
      orthoScreening: { ...emptyOrthoScreening(), interest: "maybe", concerns: ["spacing"] },
    });
    await openOrthoTab();
    expect(screen.getByTestId("ortho-interest-maybe").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ortho-concerns-spacing").getAttribute("aria-pressed")).toBe("true");
  });

  it("an older visit with no screening key at all loads without error", async () => {
    const old = { ...emptySlip() } as Record<string, unknown>;
    delete old.orthoScreening;
    const visit = baseVisit(old as HygSlip) as Record<string, unknown>;
    delete visit.orthoSend;
    server.visit = visit as HygVisitRow;
    const tab = await openOrthoTab();
    expect(tab).toBeTruthy();
    expect(screen.queryByTestId("hyg-visit-error")).toBeNull();
    expect((screen.getByTestId("ortho-send") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("5 + 6: the send", () => {
  it("flushes the pending autosave FIRST, then sends with no patient, office body or provider", async () => {
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-interest-yes"));
    // Pressed inside the debounce: the tap has NOT been saved yet.
    fireEvent.click(screen.getByTestId("ortho-send"));
    await screen.findByTestId("ortho-sent");

    const saveAt = server.calls.lastIndexOf("SAVE");
    const sendAt = server.calls.indexOf("SEND ORTHO");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeLessThan(sendAt);
    // The call carries the office and the appointment number — nothing else.
    expect(server.sendArgs).toEqual([["roland", 900001]]);
    expect(vi.mocked(hygApi.sendOrthoScreening)).toHaveBeenCalledTimes(1);
  });

  it("Sent shows the time and the chips go read-only", async () => {
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-interest-yes"));
    fireEvent.click(screen.getByTestId("ortho-send"));
    const sent = await screen.findByTestId("ortho-sent");
    expect(sent.textContent).toMatch(/Sent to TC at 9:42/);
    expect(screen.queryByTestId("ortho-send")).toBeNull();
    expect((screen.getByTestId("ortho-interest-maybe") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("hyg-visit-tab-ortho").textContent).toMatch(/Sent/);
  });

  it("6: TC down → the reason in words, NO Sent, and the sheet stays editable and saved", async () => {
    server.tcDown = true;
    await openOrthoTab();
    fireEvent.click(screen.getByTestId("ortho-interest-yes"));
    fireEvent.click(screen.getByTestId("ortho-send"));
    const alert = await screen.findByTestId("ortho-send-error");
    expect(alert.textContent).toMatch(/NOT sent to the TC/);
    expect(screen.queryByTestId("ortho-sent")).toBeNull();
    // Saved before the attempt, and still editable after it.
    expect(server.visit?.slip.orthoScreening?.interest).toBe("yes");
    const maybe = screen.getByTestId("ortho-interest-maybe") as HTMLButtonElement;
    expect(maybe.disabled).toBe(false);
    fireEvent.click(maybe);
    expect(maybe.getAttribute("aria-pressed")).toBe("true");
    // And the button is there to try again.
    expect((screen.getByTestId("ortho-send") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the component on its own", () => {
  it("a sent screening renders read-only from `sent`, never from a local guess", () => {
    render(
      <OrthoScreening
        screening={{ ...emptyOrthoScreening(), interest: "yes" }}
        sent={{ caseId: "c", sentAt: "2026-09-08T14:42:00.000Z", sentBy: "hygienist@carein.ai" }}
        sending={false}
        error={null}
        onChange={() => {}}
        onSend={() => {}}
      />,
    );
    expect(screen.getByTestId("ortho-sent").textContent).toMatch(/Sent to TC/);
    for (const chip of within(screen.getByTestId("hyg-ortho-screening")).getAllByRole("button")) {
      expect((chip as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
