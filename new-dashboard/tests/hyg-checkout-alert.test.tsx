/**
 * "ALERT CHECKOUT" on the hygiene visit (queue item 49).
 *
 *   - switched off for the office → the section is not drawn at all.
 *   - the press asks the server with NOTHING about who the patient is — the api
 *     call carries the office and appointment number only.
 *   - "Checkout alerted" renders from the visit's `checkoutSend`, read back;
 *     TC down → the error in words and no "alerted".
 *   - a pending autosave is stored BEFORE the alert, so the front desk gets the
 *     visit on screen.
 *   - a Send whose handoff update did not land says so, with a retry.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The api module is faked; the patient is the
 * roland test fixture 12827 under a synthetic name.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import {
  emptySlip,
  type HygAppointment,
  type HygSlip,
  type HygVisit as HygVisitRow,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const server = vi.hoisted(() => ({
  visit: null as HygVisitRow | null,
  enabled: true,
  calls: [] as string[],
  alertArgs: [] as unknown[][],
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
    checkoutSend: null,
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
    doctorOptions: ["Drew Example"],
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
        doctorOptions: ["Drew Example"],
        checkoutEnabled: server.enabled,
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
      server.visit = { ...server.visit, slip };
      return payload();
    }),
    alertCheckout: vi.fn(async (...args: unknown[]) => {
      server.calls.push("ALERT");
      server.alertArgs.push(args);
      if (server.tcDown) {
        throw new real.HygApiError(
          "The checkout alert was NOT sent: The TC app did not respond. Nothing is lost on this visit; try again.",
          502,
          "TC_UNREACHABLE",
        );
      }
      server.visit = {
        ...(server.visit as HygVisitRow),
        checkoutSend: {
          handoffId: "5d2a7e10-0000-4000-8000-0000000000c1",
          sentAt: "2026-09-08T14:42:00.000Z",
          sentBy: "hygienist@carein.ai",
          finalAt: null,
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
import { CheckoutAlert } from "@/features/hyg/visit/CheckoutAlert";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

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

beforeEach(() => {
  server.visit = baseVisit(emptySlip());
  server.enabled = true;
  server.calls = [];
  server.alertArgs = [];
  server.tcDown = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Alert checkout on the visit page", () => {
  it("is not drawn at all when checkout is switched off for the office", async () => {
    server.enabled = false;
    renderVisit();
    await screen.findByTestId("hyg-visit-tabs");
    expect(screen.queryByTestId("checkout-alert")).toBeNull();
  });

  it("asks with the office and appointment ONLY, and shows 'alerted' from the read-back", async () => {
    renderVisit();
    fireEvent.click(await screen.findByTestId("checkout-alert-button"));
    const alerted = await screen.findByTestId("checkout-alerted");
    expect(alerted.textContent).toMatch(/Checkout alerted at 9:42 AM/);
    expect(alerted.textContent).toMatch(/your final notes go with Send/);
    expect(server.alertArgs).toEqual([["roland", 900001]]);
    expect(screen.queryByTestId("checkout-alert-button")).toBeNull();
  });

  it("TC down → the refusal in words, nothing claimed, the button still there", async () => {
    server.tcDown = true;
    renderVisit();
    fireEvent.click(await screen.findByTestId("checkout-alert-button"));
    const error = await screen.findByTestId("checkout-error");
    expect(error.textContent).toMatch(/NOT sent/);
    expect(screen.queryByTestId("checkout-alerted")).toBeNull();
    expect(screen.getByTestId("checkout-alert-button")).toBeTruthy();
  });

  it("stores a pending autosave BEFORE alerting", async () => {
    renderVisit();
    // A screening tap is a slip change: it autosaves on a debounce, exactly
    // like the rest of the visit — and the alert must not race it.
    fireEvent.click(await screen.findByTestId("hyg-visit-tab-ortho"));
    fireEvent.click(await screen.findByTestId("ortho-interest-yes"));
    expect(server.calls).not.toContain("SAVE");
    fireEvent.click(screen.getByTestId("checkout-alert-button"));
    await screen.findByTestId("checkout-alerted");
    const save = server.calls.indexOf("SAVE");
    const alert = server.calls.indexOf("ALERT");
    expect(save).toBeGreaterThan(-1);
    expect(alert).toBeGreaterThan(save);
  });
});

describe("CheckoutAlert states", () => {
  const sent = {
    handoffId: "5d2a7e10-0000-4000-8000-0000000000c1",
    sentAt: "2026-09-08T14:42:00.000Z",
    sentBy: "hygienist@carein.ai",
    finalAt: "2026-09-08T15:05:00.000Z",
  };

  it("says when the final notes went", () => {
    render(
      <CheckoutAlert sent={sent} sending={false} error={null} delivery={null} onAlert={() => {}} onRetryFinal={() => {}} />,
    );
    expect(screen.getByTestId("checkout-alerted").textContent).toMatch(/final notes sent at 10:05 AM/);
  });

  it("a Send whose update did not land says so, and the retry re-sends only the handoff", async () => {
    const onRetryFinal = vi.fn();
    render(
      <CheckoutAlert
        sent={null}
        sending={false}
        error={null}
        delivery={{ state: "not_delivered", code: "TC_ERROR", message: "TC responded 500" }}
        onAlert={() => {}}
        onRetryFinal={onRetryFinal}
      />,
    );
    const banner = screen.getByTestId("checkout-undelivered");
    expect(banner.textContent).toMatch(/did not get your final notes/);
    expect(banner.textContent).toMatch(/chart writes are not affected/);
    // The retry is the ONE way forward: an early alert now would send a
    // non-final snapshot after the final one was meant to go.
    expect(screen.queryByTestId("checkout-alert-button")).toBeNull();
    fireEvent.click(screen.getByTestId("checkout-retry-final"));
    await waitFor(() => expect(onRetryFinal).toHaveBeenCalledTimes(1));
  });

  it("a delivered Send shows no warning", () => {
    render(
      <CheckoutAlert
        sent={sent}
        sending={false}
        error={null}
        delivery={{ state: "delivered", code: null, message: null }}
        onAlert={() => {}}
        onRetryFinal={() => {}}
      />,
    );
    expect(screen.queryByTestId("checkout-undelivered")).toBeNull();
  });
});
