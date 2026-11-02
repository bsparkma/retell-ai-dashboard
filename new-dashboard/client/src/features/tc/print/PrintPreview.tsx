/**
 * The live preview of a print template (CO-3): the SAME `composePrintDocument`
 * the server's PDF is drawn from, laid out as a letter page. Pure rendering —
 * whatever values it is handed. Settings hands it `samplePrintValues`, which
 * are clearly synthetic; it is never handed a patient.
 */
import type { PrintDocument } from "@shared/tc/printTemplates";

export function PrintPreview({ doc, logoUrl }: { doc: PrintDocument; logoUrl?: string | null }) {
  return (
    // PAPER, in both themes: this is a picture of the printout, which is white
    // whatever the app's theme. The text colour is fixed dark with it, so the
    // two can never invert into white-on-white (tests/dark-mode-contrast.test.ts).
    <div
      className="mx-auto w-full max-w-[612px] aspect-[8.5/11] overflow-hidden rounded-md border border-border bg-white dark:bg-white p-10 text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-900 shadow-sm"
      data-testid="print-preview"
    >
      <div className="flex items-start gap-4 border-b border-neutral-300 pb-3">
        {logoUrl ? <img src={logoUrl} alt="Logo" className="max-h-16 max-w-16 object-contain" data-testid="print-preview-logo" /> : null}
        <div className="min-w-0">
          {doc.letterhead.name ? <div className="text-base font-bold">{doc.letterhead.name}</div> : null}
          {doc.letterhead.addressLines.map((l, i) => (
            <div key={i} className="text-xs text-neutral-700">
              {l}
            </div>
          ))}
          {doc.letterhead.phone ? <div className="text-xs text-neutral-700">{doc.letterhead.phone}</div> : null}
        </div>
      </div>
      {doc.heading ? (
        <h2 className="mt-6 text-lg font-bold" data-testid="print-preview-heading">
          {doc.heading}
        </h2>
      ) : null}
      <div className="mt-4 space-y-3" data-testid="print-preview-body">
        {doc.paragraphs.map((lines, i) => (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {l}
              </span>
            ))}
          </p>
        ))}
      </div>
      {doc.signatureLine ? (
        <div className="mt-10 w-64" data-testid="print-preview-signature">
          <div className="border-t border-neutral-800" />
          <div className="mt-1 text-xs">{doc.signatureLine}</div>
        </div>
      ) : null}
    </div>
  );
}
