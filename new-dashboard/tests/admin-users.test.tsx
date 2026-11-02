/**
 * Admin → Users page (Roles PR B).
 *
 * The page's own rules are thin on purpose — every guard is server-side. What
 * these tests defend is that the page (a) renders the server's data honestly,
 * (b) surfaces the server's refusal rather than inventing its own message, and
 * (c) disables the two self-edits so the round trip is rare, without pretending
 * that disabling is what enforces them.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const authState = vi.hoisted(() => ({ email: "boss@carein.ai" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Boss",
      email: authState.email,
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice"] },
      role: "admin" as const,
      isSuperAdmin: false,
      permissions: ["admin.all"],
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

const server = vi.hoisted(() => ({
  users: [] as Array<{
    email: string;
    role: string;
    status: string;
    lastLoginAt: string | null;
    homeOffice: string | null;
  }>,
  patchError: null as { message: string } | null,
  patched: [] as Array<{ email: string; patch: unknown }>,
  created: [] as Array<{ email: string; role: string }>,
  // Signature on notes: what the server holds per email, and every PUT body.
  signatures: {} as Record<string, { fullName: string; license: string | null } | null>,
  signatureSaves: [] as Array<{ email: string; input: unknown }>,
  signatureError: null as { message: string; code: string } | null,
  // Whether the office still prints from the built-in list (no hyg_staff rows).
  usingBuiltInList: false,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      listUsers: vi.fn(async () => ({
        users: server.users,
        roles: ["admin", "office", "tc", "hygiene"],
        offices: [
          { officeId: "roland", officeName: "Roland" },
          { officeId: "valley", officeName: "Valley Fort Smith" },
        ],
        actor: authState.email,
      })),
      createUser: vi.fn(async (email: string, role: string) => {
        server.created.push({ email, role });
        return { email, role, status: "active", lastLoginAt: null, homeOffice: null };
      }),
      updateUser: vi.fn(async (email: string, patch: Record<string, string>) => {
        server.patched.push({ email, patch });
        if (server.patchError) throw new real.ApiError(server.patchError.message, 409, "LAST_ADMIN");
        const row = server.users.find((u) => u.email === email)!;
        return { ...row, ...patch };
      }),
      getUserSignature: vi.fn(async (email: string) => ({
        success: true as const,
        office: "roland" as const,
        signature: server.signatures[email] ?? null,
        usingBuiltInList: server.usingBuiltInList,
      })),
      saveUserSignature: vi.fn(
        async (email: string, input: { fullName: string | null; license: string | null }) => {
          server.signatureSaves.push({ email, input });
          if (server.signatureError) {
            throw new real.ApiError(server.signatureError.message, 403, server.signatureError.code);
          }
          const signature = input.fullName ? { fullName: input.fullName, license: input.license } : null;
          server.signatures[email] = signature;
          server.usingBuiltInList = false;
          return { success: true as const, office: "roland" as const, signature, usingBuiltInList: false };
        },
      ),
    },
  };
});

import { AuthProvider } from "@/contexts/AuthContext";
import AdminUsers from "@/pages/AdminUsers";
import { api } from "@/lib/api";

beforeEach(() => {
  server.users = [
    { email: "boss@carein.ai", role: "admin", status: "active", lastLoginAt: "2026-08-10T12:00:00.000Z", homeOffice: "roland" },
    { email: "front@carein.ai", role: "office", status: "active", lastLoginAt: null, homeOffice: null },
    { email: "hyg@carein.ai", role: "hygiene", status: "disabled", lastLoginAt: null, homeOffice: "valley" },
  ];
  server.patchError = null;
  server.patched = [];
  server.created = [];
  server.signatures = {};
  server.signatureSaves = [];
  server.signatureError = null;
  server.usingBuiltInList = false;
  toasts.errors = [];
  toasts.successes = [];
  authState.email = "boss@carein.ai";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <AuthProvider>
      <AdminUsers />
    </AuthProvider>,
  );

describe("Users page", () => {
  it("renders one row per user with role, status and last sign-in", async () => {
    renderPage();

    expect(await screen.findByTestId("user-row-boss@carein.ai")).toBeTruthy();
    expect(screen.getByTestId("user-row-front@carein.ai")).toBeTruthy();
    // "Never" is the honest rendering of a null last_login_at — a
    // pre-provisioned row that nobody has used yet.
    expect(screen.getAllByText("Never").length).toBe(2);
    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  it("marks the signed-in admin's own row and locks its two self-edits", async () => {
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");

    expect(screen.getByText("You")).toBeTruthy();
    // Disabled here purely to spare a round trip the server would refuse.
    expect(screen.getByTestId("role-select-boss@carein.ai").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("toggle-boss@carein.ai").hasAttribute("disabled")).toBe(true);
    // Somebody else's row stays editable.
    expect(screen.getByTestId("role-select-front@carein.ai").hasAttribute("disabled")).toBe(false);
  });

  it("each row's role select shows THAT row's role", () => {
    renderPage();
    return waitFor(() => {
      const value = (id: string) => (screen.getByTestId(id) as HTMLSelectElement).value;
      expect(value("role-select-boss@carein.ai")).toBe("admin");
      expect(value("role-select-front@carein.ai")).toBe("office");
      expect(value("role-select-hyg@carein.ai")).toBe("hygiene");
    });
  });

  it("sends a role change and reports the cache delay honestly", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.change(screen.getByTestId("role-select-front@carein.ai"), { target: { value: "tc" } });

    await waitFor(() => expect(server.patched).toEqual([{ email: "front@carein.ai", patch: { role: "tc" } }]));
    // The role cache is ~60s, so promising "done" would be a lie.
    expect(toasts.successes[0]).toMatch(/within a minute/i);
  });

  it("toggles status both ways", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.click(screen.getByTestId("toggle-front@carein.ai"));
    await waitFor(() => expect(server.patched[0].patch).toEqual({ status: "disabled" }));

    fireEvent.click(screen.getByTestId("toggle-hyg@carein.ai"));
    await waitFor(() => expect(server.patched[1].patch).toEqual({ status: "active" }));
  });

  it("shows the SERVER's refusal verbatim rather than a generic failure", async () => {
    server.patchError = {
      message: "This is the last active admin for this practice. Give someone else the admin role first.",
    };
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.change(screen.getByTestId("role-select-front@carein.ai"), { target: { value: "tc" } });

    await waitFor(() => expect(toasts.errors[0]).toMatch(/last active admin/i));
  });

  it("adds a user, lowercased", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.change(screen.getByTestId("add-user-email"), { target: { value: "NewHire@CareIN.ai" } });
    fireEvent.change(screen.getByTestId("add-user-role"), { target: { value: "hygiene" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(server.created).toEqual([{ email: "newhire@carein.ai", role: "hygiene" }]),
    );
  });

  it("WARNS about an off-domain address without blocking it", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.change(screen.getByTestId("add-user-email"), {
      target: { value: "contractor@example.com" },
    });

    expect(await screen.findByText(/won't be able to sign in/i)).toBeTruthy();
    // The Add button stays live — practices do hire people with other addresses.
    expect(screen.getByRole("button", { name: /^add$/i }).hasAttribute("disabled")).toBe(false);
  });
});

describe("Home office column", () => {
  it("shows each person's home office, and an em dash for nobody's", async () => {
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");

    expect(
      (screen.getByTestId("home-office-boss@carein.ai") as HTMLSelectElement).value,
    ).toBe("roland");
    // temp/shared accounts are MEANT to have none — the office picker is their
    // "which office are you at today?" prompt, so "" is a real answer.
    expect(
      (screen.getByTestId("home-office-front@carein.ai") as HTMLSelectElement).value,
    ).toBe("");
  });

  it("offers the server's office list, never a hardcoded one", async () => {
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");

    const select = screen.getByTestId("home-office-front@carein.ai") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "roland", "valley"]);
  });

  it("patches homeOffice on change", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    fireEvent.change(screen.getByTestId("home-office-front@carein.ai"), {
      target: { value: "valley" },
    });

    await waitFor(() => expect(server.patched.length).toBe(1));
    expect(server.patched[0]).toEqual({
      email: "front@carein.ai",
      patch: { homeOffice: "valley" },
    });
  });

  it("clearing it sends null, not an empty string", async () => {
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");

    fireEvent.change(screen.getByTestId("home-office-boss@carein.ai"), {
      target: { value: "" },
    });

    await waitFor(() => expect(server.patched.length).toBe(1));
    expect(server.patched[0].patch).toEqual({ homeOffice: null });
  });

  it("is editable on your OWN row — a home office locks nobody out", async () => {
    // Role and status are disabled for yourself because they are one-way doors.
    // A home office only seeds a picker that still offers every office, so
    // spreading that lock to it would be friction with no safety behind it.
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");

    const own = screen.getByTestId("home-office-boss@carein.ai") as HTMLSelectElement;
    expect(own.disabled).toBe(false);
    expect((screen.getByTestId("role-select-boss@carein.ai") as HTMLSelectElement).disabled).toBe(
      true,
    );
  });
});

describe("Signature on notes", () => {
  it("is collapsed by default on every row, whatever the role, and loads only when opened", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");

    for (const email of ["boss@carein.ai", "front@carein.ai", "hyg@carein.ai"]) {
      expect(screen.getByTestId(`signature-toggle-${email}`).getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId(`signature-panel-${email}`)).toBeNull();
    }
    expect(api.getUserSignature).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));
    expect(await screen.findByTestId("signature-panel-front@carein.ai")).toBeTruthy();
    expect(api.getUserSignature).toHaveBeenCalledWith("front@carein.ai");
    expect(screen.getByTestId("signature-panel-front@carein.ai").textContent).toContain("Roland notes");
  });

  it("saves a name and licence — and sends nothing else (no email, no office)", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));
    await screen.findByTestId("signature-panel-front@carein.ai");

    fireEvent.change(screen.getByTestId("signature-name-front@carein.ai"), { target: { value: "  Avery   Example " } });
    fireEvent.change(screen.getByTestId("signature-license-front@carein.ai"), { target: { value: " 9101 " } });
    expect(screen.getByTestId("signature-hint-front@carein.ai").textContent).toContain("licence #9101");
    fireEvent.click(screen.getByTestId("signature-save-front@carein.ai"));

    await waitFor(() => expect(server.signatureSaves.length).toBe(1));
    expect(server.signatureSaves[0]).toEqual({
      email: "front@carein.ai",
      input: { fullName: "Avery Example", license: "9101" },
    });
    await waitFor(() => expect(toasts.successes).toContain("Signature saved"));
  });

  it("a blank licence is sent as null and says the name prints alone — never a placeholder", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));
    await screen.findByTestId("signature-panel-front@carein.ai");

    fireEvent.change(screen.getByTestId("signature-name-front@carein.ai"), { target: { value: "Avery Example" } });
    const hint = screen.getByTestId("signature-hint-front@carein.ai").textContent ?? "";
    expect(hint).toContain("the name prints alone");
    expect(hint).not.toMatch(/#/);
    fireEvent.click(screen.getByTestId("signature-save-front@carein.ai"));
    await waitFor(() => expect(server.signatureSaves.length).toBe(1));
    expect(server.signatureSaves[0].input).toEqual({ fullName: "Avery Example", license: null });
  });

  it("a licence with no name cannot be saved", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));
    await screen.findByTestId("signature-panel-front@carein.ai");

    fireEvent.change(screen.getByTestId("signature-license-front@carein.ai"), { target: { value: "9101" } });
    expect(screen.getByTestId("signature-save-front@carein.ai").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("signature-hint-front@carein.ai").textContent).toContain("Enter the name");
  });

  it("shows the stored signature, and Remove clears both fields", async () => {
    server.signatures["front@carein.ai"] = { fullName: "Jamie Example", license: null };
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));

    await waitFor(() =>
      expect((screen.getByTestId("signature-name-front@carein.ai") as HTMLInputElement).value).toBe("Jamie Example"),
    );
    fireEvent.click(screen.getByTestId("signature-remove-front@carein.ai"));
    await waitFor(() => expect(server.signatureSaves.length).toBe(1));
    expect(server.signatureSaves[0].input).toEqual({ fullName: null, license: null });
    await waitFor(() =>
      expect((screen.getByTestId("signature-name-front@carein.ai") as HTMLInputElement).value).toBe(""),
    );
    expect(toasts.successes).toContain("Signature removed");
  });

  it("is open on your OWN row too, and shows the server's refusal verbatim", async () => {
    server.signatureError = {
      message: "That account is a platform administrator and can only be changed by one.",
      code: "PLATFORM_ADMIN_PROTECTED",
    };
    renderPage();
    await screen.findByTestId("user-row-boss@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-boss@carein.ai"));
    await screen.findByTestId("signature-panel-boss@carein.ai");

    fireEvent.change(screen.getByTestId("signature-name-boss@carein.ai"), { target: { value: "Morgan Example" } });
    expect(screen.getByTestId("signature-save-boss@carein.ai").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("signature-save-boss@carein.ai"));

    const refusal = await screen.findByTestId("signature-refusal-boss@carein.ai");
    expect(refusal.getAttribute("data-code")).toBe("PLATFORM_ADMIN_PROTECTED");
    expect(refusal.textContent).toContain("can only be changed by one");
  });

  it("a disabled account's signature cannot be edited — nothing prints for it", async () => {
    renderPage();
    await screen.findByTestId("user-row-hyg@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-hyg@carein.ai"));
    await screen.findByTestId("signature-panel-hyg@carein.ai");

    expect(screen.getByTestId("signature-name-hyg@carein.ai").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("signature-hint-hyg@carein.ai").textContent).toContain("disabled");
  });
});

describe("Signature on notes — the built-in list switch", () => {
  it("warns, before the first save, that it switches the office off the built-in list", async () => {
    server.usingBuiltInList = true;
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));

    const warning = await screen.findByTestId("signature-builtin-warning-front@carein.ai");
    expect(warning.textContent).toContain("built-in list");
    expect(warning.textContent).toContain("without a");

    fireEvent.change(screen.getByTestId("signature-name-front@carein.ai"), { target: { value: "Avery Example" } });
    fireEvent.click(screen.getByTestId("signature-save-front@carein.ai"));
    await waitFor(() => expect(screen.queryByTestId("signature-builtin-warning-front@carein.ai")).toBeNull());
  });

  it("says nothing once the office has its own list", async () => {
    renderPage();
    await screen.findByTestId("user-row-front@carein.ai");
    fireEvent.click(screen.getByTestId("signature-toggle-front@carein.ai"));
    await screen.findByTestId("signature-panel-front@carein.ai");
    expect(screen.queryByTestId("signature-builtin-warning-front@carein.ai")).toBeNull();
  });
});
