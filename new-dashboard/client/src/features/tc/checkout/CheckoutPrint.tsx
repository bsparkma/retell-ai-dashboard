/**
 * Print from the checkout workup (CO-3): the school/work excuse and the
 * appointment card, from the office's templates (Settings → Print templates).
 *
 * The dialog shows what the SERVER will fill: the card's own patient, visit
 * day and provider, and the office — read-only, because the server takes them
 * from the stored record, never from here. Three values are the desk's to set
 * before generating (time seen, next appointment date and time), pre-filled
 * where the card knows them (the schedule appointment's start; the Scheduled
 * anchor).
 *
 * CO-3b — ONE CLICK FROM DIALOG TO PAPER: "Print" generates the PDF, loads it
 * into a hidden frame and opens the browser's own print dialog on it, which is
 * the printer surface (no printer management in the app). "Download PDF" is
 * the secondary action. Each one is its own printout, so each is audited. If
 * the browser will not print from the frame, a link to the PDF is offered.
 *
 * Nothing is stored on the patient and nothing goes to Open Dental. Each
 * printout is recorded in the audit trail, and the server sends no PDF when it
 * cannot record it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, ExternalLink, Loader2, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { tcErrorMessage } from "@/features/tc/api";
import { getCheckoutPrintDefaults, printCheckout } from "@/features/tc/print/printApi";
import {
  PRINT_TEMPLATE_TYPES,
  PRINT_TEMPLATE_TYPE_KEYS,
  type PrintTemplateType,
  type TcCheckoutPrintDefaults,
} from "@shared/tc/printTemplates";
import type { OfficeId } from "@shared/tc/contract";

/** How long a printout's object URL (and its print frame) lives. */
const URL_LIFETIME_MS = 5 * 60 * 1000;
/** How long to wait for the PDF to load into the frame before offering a link. */
const FRAME_LOAD_TIMEOUT_MS = 15 * 1000;

/**
 * Open the browser's print dialog on a PDF: load it into a hidden, same-origin
 * frame (an object URL), then call the frame's print(). Resolves true once the
 * dialog has been asked for, false when the browser would not (the caller then
 * offers a link). The frame is removed when the URL is revoked.
 */
export function printPdfInFrame(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    // One print frame at a time: a new printout replaces the last one's.
    document.querySelectorAll('iframe[data-testid="print-frame"]').forEach((f) => f.remove());
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.dataset.testid = "print-frame";
    // Off-screen rather than display:none — a hidden frame will not print in some browsers.
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(false), FRAME_LOAD_TIMEOUT_MS);
    frame.addEventListener("load", () => {
      try {
        const win = frame.contentWindow;
        if (!win) return done(false);
        win.focus();
        win.print();
        done(true);
      } catch {
        done(false);
      }
    });
    frame.src = url;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), URL_LIFETIME_MS);
  });
}

/** Save the PDF through the browser's download, named for the template. */
function downloadPdf(url: string, type: PrintTemplateType) {
  const a = document.createElement("a");
  a.href = url;
  a.download = `${type}.pdf`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function PrintDialog({
  office,
  handoffId,
  type,
  onClose,
}: {
  office: OfficeId;
  handoffId: string;
  type: PrintTemplateType | null;
  onClose: () => void;
}) {
  const [defaults, setDefaults] = useState<TcCheckoutPrintDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState({ timeSeenRange: "", nextAppointmentDate: "", nextAppointmentTime: "" });
  const [busy, setBusy] = useState<"print" | "download" | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    if (type === null) return undefined;
    let live = true;
    setDefaults(null);
    setError(null);
    setOpened(null);
    getCheckoutPrintDefaults(office, handoffId)
      .then((d) => {
        if (!live) return;
        setDefaults(d);
        setValues(d.editable);
      })
      .catch((e) => live && setError(tcErrorMessage(e)));
    return () => {
      live = false;
    };
  }, [office, handoffId, type]);

  const generate = async (mode: "print" | "download") => {
    if (type === null) return;
    setBusy(mode);
    setError(null);
    setOpened(null);
    try {
      const out = await printCheckout(office, handoffId, { templateType: type, ...values });
      window.setTimeout(() => URL.revokeObjectURL(out.url), URL_LIFETIME_MS);
      if (out.logo === "omitted") toast.info("Printed without the logo: it could not be loaded.");
      if (mode === "download") {
        downloadPdf(out.url, type);
        onClose();
        return;
      }
      if (await printPdfInFrame(out.url)) onClose();
      else setOpened(out.url);
    } catch (e) {
      setError(tcErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const field = (key: keyof typeof values, label: string, placeholder: string) => (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <Input
        value={values[key]}
        maxLength={key === "nextAppointmentTime" ? 40 : 80}
        placeholder={placeholder}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        data-testid={`print-value-${key}`}
      />
    </label>
  );

  return (
    <Dialog open={type !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent data-testid="print-dialog">
        <DialogHeader>
          <DialogTitle>{type ? `Print: ${PRINT_TEMPLATE_TYPES[type].label}` : "Print"}</DialogTitle>
          <DialogDescription>
            Filled from this checkout and the office&apos;s template. Nothing is saved to the patient or to Open Dental;
            the printout is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        {!defaults && !error ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : null}
        {defaults ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="print-fixed">
              <dt className="text-muted-foreground">Patient</dt>
              <dd>{defaults.fixed.patientFullName}</dd>
              <dt className="text-muted-foreground">Seen</dt>
              <dd>{defaults.fixed.dateSeen}</dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd>{defaults.fixed.providerName || "Not recorded"}</dd>
              <dt className="text-muted-foreground">Office</dt>
              <dd>{defaults.fixed.officeName}</dd>
            </dl>
            {field("timeSeenRange", "Time seen", "e.g. 9:00 AM - 10:00 AM")}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field("nextAppointmentDate", "Next appointment date", "e.g. Tuesday, July 7, 2026")}
              {field("nextAppointmentTime", "Next appointment time", "e.g. 9:00 AM")}
            </div>
            <p className="text-xs text-muted-foreground">A value left empty prints as a line to write on.</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="print-error">
            {error}
          </p>
        ) : null}
        {opened ? (
          <p className="text-sm" data-testid="print-opened">
            Your browser would not open its print dialog here.{" "}
            <a href={opened} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
              Open the printout <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            disabled={!defaults || busy !== null}
            onClick={() => void generate("download")}
            className="gap-1.5"
            data-testid="print-download"
          >
            {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download PDF
          </Button>
          <Button disabled={!defaults || busy !== null} onClick={() => void generate("print")} className="gap-1.5" data-testid="print-generate">
            {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The workup's Print section: one button per template type. */
export function CheckoutPrint({ office, handoffId }: { office: OfficeId; handoffId: string }) {
  const [type, setType] = useState<PrintTemplateType | null>(null);
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid="workup-print">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <Printer className="h-4 w-4 text-muted-foreground" /> Print
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">From this office&apos;s templates (Settings → Print templates).</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRINT_TEMPLATE_TYPE_KEYS.map((t) => (
          <Button key={t} size="sm" variant="outline" className="gap-1.5" onClick={() => setType(t)} data-testid={`print-open-${t}`}>
            <Printer className="h-3.5 w-3.5" /> {PRINT_TEMPLATE_TYPES[t].label}
          </Button>
        ))}
      </div>
      <PrintDialog office={office} handoffId={handoffId} type={type} onClose={() => setType(null)} />
    </section>
  );
}
