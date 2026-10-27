/**
 * Screenshot DUMP for Developer Console user management (S1).
 *
 * Same shape as `hyg-switch-shots.test.tsx`: renders into jsdom with fixture
 * data that lives in THIS file and writes the markup to
 * `tests/.shots/users-*.html`, which `scripts/shoot-dev-console-users.mjs`
 * wraps in the app's real built CSS and photographs at 1280 × 900.
 *
 *   users-01-console          Developer Console → a practice → People
 *   users-02-add-filled       the add form, with a home office chosen
 *   users-03-added            the new row, "Never signed in"
 *   users-04-refusal-row      LAST_ADMIN, inline on the row it refused
 *   users-05-refusal-add      USER_EXISTS, inline under the add form
 *   users-06-admin-after      /admin/users on this branch
 *   users-00-admin-before     /admin/users as origin/develop renders it — only
 *                             when a copy of that file has been placed at
 *                             tests/.shots/AdminUsersBefore.tsx (gitignored):
 *                               git show origin/develop:new-dashboard/client/src/pages/AdminUsers.tsx \
 *                                 > tests/.shots/AdminUsersBefore.tsx
 *
 * NO NETWORK, NO BACKEND, NO PHI. Synthetic addresses only.
 *
 * Skipped unless USERS_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

const authState = vi.hoisted(() => ({ isSuperAdmin: true, email: "operator@example.test" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Operator",
      email: authState.email,
      tenantId: "tid",
      tenant: { slug: "demo", displayName: "Demo Dental", modules: ["voice", "tc"] },
      role: "admin" as const,
      isSuperAdmin: authState.isSuperAdmin,
      permissions: ["admin.all", "voice.read", "tc.full"],
    })),
  };
});

const PRACTICE = "11111111-1111-4111-8111-111111111111";

const fixtures = vi.hoisted(() => ({
  writeError: null as { message: string; status: number; code: string } | null,
}));

const USERS = () => [
  { email: "person.one@example.test", role: "admin" as const, status: "active" as const, lastLoginAt: "2026-10-20T14:05:00.000Z", homeOffice: "roland" },
  { email: "person.two@example.test", role: "office" as const, status: "active" as const, lastLoginAt: "2026-10-24T09:30:00.000Z", homeOffice: "valley" },
  { email: "person.three@example.test", role: "hygiene" as const, status: "active" as const, lastLoginAt: null, homeOffice: "valley" },
  { email: "person.four@example.test", role: "tc" as const, status: "disabled" as const, lastLoginAt: "2026-09-02T16:00:00.000Z", homeOffice: null },
];
const OFFICES = [
  { officeId: "roland", officeName: "Roland" },
  { officeId: "valley", officeName: "Valley Fort Smith" },
];
const ROLES = ["admin", "office", "tc", "hygiene", "reviewer", "rcm_biller", "doctor"] as const;

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const maybeFail = () => {
    if (fixtures.writeError) {
      const e = fixtures.writeError;
      throw new real.ApiError(e.message, e.status, e.code);
    }
  };
  const roster = () => ({ users: USERS(), roles: [...ROLES], offices: OFFICES, actor: authState.email });
  return {
    ...real,
    api: {
      ...real.api,
      getAdminHealth: vi.fn(() => new Promise(() => {})),
      listPractices: vi.fn(async () => [
        {
          tenantId: PRACTICE, slug: "demo", displayName: "Demo Dental", status: "active",
          createdAt: "2026-01-05T00:00:00.000Z", userCount: 4,
          modules: [
            { module: "voice" as const, label: "Voice", blurb: "Call worklist", enabled: true },
            { module: "tc" as const, label: "Treatment Coordinator", blurb: "Case pipeline", enabled: true },
          ],
        },
      ]),
      listPracticeUsers: vi.fn(async () => roster()),
      listUsers: vi.fn(async () => roster()),
      createPracticeUser: vi.fn(async (_t: string, input: { email: string; role: "tc"; homeOffice?: string | null }) => {
        maybeFail();
        return { email: input.email, role: input.role, status: "active" as const, lastLoginAt: null, homeOffice: input.homeOffice ?? null };
      }),
      updatePracticeUser: vi.fn(async () => {
        maybeFail();
        throw new Error("unreachable in these shots");
      }),
    },
  };
});

import { AuthProvider } from "@/contexts/AuthContext";
import Platform from "@/pages/Platform";
import AdminUsers from "@/pages/AdminUsers";

const OUT = resolve(import.meta.dirname, ".shots");
const BEFORE = resolve(OUT, "AdminUsersBefore.tsx");

/**
 * Serialize the screen. React keeps a select's choice and an input's text in
 * DOM PROPERTIES, which innerHTML does not carry — so they are stamped onto
 * attributes first, or every picker would photograph as its first option.
 */
function dump(name: string) {
  mkdirSync(OUT, { recursive: true });
  document.querySelectorAll("select").forEach((sel) => {
    Array.from(sel.options).forEach((o) => {
      if (o.selected) o.setAttribute("selected", "");
      else o.removeAttribute("selected");
    });
  });
  document.querySelectorAll("input").forEach((input) => input.setAttribute("value", input.value));
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOOT = process.env.USERS_SHOTS === "1";

async function openPeople() {
  render(
    <AuthProvider>
      <Platform />
    </AuthProvider>,
  );
  fireEvent.click(await screen.findByTestId("practice-row-demo"));
  await screen.findByTestId("practice-detail");
  fireEvent.mouseDown(screen.getByTestId("tab-users"));
  await screen.findByTestId("user-row-person.one@example.test");
}

beforeEach(() => {
  fixtures.writeError = null;
  authState.email = "operator@example.test";
});

afterEach(() => {
  cleanup();
});

describe.skipIf(!SHOOT)("Developer Console users — shots", () => {
  it("01 — a practice's People tab, every status chip", async () => {
    await openPeople();
    dump("users-01-console");
  });

  it("02/03 — add someone with a home office, then the new row", async () => {
    await openPeople();
    fireEvent.change(screen.getByTestId("add-user-email"), { target: { value: "new.hire@example.test" } });
    fireEvent.change(screen.getByTestId("add-user-role"), { target: { value: "tc" } });
    fireEvent.change(screen.getByTestId("add-user-home-office"), { target: { value: "roland" } });
    dump("users-02-add-filled");

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await screen.findByTestId("user-row-new.hire@example.test");
    dump("users-03-added");
  });

  it("04 — the last admin, refused inline on its row", async () => {
    fixtures.writeError = {
      message: "This is the last active admin for this practice. Give someone else the admin role first.",
      status: 409,
      code: "LAST_ADMIN",
    };
    await openPeople();
    fireEvent.change(screen.getByTestId("role-select-person.one@example.test"), { target: { value: "office" } });
    await screen.findByTestId("refusal-person.one@example.test");
    dump("users-04-refusal-row");
  });

  it("05 — a duplicate address, refused inline under the form", async () => {
    fixtures.writeError = {
      message: "That email already has a row in this practice",
      status: 409,
      code: "USER_EXISTS",
    };
    await openPeople();
    fireEvent.change(screen.getByTestId("add-user-email"), { target: { value: "person.two@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await screen.findByTestId("add-user-refusal");
    dump("users-05-refusal-add");
  });

  it("06 — /admin/users on this branch, signed in as the practice's admin", async () => {
    authState.isSuperAdmin = false;
    authState.email = "person.one@example.test";
    render(
      <AuthProvider>
        <AdminUsers />
      </AuthProvider>,
    );
    await screen.findByTestId("user-row-person.two@example.test");
    dump("users-06-admin-after");
    authState.isSuperAdmin = true;
  });

  it.skipIf(!existsSync(BEFORE))("00 — /admin/users as origin/develop renders it", async () => {
    authState.isSuperAdmin = false;
    authState.email = "person.one@example.test";
    const mod = (await import(/* @vite-ignore */ BEFORE)) as { default: () => React.JSX.Element };
    const Before = mod.default;
    render(
      <AuthProvider>
        <Before />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByTestId("user-row-person.two@example.test"));
    dump("users-00-admin-before");
    authState.isSuperAdmin = true;
  });
});
