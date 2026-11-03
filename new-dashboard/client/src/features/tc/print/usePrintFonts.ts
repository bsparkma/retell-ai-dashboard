/**
 * CO-3b: make the preview draw with the SAME font files the PDF embeds.
 *
 * Each bundled face is fetched once from the backend (the authenticated
 * /print-templates/fonts route — backend/assets/print-fonts is their only
 * home), registered with the browser's FontFace API under the family name the
 * shared contract gives it, and kept for the rest of the session. Nothing is
 * fetched from a font CDN, and Helvetica (the default pair) needs nothing.
 *
 * Where FontFace does not exist (jsdom), or a fetch fails, the preview still
 * draws — positions come from the layout engine, not from the browser's font —
 * and says the font could not be shown.
 */
import { useEffect, useState } from "react";

import { fetchPrintFontUrl } from "@/features/tc/print/printApi";
import { PRINT_FONT_FACES, PRINT_FONT_PAIRS, type PrintFontFace, type PrintFontPair } from "@shared/tc/printStyling";
import type { OfficeId } from "@shared/tc/contract";

export type PrintFontStatus = "ready" | "loading" | "unavailable";

/** One load per face per session. */
const loads = new Map<PrintFontFace, Promise<boolean>>();

function familyOf(face: PrintFontFace): string {
  return PRINT_FONT_FACES[face].cssFamily.replace(/"/g, "");
}

function loadFace(office: OfficeId, face: PrintFontFace): Promise<boolean> {
  const file = PRINT_FONT_FACES[face].file;
  if (file === null) return Promise.resolve(true);
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return Promise.resolve(false);
  const known = loads.get(face);
  if (known) return known;
  const p = (async () => {
    try {
      const url = await fetchPrintFontUrl(office, file);
      const ff = new FontFace(familyOf(face), `url(${url})`);
      await ff.load();
      document.fonts.add(ff);
      return true;
    } catch {
      loads.delete(face);
      return false;
    }
  })();
  loads.set(face, p);
  return p;
}

/** Load the pair's two faces; answers whether the preview is drawing in them. */
export function usePrintFonts(office: OfficeId, pair: PrintFontPair): PrintFontStatus {
  const [status, setStatus] = useState<PrintFontStatus>("loading");
  useEffect(() => {
    let live = true;
    const faces = [PRINT_FONT_PAIRS[pair].heading, PRINT_FONT_PAIRS[pair].body] as PrintFontFace[];
    if (faces.every((f) => PRINT_FONT_FACES[f].file === null)) {
      setStatus("ready");
      return undefined;
    }
    setStatus("loading");
    void Promise.all(faces.map((f) => loadFace(office, f))).then((ok) => {
      if (live) setStatus(ok.every(Boolean) ? "ready" : "unavailable");
    });
    return () => {
      live = false;
    };
  }, [office, pair]);
  return status;
}
