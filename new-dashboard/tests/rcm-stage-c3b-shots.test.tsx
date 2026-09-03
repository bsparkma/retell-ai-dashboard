/**
 * Screenshot DUMP for Stage C-3b — the Checks list, with patients on it.
 *
 * Same shape and same reasons as `rcm-stage-c3-shots.test.tsx`: renders the
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/c3b-*.html`, which `scripts/shoot-stage-c3b.mjs`
 * wraps in the app's real built CSS and photographs at 1280 wide, light and
 * dark.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE SHOT, AND WHAT IT IS EVIDENCE FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *   c3b-01-checks-patient-names   four rows: one name, two names, two plus a
 *                                 count, and a check that resolved none — so
 *                                 the picture shows every shape the row takes,
 *                                 including the one that prints no line at all.
 *
 * The third row is the one worth looking at twice: NINE claims, FOUR people, so
 * it reads "+2 more" and not "+7". `more` counts people, and a row that derived
 * it from `claimCount` would be wrong about every check where one patient has
 * two claims.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of
 * fixture data in this file, so a screenshot physically cannot contain a real
 * patient.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const OUT = resolve(import.meta.dirname, ".shots");

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

function check(over: Record<string, unknown> = {}) {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: "830200001",
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 45000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    patientNames: { shown: ["Fixture, Synthetic"], more: 0 },
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 45000,
      claimTotalCents: 45000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: [] as string[],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    parkedAt: null,
    parkedBy: null,
    parkedNote: null,
    setAsideAt: null,
    setAsideBy: null,
    setAsideReason: null,
    setAsideNote: null,
    lastDecidedAt: null,
    lastDecidedBy: null,
    upload: null,
    ...over,
  };
}

/** A balance block that agrees with itself, for a check that reconciles. */
function balanced(totalCents: number) {
  return {
    batchTotalCents: totalCents,
    claimTotalCents: totalCents,
    differenceCents: 0,
    plbTotalCents: 0,
    balanced: true,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({ checks: [] as Record<string, unknown>[] }));

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
    listRemittances: vi.fn(async (office: string, opts: Record<string, unknown> = {}) => ({
      office,
      view: (opts.view as string) ?? "all",
      remittances: state.checks,
      total: state.checks.length,
      needsAttentionCount: state.checks.filter((r) => r.needsAttention).length,
      parkedCount: 0,
      setAsideCount: 0,
      matchingCount: state.checks.length,
      limit: 50,
      offset: 0,
    })),
  };
});

import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(node: React.ReactElement, path: string) {
  const [pathname, search = ""] = path.split("?");
  const memory = memoryLocation({ path: pathname, searchPath: search, record: true });
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

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.checks = [];
});

afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("Stage C-3b screenshots", () => {
  it("c3b-01-checks-patient-names — who is on each check, from the list", async () => {
    state.checks = [
      check(),
      check({
        batchId: "b-2",
        checkNumber: "830200002",
        payer: "SYNTHETIC HEALTH PLAN",
        totalAmountCents: 128460,
        claimCount: 2,
        patientNames: { shown: ["Sample, Placeholder", "Placeholder, Third"], more: 0 },
        balance: balanced(128460),
      }),
      check({
        batchId: "b-3",
        checkNumber: "830200003",
        payer: "SYNTHETIC PPO",
        totalAmountCents: 402100,
        claimCount: 9,
        patientNames: { shown: ["Fixture, Synthetic", "Placeholder, Fourth"], more: 2 },
        attentionReasons: ["claims_awaiting_approval"],
        balance: balanced(402100),
      }),
      check({
        batchId: "b-4",
        checkNumber: "830200004",
        payer: "SYNTHETIC DENTAL PLAN",
        totalAmountCents: 5400,
        claimCount: 1,
        // Nothing resolvable: the row prints NO name line rather than an empty
        // one or an assertion the data does not support.
        patientNames: { shown: [], more: 0 },
        balance: balanced(5400),
      }),
    ];

    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances?view=all");
    await waitFor(() => expect(screen.getByTestId("remittance-patients-b-3")).toBeTruthy());
    expect(screen.queryByTestId("remittance-patients-b-4")).toBeNull();
    dump("c3b-01-checks-patient-names");
  });
});
