/**
 * SHADOW MODE, ON SCREEN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SLICE IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Roland goes to production in shadow mode: a real biller works real EOBs end
 * to end while a chart write stays impossible until an administrator flips a
 * switch. The backend suites prove the gate refuses. This file proves the two
 * things a SCREEN owes the people living with it:
 *
 *   1. the biller can see it, without pressing anything — a badge on the office
 *      header and a rendered (never hovered) reason beside the dead Drain
 *      button, on both the Posting page and the RCM inbox;
 *   2. the admin control exists for an admin and DOES NOT EXIST for anybody
 *      else — not greyed, not a status line: absent, and not even requested.
 *
 * NO NETWORK, NO PHI. Every payer, patient and figure is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

const PLAN = {
  queueId: "q-1",
  office: "roland",
  batchId: "b-1",
  status: "approved",
  statusLabel: "queued",
  blockedReason: null as string | null,
  withdrawnReason: null as string | null,
  withdrawnNote: null as string | null,
  withdrawnAt: null as string | null,
  step: null as string | null,
  isRecoupment: false,
  documentAttachStatus: null as string | null,
  carrierEobDate: "2026-03-01",
  intendedTotalCents: 15000,
  postedTotalCents: 0,
  odClaimPaymentNum: null as number | null,
  reconciledAt: null as string | null,
  approvedBy: "biller",
  approvedAt: "2026-03-02T11:10:00.000Z",
  startedAt: null as string | null,
  finishedAt: null as string | null,
  attemptCount: 0,
  lastError: null as string | null,
  drainedBy: null as string | null,
  drainAttemptAt: null as string | null,
  checkNumber: "830200001",
  payer: "SYNTHETIC DENTAL",
  lineCount: 1,
};

/** One plan approved and waiting, the switch OFF, the ceiling clear. */
const state = {
  drainEnabled: false,
  postingEnabled: true,
  canDrain: true,
  settingsError: null as string | null,
  settingsRowMissing: false,
  savedTo: [] as boolean[],
};

const QUEUE_PAGE = () => ({
  office: "roland",
  rows: [PLAN],
  byStatus: {
    approved: 1,
    posting: 0,
    posted: 0,
    partially_posted: 0,
    failed: 0,
    blocked: 0,
    withdrawn: 0,
  },
  total: 1,
  limit: 50,
  offset: 0,
  canDrain: state.canDrain,
  drainRequires: "rcm.post",
  postingEnabled: state.postingEnabled,
  drainEnabled: state.drainEnabled,
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

const auth = { permissions: ["rcm.read", "rcm.queue", "rcm.write"] as string[] };

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    useAuth: () => ({
      status: "authenticated",
      user: { permissions: auth.permissions, isSuperAdmin: false },
      loading: false,
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listPostingQueue: vi.fn(async () => QUEUE_PAGE()),
    listRemittances: vi.fn(async () => ({
      office: "roland",
      view: "all",
      remittances: [],
      total: 0,
      needsAttentionCount: 0,
      matchingCount: 0,
      limit: 50,
      offset: 0,
    })),
    getRcmOfficeSettings: vi.fn(async () => {
      if (state.settingsError) throw new real.RcmApiError(state.settingsError, 403, "FORBIDDEN");
      return {
        office: "roland",
        drainEnabled: state.drainEnabled,
        updatedAt: state.drainEnabled ? "2026-03-04T09:00:00.000Z" : null,
        updatedBy: state.drainEnabled ? "user-1" : null,
        postingEnabled: state.postingEnabled,
        rowMissing: state.settingsRowMissing,
      };
    }),
    setRcmOfficeSettings: vi.fn(async (_office: string, drainEnabled: boolean) => {
      state.savedTo.push(drainEnabled);
      state.drainEnabled = drainEnabled;
      return {
        office: "roland",
        drainEnabled,
        updatedAt: "2026-03-04T09:00:00.000Z",
        updatedBy: "user-1",
        postingEnabled: state.postingEnabled,
        rowMissing: false,
      };
    }),
  };
});

import PostingQueue from "@/pages/rcm/PostingQueue";
import RcmToday from "@/pages/rcm/RcmToday";
import RcmPostingSettingsCard from "@/pages/admin/RcmPostingSettingsCard";
import { SHADOW_MODE_COPY, SHADOW_REFUSAL_SLUG } from "@/features/rcm/posting";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  state.drainEnabled = false;
  state.postingEnabled = true;
  state.canDrain = true;
  state.settingsError = null;
  state.settingsRowMissing = false;
  state.savedTo = [];
  auth.permissions = ["rcm.read", "rcm.queue", "rcm.write"];
});
afterEach(cleanup);

// ═══════════════════════════════════════════════════════════════════════════
// 1. WHAT THE BILLER SEES
// ═══════════════════════════════════════════════════════════════════════════

describe("the Posting page in shadow mode", () => {
  it("badges the office and greys Drain with the reason RENDERED beside it", async () => {
    renderAt(<PostingQueue />, "/rcm/posting");

    const drain = (await screen.findByTestId("posting-drain-roland")) as HTMLButtonElement;
    expect(drain.disabled).toBe(true);

    // The badge, on the office header.
    expect(screen.getByTestId("posting-shadow-badge-roland").textContent).toBe(
      SHADOW_MODE_COPY.badge,
    );

    /*
     * THE REASON IS RENDERED, NOT HOVERED — §15.2, finding 4. The practice
     * reads this screen on a tablet, and there is no hover on a tablet.
     */
    const reason = screen.getByTestId("posting-drain-reason-roland");
    expect(reason.textContent).toContain("Posting is switched off for Roland (shadow mode)");
    expect(reason.textContent).toContain("Approved checks wait here");
    expect(drain.getAttribute("title")).toBeNull();
  });

  it("says the same sentence in the banner, and says what to do about it", async () => {
    renderAt(<PostingQueue />, "/rcm/posting");
    const banner = await screen.findByTestId("posting-shadow-roland");
    expect(banner.textContent).toContain(SHADOW_MODE_COPY.reason("Roland"));
    expect(banner.textContent).toContain("Admin");
  });

  it("the plans still read as QUEUED — the refusal is not their state", async () => {
    /*
     * The difference from D-7, on screen. A shadow-mode plan is `approved` and
     * says "Queued"; it is not `blocked`, because nothing about the PLAN is
     * wrong and there is nothing on it for a biller to go fix.
     */
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-drain-roland");
    expect(screen.getByTestId("posting-counts-roland").textContent).toContain("1 waiting");
    expect(screen.getByTestId("posting-counts-roland").textContent).toContain("0 stuck");
    expect(screen.queryByTestId("posting-disabled-roland")).toBeNull();
  });

  it("permission comes FIRST — a reviewer is told the thing she can act on", async () => {
    /*
     * Two reasons she cannot press it, and they are not equally useful. "Ask an
     * approver" is something she can do today; "an admin has not switched
     * posting on" is somebody else's job and will still be true when she is an
     * approver.
     */
    state.canDrain = false;
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-drain-roland");
    expect(screen.getByTestId("posting-drain-reason-roland").textContent).toContain("rcm.post");
  });

  it("an unvalidated practice shows D-7's banner and NOT the shadow one", async () => {
    /*
     * One silence, one explanation. A practice the code ceiling has never
     * validated is not "in shadow mode" — it is not set up, and offering both
     * sentences would make the biller guess which one somebody can act on.
     */
    state.postingEnabled = false;
    renderAt(<PostingQueue />, "/rcm/posting");
    await screen.findByTestId("posting-disabled-roland");
    expect(screen.queryByTestId("posting-shadow-roland")).toBeNull();
    expect(screen.queryByTestId("posting-shadow-badge-roland")).toBeNull();
  });

  it("switched ON, the badge and the banner are gone and Drain is live", async () => {
    state.drainEnabled = true;
    renderAt(<PostingQueue />, "/rcm/posting");
    const drain = (await screen.findByTestId("posting-drain-roland")) as HTMLButtonElement;
    expect(drain.disabled).toBe(false);
    expect(screen.queryByTestId("posting-shadow-badge-roland")).toBeNull();
    expect(screen.queryByTestId("posting-shadow-roland")).toBeNull();
  });
});

describe("the RCM inbox in shadow mode", () => {
  it("carries the same badge — a biller should not have to go looking", async () => {
    renderAt(<RcmToday />, "/rcm");
    const badge = await screen.findByTestId("rcm-shadow-badge-roland");
    expect(badge.textContent).toBe(SHADOW_MODE_COPY.badge);
    // And the sentence is on the page, not only in a title attribute.
    expect(screen.getByTestId("rcm-shadow-hint-roland").textContent).toBe(SHADOW_MODE_COPY.hint);
  });

  it("is gone once posting is switched on", async () => {
    state.drainEnabled = true;
    renderAt(<RcmToday />, "/rcm");
    await screen.findByTestId("rcm-summary-roland");
    await waitFor(() => expect(screen.queryByTestId("rcm-shadow-badge-roland")).toBeNull());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE ADMIN CONTROL
// ═══════════════════════════════════════════════════════════════════════════

describe("the admin toggle", () => {
  it("does not exist for a role without rcm.settings — and is not even asked for", async () => {
    /*
     * HIDDEN, NOT DISABLED. The server refuses the READ too, so a card that
     * rendered a greyed control would be a status line pretending to be one —
     * and firing the request anyway would fill the audit trail with 403s on
     * every visit by somebody who took a wrong link.
     */
    const rcm = await import("@/features/rcm/api");
    vi.mocked(rcm.getRcmOfficeSettings).mockClear();
    auth.permissions = ["rcm.read", "rcm.queue", "rcm.write"]; // an office/biller tier
    renderAt(<RcmPostingSettingsCard />, "/admin");
    expect(screen.queryByTestId("rcm-posting-settings")).toBeNull();
    await waitFor(() => expect(vi.mocked(rcm.getRcmOfficeSettings)).not.toHaveBeenCalled());
  });

  it("renders for an admin, showing the state and when it last moved", async () => {
    auth.permissions = ["admin.all", "rcm.read", "rcm.settings"];
    renderAt(<RcmPostingSettingsCard />, "/admin");
    await screen.findByTestId("rcm-posting-setting-roland");
    expect(screen.getByTestId("rcm-posting-state-roland").textContent).toBe("Shadow");
    expect(screen.getByTestId("rcm-posting-changed-roland").textContent).toBe("Never switched.");
  });

  it("flipping it on sends true, and the row says so afterwards", async () => {
    auth.permissions = ["admin.all", "rcm.read", "rcm.settings"];
    renderAt(<RcmPostingSettingsCard />, "/admin");
    const toggle = (await screen.findByTestId("rcm-posting-toggle-roland")) as HTMLButtonElement;
    expect(toggle.textContent).toContain("Switch posting on");
    toggle.click();

    await waitFor(() =>
      expect(screen.getByTestId("rcm-posting-state-roland").textContent).toBe("Posting on"),
    );
    expect(state.savedTo).toEqual([true]);
    expect(screen.getByTestId("rcm-posting-changed-roland").textContent).toContain("user-1");
  });

  it("cannot be flipped for a practice the CODE ceiling refuses, and says why", async () => {
    /*
     * A switch you can flip that changes nothing is worse than one you cannot.
     * D-7 is a code change with evidence in the same commit, and no toggle
     * anywhere may pretend otherwise.
     */
    auth.permissions = ["admin.all", "rcm.read", "rcm.settings"];
    state.postingEnabled = false;
    renderAt(<RcmPostingSettingsCard />, "/admin");
    const toggle = (await screen.findByTestId("rcm-posting-toggle-roland")) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByTestId("rcm-posting-ceiling-roland").textContent).toContain(
      "not been validated for posting yet",
    );
    expect(state.savedTo).toEqual([]);
  });

  it("a missing settings row is named, and the toggle refuses", async () => {
    auth.permissions = ["admin.all", "rcm.read", "rcm.settings"];
    state.settingsRowMissing = true;
    renderAt(<RcmPostingSettingsCard />, "/admin");
    const toggle = (await screen.findByTestId("rcm-posting-toggle-roland")) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByTestId("rcm-posting-missing-roland").textContent).toContain(
      "Run the tenant migrations",
    );
  });

  it("a failed read shows the SERVER's sentence, not an invented one", async () => {
    auth.permissions = ["admin.all", "rcm.read", "rcm.settings"];
    state.settingsError = "This practice is not set up for the RCM module.";
    renderAt(<RcmPostingSettingsCard />, "/admin");
    const row = await screen.findByTestId("rcm-posting-setting-error-roland");
    expect(row.textContent).toContain("not set up for the RCM module");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE SLUG
// ═══════════════════════════════════════════════════════════════════════════

describe("the refusal slug", () => {
  it("is the one the backend sends", () => {
    // The full drift check lives in rcm-labels.test.ts, which reads the backend
    // source. This is the one-line version, so a reader of this file can see
    // what the screens are agreeing with.
    expect(SHADOW_REFUSAL_SLUG).toBe("drain_disabled_for_office");
  });
});
