/**
 * The live preview of a print template (CO-3, CO-3b).
 *
 * CO-3b: the preview is a DRAWING OF THE PDF'S OWN GEOMETRY. The shared layout
 * engine (`layoutPrintDocument`) turns the composed printout and its styling
 * into positioned operations in PDF points; the server's PDF writer serialises
 * those operations and this component draws the same ones as an SVG page
 * (612 × 792 pt, y flipped). Every coordinate here is the printout's
 * coordinate — the preview cannot drift from the PDF, because neither of them
 * decides where anything goes.
 *
 * Pure rendering — whatever values it is handed. Settings hands it
 * `samplePrintValues`, which are clearly synthetic; it is never handed a
 * patient.
 */
import { useMemo } from "react";

import {
  PRINT_FONT_FACES,
  PRINT_PAGE,
  PRINT_STYLING_DEFAULTS,
  layoutPrintDocument,
  type PrintFontFace,
  type PrintOp,
  type PrintStyling,
} from "@shared/tc/printStyling";
import type { PrintDocument } from "@shared/tc/printTemplates";

/** The logo as the preview has it: its URL and, once loaded, its pixel size. */
export interface PreviewLogo {
  url: string;
  width: number;
  height: number;
}

const H = PRINT_PAGE.height;

/** The frame's grey, as the PDF draws it (0.55 G). */
const FRAME_GREY = "#8c8c8c";

type DrawnOp = Extract<PrintOp, { kind: "text" | "rule" }>;

function textStyle(face: PrintFontFace) {
  const f = PRINT_FONT_FACES[face];
  // No kerning or ligatures: the PDF draws each glyph at its plain advance,
  // which is what the layout engine measured.
  return { fontFamily: f.cssFamily, fontWeight: f.cssWeight, fontKerning: "none", fontVariantLigatures: "none" } as const;
}

function Page({
  ops,
  index,
  faces,
  logoUrl,
}: {
  ops: PrintOp[];
  index: number;
  faces: { body: PrintFontFace; heading: PrintFontFace };
  logoUrl: string | null;
}) {
  const first = index === 0;
  const byRole = (role: string) => ops.filter((op): op is DrawnOp => (op.kind === "text" || op.kind === "rule") && op.role === role);
  const draw = (op: DrawnOp, i: number) =>
    op.kind === "text" ? (
      <text
        key={i}
        x={op.x}
        y={H - op.y}
        fontSize={op.size}
        fill={op.color ?? "#000000"}
        style={textStyle(op.slot === "heading" ? faces.heading : faces.body)}
        xmlSpace="preserve"
        data-op="text"
      >
        {op.text}
      </text>
    ) : (
      <line key={i} x1={op.x1} y1={H - op.y} x2={op.x2} y2={H - op.y} stroke={op.color ?? "#000000"} strokeWidth={0.6} data-op="rule" />
    );
  // A newline between rows keeps the group's textContent readable (whitespace
  // between SVG elements is never drawn).
  const group = (role: string, testid: string) => (
    <g data-testid={first ? testid : `${testid}-p${index + 1}`} data-role={role}>
      {byRole(role).flatMap((op, i) => [draw(op, i), "\n"])}
    </g>
  );
  return (
    <svg
      viewBox={`0 0 ${PRINT_PAGE.width} ${PRINT_PAGE.height}`}
      className="block h-auto w-full"
      role="img"
      aria-label={`Preview of page ${index + 1} of the printout`}
      data-testid={`print-preview-page-${index + 1}`}
    >
      <rect x={0} y={0} width={PRINT_PAGE.width} height={PRINT_PAGE.height} fill="#ffffff" />
      {ops.map((op, i) =>
        op.kind === "frame" ? (
          <rect
            key={`f${i}`}
            x={op.x}
            y={H - op.y - op.h}
            width={op.w}
            height={op.h}
            fill="none"
            stroke={FRAME_GREY}
            strokeWidth={0.8}
            data-testid={first ? "print-preview-frame" : undefined}
          />
        ) : op.kind === "image" && logoUrl ? (
          <image
            key={`i${i}`}
            href={logoUrl}
            x={op.x}
            y={H - op.y - op.h}
            width={op.w}
            height={op.h}
            preserveAspectRatio="none"
            data-testid="print-preview-logo"
          />
        ) : null,
      )}
      {group("letterhead", "print-preview-letterhead")}
      {group("heading", "print-preview-heading")}
      {group("body", "print-preview-body")}
      {group("signature", "print-preview-signature")}
    </svg>
  );
}

export function PrintPreview({
  doc,
  styling = PRINT_STYLING_DEFAULTS,
  logo = null,
}: {
  doc: PrintDocument;
  styling?: PrintStyling;
  logo?: PreviewLogo | null;
}) {
  const layout = useMemo(
    () => layoutPrintDocument(doc, styling, logo ? { width: logo.width, height: logo.height } : null),
    [doc, styling, logo],
  );
  return (
    // PAPER, in both themes: this is a picture of the printout, which is white
    // whatever the app's theme (tests/dark-mode-contrast.test.ts).
    <div className="mx-auto w-full max-w-[612px] space-y-3" data-testid="print-preview" data-layout={styling.layout} data-font-pair={styling.fontPair}>
      {layout.pages.map((ops, i) => (
        <div key={i} className="overflow-hidden rounded-md border border-border bg-white shadow-sm dark:bg-white">
          <Page ops={ops} index={i} faces={layout.faces} logoUrl={logo ? logo.url : null} />
        </div>
      ))}
    </div>
  );
}
