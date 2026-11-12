/**
 * CO-3 — print templates, in jsdom.
 *
 *  - Settings: both shipped templates load; the preview is filled with the
 *    clearly synthetic sample values and nothing else; the closed placeholder
 *    menu inserts at the cursor; a `{{...}}` not on the menu is named and Save
 *    is off; a save sends the draft and shows the read-back; without logo
 *    storage the page says "Logo storage is not set up for this environment"
 *  - the workup: a Print section with one button per template; the dialog shows
 *    the card's own patient / day / provider / office read-only and the three
 *    editable values pre-filled; Generate sends exactly those and opens the PDF;
 *    a refusal (the audit could not be written) is shown, nothing opens
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co3-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names, roland test PatNum.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PRINT_PLACEHOLDERS,
  defaultPrintTemplate,
  samplePrintValues,
  type PrintTemplateState,
  type PrintTemplatesResponse,
  type TcCheckoutPrintDefaults,
} from "@shared/tc/printTemplates";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
// jsdom has no object URLs; the editor revokes the logo preview's on unmount.
URL.revokeObjectURL ??= () => undefined;

const { api, toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  api: {
    getPrintTemplates: vi.fn(),
    savePrintTemplate: vi.fn(),
    uploadPrintLogo: vi.fn(),
    removePrintLogo: vi.fn(),
    fetchPrintLogoUrl: vi.fn(),
    getCheckoutPrintDefaults: vi.fn(),
    printCheckout: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/print/printApi", () => api);
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({
    office: "roland",
    offices: [
      { officeId: "roland", officeName: "Roland" },
      { officeId: "valley", officeName: "Valley Fort Smith" },
    ],
    loading: false,
    error: null,
  }),
}));

import AdminPrintTemplates from "@/pages/AdminPrintTemplates";
import { CheckoutPrint } from "@/features/tc/checkout/CheckoutPrint";
import { TcApiError } from "@/features/tc/api";

const PREFILL = { name: "Synthetic Roland Dental", address: "1 Example Way\nRoland, OK", phone: "(555) 010-0001" };

function stateOf(type: "excuse" | "appointment_card", over: Partial<PrintTemplateState> = {}): PrintTemplateState {
  return {
    type,
    label: type === "excuse" ? "School / work excuse" : "Appointment card",
    stored: false,
    fields: defaultPrintTemplate(type, PREFILL),
    logo: { present: false, contentType: null },
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

function templates(over: Partial<PrintTemplatesResponse> = {}): PrintTemplatesResponse {
  return {
    success: true,
    office: "roland",
    prefill: PREFILL,
    templates: [stateOf("excuse"), stateOf("appointment_card")],
    logoStorageConfigured: false,
    ...over,
  };
}

const DEFAULTS: TcCheckoutPrintDefaults = {
  success: true,
  templates: [
    { type: "excuse", label: "School / work excuse" },
    { type: "appointment_card", label: "Appointment card" },
  ],
  fixed: { patientFullName: "Stedi Test 2", dateSeen: "October 30, 2026", providerName: "DOC1", officeName: "Synthetic Roland Dental" },
  editable: { timeSeenRange: "9:00 AM", nextAppointmentDate: "Wednesday, November 4, 2026", nextAppointmentTime: "1:30 PM" },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPrintTemplates.mockResolvedValue(templates());
  api.getCheckoutPrintDefaults.mockResolvedValue(DEFAULTS);
  toastMock.info.mockReset();
});
afterEach(() => {
  cleanup();
  // RULING (CO-3b): Print leaves its hidden print frame on the page for the
  // object URL's lifetime; one test's frame must not be found by the next.
  document.querySelectorAll('iframe[data-testid="print-frame"]').forEach((f) => f.remove());
  vi.restoreAllMocks();
});

function renderSettings() {
  return render(
    <WouterRouter hook={memoryLocation({ path: "/admin/print-templates" }).hook}>
      <AdminPrintTemplates />
    </WouterRouter>,
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

describe("Settings → Print templates", () => {
  it("loads both shipped templates; the preview uses the synthetic sample values only", async () => {
    renderSettings();
    const editor = await screen.findByTestId("print-editor-excuse");
    expect(within(editor).getByTestId("print-default-badge")).toBeTruthy();
    expect(screen.getByTestId("print-tab-appointment_card")).toBeTruthy();

    const preview = within(editor).getByTestId("print-preview");
    const text = preview.textContent ?? "";
    const sample = samplePrintValues(defaultPrintTemplate("excuse", PREFILL));
    expect(text).toContain(`${sample.patient_full_name} was seen in our office on ${sample.date_seen} (${sample.time_seen_range})`);
    expect(text).toContain("Synthetic Roland Dental");
    expect(text).toContain(`${sample.provider_name}, Synthetic Roland Dental`);
    // The sample is unmistakably not a patient, and nothing patient-shaped reaches the preview.
    expect(sample.patient_full_name).toBe("Sample Patient");
    expect(sample.provider_name).toBe("Dr. Sample Provider");
    expect(text).not.toMatch(/Stedi|MangoTest|TestValley/);
    expect(api.getCheckoutPrintDefaults).not.toHaveBeenCalled();
  });

  it("the picker inserts a menu placeholder at the cursor, and the preview fills it", async () => {
    renderSettings();
    const body = (await screen.findByTestId("print-field-body")) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Hello  today." } });
    body.focus();
    body.setSelectionRange(6, 6);
    fireEvent.click(screen.getByTestId("print-insert-patient_first_name"));
    await waitFor(() => expect(body.value).toBe("Hello {{patient_first_name}} today."));
    expect(screen.getByTestId("print-preview-body").textContent).toContain("Hello Sample today.");
    // The menu is exactly the ten ruled placeholders.
    expect(within(screen.getByTestId("print-placeholder-menu")).getAllByRole("button")).toHaveLength(PRINT_PLACEHOLDERS.length);
  });

  it("a {{...}} not on the menu is named, and Save is off", async () => {
    renderSettings();
    const body = await screen.findByTestId("print-field-body");
    fireEvent.change(body, { target: { value: "Born {{patient_dob}}." } });
    const problems = await screen.findByTestId("print-problems");
    expect(problems.textContent).toContain("{{patient_dob}}");
    expect(problems.textContent).toContain("is not on the placeholder menu");
    expect((screen.getByTestId("print-save") as HTMLButtonElement).disabled).toBe(true);
    expect(api.savePrintTemplate).not.toHaveBeenCalled();
  });

  it("Save sends the draft and shows the read-back; a server refusal is shown in its words", async () => {
    api.savePrintTemplate.mockImplementation(async (_o: string, type: "excuse", fields: PrintTemplateState["fields"]) =>
      stateOf(type, { stored: true, fields, updatedBy: "om@carein.ai", updatedAt: "2026-11-02T15:00:00.000Z" }),
    );
    renderSettings();
    const heading = await screen.findByTestId("print-field-heading");
    fireEvent.change(heading, { target: { value: "Attendance note" } });
    fireEvent.click(screen.getByTestId("print-save"));
    await screen.findByTestId("print-saved");
    expect(api.savePrintTemplate).toHaveBeenCalledWith("roland", "excuse", { ...defaultPrintTemplate("excuse", PREFILL), heading: "Attendance note" });
    expect(screen.getByText(/Edited by om@carein.ai/)).toBeTruthy();

    api.savePrintTemplate.mockRejectedValueOnce(new TcApiError("The template could not be read back as saved.", 500, "SAVE_NOT_CONFIRMED", null, []));
    // Settle the read-back before the second edit: the editor takes the server's
    // wording when the saved wording changes, which can overwrite an edit made
    // too early and leave Save disabled, so the click would send nothing.
    await waitFor(() => expect((screen.getByTestId("print-field-heading") as HTMLInputElement).value).toBe("Attendance note"));
    fireEvent.change(screen.getByTestId("print-field-heading"), { target: { value: "Attendance note 2" } });
    await waitFor(() => expect((screen.getByTestId("print-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("print-save"));
    await waitFor(() => expect(api.savePrintTemplate).toHaveBeenCalledTimes(2));
    const refusal = await screen.findByTestId("print-save-error");
    expect(refusal.textContent).toBe("The template could not be read back as saved.");
  });

  it("without logo storage: the page says so, and the upload is off", async () => {
    renderSettings();
    expect((await screen.findByTestId("print-logo-unavailable")).textContent).toContain("Logo storage is not set up for this environment");
    expect((screen.getByTestId("print-logo-input") as HTMLInputElement).disabled).toBe(true);
  });

  it("REVIEW: a logo upload keeps unsaved wording; the caret lands after an inserted placeholder", async () => {
    api.getPrintTemplates.mockResolvedValue(templates({ logoStorageConfigured: true }));
    api.uploadPrintLogo.mockResolvedValue(
      stateOf("excuse", { stored: true, logo: { present: true, contentType: "image/png" }, updatedAt: "2026-11-02T15:00:00.000Z" }),
    );
    api.fetchPrintLogoUrl.mockResolvedValue("blob:logo");
    renderSettings();
    const body = (await screen.findByTestId("print-field-body")) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Hello  today." } });
    body.focus();
    body.setSelectionRange(6, 6);
    fireEvent.click(screen.getByTestId("print-insert-date_seen"));
    await waitFor(() => expect(body.value).toBe("Hello {{date_seen}} today."));
    await waitFor(() => expect(body.selectionStart).toBe(6 + "{{date_seen}}".length));

    fireEvent.change(screen.getByTestId("print-logo-input"), {
      target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(api.uploadPrintLogo).toHaveBeenCalled());
    await screen.findByTestId("print-preview-logo");
    expect(body.value).toBe("Hello {{date_seen}} today.");
  });

  it("with storage, an upload the server refuses shows its words", async () => {
    api.getPrintTemplates.mockResolvedValue(templates({ logoStorageConfigured: true }));
    api.uploadPrintLogo.mockRejectedValue(new TcApiError("A logo must be a PNG or JPEG image.", 415, "LOGO_TYPE_NOT_ALLOWED", null, []));
    renderSettings();
    const input = (await screen.findByTestId("print-logo-input")) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], "logo.gif", { type: "image/gif" })] } });
    expect((await screen.findByTestId("print-logo-error")).textContent).toContain("PNG or JPEG");
  });
});

// ── The workup ──────────────────────────────────────────────────────────────

describe("Print from the checkout workup", () => {
  const HANDOFF = "5d2a7e10-0000-4000-8000-0000000003c3";

  it("one button per template; the dialog shows the card's own facts read-only and the editable three pre-filled", async () => {
    render(<CheckoutPrint office="roland" handoffId={HANDOFF} />);
    expect(screen.getByTestId("print-open-excuse").textContent).toContain("School / work excuse");
    fireEvent.click(screen.getByTestId("print-open-appointment_card"));
    const fixed = await screen.findByTestId("print-fixed");
    expect(fixed.textContent).toContain("Stedi Test 2");
    expect(fixed.textContent).toContain("October 30, 2026");
    expect(fixed.textContent).toContain("DOC1");
    expect(within(fixed).queryAllByRole("textbox")).toHaveLength(0);
    expect((screen.getByTestId("print-value-nextAppointmentDate") as HTMLInputElement).value).toBe("Wednesday, November 4, 2026");
    expect((screen.getByTestId("print-value-nextAppointmentTime") as HTMLInputElement).value).toBe("1:30 PM");
    expect(api.getCheckoutPrintDefaults).toHaveBeenCalledWith("roland", HANDOFF);
  });

  // RULING (CO-3b): Print opens the browser's print dialog directly on the PDF
  // (a hidden frame), instead of opening the PDF in a new tab.
  it("Print sends exactly the template and the three values, and opens the print dialog on the PDF", async () => {
    api.printCheckout.mockResolvedValue({ url: "blob:printout", logo: "none" });
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    render(<CheckoutPrint office="roland" handoffId={HANDOFF} />);
    fireEvent.click(screen.getByTestId("print-open-excuse"));
    const time = await screen.findByTestId("print-value-timeSeenRange");
    fireEvent.change(time, { target: { value: "9:00 AM - 10:15 AM" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("print-generate"));
    });
    expect(api.printCheckout).toHaveBeenCalledWith("roland", HANDOFF, {
      templateType: "excuse",
      timeSeenRange: "9:00 AM - 10:15 AM",
      nextAppointmentDate: "Wednesday, November 4, 2026",
      nextAppointmentTime: "1:30 PM",
    });
    const frame = (await waitFor(() => {
      const f = document.querySelector('iframe[data-testid="print-frame"]');
      expect(f).not.toBeNull();
      return f;
    })) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("blob:printout");
    const print = vi.spyOn(frame.contentWindow as Window, "print").mockImplementation(() => undefined);
    fireEvent.load(frame);
    expect(print).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("print-dialog")).toBeNull());
    expect(api.printCheckout).toHaveBeenCalledTimes(1);
  });

  // RULING (CO-3b): the fallback is no longer a blocked tab but a frame the
  // browser will not print from; the link to the PDF is still offered.
  it("a browser that will not print from the frame leaves a link; a logo that could not load is said", async () => {
    api.printCheckout.mockResolvedValue({ url: "blob:printout", logo: "omitted" });
    render(<CheckoutPrint office="roland" handoffId={HANDOFF} />);
    fireEvent.click(screen.getByTestId("print-open-excuse"));
    await screen.findByTestId("print-fixed");
    await act(async () => {
      fireEvent.click(screen.getByTestId("print-generate"));
    });
    const frame = (await waitFor(() => {
      const f = document.querySelector('iframe[data-testid="print-frame"]');
      expect(f).not.toBeNull();
      return f;
    })) as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow as Window, "print").mockImplementation(() => {
      throw new Error("printing is blocked here");
    });
    fireEvent.load(frame);
    expect((await screen.findByTestId("print-opened")).querySelector("a")?.getAttribute("href")).toBe("blob:printout");
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining("without the logo"));
  });

  it("Download PDF is the secondary action: the same request, saved as a file, no print dialog", async () => {
    api.printCheckout.mockResolvedValue({ url: "blob:printout", logo: "none" });
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    render(<CheckoutPrint office="roland" handoffId={HANDOFF} />);
    fireEvent.click(screen.getByTestId("print-open-appointment_card"));
    await screen.findByTestId("print-fixed");
    await act(async () => {
      fireEvent.click(screen.getByTestId("print-download"));
    });
    expect(api.printCheckout).toHaveBeenCalledWith("roland", HANDOFF, {
      templateType: "appointment_card",
      timeSeenRange: "9:00 AM",
      nextAppointmentDate: "Wednesday, November 4, 2026",
      nextAppointmentTime: "1:30 PM",
    });
    expect(clicks).toEqual([{ href: "blob:printout", download: "appointment_card.pdf" }]);
    expect(document.querySelector('iframe[data-testid="print-frame"]')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("print-dialog")).toBeNull());
  });

  it("when the server refuses (the print could not be audited), the reason shows and nothing opens", async () => {
    api.printCheckout.mockRejectedValue(
      new TcApiError("The print could not be recorded in the audit trail, so nothing was printed.", 500, "PRINT_AUDIT_FAILED", null, []),
    );
    const open = vi.spyOn(window, "open");
    render(<CheckoutPrint office="roland" handoffId={HANDOFF} />);
    fireEvent.click(screen.getByTestId("print-open-excuse"));
    await screen.findByTestId("print-fixed");
    await act(async () => {
      fireEvent.click(screen.getByTestId("print-generate"));
    });
    expect((await screen.findByTestId("print-error")).textContent).toContain("nothing was printed");
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[data-testid="print-frame"]')).toBeNull();
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-3 screenshot dumps", () => {
  it("co3-01 — the excuse editor and its live preview", async () => {
    renderSettings();
    await screen.findByTestId("print-preview");
    dump("tccheckout-co3-01-excuse-editor@1280x1500");
  });

  it("co3-02 — the appointment card, and an unknown placeholder named", async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId("print-tab-appointment_card"));
    const body = await screen.findByTestId("print-field-body");
    fireEvent.change(body, { target: { value: `${(body as HTMLTextAreaElement).value}\nYour balance: {{balance_due}}` } });
    await screen.findByTestId("print-problems");
    dump("tccheckout-co3-02-card-editor-refusal@1280x1500");
  });

  it("co3-03 — the print dialog from the workup", async () => {
    render(
      <div className="p-6 max-w-3xl">
        <CheckoutPrint office="roland" handoffId="5d2a7e10-0000-4000-8000-0000000003c3" />
      </div>,
    );
    fireEvent.click(screen.getByTestId("print-open-excuse"));
    await screen.findByTestId("print-fixed");
    dump("tccheckout-co3-03-print-dialog@1280x900");
  });
});
