/**
 * Attaching an Open Dental patient to a hygiene intake, in jsdom.
 *
 * The hygienist's half of the office-context slice. Three properties:
 *
 *  1. The search runs against the OFFICE THE FORM IS FOR. A PatNum means
 *     nothing without its office — 7115 is the Riley test patient and a
 *     different, real person in Roland — so the office travels with every
 *     query and is stored on the case alongside the PatNum.
 *  2. Attaching is OPTIONAL. A brand-new patient who isn't in Open Dental yet
 *     must still hand off, with nothing but a typed name.
 *  3. Attaching PREFILLS, it never overwrites. The hygiene-safe endpoint
 *     returns only PatNum, name and DOB, so a phone the hygienist already typed
 *     chairside must survive the link instead of being blanked by an empty
 *     field the server deliberately does not send.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Raegan",
      email: "raegan@carein.ai",
      tenantId: "t",
      tenant: null,
      role: "hygiene",
      isSuperAdmin: false,
      permissions: ["tc.hygiene"],
      homeOffice: "valley",
    },
  }),
}));

const server = vi.hoisted(() => ({
  /** Offices the type-ahead asked about, in order. */
  searchedOffices: [] as string[],
  submitted: [] as Array<{ office: string; payload: Record<string, unknown> }>,
}));

vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  return {
    ...real,
    hygienistRoster: vi.fn(async () => []),
    odAttachSearch: vi.fn(async (office: string, query: string) => {
      server.searchedOffices.push(office);
      return {
        query,
        matchMode: "prefix",
        truncated: false,
        notes: [],
        patients: [
          {
            patNum: 7115,
            firstName: "Stedi",
            lastName: "TestValley",
            displayName: "TestValley, Stedi",
            birthdate: "1985-02-02",
            // The endpoint does not serve these; the client fills blanks so the
            // shared OdPatient shape stays one type.
            phone: "",
            email: "",
            status: "",
          },
        ],
      };
    }),
    submitHygieneIntake: vi.fn(async (office: string, payload: Record<string, unknown>) => {
      server.submitted.push({ office, payload });
      return { caseId: "case-1" };
    }),
  };
});

import { IntakeForm } from "@/features/tc/hygiene/IntakeForm";
import { odAttachSearch } from "@/features/tc/api";

function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function searchAndPick() {
  fireEvent.change(screen.getByLabelText(/link an open dental patient/i), {
    target: { value: "TestValley" },
  });
  const hit = await screen.findByText("TestValley, Stedi", {}, { timeout: 3000 });
  fireEvent.click(hit.closest("button")!);
}

beforeEach(() => {
  server.searchedOffices = [];
  server.submitted = [];
  vi.mocked(odAttachSearch).mockClear();
});

afterEach(cleanup);

describe("attaching a patient to a hygiene intake", () => {
  it("searches the office the form is for, and stores the PatNum with that office", async () => {
    render(<IntakeForm office="valley" />);

    await searchAndPick();
    await waitFor(() => expect(server.searchedOffices).toEqual(["valley"]));

    // The chip shows PatNum and DOB — OD matches names by PREFIX, so those are
    // what let a human confirm they attached the right person.
    expect(screen.getByText(/PatNum 7115/)).toBeTruthy();
    expect(screen.getByText(/DOB 1985-02-02/)).toBeTruthy();

    type(/diagnosing provider/i, "Dr. Example");
    fireEvent.click(screen.getByRole("button", { name: /submit handoff/i }));

    await waitFor(() => expect(server.submitted.length).toBe(1));
    const [sent] = server.submitted;
    // The office is the case's office — that is what makes the PatNum meaningful.
    expect(sent.office).toBe("valley");
    expect(sent.payload.odPatientId).toBe(7115);
    // …and the name is snapshotted alongside it, so the case reads correctly
    // even if nobody can reach Open Dental later.
    expect(sent.payload.patientName).toBe("Stedi TestValley");
  });

  it("still submits with no patient attached — a new patient isn't in OD yet", async () => {
    render(<IntakeForm office="roland" />);

    type(/patient name/i, "Walk In");
    type(/diagnosing provider/i, "Dr. Example");
    fireEvent.click(screen.getByRole("button", { name: /submit handoff/i }));

    await waitFor(() => expect(server.submitted.length).toBe(1));
    expect(server.submitted[0].payload.odPatientId).toBe(null);
    expect(server.submitted[0].payload.patientName).toBe("Walk In");
    expect(odAttachSearch).not.toHaveBeenCalled();
  });

  it("does not blank a phone the hygienist already typed", async () => {
    render(<IntakeForm office="valley" />);

    type(/phone/i, "(479) 555-0100");
    await searchAndPick();

    type(/diagnosing provider/i, "Dr. Example");
    fireEvent.click(screen.getByRole("button", { name: /submit handoff/i }));

    await waitFor(() => expect(server.submitted.length).toBe(1));
    expect(server.submitted[0].payload.phone).toBe("(479) 555-0100");
  });

  it("unlinking drops the PatNum but keeps what was typed", async () => {
    render(<IntakeForm office="valley" />);

    await searchAndPick();
    fireEvent.click(screen.getByRole("button", { name: /unlink this patient/i }));

    type(/diagnosing provider/i, "Dr. Example");
    fireEvent.click(screen.getByRole("button", { name: /submit handoff/i }));

    await waitFor(() => expect(server.submitted.length).toBe(1));
    expect(server.submitted[0].payload.odPatientId).toBe(null);
    expect(server.submitted[0].payload.patientName).toBe("Stedi TestValley");
  });
});
