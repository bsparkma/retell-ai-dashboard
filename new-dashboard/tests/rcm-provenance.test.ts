/**
 * The provenance wording — "read from the text layer" vs "read by OCR".
 *
 * Three screens ask the same question (the remittance detail, the claim detail
 * and the upload panel), so the wording is one function and this is where its
 * edges are pinned. The edges are all the same shape: WE DO NOT KNOW must never
 * render as an assertion.
 */
import { describe, it, expect } from "vitest";
import { provenanceLabel, provenanceNote, isBlockingReason, REVIEW_LABELS } from "../client/src/features/rcm/labels";

describe("document provenance, in words", () => {
  it("names the text layer plainly", () => {
    expect(
      provenanceLabel({ textSource: "text_layer", ocrPageCount: null, ocrMeanConfidence: null }),
    ).toBe("Read from the PDF text layer");
    // No editorial on the ordinary case — explaining it at length would make
    // the normal path look like it needed defending.
    expect(provenanceNote({ textSource: "text_layer" })).toBeNull();
  });

  it("gives the OCR page count and confidence, because that is what decides scrutiny", () => {
    expect(
      provenanceLabel({ textSource: "ocr", ocrPageCount: 3, ocrMeanConfidence: 0.9409 }),
    ).toBe("Read by OCR (3 pages, 94% confidence)");
    expect(provenanceLabel({ textSource: "ocr", ocrPageCount: 1, ocrMeanConfidence: 0.99 })).toBe(
      "Read by OCR (1 page, 99% confidence)",
    );
    expect(provenanceNote({ textSource: "ocr" })).toMatch(/page image/);
  });

  it("says 'not reported' rather than badging a confidence nobody measured", () => {
    // 100% on a document nothing measured is worse than an admission, and it is
    // the exact shape of the honest-states failure the module forbids.
    expect(provenanceLabel({ textSource: "ocr", ocrPageCount: 2, ocrMeanConfidence: null })).toBe(
      "Read by OCR (2 pages, confidence not reported)",
    );
  });

  it("renders NOTHING when the provenance is unknown", () => {
    // An 835 (parsed, never read), an upload still waiting, and anything
    // extracted before the OCR slice. The caller shows no chip at all — filling
    // the gap with "text layer" would assert something nobody recorded.
    expect(provenanceLabel(null)).toBeNull();
    expect(
      provenanceLabel({ textSource: null, ocrPageCount: null, ocrMeanConfidence: null }),
    ).toBeNull();
    expect(provenanceNote(null)).toBeNull();
    expect(provenanceNote({ textSource: null })).toBeNull();
  });

  it("survives a missing page count without printing a broken sentence", () => {
    expect(provenanceLabel({ textSource: "ocr", ocrPageCount: null, ocrMeanConfidence: 0.9 })).toBe(
      "Read by OCR (90% confidence)",
    );
  });
});

describe("ocr_low_confidence is annotating, and says what to DO", () => {
  it("is grey, not amber — it widens review without withholding the claim", () => {
    // D-11: it is a fact about how confidently the document was READ, not a
    // claim that any stored amount is wrong. The arithmetic checks that would
    // catch a misreading which actually moved a number are all blocking.
    expect(isBlockingReason("ocr_low_confidence")).toBe(false);
  });

  it("tells the biller the action, not what the reader noticed", () => {
    const text = REVIEW_LABELS.ocr_low_confidence;
    expect(text).toBeTruthy();
    expect(text).toMatch(/check the amounts/i);
    // No raw slug, and no jargon a biller would have to look up.
    expect(text).not.toMatch(/ocr_low_confidence|confidence floor|mean confidence/i);
  });
});
