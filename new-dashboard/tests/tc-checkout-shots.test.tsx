/**
 * Screenshot DUMPS for the TC Checkout page (queue item 50).
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-checkout-shots.test.tsx
 *   node scripts/shoot-tc-checkout.mjs
 *
 *   tccheckout-01-inbox      today's waiting checkouts, newest first
 *   tccheckout-02-sidebar    a row opened: the snapshot + the three outcomes
 *   tccheckout-03-answered   the same sidebar after "Scheduled"
 *   tccheckout-04-switch     the platform console's per-office switch
 *
 * NO NETWORK, NO BACKEND, NO PHI. Synthetic names; roland fixture PatNums.
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { TcCheckoutHandoff } from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

function handoff(n: number, over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: `5d2a7e10-0000-4000-8000-00000000000${n}`,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-09-08",
    snapshot: {
      procedures: [
        { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "Fractured cusp" },
        { teeth: [14, 15], code: "Comp", category: "Restorative", priority: "preventative", status: "proposed", surfaces: ["M", "O"], scheduleNext: false, note: "" },
      ],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 months, periodic exam" },
      notesPending: false,
      frontDeskNote: "Prefers afternoons.",
      financialNote: "Has dental insurance; ask about the crown estimate.",
    },
    final: true,
    revision: 2,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T14:42:00.000Z",
    updatedAt: "2026-09-08T14:42:00.000Z",
    status: "open",
    claimedBy: null,
    claimedAt: null,
    dismissedReason: null,
    dismissedBy: null,
    dismissedAt: null,
    outcomeBy: null,
    outcomeAt: null,
    appointmentNote: null,
    caseId: null,
    expiredAt: null,
    ...over,
  };
}

const fixtures = vi.hoisted(() => ({ rows: [] as TcCheckoutHandoff[] }));

vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  listCheckout: vi.fn(async (_o: string, view: string) => ({
    success: true,
    today: "2026-09-08",
    view,
    handoffs: fixtures.rows,
  })),
  getCheckoutHandoff: vi.fn(async (_o: string, id: string) => fixtures.rows.find((r) => r.handoffId === id)),
  claimCheckout: vi.fn(),
  dismissCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(async (_o: string, id: string, outcome: string, note: string) => {
    const r = fixtures.rows.find((x) => x.handoffId === id) as TcCheckoutHandoff;
    const done = {
      ...r,
      status: outcome,
      outcomeBy: "tc@carein.ai",
      outcomeAt: "2026-09-08T15:05:00.000Z",
      appointmentNote: note,
      caseId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    };
    return { success: true, handoff: done, caseId: done.caseId, url: `/tc/cases/${done.caseId}`, attached: false };
  }),
  getCheckoutSummary: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const office = (o: string, enabled: boolean, source: "db" | "default" | "env") => ({
    office: o,
    enabled,
    source,
    policyKnown: true,
    envValue: null,
    settingKey: "tc_checkout_enabled",
    envVar: `TC_CHECKOUT_ENABLED_${o.toUpperCase()}`,
    updatedAt: "2026-10-14T12:00:00.000Z",
    updatedBy: source === "db" ? "boss@carein.ai" : null,
  });
  return {
    ...real,
    api: {
      ...real.api,
      getTcCheckoutOffices: vi.fn(async () => ({
        offices: [office("roland", true, "db"), office("valley", false, "default")],
        settingKey: "tc_checkout_enabled",
        controlPlaneError: null,
      })),
    },
  };
});

import { CheckoutInbox } from "@/pages/tc/TcCheckout";
import { TcPageHeader } from "@/features/tc/components/TcShell";
import { TcCheckoutPanel } from "@/pages/platform/TcCheckoutPanel";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function page() {
  const memory = memoryLocation({ path: "/tc/checkout" });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <div className="p-6 max-w-4xl mx-auto">
        <TcPageHeader title="Checkout" subtitle="Patients the hygiene visit sent to the front desk today" />
        <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
      </div>
    </WouterRouter>,
  );
}

const SHOOT = process.env.TC_SHOTS === "1";
afterEach(cleanup);

describe.skipIf(!SHOOT)("tc checkout screenshot dumps", () => {
  it("01 — the inbox", async () => {
    const base = handoff(1).snapshot;
    fixtures.rows = [
      handoff(3, { patientName: "Kiwi, Sam", createdAt: "2026-09-08T15:10:00.000Z" }),
      handoff(2, {
        patientName: "Plum, Ada",
        status: "claimed",
        claimedBy: "tc@carein.ai",
        createdAt: "2026-09-08T14:30:00.000Z",
        snapshot: { ...base, priority: "preventative", notesPending: true, procedures: [base.procedures[1]] },
      }),
      handoff(1, {
        patientName: "Fig, Lee",
        createdAt: "2026-09-08T13:05:00.000Z",
        snapshot: { ...base, priority: null, procedures: [] },
      }),
    ];
    page();
    await screen.findAllByTestId("checkout-row");
    dump("tccheckout-01-inbox");
  });

  it("02 — the sidebar", async () => {
    fixtures.rows = [handoff(3)];
    page();
    // RULING (CO-1): the sidebar is now the row's "Quick look"; a row opens the workup view.
    fireEvent.click(await screen.findByTestId("checkout-row-quicklook"));
    await screen.findByTestId("checkout-procedures");
    dump("tccheckout-02-sidebar@1280x1100");
  });

  it("03 — answered: Scheduled", async () => {
    fixtures.rows = [handoff(3)];
    page();
    // RULING (CO-1): the sidebar is now the row's "Quick look"; a row opens the workup view.
    fireEvent.click(await screen.findByTestId("checkout-row-quicklook"));
    fireEvent.change(await screen.findByTestId("checkout-appointment-note"), {
      target: { value: "Tue 10/21 9:00, Dr. chair" },
    });
    fireEvent.click(screen.getByTestId("checkout-outcome-scheduled"));
    await screen.findByTestId("checkout-answered");
    dump("tccheckout-03-answered@1280x1100");
  });

  it("04 — the platform switch", async () => {
    render(
      <div className="p-6 max-w-3xl">
        <TcCheckoutPanel />
      </div>,
    );
    await screen.findByTestId("tc-checkout-office-roland");
    dump("tccheckout-04-switch@1280x500");
  });
});
