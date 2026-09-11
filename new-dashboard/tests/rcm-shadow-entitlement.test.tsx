/**
 * THE SHADOW PROVIDER DOES NOT ASK A QUESTION IT HAS NO RIGHT TO ASK.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG, AND WHY IT NEEDED A TEST RATHER THAN A COMMENT
 * ═════════════════════════════════════════════════════════════════════════════
 * `RcmShadowProvider` is mounted app-wide in `App.tsx`, because the pill it
 * feeds lives in the shell's HEADER rather than on any one page. The cost of
 * that placement is easy to miss: it also mounts for a voice-only tenant, and
 * for every session that will never open an RCM screen.
 *
 * It fetched `listPostingQueue` for each RCM-shaped office in the roster the
 * moment the roster arrived. `/api/rcm` sits behind `requireModule('rcm')`,
 * which FAILS CLOSED. So on a tenant without the module every one of those was
 * a guaranteed 403 — a wasted round trip, and an audited one, logged against a
 * user who did nothing but sign in.
 *
 * Nothing about the rendered output was wrong, which is exactly why this is a
 * test and not a code comment: the pill correctly did not appear either way,
 * the failure was invisible on screen, and the only evidence was in the network
 * tab and the audit log. A rendering assertion could never have caught it, so
 * the assertion here is about the CALL — that it never happens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `useModule()` AND NOT A NEW FETCH
 * ─────────────────────────────────────────────────────────────────────────────
 * The entitlement is already in memory: it rides in on `/auth/me` as
 * `tenant.modules` and `ModuleProvider` narrows it through `entitledModuleIds`.
 * Asking the server whether we may ask the server would be the same mistake one
 * level up.
 *
 * NO NETWORK, NO PHI. Every office and figure below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

/** What `/auth/me` says this tenant has. Rewritten per test. */
const auth = { modules: ["voice"] as string[] };

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    // A roster with an RCM-shaped office in it, deliberately: the office scope
    // must be NON-EMPTY, or the provider would decline to fetch for a reason
    // that has nothing to do with entitlement and the test would pass vacuously.
    getOffices: async () => [
      { officeId: "roland", officeName: "Roland Family Dental" },
      { officeId: "valley", officeName: "Riley Family Dental" },
    ],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    useAuth: () => ({
      status: "authenticated",
      user: {
        name: "Billing User",
        email: "billing@example.invalid",
        permissions: ["rcm.read"],
        isSuperAdmin: false,
        // The one field under test. `ModuleProvider` reads exactly this.
        tenant: { slug: "t1", displayName: "Synthetic Dental", modules: auth.modules },
      },
      loading: false,
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listPostingQueue: vi.fn(async () => ({
      office: "roland",
      rows: [],
      total: 0,
      byStatus: { blocked: 0 },
      // In shadow: switched on for the practice, switch flipped off.
      postingEnabled: true,
      drainEnabled: false,
    })),
  };
});

import * as rcmApi from "@/features/rcm/api";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { ALL_OFFICES, OfficeProvider } from "@/contexts/OfficeContext";
import { RcmShadowProvider, useRcmShadow } from "@/features/rcm/shadowMode";

/** Reports what the context is handing out, so `any` can be asserted. */
function Probe() {
  const shadow = useRcmShadow();
  return <span data-testid="probe">{shadow.any ? "shadow" : "quiet"}</span>;
}

function renderProvider() {
  return render(
    <ModuleProvider>
      <OfficeProvider>
        <RcmShadowProvider>
          <Probe />
        </RcmShadowProvider>
      </OfficeProvider>
    </ModuleProvider>,
  );
}

/**
 * The roster load and the effect that follows it both settle in microtasks.
 * Waiting on the ROSTER rather than on a timer means the negative assertion
 * below runs after the exact moment the fetch would have gone out.
 */
async function settle() {
  await waitFor(() => expect(vi.mocked(rcmApi.listPostingQueue)).toHaveBeenCalledTimes(2));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  auth.modules = ["voice"];
  vi.mocked(rcmApi.listPostingQueue).mockClear();
});
afterEach(cleanup);

describe("the shadow provider is gated on the module, not just on the route", () => {
  it("a voice-only tenant never calls the posting queue", async () => {
    renderProvider();

    /*
     * A NEGATIVE ASSERTION NEEDS A DEADLINE, or it passes because nothing has
     * happened YET. Waiting for the probe to mount takes this past the point
     * the roster resolves, and the entitled cases below prove the calls DO go
     * out within that same window on these same fixtures — so silence here is
     * a decision, not a race.
     *
     * Verified by removing the gate: both negative cases go red, and the two
     * entitled ones stay green.
     */
    await waitFor(() => expect(document.querySelector("[data-testid=probe]")).not.toBeNull());
    await Promise.resolve();
    expect(vi.mocked(rcmApi.listPostingQueue)).not.toHaveBeenCalled();
    expect(document.querySelector("[data-testid=probe]")!.textContent).toBe("quiet");
  });

  it("a tenant with no modules at all never calls it either", async () => {
    // Fails closed, like `hasModule` and like the backend's isEntitledModule:
    // an absent list is NOT entitled, never "we don't know, so try".
    auth.modules = [];
    renderProvider();

    await waitFor(() => expect(document.querySelector("[data-testid=probe]")).not.toBeNull());
    await Promise.resolve();
    expect(vi.mocked(rcmApi.listPostingQueue)).not.toHaveBeenCalled();
  });

  it("an entitled tenant is unchanged — one read per office in scope", async () => {
    auth.modules = ["voice", "rcm"];
    localStorage.setItem("carein.office", ALL_OFFICES);
    renderProvider();

    await settle();
    expect(
      vi.mocked(rcmApi.listPostingQueue).mock.calls.map((c) => c[0]).sort(),
    ).toEqual(["roland", "valley"]);
    // And the two flags still resolve to the pill's answer.
    await waitFor(() =>
      expect(document.querySelector("[data-testid=probe]")!.textContent).toBe("shadow"),
    );
  });

  it("asks with limit 1 — the flags are wanted, the rows are not", async () => {
    auth.modules = ["voice", "rcm"];
    renderProvider();

    await waitFor(() => expect(vi.mocked(rcmApi.listPostingQueue)).toHaveBeenCalled());
    expect(vi.mocked(rcmApi.listPostingQueue).mock.calls[0][1]).toEqual({ limit: 1 });
  });
});
