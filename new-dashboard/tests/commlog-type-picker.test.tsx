/**
 * The chart-note type picker at review-then-send.
 *
 * Sending a call summary to a chart always stamped one hardcoded per-office
 * CommType — Roland 486, Riley/valley 451. The send dialog now offers the
 * office's OWN Open Dental commlog types instead, preselected to that default.
 *
 * What these assert, in order of what would actually hurt if it broke:
 *
 *  1. The dropdown is preselected to the office default and the send carries it,
 *     so "open the dialog and press Send" writes what it wrote before.
 *  2. The list served is the CALL's office's list — the DefNums differ per
 *     practice, and 401 names a different type in each, so a list from the wrong
 *     office would be silently wrong rather than obviously wrong.
 *  3. With no list available the control is disabled and explained, and Send
 *     still works. A chart write must never wait on a definitions lookup.
 *
 * No PHI: the patients below are the synthetic staging fixtures (valley 7115,
 * roland 12827). The commlog type names are practice configuration.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const apiMock = vi.hoisted(() => ({
  getCommlogPreview: vi.fn(),
  resolvePatient: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { type UnifiedCall } from "@/lib/api";
import { SendToChartDialog } from "@/pages/calls/SendToChartDialog";

// ── jsdom gaps Radix Select needs ───────────────────────────────────────────

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

// ── Fixtures: the real per-office lists, read live on 2026-08-13 ────────────
//
// Trimmed to the rows the assertions turn on. The full lists are 12 types each
// and share not one DefNum for the same concept.

const ROLAND_TYPES = [
  { defNum: 486, name: "CareIN AI Call" },
  { defNum: 401, name: "ODHQ" },
  { defNum: 227, name: "Recall" },
];

const VALLEY_TYPES = [
  { defNum: 451, name: "CareIN AI Call" },
  { defNum: 401, name: "Crown by Moolah" },
  { defNum: 238, name: "Recall" },
];

function call(id = "mango_call_seed_roland"): UnifiedCall {
  return { id, officeId: "roland" } as unknown as UnifiedCall;
}

/** The preview response, with whatever catalogue this test is about. */
function preview(over: Record<string, unknown> = {}) {
  return {
    note: "CareIN call - Aug 13, 2026 - Staff (Mango)\nCaller: Stedi Test 2",
    patientId: 12827,
    patientName: "Test 2, Stedi",
    office: { officeId: "roland", officeName: "Roland Family Dental", odConnected: true },
    commlogTypes: {
      available: true,
      options: ROLAND_TYPES,
      defaultDefNum: 486,
      defaultName: "CareIN AI Call",
      stale: false,
    },
    ...over,
  };
}

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <SendToChartDialog
      open
      onOpenChange={() => {}}
      call={call()}
      patientId={12827}
      patientName="Test 2, Stedi"
      onSent={() => {}}
      {...props}
    />,
  );
}

/** Wait for the preview fetch to settle, i.e. the note textarea to be filled. */
async function ready() {
  await waitFor(() => expect(screen.getByRole("combobox", { name: /note type/i })).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.resolvePatient.mockResolvedValue({ success: true, commLogNum: 1, call: null });
});

afterEach(() => cleanup());

// ── 1. Default preselected, and unchanged behaviour on a plain Send ──────────

describe("the office default", () => {
  it("is preselected and labelled as the default", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(preview());
    renderDialog();
    await ready();

    // The trigger shows the default's name without the user touching anything.
    expect(screen.getByRole("combobox", { name: /note type/i }).textContent).toContain("CareIN AI Call");

    fireEvent.click(screen.getByRole("combobox", { name: /note type/i }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    const chosen = screen.getAllByRole("option").find((o) => o.textContent?.includes("CareIN AI Call"));
    expect(chosen?.textContent).toContain("default");
    expect(chosen?.getAttribute("aria-selected")).toBe("true");
  });

  it("is what a plain Send carries — the pre-picker write, spelled out", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(preview());
    renderDialog();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));

    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1));
    expect(apiMock.resolvePatient.mock.calls[0][1]).toMatchObject({
      patientId: 12827,
      commTypeDefNum: 486,
      office_id: "roland",
    });
  });
});

// ── 2. A deliberate pick, and only a deliberate pick, changes the write ──────

describe("picking a different type", () => {
  it("sends the picked DefNum instead of the default", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(preview());
    renderDialog();
    await ready();

    fireEvent.click(screen.getByRole("combobox", { name: /note type/i }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    fireEvent.click(screen.getAllByRole("option").find((o) => o.textContent?.startsWith("Recall"))!);

    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));
    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1));
    expect(apiMock.resolvePatient.mock.calls[0][1]).toMatchObject({ commTypeDefNum: 227 });
  });

  it("offers the CALL's office list — a valley call never sees Roland's DefNums", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(
      preview({
        office: { officeId: "valley", officeName: "Riley Family Dental", odConnected: true },
        commlogTypes: {
          available: true, options: VALLEY_TYPES, defaultDefNum: 451,
          defaultName: "CareIN AI Call", stale: false,
        },
      }),
    );
    renderDialog({ call: call("mango_call_seed_valley"), patientId: 7115, patientName: "Stedi TestValley" });
    await ready();

    fireEvent.click(screen.getByRole("combobox", { name: /note type/i }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));

    // 401 is a valid type in BOTH practices and names a different thing in each.
    // Serving the wrong office's list would look perfectly normal right here.
    const options = screen.getAllByRole("option");
    const names = options.map((o) => o.textContent);
    expect(names.some((n) => n?.includes("Crown by Moolah"))).toBe(true);
    expect(names.some((n) => n?.includes("ODHQ"))).toBe(false);

    // Close the popup by choosing — Radix keeps the rest of the dialog inert
    // while it is open, so Send is genuinely unreachable until it closes.
    fireEvent.click(options.find((o) => o.textContent?.startsWith("CareIN AI Call"))!);
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(0));

    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));
    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1));
    // Riley's "CareIN AI Call", never Roland's 486.
    expect(apiMock.resolvePatient.mock.calls[0][1]).toMatchObject({ commTypeDefNum: 451 });
  });
});

// ── 3. Degraded: no list. Send must still work. ─────────────────────────────

describe("when Open Dental's type list is unavailable", () => {
  it("shows the default alone, disabled and explained, and still sends", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(
      preview({
        commlogTypes: {
          available: false, options: [], defaultDefNum: 486, defaultName: null, stale: false,
        },
      }),
    );
    renderDialog();
    await ready();

    const trigger = screen.getByRole("combobox", { name: /note type/i });
    expect(trigger.hasAttribute("disabled") || trigger.getAttribute("data-disabled") !== null).toBe(true);
    expect(screen.getByText(/note types aren't available right now/i)).toBeTruthy();

    const send = screen.getByRole("button", { name: /send to chart/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1));
    // Still names the office default, which the server accepts without needing
    // the catalogue it just failed to produce.
    expect(apiMock.resolvePatient.mock.calls[0][1]).toMatchObject({ commTypeDefNum: 486 });
  });

  it("says so when the list is a served-stale copy, without disabling anything", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(
      preview({
        commlogTypes: {
          available: true, options: ROLAND_TYPES, defaultDefNum: 486,
          defaultName: "CareIN AI Call", stale: true,
        },
      }),
    );
    renderDialog();
    await ready();

    expect(screen.getByText(/may be out of date/i)).toBeTruthy();
    const trigger = screen.getByRole("combobox", { name: /note type/i });
    expect(trigger.hasAttribute("disabled")).toBe(false);
  });

  it("omits commTypeDefNum entirely when the server offered no default", async () => {
    // An office with no Open Dental at all: there is nothing to pick and nothing
    // to assert, so the request looks exactly like a pre-picker one.
    apiMock.getCommlogPreview.mockResolvedValue(preview({ commlogTypes: undefined }));
    renderDialog();
    await waitFor(() => expect(screen.getByRole("button", { name: /send to chart/i })).toBeTruthy());

    expect(screen.queryByRole("combobox", { name: /note type/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));
    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1));
    expect("commTypeDefNum" in (apiMock.resolvePatient.mock.calls[0][1] as object)).toBe(false);
  });
});
