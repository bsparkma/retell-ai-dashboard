/**
 * Admin → Practice staff (hygienists).
 *
 * Every rule is the server's (backend/routes/hygStaff.js, and its tests). What
 * these defend is the page: it scopes to the OFFICE PICKER and never asks for
 * an office; it says "— none on file" for a missing licence in words; it says
 * when notes still use the built-in list; it shows a row as saved only from
 * the server's answer; and it shows the server's refusal verbatim.
 *
 * Synthetic staff only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

type Row = {
  id: string;
  office: "roland" | "valley";
  fullName: string;
  license: string | null;
  signInIds: string[];
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

const officeState = vi.hoisted(() => ({ office: "all" }));
const server = vi.hoisted(() => ({
  rows: [] as Row[],
  calls: [] as Array<{ fn: string; office: string; body?: unknown }>,
  refuseNext: null as null | { message: string; status: number; code: string },
  seq: 0,
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({
    office: officeState.office,
    offices: [
      { officeId: "roland", officeName: "Roland Office" },
      { officeId: "valley", officeName: "Valley Office" },
    ],
    loading: false,
    error: null,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const refuse = () => {
    const r = server.refuseNext;
    server.refuseNext = null;
    if (r) throw new real.ApiError(r.message, r.status, r.code, null);
  };
  const stamp = { createdBy: "om@carein.ai", createdAt: "2026-10-28T15:00:00.000Z", updatedBy: "om@carein.ai", updatedAt: "2026-10-28T15:00:00.000Z" };
  return {
    ...real,
    api: {
      ...real.api,
      listHygStaff: vi.fn(async (office: string) => {
        server.calls.push({ fn: "list", office });
        const staff = server.rows.filter((r) => r.office === office);
        return { success: true, office, staff, usingBuiltInList: staff.length === 0 };
      }),
      createHygStaff: vi.fn(async (office: string, input: { fullName: string; license: string | null; signInIds: string[] }) => {
        server.calls.push({ fn: "create", office, body: input });
        refuse();
        server.seq += 1;
        const row: Row = {
          id: `00000000-0000-4000-8000-${String(server.seq).padStart(12, "0")}`,
          office: office as Row["office"],
          fullName: input.fullName.trim(),
          license: input.license,
          signInIds: input.signInIds.map((s) => s.toLowerCase()),
          active: true,
          ...stamp,
        };
        server.rows.push(row);
        return row;
      }),
      updateHygStaff: vi.fn(async (office: string, id: string, input: { fullName: string; license: string | null; signInIds: string[] }) => {
        server.calls.push({ fn: "update", office, body: input });
        refuse();
        const row = server.rows.find((r) => r.id === id && r.office === office)!;
        Object.assign(row, { fullName: input.fullName, license: input.license, signInIds: input.signInIds });
        return { ...row };
      }),
      setHygStaffActive: vi.fn(async (office: string, id: string, active: boolean) => {
        server.calls.push({ fn: active ? "reactivate" : "deactivate", office });
        const row = server.rows.find((r) => r.id === id && r.office === office)!;
        row.active = active;
        return { ...row };
      }),
    },
  };
});

import AdminStaff from "@/pages/AdminStaff";

function row(over: Partial<Row>): Row {
  server.seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(server.seq).padStart(12, "0")}`,
    office: "roland",
    fullName: "Avery Example",
    license: "9101",
    signInIds: ["avery.example@carein.ai"],
    active: true,
    createdBy: "om@carein.ai",
    createdAt: "2026-10-28T15:00:00.000Z",
    updatedBy: "om@carein.ai",
    updatedAt: "2026-10-28T15:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  officeState.office = "all";
  server.rows = [];
  server.calls = [];
  server.refuseNext = null;
  server.seq = 0;
});
afterEach(() => cleanup());

describe("Practice staff page", () => {
  it("scopes to the office picker: All offices shows each office; one office shows only its own", async () => {
    server.rows = [row({}), row({ office: "valley", fullName: "Jamie Example", license: null, signInIds: ["jamie.example@carein.ai"] })];
    render(<AdminStaff />);
    expect(await screen.findByTestId("staff-office-roland")).toBeTruthy();
    expect(await screen.findByTestId("staff-office-valley")).toBeTruthy();
    expect(screen.getByTestId("staff-office-roland").textContent).toContain("Roland Office");
    cleanup();

    officeState.office = "valley";
    server.calls = [];
    render(<AdminStaff />);
    await screen.findByTestId("staff-office-valley");
    expect(screen.queryByTestId("staff-office-roland")).toBeNull();
    expect(server.calls.map((c) => c.office)).toEqual(["valley"]);
    // There is no office field anywhere on the page.
    expect(screen.queryByLabelText(/office/i)).toBeNull();
  });

  it("an office outside the hygiene offices gets words, not an empty list", async () => {
    officeState.office = "unknown";
    render(<AdminStaff />);
    expect(screen.getByTestId("staff-no-office").textContent).toMatch(/kept per hygiene office/);
  });

  it("shows name, licence, sign-ins and status — a missing licence reads '— none on file'", async () => {
    officeState.office = "roland";
    const avery = row({});
    const jamie = row({ fullName: "Jamie Example", license: null, signInIds: ["jamie.example@carein.ai", "jamie e"], active: false });
    server.rows = [avery, jamie];
    render(<AdminStaff />);
    await screen.findByTestId(`staff-row-${avery.id}`);
    expect(screen.getByTestId(`staff-row-${avery.id}-license`).textContent).toBe("Licence: RDH #9101");
    expect(screen.getByTestId(`staff-row-${jamie.id}-license`).textContent).toBe("Licence: — none on file");
    expect(screen.getByTestId(`staff-row-${jamie.id}-signins`).textContent).toBe("Signs in as: jamie.example@carein.ai, jamie e");
    // Status in words, not colour or a hover.
    expect(screen.getByTestId(`staff-row-${avery.id}-status`).textContent).toBe("Active");
    expect(screen.getByTestId(`staff-row-${jamie.id}-status`).textContent).toBe("Inactive — not used on notes");
    expect(screen.getByTestId(`staff-row-${jamie.id}-toggle`).textContent).toBe("Reactivate");
    expect(screen.queryByTestId("staff-builtin-roland")).toBeNull();
  });

  it("an office with nobody entered says notes still use the built-in list", async () => {
    officeState.office = "roland";
    render(<AdminStaff />);
    expect((await screen.findByTestId("staff-builtin-roland")).textContent).toMatch(
      /notes still use the names CareIN was set up with/,
    );
  });

  it("add: sends the three fields for the picker's office, and shows the row the server returned", async () => {
    officeState.office = "roland";
    render(<AdminStaff />);
    fireEvent.click(await screen.findByTestId("staff-add-roland"));
    fireEvent.change(screen.getByTestId("staff-new-roland-name"), { target: { value: "Avery Example" } });
    fireEvent.change(screen.getByTestId("staff-new-roland-license"), { target: { value: "  " } });
    fireEvent.change(screen.getByTestId("staff-new-roland-signins"), {
      target: { value: "Avery.Example@carein.ai\navery, " },
    });
    fireEvent.click(screen.getByTestId("staff-new-roland-save"));
    await waitFor(() => expect(screen.getByTestId("staff-list-roland")).toBeTruthy());
    expect(server.calls.find((c) => c.fn === "create")).toEqual({
      fn: "create",
      office: "roland",
      body: { fullName: "Avery Example", license: null, signInIds: ["Avery.Example@carein.ai", "avery"] },
    });
    const list = screen.getByTestId("staff-list-roland");
    expect(within(list).getByText("Avery Example")).toBeTruthy();
    expect(list.textContent).toContain("— none on file");
    expect(screen.queryByTestId("staff-builtin-roland")).toBeNull();
  });

  it("a refusal shows the server's own words, and the form keeps what was typed", async () => {
    officeState.office = "roland";
    render(<AdminStaff />);
    fireEvent.click(await screen.findByTestId("staff-add-roland"));
    fireEvent.change(screen.getByTestId("staff-new-roland-name"), { target: { value: "Someone Else" } });
    fireEvent.change(screen.getByTestId("staff-new-roland-signins"), { target: { value: "avery.example@carein.ai" } });
    server.refuseNext = {
      message: "Another person in this office already signs in as avery.example@carein.ai. Each sign-in can belong to one person only.",
      status: 409,
      code: "SIGN_IN_TAKEN",
    };
    fireEvent.click(screen.getByTestId("staff-new-roland-save"));
    expect((await screen.findByTestId("staff-new-roland-error")).textContent).toMatch(
      /already signs in as avery\.example@carein\.ai/,
    );
    expect((screen.getByTestId("staff-new-roland-name") as HTMLInputElement).value).toBe("Someone Else");
    expect(server.rows).toHaveLength(0);
  });

  it("edit inline, then deactivate — each shown from the server's answer", async () => {
    officeState.office = "roland";
    const avery = row({});
    server.rows = [avery];
    render(<AdminStaff />);
    fireEvent.click(await screen.findByTestId(`staff-row-${avery.id}-edit`));
    const name = screen.getByTestId(`staff-edit-${avery.id}-name`) as HTMLInputElement;
    expect(name.value).toBe("Avery Example");
    fireEvent.change(screen.getByTestId(`staff-edit-${avery.id}-license`), { target: { value: "" } });
    fireEvent.click(screen.getByTestId(`staff-edit-${avery.id}-save`));
    expect((await screen.findByTestId(`staff-row-${avery.id}-license`)).textContent).toBe("Licence: — none on file");
    expect(server.calls.find((c) => c.fn === "update")?.body).toEqual({
      fullName: "Avery Example",
      license: null,
      signInIds: ["avery.example@carein.ai"],
    });

    fireEvent.click(screen.getByTestId(`staff-row-${avery.id}-toggle`));
    await waitFor(() =>
      expect(screen.getByTestId(`staff-row-${avery.id}-status`).textContent).toBe("Inactive — not used on notes"),
    );
    expect(server.calls.some((c) => c.fn === "deactivate" && c.office === "roland")).toBe(true);
    // Deactivated, not removed.
    expect(screen.getByTestId(`staff-row-${avery.id}`)).toBeTruthy();
  });
});
