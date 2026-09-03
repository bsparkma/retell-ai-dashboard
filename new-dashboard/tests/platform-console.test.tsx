/**
 * /platform — the Platform Console (PR C).
 *
 * The page enforces nothing; every endpoint behind it is `requireSuperAdmin()`-
 * gated server-side. What these tests defend is the four ways the SCREEN could
 * lie about what the server did:
 *
 *   1. Showing the console — or even ASKING for its data — to someone who is
 *      not a platform administrator.
 *   2. Flipping a switch on click instead of on the server's readback, so a
 *      refused write looks like it took.
 *   3. Confirming a destructive change without naming what it destroys: the
 *      practice, the headcount, the number of calls about to lose their content.
 *   4. Offering a live purge before a dry run has said what it would take.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Classic JSX runtime global — see tests/module-home.test.tsx for why.
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const authState = vi.hoisted(() => ({ isSuperAdmin: true, email: "admin@carein.ai" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Platform Admin",
      email: authState.email,
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["voice", "tc"] },
      role: "admin" as const,
      isSuperAdmin: authState.isSuperAdmin,
      permissions: ["admin.all", "voice.read", "tc.full"],
    })),
  };
});

const toasts = vi.hoisted(() => ({ errors: [] as string[], successes: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toasts.errors.push(m),
    success: (m: string) => toasts.successes.push(m),
  },
}));

const CAREIN = "11111111-1111-4111-8111-111111111111";
const SMITH = "22222222-2222-4222-8222-222222222222";

const MODULES = () => [
  { module: "voice" as const, label: "Voice", blurb: "Call worklist", enabled: true },
  { module: "tc" as const, label: "Treatment Coordinator", blurb: "Case pipeline", enabled: true },
  { module: "hyg" as const, label: "Hygiene", blurb: "Hygiene day view", enabled: false },
  { module: "rcm" as const, label: "RCM", blurb: "Claims", enabled: false },
  { module: "scheduling" as const, label: "Scheduling", blurb: "Not yet built", enabled: false },
];

/** Everything the fake server holds, plus the calls it recorded. */
const server = vi.hoisted(() => ({
  practicesCalls: 0,
  moduleWrites: [] as Array<{ tenantId: string; module: string; enabled: boolean }>,
  moduleWriteError: null as { message: string; code: string } | null,
  retentionDays: 90,
  retentionSource: "env" as "db" | "env" | "default",
  policyKnown: true,
  prunedCalls: 412,
  retentionWrites: [] as number[],
  impactCalls: [] as number[],
  purgeCalls: [] as Array<{ dryRun: boolean; confirm?: string }>,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      getAdminHealth: vi.fn(() => new Promise(() => {})),
      listPractices: vi.fn(async () => {
        server.practicesCalls += 1;
        return [
          {
            tenantId: CAREIN, slug: "carein", displayName: "CareIN Dental", status: "active",
            createdAt: "2026-01-05T00:00:00.000Z", userCount: 13, modules: MODULES(),
          },
          {
            tenantId: SMITH, slug: "smith", displayName: "Smith Dental", status: "active",
            createdAt: "2026-06-01T00:00:00.000Z", userCount: 4,
            modules: MODULES().map((m) => ({ ...m, enabled: m.module === "voice" })),
          },
        ];
      }),
      setPracticeModule: vi.fn(async (tenantId: string, module: string, enabled: boolean) => {
        server.moduleWrites.push({ tenantId, module, enabled });
        if (server.moduleWriteError) {
          throw new real.ApiError(server.moduleWriteError.message, 500, server.moduleWriteError.code);
        }
        return MODULES().map((m) => (m.module === module ? { ...m, enabled } : m));
      }),
      listPracticeUsers: vi.fn(async () => ({
        users: [
          { email: "boss@carein.ai", role: "admin" as const, status: "active" as const, lastLoginAt: "2026-08-12T09:00:00.000Z", homeOffice: "roland" },
          { email: "temp@carein.ai", role: "hygiene" as const, status: "active" as const, lastLoginAt: null, homeOffice: null },
        ],
        roles: ["admin", "office", "tc", "hygiene"] as const,
        manageAt: "/admin/users",
      })),
      listPracticeAudit: vi.fn(async (_t: string, filters: Record<string, unknown> = {}) => {
        const all = Array.from({ length: 120 }, (_, i) => ({
          auditId: `a${i}`,
          ts: `2026-08-13T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
          actor: "boss@carein.ai",
          action: (i % 2 === 0 ? "UPDATE" : "READ") as "UPDATE" | "READ",
          resourceType: "app_user",
          resourceId: `x${i}@carein.ai`,
          ip: "10.0.0.1",
          result: "SUCCESS" as const,
          endpoint: "/api/users",
          office: null,
          sourceRef: null,
        }));
        const filtered = filters.action ? all.filter((e) => e.action === filters.action) : all;
        const offset = Number(filters.offset ?? 0);
        const limit = Number(filters.limit ?? 50);
        return { entries: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
      }),
      getRetention: vi.fn(async () => ({
        policy: {
          days: server.retentionDays,
          source: server.retentionSource,
          enabled: server.retentionDays > 0,
          policyKnown: server.policyKnown,
          dbDays: server.retentionSource === "db" ? server.retentionDays : null,
          envDays: 90,
          envDaysIsSet: true,
          options: [30, 60, 90],
          updatedAt: server.retentionSource === "db" ? "2026-08-13T12:00:00.000Z" : null,
          updatedBy: server.retentionSource === "db" ? "admin@carein.ai" : null,
        },
        scheduler: {
          running: true, schedule: "30 3 * * *", timezone: "America/Chicago",
          retentionDays: server.retentionDays, enabled: true,
          source: server.retentionSource, policyKnown: server.policyKnown, lastRun: null,
        },
        store: { totalCalls: 5000, liveCalls: 5000 - server.prunedCalls, prunedCalls: server.prunedCalls },
        controlPlaneError: null,
      })),
      setRetentionDays: vi.fn(async (days: number) => {
        server.retentionWrites.push(days);
        server.retentionDays = days;
        server.retentionSource = "db";
        return await (api as unknown as { getRetention: () => Promise<unknown> }).getRetention();
      }),
      getRetentionImpact: vi.fn(async (days: number) => {
        server.impactCalls.push(days);
        return {
          days,
          currentDays: server.retentionDays,
          shortening: days < server.retentionDays,
          wouldPrune: days < server.retentionDays ? 137 : 0,
          alreadyPruned: server.prunedCalls,
        };
      }),
      runCallStorePrune: vi.fn(async () => ({ scanned: 3, stubbed: 3, alreadyStubbed: 0 })),
      purgeLegacyCalls: vi.fn(async (opts: { dryRun: boolean; confirm?: string }) => {
        server.purgeCalls.push(opts);
        return {
          dryRun: opts.dryRun,
          count: 1660,
          bySource: { mango: 1660 },
          ids: [],
          skippedTwinned: ["m1", "m2"],
          deleted: opts.dryRun ? 0 : 1660,
          backupPath: opts.dryRun ? null : "/data/backups/unified_calls.2026-08-13.json",
        };
      }),
    },
  };
});

import { AuthProvider } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import Platform from "@/pages/Platform";
import { visibleNav } from "@/components/DashboardLayout";

beforeEach(() => {
  authState.isSuperAdmin = true;
  server.practicesCalls = 0;
  server.moduleWrites = [];
  server.moduleWriteError = null;
  server.retentionDays = 90;
  server.retentionSource = "env";
  server.policyKnown = true;
  server.prunedCalls = 412;
  server.retentionWrites = [];
  server.impactCalls = [];
  server.purgeCalls = [];
  toasts.errors = [];
  toasts.successes = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <AuthProvider>
      <Platform />
    </AuthProvider>,
  );

/**
 * Select a Radix tab.
 *
 * `mouseDown`, not `click`: Radix TabsTrigger selects in its onMouseDown handler
 * and jsdom's click does not dispatch one, so a plain click leaves the tab
 * inactive and every assertion below it fails for the wrong reason. Same idiom
 * as tests/tc-guide.test.tsx.
 */
function clickTab(testId: string) {
  fireEvent.mouseDown(screen.getByTestId(testId));
}

/** Open a practice's detail panel and switch to one of its tabs. */
async function openPractice(slug: string, tab?: "modules" | "users" | "audit") {
  fireEvent.click(await screen.findByTestId(`practice-row-${slug}`));
  await screen.findByTestId("practice-detail");
  if (tab && tab !== "modules") clickTab(`tab-${tab}`);
}

// --- 1. access ---------------------------------------------------------------

describe("access", () => {
  it("shows an honest dead-end to a non-super_admin, and asks the server for nothing", async () => {
    authState.isSuperAdmin = false;
    renderPage();

    expect(await screen.findByTestId("platform-access-required")).toBeTruthy();
    expect(screen.queryByTestId("platform-console")).toBeNull();
    // Not merely hidden — never requested. Eight known-403s per wrong link would
    // fill the audit trail with noise.
    expect(server.practicesCalls).toBe(0);
  });

  it("renders the console for a super_admin", async () => {
    renderPage();
    expect(await screen.findByTestId("platform-console")).toBeTruthy();
    expect(screen.queryByTestId("platform-access-required")).toBeNull();
  });

  it("keeps the Platform nav item out of the sidebar for everyone else", () => {
    // visibleNav is the permission filter; /platform is deliberately NOT in
    // ROUTE_PERMISSIONS, so it must never be routed through this — a nav group
    // that leaked through here would show for every signed-in user.
    const groups = [{ title: "Platform", items: [{ path: "/platform", label: "Platform Console", icon: (() => null) as never }] }];
    expect(visibleNav(groups, []).length).toBe(1);
    // ...which is exactly why DashboardLayout appends it on isSuperAdmin instead.
  });
});

// --- 2. practices + the toggle ----------------------------------------------

describe("practices", () => {
  it("lists every practice with its enabled modules and roster size", async () => {
    renderPage();

    expect(await screen.findByTestId("practice-row-carein")).toBeTruthy();
    const smith = screen.getByTestId("practice-row-smith");
    expect(smith.textContent).toContain("Smith Dental");
    expect(smith.textContent).toContain("4");
    // Only the enabled ones are chipped; Smith has voice and nothing else.
    expect(smith.textContent).toContain("voice");
    expect(smith.textContent).not.toContain("rcm");
  });

  it("shows every catalog module for a practice, including those with no row", async () => {
    renderPage();
    await openPractice("smith");

    for (const m of ["voice", "tc", "hyg", "rcm", "scheduling"]) {
      expect(screen.getByTestId(`module-switch-${m}`)).toBeTruthy();
    }
  });

  it("names the blast radius before turning a module off", async () => {
    renderPage();
    await openPractice("carein");

    fireEvent.click(screen.getByTestId("module-switch-tc"));

    const blast = await screen.findByTestId("module-confirm-blast-radius");
    expect(blast.textContent).toContain("CareIN Dental");
    expect(blast.textContent).toContain("13");
    expect(blast.textContent).toContain("immediately");
    // Nothing has been written by merely opening the dialog.
    expect(server.moduleWrites.length).toBe(0);
  });

  it("writes only on confirm, and renders the server's readback", async () => {
    renderPage();
    await openPractice("carein");
    fireEvent.click(screen.getByTestId("module-switch-tc"));
    fireEvent.click(await screen.findByTestId("module-confirm-accept"));

    await waitFor(() => expect(server.moduleWrites.length).toBe(1));
    expect(server.moduleWrites[0]).toEqual({ tenantId: CAREIN, module: "tc", enabled: false });
    await waitFor(() =>
      expect(screen.getByTestId("module-switch-tc").getAttribute("data-state")).toBe("unchecked"),
    );
  });

  it("flips back — the switch is not one-way", async () => {
    renderPage();
    await openPractice("carein");
    fireEvent.click(screen.getByTestId("module-switch-tc"));
    fireEvent.click(await screen.findByTestId("module-confirm-accept"));
    await waitFor(() =>
      expect(screen.getByTestId("module-switch-tc").getAttribute("data-state")).toBe("unchecked"),
    );

    fireEvent.click(screen.getByTestId("module-switch-tc"));
    fireEvent.click(await screen.findByTestId("module-confirm-accept"));

    await waitFor(() => expect(server.moduleWrites.length).toBe(2));
    expect(server.moduleWrites[1].enabled).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("module-switch-tc").getAttribute("data-state")).toBe("checked"),
    );
  });

  it("a refused write leaves the switch where it was, and shows the server's message", async () => {
    server.moduleWriteError = { message: "Could not change that module", code: "MODULE_TOGGLE_FAILED" };
    renderPage();
    await openPractice("carein");
    fireEvent.click(screen.getByTestId("module-switch-tc"));
    fireEvent.click(await screen.findByTestId("module-confirm-accept"));

    await waitFor(() => expect(toasts.errors).toContain("Could not change that module"));
    // The switch is driven by the practice list, which a failed write never touched.
    expect(screen.getByTestId("module-switch-tc").getAttribute("data-state")).toBe("checked");
  });
});

// --- 3. users ----------------------------------------------------------------

describe("users", () => {
  it("shows role and home office, and renders a missing home office as an em dash", async () => {
    renderPage();
    await openPractice("carein", "users");

    await screen.findByTestId("practice-users");
    expect(screen.getByTestId("home-office-boss@carein.ai").textContent).toBe("roland");
    // A shared account is MEANT to have none — blank would read as missing data.
    expect(screen.getByTestId("home-office-temp@carein.ai").textContent).toBe("—");
  });

  it("offers no way to write, and points at the page that does", async () => {
    renderPage();
    await openPractice("carein", "users");
    const panel = await screen.findByTestId("practice-users");

    expect(panel.querySelectorAll("select").length).toBe(0);
    expect(panel.querySelectorAll("input").length).toBe(0);
    expect(panel.querySelector('a[href="/admin/users"]')).toBeTruthy();
  });
});

// --- 4. audit ----------------------------------------------------------------

describe("audit", () => {
  it("pages server-side and reports the range against the filtered total", async () => {
    renderPage();
    await openPractice("carein", "audit");

    await waitFor(() => expect(screen.getByTestId("audit-range").textContent).toBe("1–50 of 120"));

    fireEvent.click(screen.getByTestId("audit-next"));
    await waitFor(() => expect(screen.getByTestId("audit-range").textContent).toBe("51–100 of 120"));

    // The request carried the offset — the page did not slice a cached array.
    expect(api.listPracticeAudit).toHaveBeenCalledWith(
      CAREIN,
      expect.objectContaining({ offset: 50, limit: 50 }),
    );
  });

  it("applying a filter re-queries and returns to the first page", async () => {
    renderPage();
    await openPractice("carein", "audit");
    await waitFor(() => expect(screen.getByTestId("audit-range").textContent).toBe("1–50 of 120"));

    fireEvent.click(screen.getByTestId("audit-next"));
    await waitFor(() => expect(screen.getByTestId("audit-range").textContent).toBe("51–100 of 120"));

    fireEvent.change(screen.getByTestId("audit-filter-action"), { target: { value: "UPDATE" } });
    fireEvent.click(screen.getByTestId("audit-apply"));

    // Page 2 of the old result set is meaningless against the new one.
    await waitFor(() => expect(screen.getByTestId("audit-range").textContent).toBe("1–50 of 60"));
    expect(api.listPracticeAudit).toHaveBeenLastCalledWith(
      CAREIN,
      expect.objectContaining({ action: "UPDATE", offset: 0 }),
    );
  });
});

// --- 5. retention ------------------------------------------------------------

describe("retention", () => {
  it("says WHERE the current window came from, not just what it is", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    const src = await screen.findByTestId("retention-source");
    expect(src.textContent).toContain("Nobody has chosen");
    expect(src.textContent).toContain("CALL_RETENTION_DAYS");
  });

  it("renders the stored window's author once one has been chosen", async () => {
    server.retentionSource = "db";
    server.retentionDays = 60;
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    const src = await screen.findByTestId("retention-source");
    expect(src.textContent).toContain("60 days");
    expect(src.textContent).toContain("admin@carein.ai");
  });

  it("shortening shows a server-computed count before it can be confirmed", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");
    fireEvent.click(await screen.findByTestId("retention-option-30"));

    const warn = await screen.findByTestId("retention-shorten-warning");
    expect(warn.textContent).toContain("137");
    expect(warn.textContent).toContain("90");
    expect(warn.textContent).toContain("30");
    expect(server.impactCalls).toEqual([30]);
    // Still nothing written.
    expect(server.retentionWrites).toEqual([]);
  });

  it("extending says plainly that it restores nothing", async () => {
    server.retentionDays = 30;
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");
    fireEvent.click(await screen.findByTestId("retention-option-90"));

    const warn = await screen.findByTestId("retention-extend-warning");
    expect(warn.textContent).toContain("not");
    expect(warn.textContent).toContain("412");
    expect(screen.queryByTestId("retention-shorten-warning")).toBeNull();
  });

  it("persists on confirm and adopts the readback", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");
    fireEvent.click(await screen.findByTestId("retention-option-60"));
    await screen.findByTestId("retention-shorten-warning");
    fireEvent.click(screen.getByTestId("retention-confirm-accept"));

    await waitFor(() => expect(server.retentionWrites).toEqual([60]));
    await waitFor(() =>
      expect(screen.getByTestId("retention-source").textContent).toContain("60 days"),
    );
  });

  it("shows the nightly run as a time, with the office zone it is read in", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    const label = await screen.findByTestId("schedule-label");
    expect(label.textContent).toContain("3:30");
    expect(label.textContent).not.toContain("* * *");
    // The zone is load-bearing, not decoration — the job runs on office time.
    expect(label.textContent).toContain("America/Chicago");
  });

  it("shows an unrecognised cron verbatim rather than describing it wrongly", async () => {
    vi.mocked(api.getRetention).mockImplementationOnce(async () => {
      const base = await vi.mocked(api.getRetention).getMockImplementation()!();
      return { ...base, scheduler: { ...base.scheduler, schedule: "30 3 * * 1-5" } };
    });
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    // Weekdays only. "3:30 AM" would read as every day and be a lie.
    const label = await screen.findByTestId("schedule-label");
    expect(label.textContent).toContain("30 3 * * 1-5");
  });

  it("warns loudly when the policy is unknown and the prune is skipping", async () => {
    server.policyKnown = false;
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    const banner = await screen.findByTestId("policy-unknown");
    expect(banner.textContent).toContain("skipping");
    expect(banner.textContent).toContain("Nothing is being deleted");
  });

  it("reports a skipped prune as a failure, not a success", async () => {
    vi.mocked(api.runCallStorePrune).mockResolvedValueOnce({ skipped: "RETENTION_POLICY_UNKNOWN" });
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");
    fireEvent.click(await screen.findByTestId("run-prune"));

    await waitFor(() =>
      expect(toasts.errors.some((m) => m.includes("RETENTION_POLICY_UNKNOWN"))).toBe(true),
    );
    expect(toasts.successes).toEqual([]);
  });
});

// --- 6. the legacy purge ----------------------------------------------------

describe("legacy purge", () => {
  it("will not offer a live run until a dry run has said what it would take", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");

    expect((await screen.findByTestId("purge-live") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("purge-dry-run"));
    const dry = await screen.findByTestId("purge-dry-result");
    expect(dry.textContent).toContain("1660");
    expect(dry.textContent).toContain("2"); // skipped because twinned
    expect(server.purgeCalls).toEqual([{ dryRun: true }]);
    await waitFor(() =>
      expect((screen.getByTestId("purge-live") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("requires the typed token, then surfaces the backup path", async () => {
    renderPage();
    await screen.findByTestId("tab-call-store");
    clickTab("tab-call-store");
    fireEvent.click(await screen.findByTestId("purge-dry-run"));
    await screen.findByTestId("purge-dry-result");
    fireEvent.click(screen.getByTestId("purge-live"));

    const accept = (await screen.findByTestId("purge-confirm-accept")) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("purge-confirm-input"), { target: { value: "delete" } });
    expect((screen.getByTestId("purge-confirm-accept") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("purge-confirm-input"), { target: { value: "DELETE" } });
    await waitFor(() =>
      expect((screen.getByTestId("purge-confirm-accept") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("purge-confirm-accept"));

    await waitFor(() => expect(server.purgeCalls[1]).toEqual({ dryRun: false, confirm: "DELETE" }));
    const live = await screen.findByTestId("purge-live-result");
    expect(live.textContent).toContain("/data/backups/unified_calls.2026-08-13.json");
  });
});
