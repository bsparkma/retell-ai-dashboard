/**
 * THE SHELL — Today, the nav, the two worklist states, and the one upload door.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * Stage A rebuilt the SHAPE of this module around a biller's day rather than
 * around the slices that built it. Every claim below is one a person would
 * notice being wrong within a morning, and none of them is checked by the
 * server:
 *
 *  · `/rcm` lands on Today, and Today is the first nav item;
 *  · SAVE FOR TOMORROW is a note to yourself, not a way to lose work — the check
 *    still needs attention, it appears on Today, and OPENING IT clears the note;
 *  · SET ASIDE is the opposite — out of the counts, out of Today, findable under
 *    its own filter, and reversible in one click;
 *  · there is EXACTLY ONE upload surface in the whole module;
 *  · the one-check Post and the office-wide Post are the SAME CALL, differing
 *    only by which check is named.
 *
 * The backend is the source of truth for what is ALLOWED
 * (`backend/routes/rcm/worklistState.test.js`, `posting.test.js`). This suite is
 * about what a person is TOLD and what a click does.
 *
 * NO REAL PATIENTS. Every name, payer and number below is synthetic.
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
    totalAmountCents: 15000,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 1,
    status: "ready",
    source: "835",
    flags: [] as string[],
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    createdBy: "Billing User",
    balance: {
      batchTotalCents: 15000,
      claimTotalCents: 15000,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: true,
    attentionReasons: ["claims_unreviewed"],
    attentionObservations: ["claims_unmatched"],
    reviewReasonCount: 0,
    unmatchedClaimCount: 1,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    // Stage A's two worklist states. Null throughout = neither.
    parkedAt: null,
    parkedBy: null,
    parkedNote: null,
    setAsideAt: null,
    setAsideBy: null,
    setAsideReason: null,
    setAsideNote: null,
    upload: null,
    ...over,
  };
}

const EMPTY_QUEUE = {
  office: "roland",
  rows: [] as unknown[],
  byStatus: {
    approved: 0,
    posting: 0,
    posted: 0,
    failed: 0,
    partially_posted: 0,
    blocked: 0,
    withdrawn: 0,
  },
  total: 0,
  limit: 200,
  offset: 0,
  canDrain: true,
  drainRequires: "rcm.post",
  postingEnabled: true,
  drainEnabled: true,
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  /** Every call the page made, so a test can assert WHAT was sent. */
  calls: [] as { fn: string; args: unknown[] }[],
  queue: null as unknown,
  plan: null as unknown,
  drainCalls: [] as { office: string; opts: Record<string, unknown> }[],
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

  /**
   * THE SERVER'S OWN VIEW RULES, MIRRORED.
   *
   * A mock that ignored `view` would let the page pass a test the real server
   * would fail — the exact reason the workbench suite's own list mock applies
   * the filter rather than returning everything. `attention` excludes a
   * set-aside check because the server's `attentionFor` returns early for one,
   * which is where the rule lives; this repeats the CONSEQUENCE, never the rule.
   */
  const page = (office: string, opts: { view?: string; limit?: number; offset?: number } = {}) => {
    const all = state.checks;
    const live = all.filter((r) => r.setAsideAt == null);
    const view = opts.view ?? "all";
    const selected =
      view === "attention"
        ? live.filter((r) => r.needsAttention)
        : view === "parked"
          ? live.filter((r) => r.parkedAt != null)
          : view === "set_aside"
            ? all.filter((r) => r.setAsideAt != null)
            : all;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return {
      office,
      view,
      remittances: selected.slice(offset, offset + limit),
      total: all.length,
      needsAttentionCount: live.filter((r) => r.needsAttention).length,
      parkedCount: live.filter((r) => r.parkedAt != null).length,
      setAsideCount: all.filter((r) => r.setAsideAt != null).length,
      matchingCount: selected.length,
      limit,
      offset,
    };
  };

  const record = (fn: string) => (...args: unknown[]) => {
    state.calls.push({ fn, args });
  };

  return {
    ...real,
    listRemittances: vi.fn(async (office: string, opts = {}) => {
      record("listRemittances")(office, opts);
      return page(office, opts);
    }),
    listPostingQueue: vi.fn(async () => state.queue ?? EMPTY_QUEUE),
    getPostingPlan: vi.fn(async () => state.plan),
    drainPostingQueue: vi.fn(async (office: string, opts: Record<string, unknown> = {}) => {
      state.drainCalls.push({ office, opts });
      return { office, outcomes: [], ran: 1, outOfTime: false, remaining: 0, config: null, postingEnabled: true };
    }),
    parkRemittance: vi.fn(async (office: string, batchId: string, note?: string) => {
      record("parkRemittance")(office, batchId, note);
      const row = state.checks.find((r) => r.batchId === batchId)!;
      row.parkedAt = "2026-03-04T22:55:00.000Z";
      row.parkedBy = "Billing User";
      row.parkedNote = note ?? null;
      return { batchId, parked: true };
    }),
    unparkRemittance: vi.fn(async (office: string, batchId: string) => {
      record("unparkRemittance")(office, batchId);
      const row = state.checks.find((r) => r.batchId === batchId);
      const wasParked = row?.parkedAt != null;
      if (row) {
        row.parkedAt = null;
        row.parkedBy = null;
        row.parkedNote = null;
      }
      return { batchId, parked: false, wasParked };
    }),
    setAsideRemittance: vi.fn(
      async (office: string, batchId: string, reason: string, note?: string) => {
        record("setAsideRemittance")(office, batchId, reason, note);
        const row = state.checks.find((r) => r.batchId === batchId)!;
        row.setAsideAt = "2026-03-04T23:00:00.000Z";
        row.setAsideBy = "Billing User";
        row.setAsideReason = reason;
        row.setAsideNote = note ?? null;
        // The server's own rule: a set-aside check needs nobody's attention.
        row.needsAttention = false;
        return { batchId, setAside: true, reason };
      },
    ),
    restoreRemittance: vi.fn(async (office: string, batchId: string) => {
      record("restoreRemittance")(office, batchId);
      const row = state.checks.find((r) => r.batchId === batchId)!;
      row.setAsideAt = null;
      row.setAsideBy = null;
      row.setAsideReason = null;
      row.setAsideNote = null;
      row.needsAttention = true;
      return { batchId, setAside: false, wasSetAside: true };
    }),
    getRemittance: vi.fn(async (office: string, batchId: string) => {
      const row = state.checks.find((r) => r.batchId === batchId);
      if (!row) throw new real.RcmApiError("No such remittance", 404, "REMITTANCE_NOT_FOUND");
      return { office, remittance: { ...row, plbAdjustments: [], plans: [] }, claims: [] };
    }),
    getApprovalPreview: vi.fn(async (office: string, batchId: string) => ({
      office,
      batchId,
      canApprove: true,
      approveRequires: "rcm.write",
      claims: [],
      postableCount: 0,
      withheldCount: 0,
      queuedCount: 0,
      balanced: true,
      differenceCents: 0,
    })),
    getRecoupmentPreview: vi.fn(async () => {
      throw new real.RcmApiError("No takeback here", 404, "NOT_FOUND");
    }),
    matchRemittance: vi.fn(async () => ({ matched: [] })),
  };
});

// ─── Harness ─────────────────────────────────────────────────────────────────

import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The same provider stack the workbench suite uses, because these pages read the
 * same three contexts.
 *
 * `searchPath` takes NO leading `?` — it prepends one, so `"?view=x"` becomes
 * `??view=x` and the search reads empty. The search hook must ALSO be handed to
 * `<Router>` or `useSearchParams` silently reads the jsdom URL instead of this
 * memory router. Both learned the hard way in PR #112.
 */
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

/** A bare component that needs no page context. */
function renderBare(node: React.ReactElement) {
  return render(
    <WouterRouter hook={memoryLocation({ path: "/rcm/remittances/b-1" }).hook}>{node}</WouterRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.checks = [];
  state.calls = [];
  state.queue = null;
  state.plan = null;
  state.drainCalls = [];
});

afterEach(cleanup);

// ─── The nav, and the default route ──────────────────────────────────────────

describe("the module is ordered around the day", () => {
  /**
   * The nav array is a module-private literal in `DashboardLayout.tsx` — the
   * same shape `rcm-labels.test.ts` already reads for the "Admin → Office"
   * drift, and for the same reason: exporting an internal so a test can reach it
   * turns an implementation detail into a contract.
   */
  async function rcmNavItems(): Promise<{ path: string; label: string }[]> {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../client/src/components/DashboardLayout.tsx"),
      "utf8",
    );
    const group = /\n  rcm: \[([\s\S]*?)\n  \],/.exec(src);
    expect(group, "the rcm nav group moved — update this test and the nav").toBeTruthy();
    return [...group![1].matchAll(/path:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({
      path: m[1],
      label: m[2],
    }));
  }

  it("puts Today first and lands /rcm on it", async () => {
    const items = await rcmNavItems();
    /*
     * CHANGED BY STAGE C. Two things moved and the reasons are different:
     *
     *   BRING IN is new and first-class after Checks — the module's one upload
     *   surface became a page of its own (ruling D-16), because Today is what a
     *   biller reads to find out what is waiting on her and it opened with two
     *   drop zones in front of that.
     *
     *   POSTING → POSTING HISTORY. The design dropped the screen; the PM ruling
     *   is to keep it, demote it below the working screens, and rename it
     *   honestly. It is where an office-wide post lives, where a stuck run is
     *   retried, and where anybody debugging at 9pm looks.
     */
    expect(items.map((i) => i.label)).toEqual([
      "Today",
      "Checks",
      "Bring in",
      "Posting history",
      "Takeback SOP",
    ]);
    expect(items[0].path).toBe("/rcm");
  });

  it("renames Remittances to Checks in the nav — the word used at the desk", async () => {
    const items = await rcmNavItems();
    expect(items.find((i) => i.path === "/rcm/remittances")!.label).toBe("Checks");
    /*
     * A WORD BOUNDARY, not `includes`. "Remittances" contains "Remittance", so a
     * substring assertion passes on exactly the drift it was written to catch —
     * which is what happened to the "Admin → Offices" check in PR #123.
     *
     * The ROUTE PATH is deliberately untouched: `/rcm/remittances` is a machine
     * identifier and a link somebody may have bookmarked. Only what a person
     * reads changed.
     */
    for (const item of items) {
      expect(/\bremittances?\b/i.test(item.label), `nav item "${item.label}"`).toBe(false);
    }
  });

  it("routes /rcm to Today", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../client/src/App.tsx"), "utf8");
    expect(src).toMatch(/<Route path="\/rcm" component=\{RcmToday\} \/>/);
    expect(src).toContain('import RcmToday from "./pages/rcm/RcmToday"');
    expect(typeof (await import("@/pages/rcm/RcmToday")).default).toBe("function");
  });
});

// ─── Exactly one upload surface ──────────────────────────────────────────────

describe("there is exactly one place to add a check", () => {
  it("no page but Today renders an upload panel", async () => {
    /*
     * §15.2 finding 6, asserted structurally rather than by clicking.
     *
     * The practice owner got lost going round the Upload loop live because the
     * panels were on two pages. A rendering test would only catch the two pages
     * a test happens to render; this reads the SOURCE of every RCM page and
     * fails the moment a third one imports a panel.
     */
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const dir = resolve(__dirname, "../client/src/pages/rcm");
    const importers: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(join(dir, file), "utf8");
      // The panel's own file naturally names itself.
      if (file === "EobUploadPanel.tsx" || file === "EraUploadPanel.tsx") continue;
      if (/from "\.\/(Eob|Era)UploadPanel"/.test(src)) importers.push(file);
    }
    /*
     * CHANGED BY STAGE C — the ASSERTION MOVED, the RULE DID NOT.
     *
     * Stage A put the one door on Today. Stage C moved it to a page of its own
     * (ruling D-16) and this test now points there. What it asserts is
     * unchanged and is the whole point: exactly ONE page in this module may
     * import an upload panel, so a third door cannot appear without a red test.
     */
    expect(importers).toEqual(["BringIn.tsx"]);
  });

  it("the Checks page's button navigates to that one surface rather than opening its own", async () => {
    state.checks = [check()];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances");

    const button = await screen.findByTestId("remittance-upload-toggle");
    /*
     * CHANGED BY STAGE C. It pointed at `/rcm?add=1` — Today's upload section,
     * scrolled to. The section is a page now, so the button points at the page.
     * `/rcm?add=1` still works: Today redirects it here rather than silently
     * doing nothing, which is what a stale bookmark deserves.
     */
    expect(button.getAttribute("href")).toBe("/rcm/bring-in");
    expect(screen.queryByTestId("remittance-upload-panels")).toBeNull();
  });
});

// ─── Saved for tomorrow ──────────────────────────────────────────────────────

describe("save for tomorrow", () => {
  it("appears on Today under 'where you left off', with the biller's own note", async () => {
    state.checks = [
      check({
        parkedAt: "2026-03-04T22:55:00.000Z",
        parkedBy: "Billing User",
        parkedNote: "Waiting on the carrier to resend",
      }),
    ];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    const card = await screen.findByTestId("rcm-left-off-roland");
    expect(card.textContent).toContain("Where you left off");
    expect(card.textContent).toContain("Saved");
    expect(card.textContent).toContain("Waiting on the carrier to resend");
    expect(card.textContent).toContain("SYNTHETIC DENTAL");
  });

  it("renders NOTHING when there is nothing unfinished, rather than an empty state", async () => {
    // An empty "where you left off" every morning is furniture, and furniture
    // is what people learn to scroll past.
    state.checks = [check()];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    await screen.findByTestId("rcm-summary-roland");
    expect(screen.queryByTestId("rcm-left-off-roland")).toBeNull();
  });

  it("does NOT hide the check or drop it out of the counts — that is the whole difference", async () => {
    state.checks = [check({ parkedAt: "2026-03-04T22:55:00.000Z", parkedBy: "Billing User" })];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    // Still needing attention, still counted in the work-state cards.
    await waitFor(() =>
      expect(screen.getByTestId("rcm-queue-count-review-roland").textContent).toBe("1"),
    );
  });

  it("un-parks when the check is opened — the note has done its job by then", async () => {
    state.checks = [check({ parkedAt: "2026-03-04T22:55:00.000Z", parkedBy: "Billing User" })];
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    await waitFor(() =>
      expect(state.calls.some((c) => c.fn === "unparkRemittance")).toBe(true),
    );
    expect(state.checks[0].parkedAt).toBeNull();
  });

  it("saves from the check's own page, note and all", async () => {
    state.checks = [check()];
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("check-park"));
    fireEvent.change(screen.getByTestId("check-park-note"), {
      target: { value: "Back to this Monday" },
    });
    fireEvent.click(screen.getByTestId("check-park-confirm"));

    await waitFor(() => {
      const call = state.calls.find((c) => c.fn === "parkRemittance");
      expect(call?.args).toEqual(["roland", "b-1", "Back to this Monday"]);
    });
  });
});

// ─── Set aside ───────────────────────────────────────────────────────────────

describe("set aside", () => {
  it("demands a reason, and demands words for 'something else'", async () => {
    state.checks = [check()];
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("check-set-aside"));
    fireEvent.click(screen.getByTestId("check-set-aside-reason-other"));

    const confirm = screen.getByTestId("check-set-aside-confirm") as HTMLButtonElement;
    // The server refuses this combination (400 SET_ASIDE_NOTE_REQUIRED). Meeting
    // the rule while you can still act on it beats meeting it after a round trip.
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId("check-set-aside-needs-note")).toBeTruthy();

    fireEvent.change(screen.getByTestId("check-set-aside-note-input"), {
      target: { value: "The payer re-sent this under a new check number" },
    });
    expect((screen.getByTestId("check-set-aside-confirm") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("sets a check aside with its reason, and says so on the check afterwards", async () => {
    state.checks = [check()];
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("check-set-aside"));
    fireEvent.click(screen.getByTestId("check-set-aside-reason-target_gone"));
    fireEvent.click(screen.getByTestId("check-set-aside-confirm"));

    await waitFor(() => {
      const call = state.calls.find((c) => c.fn === "setAsideRemittance");
      expect(call?.args.slice(0, 3)).toEqual(["roland", "b-1", "target_gone"]);
    });
    const banner = await screen.findByTestId("check-set-aside-banner");
    expect(banner.textContent).toContain("Set aside");
    /*
     * CHANGED BY STAGE C — the LABEL was reworded (§8), the SLUG was not.
     * `target_gone` is still exactly what is stored and still the case the
     * whole feature was built for; only the words a person reads changed.
     */
    expect(banner.textContent).toContain("The claims aren't in Open Dental any more");
    // It says out loud that nothing was destroyed — the reason it is safe to press.
    expect(banner.textContent).toContain("not out of the records");
  });

  it("drops out of Today and out of the attention counts", async () => {
    state.checks = [
      check({
        batchId: "b-1",
        setAsideAt: "2026-03-04T23:00:00.000Z",
        setAsideBy: "Billing User",
        setAsideReason: "target_gone",
        needsAttention: false,
      }),
      check({ batchId: "b-2" }),
    ];
    const RcmToday = (await import("@/pages/rcm/RcmToday")).default;
    renderAt(<RcmToday />, "/rcm");

    // One live check needing review, not two.
    await waitFor(() =>
      expect(screen.getByTestId("rcm-queue-count-review-roland").textContent).toBe("1"),
    );
    // And Today says how many are set aside rather than pretending none are.
    expect(screen.getByTestId("rcm-set-aside-count-roland").textContent).toBe("1");
  });

  it("is still findable under its own filter on the Checks page", async () => {
    state.checks = [
      check({
        setAsideAt: "2026-03-04T23:00:00.000Z",
        setAsideBy: "Billing User",
        setAsideReason: "duplicate",
        needsAttention: false,
      }),
    ];
    const RemittanceList = (await import("@/pages/rcm/RemittanceList")).default;
    renderAt(<RemittanceList />, "/rcm/remittances?view=set_aside");

    await waitFor(() => expect(screen.getByTestId("remittance-row-b-1")).toBeTruthy());
  });

  it("is reversible in one click", async () => {
    state.checks = [
      check({
        setAsideAt: "2026-03-04T23:00:00.000Z",
        setAsideBy: "Billing User",
        setAsideReason: "duplicate",
        needsAttention: false,
      }),
    ];
    const RemittanceDetail = (await import("@/pages/rcm/RemittanceDetail")).default;
    renderAt(<RemittanceDetail />, "/rcm/remittances/b-1");

    fireEvent.click(await screen.findByTestId("check-restore"));

    await waitFor(() =>
      expect(state.calls.some((c) => c.fn === "restoreRemittance")).toBe(true),
    );
    expect(state.checks[0].setAsideAt).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("check-set-aside-banner")).toBeNull());
  });
});

// ─── One check, one post, one code path ──────────────────────────────────────

describe("posting one check", () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    office: "roland",
    plan: {
      queueId: "q-1",
      office: "roland",
      batchId: "b-1",
      status: "approved",
      statusLabel: "queued",
      blockedReason: null,
      withdrawnReason: null,
      withdrawnNote: null,
      withdrawnAt: null,
      step: null,
      isRecoupment: false,
      documentAttachStatus: null,
      carrierEobDate: null,
      intendedTotalCents: 15000,
      postedTotalCents: 0,
      odClaimPaymentNum: null,
      reconciledAt: null,
      approvedAt: "2026-03-04T15:00:00.000Z",
      approvedBy: "Billing User",
      startedAt: null,
      finishedAt: null,
      drainAttemptAt: null,
      drainedBy: null,
      attemptCount: 0,
      lastError: null,
      checkNumber: "830200001",
      payer: "SYNTHETIC DENTAL",
      ...over,
    },
    lines: [],
    claims: [],
    canDrain: true,
    drainRequires: "rcm.post",
    postingEnabled: true,
    drainEnabled: true,
  });

  it("sends the SAME call as the office-wide press, naming one check", async () => {
    /*
     * THE IDENTITY TEST.
     *
     * There is no second write path. `drainPostingQueue` is one function, the
     * route behind it is one route, and `queueId` is a narrowing on the same
     * office-scoped, status-filtered query. This asserts the client half: the
     * two presses differ by exactly the presence of `queueId` and by nothing
     * else — same office, same function, same everything downstream.
     */
    const { drainPostingQueue } = await import("@/features/rcm/api");
    state.plan = plan();

    const PostThisCheck = (await import("@/components/rcm/PostThisCheck")).default;
    renderBare(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);

    fireEvent.click(await screen.findByTestId("post-this-check-button"));
    await waitFor(() => expect(state.drainCalls.length).toBe(1));
    expect(state.drainCalls[0]).toEqual({ office: "roland", opts: { queueId: "q-1" } });

    // The office-wide press, through the very same function.
    await drainPostingQueue("roland");
    expect(state.drainCalls[1]).toEqual({ office: "roland", opts: {} });

    // Same office, same function, one extra field. Nothing else differs.
    const [one, all] = state.drainCalls;
    expect(one.office).toBe(all.office);
    expect(Object.keys(one.opts)).toEqual(["queueId"]);
    expect(Object.keys(all.opts)).toEqual([]);
  });

  it("greys the button and says which of the three silences it is", async () => {
    // §15.2 finding 4, and the three remedies are three different people.
    for (const [over, fragment] of [
      [{ canDrain: false }, "needs rcm.post"],
      [{ postingEnabled: false }, "not been switched on for posting"],
      [{ drainEnabled: false }, "shadow mode"],
    ] as const) {
      state.plan = { ...plan(), ...over };
      const PostThisCheck = (await import("@/components/rcm/PostThisCheck")).default;
      const view = renderBare(
        <PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />,
      );
      const button = (await screen.findByTestId("post-this-check-button")) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      // RENDERED beside it, never a tooltip — there is no hover on a tablet.
      expect(screen.getByTestId("post-this-check-reason").textContent).toContain(fragment);
      view.unmount();
    }
  });

  it("reads FINISHED once it is posted, with the check number and the confirmation", async () => {
    state.plan = plan({
      status: "posted",
      statusLabel: "posted",
      odClaimPaymentNum: 21436,
      postedTotalCents: 15000,
      reconciledAt: "2026-03-04T16:00:00.000Z",
      documentAttachStatus: "none",
      attemptCount: 1,
    });
    const PostThisCheck = (await import("@/components/rcm/PostThisCheck")).default;
    renderBare(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);

    expect((await screen.findByTestId("post-this-check-state")).textContent).toBe("Finished");
    /*
     * CHANGED BY STAGE C — the PROOF moved into "What landed in Open Dental".
     *
     * The generic proof block is suppressed on the two ENDINGS (§7), which say
     * it better and in the right order. On a FINISHED check the payment number
     * is one row of the landed table; on a STUCK one it was appearing above
     * "the payment did reach Open Dental — do not enter it again", in a calm
     * green, repeating the same number — which is exactly what makes a warning
     * skimmable.
     *
     * Both facts are still asserted: the number, and the confirmed register.
     */
    expect(screen.getByTestId("posted-payment-num").textContent).toContain("21436");
    expect(screen.getByTestId("posted-verdict").textContent).toContain("Confirmed in Open Dental");
    /*
     * CHANGED BY STAGE C — the EOB line MOVED, its meaning did not.
     *
     * On a FINISHED check it is now one row of *What landed in Open Dental*
     * (§7), beside the payment number, the write-offs and the balance, because
     * that is the question it answers. On every other state it is still its own
     * line under the panel.
     *
     * `none` is still an ANSWER — examined, nothing to file — and still never
     * reads as a failure.
     */
    expect(screen.getByTestId("posted-landed").textContent).toContain("No EOB to file");
    // And the register is named: this figure was measured, not calculated.
    expect(screen.getByTestId("posted-register").textContent).toContain(
      "Read out of the chart after posting",
    );
    // And no button at all: there is nothing left to press on a finished check.
    expect(screen.queryByTestId("post-this-check-button")).toBeNull();
  });

  it("never offers to post a RETIRED check, because that state has no way out", async () => {
    state.plan = plan({
      status: "withdrawn",
      statusLabel: "withdrawn",
      withdrawnReason: "manual",
      withdrawnAt: "2026-03-04T16:00:00.000Z",
    });
    const PostThisCheck = (await import("@/components/rcm/PostThisCheck")).default;
    renderBare(<PostThisCheck office="roland" queueId="q-1" onPosted={() => {}} />);

    await screen.findByTestId("post-this-check-state");
    expect(screen.queryByTestId("post-this-check-button")).toBeNull();
    expect(screen.getByTestId("post-this-check-not-postable").textContent).toContain(
      "never post through CareIN",
    );
  });
});
