/**
 * Screenshot DUMPS for the Practice staff page.
 *
 *   pnpm exec vite build
 *   STAFF_SHOTS=1 pnpm exec vitest run tests/admin-staff-shots.test.tsx
 *   node scripts/shoot-staff.mjs
 *
 *   staff-01-all-offices   All offices: Roland with three hygienists (one with no
 *                          licence on file, one inactive); Valley with nobody
 *                          entered yet, still on the built-in list
 *   staff-02-add-refused   adding someone whose sign-in another person holds:
 *                          the server's refusal, the typed values kept
 *   staff-03-edit          editing a row inline
 *
 * NO NETWORK, NO BACKEND. Synthetic staff only. Skipped unless STAFF_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

const officeState = vi.hoisted(() => ({ office: "all" }));
const server = vi.hoisted(() => ({ refuse: false }));

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

const STAMP = {
  createdBy: "om@carein.ai",
  createdAt: "2026-10-28T15:00:00.000Z",
  updatedBy: "om@carein.ai",
  updatedAt: "2026-10-28T15:00:00.000Z",
};
const ROLAND = [
  { id: "00000000-0000-4000-8000-000000000001", office: "roland", fullName: "Avery Example", license: "9101", signInIds: ["avery.example@carein.ai"], active: true, ...STAMP },
  { id: "00000000-0000-4000-8000-000000000002", office: "roland", fullName: "Jamie Example", license: null, signInIds: ["jamie.example@carein.ai", "jamie.e"], active: true, ...STAMP },
  { id: "00000000-0000-4000-8000-000000000003", office: "roland", fullName: "Casey Example", license: "9103", signInIds: ["casey.example@carein.ai"], active: false, ...STAMP },
];

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      listHygStaff: vi.fn(async (office: string) => {
        const staff = office === "roland" ? ROLAND : [];
        return { success: true, office, staff, usingBuiltInList: staff.length === 0 };
      }),
      createHygStaff: vi.fn(async () => {
        throw new real.ApiError(
          "Another person in this office already signs in as avery.example@carein.ai. Each sign-in can belong to one person only.",
          409,
          "SIGN_IN_TAKEN",
          null,
        );
      }),
    },
  };
});

import AdminStaff from "@/pages/AdminStaff";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOTS = process.env.STAFF_SHOTS === "1";

describe.skipIf(!SHOTS)("practice staff shots", () => {
  afterEach(() => cleanup());

  it("staff-01-all-offices", async () => {
    officeState.office = "all";
    render(<AdminStaff />);
    await screen.findByTestId("staff-list-roland");
    await screen.findByTestId("staff-builtin-valley");
    dump("staff-01-all-offices@1280x1100");
  });

  it("staff-02-add-refused", async () => {
    officeState.office = "roland";
    render(<AdminStaff />);
    fireEvent.click(await screen.findByTestId("staff-add-roland"));
    fireEvent.change(screen.getByTestId("staff-new-roland-name"), { target: { value: "Robin Example" } });
    fireEvent.change(screen.getByTestId("staff-new-roland-license"), { target: { value: "9104" } });
    fireEvent.change(screen.getByTestId("staff-new-roland-signins"), { target: { value: "avery.example@carein.ai" } });
    fireEvent.click(screen.getByTestId("staff-new-roland-save"));
    await screen.findByTestId("staff-new-roland-error");
    dump("staff-02-add-refused@1280x1100");
  });

  it("staff-03-edit", async () => {
    officeState.office = "roland";
    render(<AdminStaff />);
    fireEvent.click(await screen.findByTestId(`staff-row-${ROLAND[1].id}-edit`));
    await screen.findByTestId(`staff-edit-${ROLAND[1].id}`);
    dump("staff-03-edit@1280x1000");
  });
});
