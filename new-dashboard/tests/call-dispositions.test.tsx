/**
 * Call dispositions + internal notes.
 *
 * THE PROBLEM: the only two ways to finish a call both wrote somewhere — a chart
 * note or a TC case. A lab confirming a case, a supply vendor, a pharmacy needs
 * neither, so those rows sat in "Needs attention" looking like unworked backlog
 * forever, and there was nowhere to jot what actually happened on a call.
 *
 * What these tests pin:
 *   - a dispositioned call stops demanding attention but is NEVER removed from the
 *     list — it dims, keeps a badge, and one click clears it;
 *   - the filter can ask for the true backlog ("No disposition") and for one kind;
 *   - notes append with the SERVER's author/timestamp and read newest-first;
 *   - delete is offered to the author and to an admin, and to nobody else.
 *
 * No PHI: every name and number below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

// jsdom has no ResizeObserver; radix's Popover positioning needs one, and both the
// disposition picker and the notes panel live in popovers. Same stub the other
// popover/chart tests in this suite use.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; text: string }> }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.calls.push({ kind: "success", text }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

/** The signed-in user. `role`/`permissions` decide whether delete-any is offered. */
const authState = vi.hoisted(() => ({
  permissions: ["voice.read", "voice.write"] as string[],
  isSuperAdmin: false,
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: "office",
      isSuperAdmin: authState.isSuperAdmin,
      permissions: authState.permissions,
      homeOffice: null,
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "valley",
    offices: [{ officeId: "valley", officeName: "Valley Family Dental", odConnected: true }],
    selected: { officeId: "valley", officeName: "Valley Family Dental", odConnected: true },
  }),
}));

vi.mock("@/hooks/useTranscribeCall", () => ({
  useTranscribeCall: () => ({
    isRunning: () => false,
    request: vi.fn(),
    pendingConfirm: null,
    pendingConfirmKind: null,
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
  }),
}));

const apiMock = vi.hoisted(() => ({
  getUnifiedCalls: vi.fn(),
  getSyncStatus: vi.fn(),
  setCallDisposition: vi.fn(),
  addCallNote: vi.fn(),
  deleteCallNote: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import {
  normalizeUnifiedCall, normalizeCallNotes,
  type UnifiedCall, type BackendUnifiedCall, type CallNote,
} from "@/lib/api";
import { CallWorklist } from "@/pages/calls/CallWorklist";
import { CallNotesPanel, canDeleteNote } from "@/components/calls/CallNotesPanel";
import { matchesDispositionFilter, dispositionLabel, DISPOSITIONS } from "@/lib/dispositions";
import { callNeedsAttention } from "@/lib/worklist";

const baseCall = (over: Partial<UnifiedCall>): UnifiedCall => ({
  id: "c1",
  source: "mango",
  officeId: "valley",
  patientName: "Test Caller",
  fromNumber: "+15550000000",
  calledNumber: "+15551111111",
  duration: 120,
  date: "2026-08-12T15:00:00.000Z",
  summary: "",
  odPatientId: null,
  odPatientName: null,
  odSyncStatus: "needs_review",
  odMatchCandidates: [],
  notAPatient: false,
  notAPatientReason: null,
  hasTranscript: true,
  transcribeLastOutcome: null,
  triageStatus: "new",
  triageOutcome: null,
  triageBy: null,
  triageAt: null,
  tcCaseId: null,
  tcCaseUrl: null,
  linkRole: null,
  linkedCallId: null,
  isEmergency: false,
  appointmentBooked: false,
  appointmentRequested: false,
  callbackRequested: false,
  isNewPatient: false,
  insuranceMentioned: false,
  disposition: null,
  dispositionBy: null,
  dispositionAt: null,
  notes: [],
  ...over,
} as unknown as UnifiedCall);

const note = (over: Partial<CallNote>): CallNote => ({
  id: "n1",
  text: "Lab says the crown case is ready Thursday",
  author: { name: "Sarah Front", email: "sarah@carein.ai" },
  createdAt: "2026-08-12T15:30:00.000Z",
  ...over,
});

async function renderWorklist(calls: UnifiedCall[], view: "needs" | "all" = "needs") {
  apiMock.getUnifiedCalls.mockResolvedValue({ calls, mangoWorklistMode: "all" });
  apiMock.getSyncStatus.mockResolvedValue({ lastSyncedAt: null, nextAutoSync: null, mangoMode: "api" });
  render(React.createElement(CallWorklist));
  if (view === "all") fireEvent.click(screen.getByText("All calls"));
  await waitFor(() => expect(apiMock.getUnifiedCalls).toHaveBeenCalled());
}

beforeEach(() => {
  toasts.calls.length = 0;
  authState.permissions = ["voice.read", "voice.write"];
  authState.isSuperAdmin = false;
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

// --- the attention rule ----------------------------------------------------

describe("a dispositioned call is finished, but never hidden", () => {
  it("stops demanding attention once it has a disposition", () => {
    const open = baseCall({});
    const dispositioned = baseCall({ disposition: "lab" });

    expect(callNeedsAttention(open, "all")).toBe(true);
    expect(callNeedsAttention(dispositioned, "all")).toBe(false);
  });

  it("drops out of the attention COUNT without leaving the list", async () => {
    await renderWorklist(
      [baseCall({ id: "open" }), baseCall({ id: "done-lab", disposition: "lab" })],
      "all",
    );

    // Both rows render — a disposition is not a deletion.
    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(2));
    // And the dispositioned one is marked as such for the eye: dimmed + badged.
    const row = screen.getAllByTestId("worklist-row").find((r) => r.dataset.disposition === "lab");
    expect(row).toBeTruthy();
    expect(row!.className).toContain("opacity-60");
    expect(within(row as HTMLElement).getByTestId("disposition-badge").textContent).toContain("Lab");
  });

  it("hides only from the default view, where 'finished' belongs", async () => {
    await renderWorklist([baseCall({ id: "open" }), baseCall({ id: "vendor", disposition: "vendor" })]);
    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    expect(screen.getAllByTestId("worklist-row")[0].dataset.disposition).toBe("");
  });
});

// --- the filter -------------------------------------------------------------

describe("the disposition filter", () => {
  it("distinguishes any / none / dispositioned / one kind", () => {
    const none = baseCall({});
    const lab = baseCall({ disposition: "lab" });
    const vendor = baseCall({ disposition: "vendor" });

    for (const c of [none, lab, vendor]) expect(matchesDispositionFilter(c, "any")).toBe(true);

    expect(matchesDispositionFilter(none, "none")).toBe(true);
    expect(matchesDispositionFilter(lab, "none")).toBe(false);

    expect(matchesDispositionFilter(lab, "dispositioned")).toBe(true);
    expect(matchesDispositionFilter(none, "dispositioned")).toBe(false);

    expect(matchesDispositionFilter(lab, "lab")).toBe(true);
    expect(matchesDispositionFilter(vendor, "lab")).toBe(false);
  });

  it("offers every one of the seven, and labels them all", () => {
    expect(DISPOSITIONS.map((d) => d.value)).toEqual([
      "lab", "vendor", "pharmacy", "insurance", "personal", "spam", "other",
    ]);
    for (const d of DISPOSITIONS) expect(dispositionLabel(d.value)).toBe(d.label);
  });

  it("renders the filter control with the true-backlog option", async () => {
    await renderWorklist([baseCall({})]);
    const trigger = screen.getByLabelText("Filter by disposition");
    expect(trigger).toBeTruthy();
    // Default is the non-filtering one, so the list nobody touched is unchanged.
    expect(trigger.textContent).toContain("Any disposition");
  });
});

// --- setting it from the row -------------------------------------------------

describe("setting a disposition from the row", () => {
  it("is one tap, and sends only the value (the server owns attribution)", async () => {
    apiMock.setCallDisposition.mockResolvedValue({ id: "c1", disposition: "lab" } as BackendUnifiedCall);
    await renderWorklist([baseCall({})], "all");

    fireEvent.click(await screen.findByLabelText("Mark what kind of call this was"));
    fireEvent.click(await screen.findByText("Lab"));

    // Only the value goes over the wire — attribution is the session's, server-side.
    await waitFor(() => expect(apiMock.setCallDisposition).toHaveBeenCalledWith("c1", "lab"));
    // The row reflects it immediately (optimistic), and is still in "All calls".
    await waitFor(() => expect(screen.getByTestId("disposition-badge")).toBeTruthy());
    expect(screen.getAllByTestId("worklist-row")).toHaveLength(1);
  });

  it("clears the row out of 'Needs attention' the moment it is dispositioned", async () => {
    // The same thing marking a call Done does, and for the same reason: it is
    // finished. It is still one click from being un-dispositioned in "All calls".
    apiMock.setCallDisposition.mockResolvedValue({ id: "c1", disposition: "lab" } as BackendUnifiedCall);
    await renderWorklist([baseCall({})]); // default "Needs attention" view

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    fireEvent.click(await screen.findByLabelText("Mark what kind of call this was"));
    fireEvent.click(await screen.findByText("Lab"));

    await waitFor(() => expect(screen.queryAllByTestId("worklist-row")).toHaveLength(0));
    expect(screen.getByText("Nothing needs attention. Nice.")).toBeTruthy();
  });

  it("reverts the row and says so when the save fails", async () => {
    apiMock.setCallDisposition.mockRejectedValue(new Error("nope"));
    await renderWorklist([baseCall({})]);

    fireEvent.click(await screen.findByLabelText("Mark what kind of call this was"));
    fireEvent.click(await screen.findByText("Vendor"));

    await waitFor(() => expect(toasts.calls.some((t) => t.kind === "error")).toBe(true));
    // A call must never look handled because a request died.
    expect(screen.queryByTestId("disposition-badge")).toBeNull();
  });

  it("clears with a second tap on the current value", async () => {
    apiMock.setCallDisposition.mockResolvedValue({ id: "c1", disposition: null } as BackendUnifiedCall);
    await renderWorklist([baseCall({ disposition: "spam" })], "all");

    fireEvent.click(await screen.findByLabelText(/^Disposition: Spam/));
    fireEvent.click(await screen.findByText("Clear disposition"));

    await waitFor(() => expect(apiMock.setCallDisposition).toHaveBeenCalledWith("c1", null));
  });
});

// --- notes ------------------------------------------------------------------

describe("notes on a call", () => {
  it("counts them on the row and opens the panel in place", async () => {
    await renderWorklist([
      baseCall({ notes: [note({ id: "n1" }), note({ id: "n2", text: "Called them back" })] }),
    ]);

    const trigger = await screen.findByTestId("notes-action");
    expect(trigger.getAttribute("aria-label")).toBe("2 notes — read or add");
    expect(trigger.textContent).toContain("2");

    fireEvent.click(trigger);
    const panel = await screen.findByTestId("call-notes-panel");
    expect(within(panel).getByText("Lab says the crown case is ready Thursday")).toBeTruthy();
    expect(within(panel).getByText("Called them back")).toBeTruthy();
  });

  it("sends the text and shows the SERVER's stored note back", async () => {
    apiMock.addCallNote.mockResolvedValue({
      note: { id: "n-new", text: "Pharmacy needs a callback", author: null, created_at: "2026-08-12T16:00:00.000Z" },
      call: {
        id: "c1",
        notes: [{
          id: "n-new", text: "Pharmacy needs a callback",
          author: { name: "Sarah Front", email: "sarah@carein.ai" },
          created_at: "2026-08-12T16:00:00.000Z",
        }],
      } as BackendUnifiedCall,
    });
    await renderWorklist([baseCall({})]);

    fireEvent.click(await screen.findByTestId("notes-action"));
    fireEvent.change(await screen.findByLabelText("Add a note"), {
      target: { value: "  Pharmacy needs a callback  " },
    });
    fireEvent.click(screen.getByText("Add note"));

    // Trimmed on the way out; the server trims too, and agrees.
    await waitFor(() => expect(apiMock.addCallNote).toHaveBeenCalledWith("c1", "Pharmacy needs a callback"));
    await waitFor(() => expect(screen.getByText("Pharmacy needs a callback")).toBeTruthy());
    // The count on the row follows the server's record, not a local guess.
    await waitFor(() => expect(screen.getByTestId("notes-action").getAttribute("aria-label"))
      .toBe("1 note — read or add"));
  });

  it("keeps the words in the box when the save fails", async () => {
    apiMock.addCallNote.mockRejectedValue(new Error("offline"));
    await renderWorklist([baseCall({})]);

    fireEvent.click(await screen.findByTestId("notes-action"));
    const box = await screen.findByLabelText("Add a note");
    fireEvent.change(box, { target: { value: "worth keeping" } });
    fireEvent.click(screen.getByText("Add note"));

    await waitFor(() => expect(toasts.calls.some((t) => t.kind === "error")).toBe(true));
    expect((box as HTMLTextAreaElement).value).toBe("worth keeping");
  });

  it("will not send an empty note", async () => {
    await renderWorklist([baseCall({})]);
    fireEvent.click(await screen.findByTestId("notes-action"));
    const button = await screen.findByText("Add note");
    expect(button.closest("button")?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(apiMock.addCallNote).not.toHaveBeenCalled();
  });
});

// --- who may delete ---------------------------------------------------------

describe("deleting a note is author-or-admin", () => {
  const mine = note({ id: "mine", author: { name: "Sarah Front", email: "sarah@carein.ai" } });
  const theirs = note({ id: "theirs", text: "someone else wrote this", author: { name: "Dana Desk", email: "dana@carein.ai" } });

  it("matches the author on email, case-insensitively", () => {
    expect(canDeleteNote(mine, "sarah@carein.ai", false)).toBe(true);
    expect(canDeleteNote(mine, "SARAH@CareIN.ai", false)).toBe(true);
    expect(canDeleteNote(theirs, "sarah@carein.ai", false)).toBe(false);
    // An admin may take back anyone's.
    expect(canDeleteNote(theirs, "sarah@carein.ai", true)).toBe(true);
    // Nobody is the author of a note with no author, and nobody is an unauthenticated user.
    expect(canDeleteNote(note({ author: null }), "sarah@carein.ai", false)).toBe(false);
    expect(canDeleteNote(mine, null, false)).toBe(false);
  });

  it("offers the button on my own note and not on someone else's", async () => {
    render(
      <CallNotesPanel
        notes={[mine, theirs]}
        onAdd={async () => {}}
        onDelete={async () => {}}
        actorEmail="sarah@carein.ai"
        actorIsAdmin={false}
      />,
    );
    // One note, one delete button — the other note is not mine.
    expect(screen.getAllByLabelText("Delete this note")).toHaveLength(1);
  });

  it("offers it on every note for an admin", async () => {
    render(
      <CallNotesPanel
        notes={[mine, theirs]}
        onAdd={async () => {}}
        onDelete={async () => {}}
        actorEmail="sarah@carein.ai"
        actorIsAdmin
      />,
    );
    expect(screen.getAllByLabelText("Delete this note")).toHaveLength(2);
  });

  it("reads admin from the permission map, not a role literal, on the row", async () => {
    authState.permissions = ["voice.read", "voice.write", "admin.all"];
    await renderWorklist([baseCall({ notes: [theirs] })]);

    fireEvent.click(await screen.findByTestId("notes-action"));
    expect(await screen.findByLabelText("Delete this note")).toBeTruthy();
  });

  it("deletes through the api and takes the note off the row", async () => {
    apiMock.deleteCallNote.mockResolvedValue({ call: { id: "c1", notes: [] } as BackendUnifiedCall });
    await renderWorklist([baseCall({ notes: [mine] })]);

    fireEvent.click(await screen.findByTestId("notes-action"));
    fireEvent.click(await screen.findByLabelText("Delete this note"));

    await waitFor(() => expect(apiMock.deleteCallNote).toHaveBeenCalledWith("c1", "mine"));
    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeTruthy());
  });
});

// --- the wire mapping -------------------------------------------------------

describe("the wire shape becomes the display shape", () => {
  it("maps disposition + attribution, and reads notes newest-first", () => {
    const mapped = normalizeUnifiedCall({
      id: "c1",
      source: "mango",
      disposition: "pharmacy",
      disposition_by: { name: "Sarah Front", email: "sarah@carein.ai" },
      disposition_at: "2026-08-12T15:00:00.000Z",
      notes: [
        { id: "old", text: "written first", author: null, created_at: "2026-08-12T15:00:00.000Z" },
        { id: "new", text: "written second", author: null, created_at: "2026-08-12T16:00:00.000Z" },
      ],
    } as BackendUnifiedCall);

    expect(mapped.disposition).toBe("pharmacy");
    expect(mapped.dispositionBy?.email).toBe("sarah@carein.ai");
    expect(mapped.dispositionAt).toBe("2026-08-12T15:00:00.000Z");
    // The store appends; the reader wants the latest first.
    expect(mapped.notes.map((n) => n.id)).toEqual(["new", "old"]);
  });

  it("a call nobody touched maps to no disposition and no notes", () => {
    const mapped = normalizeUnifiedCall({ id: "c2", source: "retell" } as BackendUnifiedCall);
    expect(mapped.disposition).toBeNull();
    expect(mapped.dispositionBy).toBeNull();
    expect(mapped.notes).toEqual([]);
  });

  it("survives a malformed or absent notes array rather than throwing", () => {
    expect(normalizeCallNotes(undefined)).toEqual([]);
    expect(normalizeCallNotes(null)).toEqual([]);
    expect(normalizeCallNotes([
      { id: "ok", text: "fine", created_at: "2026-08-12T15:00:00.000Z" },
      { text: "no id" },
      { id: "no text" },
    ] as never)).toHaveLength(1);
  });
});
