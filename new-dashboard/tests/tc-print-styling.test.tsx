/**
 * CO-3b — print template styling, in jsdom. Beau's ruling 2026-11-02: curated
 * options only, no free-form designer.
 *
 *  - the closed schema: an unknown key, a bad hex, a too-light accent, a
 *    missing key and an option not on the list are each refused BY NAME; the
 *    luminance floor sits exactly at 4.5 : 1 against white
 *  - the layout engine's GEOMETRY for every layout, font pair, logo placement
 *    and logo size: alignment, logo box and position, the compact card's frame,
 *    the accent confined to the letterhead and its rule, body text black and
 *    left-aligned, and a layout moving words but never changing them
 *  - the preview draws EXACTLY the engine's operations (coordinates, sizes,
 *    colours, faces) — the PDF writer serialises the same operations, which the
 *    backend tests pin from the other side
 *  - Settings: the style controls drive the preview; a too-light colour is
 *    named and Save is off; a style save sends exactly the styling; "standard"
 *    is sent as null
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co3b-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names only.
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  ACCENT_MIN_CONTRAST,
  PRINT_FONT_FACES,
  PRINT_FONT_PAIRS,
  PRINT_LAYOUTS,
  PRINT_LOGO_PLACEMENTS,
  PRINT_LOGO_SIZES,
  PRINT_PAGE,
  PRINT_STYLING_DEFAULTS,
  contrastOnWhite,
  effectivePrintStyling,
  layoutPrintDocument,
  textWidth,
  validatePrintStyling,
  type PrintFontPair,
  type PrintLayout,
  type PrintLogoPlacement,
  type PrintLogoSize,
  type PrintOp,
  type PrintStyling,
} from "@shared/tc/printStyling";
import {
  composePrintDocument,
  defaultPrintTemplate,
  samplePrintValues,
  type PrintTemplateState,
  type PrintTemplatesResponse,
} from "@shared/tc/printTemplates";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
URL.revokeObjectURL ??= () => undefined;

const { api } = vi.hoisted(() => ({
  api: {
    getPrintTemplates: vi.fn(),
    savePrintTemplate: vi.fn(),
    savePrintStyling: vi.fn(),
    uploadPrintLogo: vi.fn(),
    removePrintLogo: vi.fn(),
    fetchPrintLogoUrl: vi.fn(),
    fetchPrintFontUrl: vi.fn(),
    getCheckoutPrintDefaults: vi.fn(),
    printCheckout: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("@/features/tc/print/printApi", () => api);
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
import { PrintPreview } from "@/features/tc/print/PrintPreview";
import { TcApiError } from "@/features/tc/api";

const PREFILL = { name: "Synthetic Roland Dental", address: "1 Example Way\nRoland, OK 74954", phone: "(555) 010-0001" };
const { width: W, height: H, margin: M } = PRINT_PAGE;
const L = M;
const R = W - M;
const CENTER = W / 2;
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

function sampleDoc(type: "excuse" | "appointment_card" = "excuse") {
  const t = defaultPrintTemplate(type, PREFILL);
  return composePrintDocument(t, samplePrintValues(t));
}
const style = (over: Partial<PrintStyling> = {}): PrintStyling => ({ ...PRINT_STYLING_DEFAULTS, ...over });
const texts = (ops: PrintOp[], role?: string) =>
  ops.filter((o): o is Extract<PrintOp, { kind: "text" }> => o.kind === "text" && (!role || o.role === role));
const all = <T,>(pages: T[][]) => pages.flat();

const LAYOUTS = Object.keys(PRINT_LAYOUTS) as PrintLayout[];
const PAIRS = Object.keys(PRINT_FONT_PAIRS) as PrintFontPair[];
const PLACEMENTS = Object.keys(PRINT_LOGO_PLACEMENTS) as PrintLogoPlacement[];
const SIZES = Object.keys(PRINT_LOGO_SIZES) as PrintLogoSize[];

// ── the closed schema ───────────────────────────────────────────────────────

describe("styling schema: refused by name", () => {
  it("an unknown key is refused, never dropped", () => {
    const v = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, bodyColor: "#ff0000" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.map((p) => [p.code, p.field])).toContainEqual(["PRINT_STYLE_UNKNOWN_KEY", "bodyColor"]);
  });

  it("an accent that is not #rrggbb is refused", () => {
    for (const bad of ["red", "#fff", "#12345g", "1f4e79", "#1f4e790", 7]) {
      const v = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, accentColor: bad });
      expect(v.ok, String(bad)).toBe(false);
      if (!v.ok) expect(v.problems[0].code).toBe("PRINT_STYLE_INVALID_COLOR");
    }
  });

  it(`a too-light accent is refused below ${ACCENT_MIN_CONTRAST} : 1 against white — and the floor is exactly there`, () => {
    for (const light of ["#ffffff", "#ffff00", "#87ceeb", "#777777"]) {
      const v = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, accentColor: light });
      expect(v.ok, light).toBe(false);
      if (!v.ok) {
        expect(v.problems[0].code).toBe("PRINT_STYLE_ACCENT_TOO_LIGHT");
        expect(v.problems[0].message).toContain("too light to read");
      }
    }
    expect(contrastOnWhite("#777777")).toBeLessThan(4.5);
    expect(contrastOnWhite("#767676")).toBeGreaterThanOrEqual(4.5);
    for (const ok of ["#767676", "#000000", "#1f4e79", "#8b0000", "#0b6e4f"]) {
      expect(validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, accentColor: ok }).ok, ok).toBe(true);
    }
  });

  it("a missing key, an option not on the list, and a non-object are each named", () => {
    const { layout: _drop, ...missing } = PRINT_STYLING_DEFAULTS;
    const a = validatePrintStyling(missing);
    expect(!a.ok && a.problems[0].code).toBe("PRINT_STYLE_MISSING_KEY");
    const b = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, fontPair: "comic_sans" });
    expect(!b.ok && b.problems[0].code).toBe("PRINT_STYLE_UNKNOWN_OPTION");
    const c = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, layout: "freeform" });
    expect(!c.ok && c.problems[0].code).toBe("PRINT_STYLE_UNKNOWN_OPTION");
    for (const x of [null, "classic", [], 3]) {
      const v = validatePrintStyling(x);
      expect(!v.ok && v.problems[0].code).toBe("PRINT_STYLE_NOT_AN_OBJECT");
    }
  });

  it("a valid accent is stored lower-case; null and anything unreadable print as the defaults", () => {
    const v = validatePrintStyling({ ...PRINT_STYLING_DEFAULTS, accentColor: "#1F4E79" });
    expect(v.ok && v.styling.accentColor).toBe("#1f4e79");
    expect(effectivePrintStyling(null)).toEqual(PRINT_STYLING_DEFAULTS);
    expect(effectivePrintStyling({ fontPair: "retired" })).toEqual(PRINT_STYLING_DEFAULTS);
  });
});

// ── the layout engine's geometry ────────────────────────────────────────────

describe("layout geometry: every layout, font pair, logo placement and size", () => {
  const LOGO = { width: 300, height: 100 };

  it.each(LAYOUTS)("%s: the logo is where it is placed, at the size chosen — and absent without one", (layout) => {
    for (const logoPlacement of PLACEMENTS) {
      for (const logoSize of SIZES) {
        const out = layoutPrintDocument(sampleDoc(), style({ layout, logoPlacement, logoSize }), LOGO);
        const img = out.pages[0].find((o): o is Extract<PrintOp, { kind: "image" }> => o.kind === "image");
        expect(img, `${logoPlacement}/${logoSize}`).toBeDefined();
        if (!img) continue;
        const box = PRINT_LOGO_SIZES[logoSize].box;
        expect(near(Math.max(img.w, img.h), box)).toBe(true);
        expect(near(img.w / img.h, LOGO.width / LOGO.height)).toBe(true);
        expect(near(img.y + img.h, H - M)).toBe(true);
        if (logoPlacement === "left") expect(near(img.x, L)).toBe(true);
        if (logoPlacement === "right") expect(near(img.x + img.w, R)).toBe(true);
        if (logoPlacement === "center") expect(near(img.x + img.w / 2, CENTER)).toBe(true);
        // The letterhead never overlaps the logo.
        for (const t of texts(out.pages[0], "letterhead")) {
          const w = textWidth(t.slot === "heading" ? out.faces.heading : out.faces.body, t.size, t.text);
          const overlapsX = t.x < img.x + img.w && t.x + w > img.x;
          const overlapsY = t.y < img.y + img.h && t.y + t.size > img.y;
          expect(overlapsX && overlapsY, `${layout}/${logoPlacement}/${logoSize}: "${t.text}"`).toBe(false);
        }
      }
      const none = layoutPrintDocument(sampleDoc(), style({ layout, logoPlacement }), null);
      expect(none.pages[0].some((o) => o.kind === "image")).toBe(false);
    }
  });

  it("classic letterhead: everything left-aligned at the margin; the letterhead beside a left logo", () => {
    for (const fontPair of PAIRS) {
      const out = layoutPrintDocument(sampleDoc(), style({ fontPair }), LOGO);
      const img = out.pages[0].find((o) => o.kind === "image") as Extract<PrintOp, { kind: "image" }>;
      for (const t of texts(out.pages[0], "letterhead")) expect(near(t.x, img.x + img.w + 14), fontPair).toBe(true);
      for (const t of texts(out.pages[0], "heading")) expect(t.x).toBe(L);
      for (const t of texts(out.pages[0], "signature")) expect(t.x).toBe(L);
    }
  });

  it("centered formal: letterhead, heading and signature centered on the page", () => {
    for (const fontPair of PAIRS) {
      for (const logo of [null, LOGO]) {
        const out = layoutPrintDocument(sampleDoc(), style({ fontPair, layout: "centered_formal", logoPlacement: "left" }), logo);
        const faceOf = (t: Extract<PrintOp, { kind: "text" }>) => (t.slot === "heading" ? out.faces.heading : out.faces.body);
        for (const role of ["letterhead", "heading", "signature"]) {
          for (const t of texts(out.pages[0], role)) {
            expect(near(t.x + textWidth(faceOf(t), t.size, t.text) / 2, CENTER), `${fontPair}/${role}: ${t.text}`).toBe(true);
          }
        }
        const sig = out.pages[0].find((o) => o.kind === "rule" && o.role === "signature") as Extract<PrintOp, { kind: "rule" }>;
        expect(near((sig.x1 + sig.x2) / 2, CENTER)).toBe(true);
      }
    }
  });

  it("compact card: a frame on every page, the name left and the contact details right-aligned on one band", () => {
    const longBody = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n");
    const t = { ...defaultPrintTemplate("excuse", PREFILL), body: longBody };
    const doc = composePrintDocument(t, samplePrintValues(t));
    for (const fontPair of PAIRS) {
      const out = layoutPrintDocument(doc, style({ fontPair, layout: "compact_card" }), null);
      expect(out.pages.length).toBeGreaterThan(1);
      for (const page of out.pages) expect(page.filter((o) => o.kind === "frame")).toHaveLength(1);
      const lh = texts(out.pages[0], "letterhead");
      const name = lh.filter((x) => x.slot === "heading");
      const contact = lh.filter((x) => x.slot === "body");
      for (const x of name) expect(x.x).toBe(L);
      for (const x of contact) expect(near(x.x + textWidth(out.faces.body, x.size, x.text), R), `${fontPair}: ${x.text}`).toBe(true);
      // One band: the first name row and the first contact row start at the top together.
      expect(Math.abs(name[0].y - contact[0].y)).toBeLessThan(6);
    }
  });

  it("the accent reaches ONLY the letterhead text and the rule under it; the body is black and left-aligned everywhere", () => {
    for (const layout of LAYOUTS) {
      for (const fontPair of PAIRS) {
        const out = layoutPrintDocument(sampleDoc(), style({ layout, fontPair, accentColor: "#1f4e79" }), LOGO);
        for (const op of all(out.pages)) {
          if (op.kind === "text") {
            expect(op.color, `${layout}/${fontPair}/${op.role}`).toBe(op.role === "letterhead" ? "#1f4e79" : null);
            if (op.role === "body") expect(op.x).toBe(L);
          }
          if (op.kind === "rule") expect(op.color).toBe(op.role === "letterhead" ? "#1f4e79" : null);
        }
      }
    }
    // Black is the default, and the default carries no colour at all.
    const plain = layoutPrintDocument(sampleDoc(), style(), LOGO);
    expect(all(plain.pages).every((o) => !("color" in o) || o.color === null)).toBe(true);
  });

  it("each font pair draws in its own two faces, and a measured row never runs past the margin", () => {
    for (const fontPair of PAIRS) {
      for (const layout of LAYOUTS) {
        const out = layoutPrintDocument(sampleDoc(), style({ fontPair, layout }), null);
        expect(out.faces).toEqual({ heading: PRINT_FONT_PAIRS[fontPair].heading, body: PRINT_FONT_PAIRS[fontPair].body });
        if (fontPair === "standard" && layout === "classic_letterhead") continue; // CO-3's character wrap, pinned elsewhere
        for (const t of texts(all(out.pages))) {
          const w = textWidth(t.slot === "heading" ? out.faces.heading : out.faces.body, t.size, t.text);
          expect(t.x >= L - 0.01 && t.x + w <= R + 0.01, `${fontPair}/${layout}: "${t.text}"`).toBe(true);
        }
      }
    }
  });

  it("a layout changes WHERE words go, never WHICH words: the same words, in order, for every layout and font", () => {
    const words = (out: ReturnType<typeof layoutPrintDocument>, role: string) =>
      texts(all(out.pages), role).map((t) => t.text).join(" ").split(/\s+/).filter(Boolean);
    for (const type of ["excuse", "appointment_card"] as const) {
      const base = layoutPrintDocument(sampleDoc(type), style(), null);
      for (const layout of LAYOUTS) {
        for (const fontPair of PAIRS) {
          const out = layoutPrintDocument(sampleDoc(type), style({ layout, fontPair }), null);
          for (const role of ["heading", "body", "signature"]) expect(words(out, role), `${type}/${layout}/${fontPair}/${role}`).toEqual(words(base, role));
          expect(new Set(words(out, "letterhead"))).toEqual(new Set(words(base, "letterhead")));
        }
      }
    }
  });
});

// ── the preview draws the engine's operations, exactly ──────────────────────

describe("the preview is the engine's geometry", () => {
  afterEach(cleanup);

  function expectPreviewMatches(s: PrintStyling, logo: { width: number; height: number } | null) {
    const doc = sampleDoc();
    const out = layoutPrintDocument(doc, s, logo);
    const { container } = render(<PrintPreview doc={doc} styling={s} logo={logo ? { url: "blob:logo", ...logo } : null} />);
    const svg = container.querySelector('[data-testid="print-preview-page-1"]') as SVGSVGElement;
    const ops = out.pages[0];
    const n = (el: Element, a: string) => Number(el.getAttribute(a));

    // Text: the same rows, at the same points, in the same size, colour and face.
    const drawn = Array.from(svg.querySelectorAll("text"));
    const expected = texts(ops);
    expect(drawn).toHaveLength(expected.length);
    const byKey = new Map(drawn.map((el) => [`${el.textContent}|${n(el, "x")}|${n(el, "y")}`, el]));
    for (const t of expected) {
      const el = byKey.get(`${t.text}|${t.x}|${H - t.y}`);
      expect(el, `${s.layout}/${s.fontPair}: "${t.text}" at ${t.x},${t.y}`).toBeDefined();
      if (!el) continue;
      expect(n(el, "font-size")).toBe(t.size);
      expect(el.getAttribute("fill")).toBe(t.color ?? "#000000");
      const face = t.slot === "heading" ? out.faces.heading : out.faces.body;
      expect((el as SVGTextElement).style.fontFamily).toBe(PRINT_FONT_FACES[face].cssFamily);
    }
    // Rules, the frame and the logo.
    const lines = Array.from(svg.querySelectorAll("line"));
    const rules = ops.filter((o): o is Extract<PrintOp, { kind: "rule" }> => o.kind === "rule");
    expect(lines.map((l) => [n(l, "x1"), n(l, "x2"), H - n(l, "y1"), l.getAttribute("stroke")])).toEqual(
      expect.arrayContaining(rules.map((r) => [r.x1, r.x2, r.y, r.color ?? "#000000"])),
    );
    const frame = ops.find((o) => o.kind === "frame") as Extract<PrintOp, { kind: "frame" }> | undefined;
    const rect = container.querySelector('[data-testid="print-preview-frame"]');
    if (frame) expect([n(rect!, "x"), H - n(rect!, "y") - n(rect!, "height"), n(rect!, "width"), n(rect!, "height")]).toEqual([frame.x, frame.y, frame.w, frame.h]);
    else expect(rect).toBeNull();
    const img = ops.find((o) => o.kind === "image") as Extract<PrintOp, { kind: "image" }> | undefined;
    const image = container.querySelector('[data-testid="print-preview-logo"]');
    if (img) expect([n(image!, "x"), H - n(image!, "y") - n(image!, "height"), n(image!, "width"), n(image!, "height")]).toEqual([img.x, img.y, img.w, img.h]);
    else expect(image).toBeNull();
    cleanup();
  }

  it("every layout × font pair, with and without a logo", () => {
    for (const layout of LAYOUTS) for (const fontPair of PAIRS) for (const logo of [null, { width: 300, height: 100 }]) {
      expectPreviewMatches(style({ layout, fontPair, accentColor: "#8b0000" }), logo);
    }
  });

  it("every logo placement × size", () => {
    for (const logoPlacement of PLACEMENTS) for (const logoSize of SIZES) {
      expectPreviewMatches(style({ logoPlacement, logoSize }), { width: 100, height: 160 });
    }
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

function stateOf(over: Partial<PrintTemplateState> = {}): PrintTemplateState {
  return {
    type: "excuse",
    label: "School / work excuse",
    stored: false,
    fields: defaultPrintTemplate("excuse", PREFILL),
    logo: { present: false, contentType: null },
    styling: { ...PRINT_STYLING_DEFAULTS },
    styled: false,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}
function templates(): PrintTemplatesResponse {
  return {
    success: true,
    office: "roland",
    prefill: PREFILL,
    templates: [stateOf(), { ...stateOf(), type: "appointment_card", label: "Appointment card", fields: defaultPrintTemplate("appointment_card", PREFILL) }],
    logoStorageConfigured: false,
  };
}
function renderSettings() {
  return render(
    <WouterRouter hook={memoryLocation({ path: "/admin/print-templates" }).hook}>
      <AdminPrintTemplates />
    </WouterRouter>,
  );
}

describe("Settings → Print templates → Style", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.getPrintTemplates.mockResolvedValue(templates());
    api.fetchPrintFontUrl.mockResolvedValue("blob:font");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the controls drive the preview: layout, font pair and accent", async () => {
    renderSettings();
    const preview = await screen.findByTestId("print-preview");
    expect(preview.getAttribute("data-layout")).toBe("classic_letterhead");
    fireEvent.click(screen.getByTestId("print-style-layout-centered_formal"));
    expect(screen.getByTestId("print-preview").getAttribute("data-layout")).toBe("centered_formal");
    fireEvent.change(screen.getByTestId("print-style-fontPair"), { target: { value: "traditional" } });
    const heading = within(screen.getByTestId("print-preview-heading")).getAllByText(/School/)[0] as unknown as SVGTextElement;
    expect(heading.style.fontFamily).toBe(PRINT_FONT_FACES.pt_serif_bold.cssFamily);
    fireEvent.change(screen.getByTestId("print-style-accent"), { target: { value: "#1f4e79" } });
    const name = within(screen.getByTestId("print-preview-letterhead")).getByText("Synthetic Roland Dental");
    expect(name.getAttribute("fill")).toBe("#1f4e79");
    // The body stays black.
    for (const el of Array.from(screen.getByTestId("print-preview-body").querySelectorAll("text"))) expect(el.getAttribute("fill")).toBe("#000000");
    // Without FontFace (jsdom) the preview still draws, and says the font is not shown.
    await screen.findByTestId("print-style-font-unavailable");
  });

  it("a too-light accent is named and Save is off; nothing is sent", async () => {
    renderSettings();
    const hex = await screen.findByTestId("print-style-accent-hex");
    fireEvent.change(hex, { target: { value: "#cccccc" } });
    expect((await screen.findByTestId("print-style-problem")).textContent).toContain("too light to read on white paper");
    expect((screen.getByTestId("print-save") as HTMLButtonElement).disabled).toBe(true);
    // The preview keeps the last colour that was allowed.
    expect(within(screen.getByTestId("print-preview-letterhead")).getByText("Synthetic Roland Dental").getAttribute("fill")).toBe("#000000");
    expect(api.savePrintStyling).not.toHaveBeenCalled();
  });

  it("a style-only change saves the styling alone, exactly; the read-back shows a custom style", async () => {
    const chosen: PrintStyling = { accentColor: "#0b6e4f", fontPair: "book", logoPlacement: "right", logoSize: "small", layout: "compact_card" };
    api.savePrintStyling.mockResolvedValue(stateOf({ stored: true, styling: chosen, styled: true, updatedBy: "om@carein.ai" }));
    renderSettings();
    fireEvent.click(await screen.findByTestId("print-style-layout-compact_card"));
    fireEvent.change(screen.getByTestId("print-style-fontPair"), { target: { value: "book" } });
    fireEvent.change(screen.getByTestId("print-style-accent"), { target: { value: "#0b6e4f" } });
    fireEvent.click(screen.getByTestId("print-style-logoPlacement-right"));
    fireEvent.click(screen.getByTestId("print-style-logoSize-small"));
    fireEvent.click(screen.getByTestId("print-save"));
    await screen.findByTestId("print-saved");
    expect(api.savePrintStyling).toHaveBeenCalledWith("roland", "excuse", chosen);
    expect(api.savePrintTemplate).not.toHaveBeenCalled();
    expect(screen.getByTestId("print-styled-badge")).toBeTruthy();
  });

  it("going back to the standard style sends null — no styling, today's printout", async () => {
    const custom: PrintStyling = { ...PRINT_STYLING_DEFAULTS, layout: "centered_formal" };
    api.getPrintTemplates.mockResolvedValue({ ...templates(), templates: [stateOf({ stored: true, styling: custom, styled: true })] });
    api.savePrintStyling.mockResolvedValue(stateOf({ stored: true }));
    renderSettings();
    fireEvent.click(await screen.findByTestId("print-style-reset"));
    fireEvent.click(screen.getByTestId("print-save"));
    await waitFor(() => expect(api.savePrintStyling).toHaveBeenCalledWith("roland", "excuse", null));
  });

  it("a refusal from the server is shown in its words", async () => {
    api.savePrintStyling.mockRejectedValue(new TcApiError("#cccccc is too light to read on white paper", 400, "PRINT_STYLE_ACCENT_TOO_LIGHT", null, []));
    renderSettings();
    fireEvent.click(await screen.findByTestId("print-style-layout-centered_formal"));
    fireEvent.click(screen.getByTestId("print-save"));
    expect((await screen.findByTestId("print-save-error")).textContent).toContain("too light");
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-3b screenshot dumps", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.getPrintTemplates.mockResolvedValue(templates());
  });
  afterEach(cleanup);
  for (const layout of LAYOUTS) {
    it(`co3b — ${layout}`, async () => {
      renderSettings();
      fireEvent.click(await screen.findByTestId(`print-style-layout-${layout}`));
      fireEvent.change(screen.getByTestId("print-style-accent"), { target: { value: "#1f4e79" } });
      dump(`tccheckout-co3b-${layout}@1280x1700`);
    });
  }
});
