/**
 * Setup polish — an honest logo error on Admin → Print templates.
 *
 * The REAL upload client runs (printApi.uploadPrintLogo → tcUpload) over a
 * stubbed fetch, so the server's JSON refusal travels the whole way to the
 * screen:
 *
 *   1  PRINT_LOGO_STORAGE_UNAVAILABLE: the server's sentence is shown verbatim
 *      ("Logo storage is not set up for this environment. …"), never the
 *      generic "Could not save the print template"
 *   2  generally, whatever sentence the server sends is what the page shows
 *   3  a refusal with no sentence (not JSON) still says something, never blank
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { defaultPrintTemplate, type PrintTemplateState, type PrintTemplatesResponse } from "@shared/tc/printTemplates";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
URL.revokeObjectURL ??= () => undefined;

const listMock = vi.hoisted(() => ({ getPrintTemplates: vi.fn() }));
// Everything real except the page's initial list read.
vi.mock("@/features/tc/print/printApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tc/print/printApi")>();
  return { ...actual, getPrintTemplates: listMock.getPrintTemplates };
});
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({
    office: "roland",
    offices: [{ officeId: "roland", officeName: "Roland" }],
    loading: false,
    error: null,
  }),
}));

import AdminPrintTemplates from "@/pages/AdminPrintTemplates";

const PREFILL = { name: "Synthetic Roland Dental", address: "1 Example Way\nRoland, OK", phone: "(555) 010-0001" };

function stateOf(type: "excuse" | "appointment_card"): PrintTemplateState {
  return {
    type,
    label: type === "excuse" ? "School / work excuse" : "Appointment card",
    stored: false,
    fields: defaultPrintTemplate(type, PREFILL),
    logo: { present: false, contentType: null },
    updatedBy: null,
    updatedAt: null,
  };
}

const LIST: PrintTemplatesResponse = {
  success: true,
  office: "roland",
  prefill: PREFILL,
  templates: [stateOf("excuse"), stateOf("appointment_card")],
  logoStorageConfigured: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: string, status: number, type = "application/json") {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(body, { status, headers: { "Content-Type": type } })));
}

beforeEach(() => {
  listMock.getPrintTemplates.mockResolvedValue(LIST);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function upload() {
  render(
    <WouterRouter hook={memoryLocation({ path: "/admin/print-templates" }).hook}>
      <AdminPrintTemplates />
    </WouterRouter>,
  );
  const input = (await screen.findByTestId("print-logo-input")) as HTMLInputElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" })] } });
  return screen.findByTestId("print-logo-error");
}

describe("an honest logo error", () => {
  it("1: storage not set up → the server's sentence, verbatim — not the generic one", async () => {
    const sentence = "Logo storage is not set up for this environment. Nothing was saved; the template prints without a logo.";
    respond(JSON.stringify({ success: false, error: sentence, code: "PRINT_LOGO_STORAGE_UNAVAILABLE" }), 503);
    const err = await upload();
    expect(err.textContent).toBe(sentence);
    expect(err.textContent).not.toContain("Could not save the print template");
    // It went to the logo endpoint, for this office.
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname.endsWith("/excuse/logo")).toBe(true);
    expect(url.searchParams.get("office")).toBe("roland");
  });

  it("2: any other refusal shows the server's own sentence", async () => {
    respond(JSON.stringify({ success: false, error: "A logo must be 2 MB or smaller.", code: "LOGO_TOO_LARGE" }), 413);
    expect((await upload()).textContent).toBe("A logo must be 2 MB or smaller.");
  });

  it("3: a refusal with no sentence (not JSON) still says something", async () => {
    respond("<html>Bad gateway</html>", 502, "text/html");
    expect((await upload()).textContent).toBe("HTTP 502");
  });
});
