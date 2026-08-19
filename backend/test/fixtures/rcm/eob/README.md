# Synthetic EOB PDF fixtures — RCM OCR

Three PDFs of the same invented EOB, and the script that made them. They exist so the OCR
pre-step (`backend/services/rcm/eobDocumentText.js`) can be tested against a real scanned
page rather than against an assertion that one would behave a certain way.

## No real scan is used here, ever

A real scanned EOB is a photograph of a page carrying a real patient's name, date of birth
and subscriber id. **There is no redaction that survives OCR** — the entire point of these
fixtures is that a machine can read the pixels, so anything visible in the image is
extractable from it. Every fixture below is manufactured end to end from invented content.

The content is the same invented EOB `docs/RCM_EOB_INGESTION.md` uses for its staging walk:
`EXAMPLE DENTAL PLAN`, patient `TESTPATIENT, ALPHA`, subscriber `SUB-0001`, check
`CHK-100200`, two procedures totalling $163.00. The names are deliberately unmistakable as
placeholders — a fixture whose names look plausible is a fixture somebody eventually mistakes
for a leak.

## The corpus

| File | How it was produced | What it exists to prove |
| --- | --- | --- |
| `Test_EOB_TextLayer.pdf` | Hand-assembled PDF text operators (`BT … Tj ET`), Helvetica. | A PDF with a text layer is read from it and **never** calls OCR. 578 characters of text layer. |
| `Test_EOB_Scanned.pdf` | The same lines laid out as monospace HTML, rasterised to JPEG by Chromium at `deviceScaleFactor: 2` (≈150 dpi), quality 85, then wrapped in a one-page PDF as a `/DCTDecode` image XObject. | The escalation, and a clean read. **No text layer** (12 characters, below the 40-char floor). |
| `Test_EOB_Scanned_Degraded.pdf` | Same, but `#b4b4b4` ink on `#f2f2f0` paper, `deviceScaleFactor: 0.7` (≈50 dpi), rotated 0.7° and blurred, JPEG quality 25. | The "we could not read this" path, with an input that is genuinely unreadable. |

## What Azure actually returned

Measured against `docint-carein-staging` (`prebuilt-read`, api-version `2024-11-30`) on
**2026-08-19**. These are the numbers the confidence floors were chosen from, and the numbers
the mocked unit tests use — so the mocks agree with reality rather than with a guess.

| File | Pages | Words | Chars | Mean confidence |
| --- | --- | --- | --- | --- |
| `Test_EOB_TextLayer.pdf` | 1 | 77 | 564 | **0.9926** |
| `Test_EOB_Scanned.pdf` | 1 | 77 | 560 | **0.9909** |
| `Test_EOB_Scanned_Degraded.pdf` | 1 | 1 | 4 | **0.1570** |

The degraded fixture trips **both** refusal conditions in `readByOcr` — under
`MIN_DOCUMENT_CHARS` (40) *and* under `RCM_OCR_UNUSABLE_CONFIDENCE` (0.55) — which is what
makes it a fair input for the rescan-advice path rather than a rigged one.

The text-layer PDF reads fine too, which is exactly why the escalation exists: OCR *would*
work on every upload, and running it on every upload would mean paying $1.50 per thousand
pages for text already present in the file for nothing.

## Regenerating them

```bash
node backend/test/fixtures/rcm/eob/make-eob-fixtures.js
```

Needs Chromium (via the `puppeteer` already in `backend/package.json`). **The tests never run
this** — they read the committed PDFs. A test that generated its own inputs would be testing
the generator, and would need a browser in CI.

The JPEG bytes go into the PDF **verbatim**: PDF's `/DCTDecode` filter *is* the JPEG decoder,
so nothing decodes or re-encodes an image and no image library enters the dependency tree.
That is also what makes these genuine rasterisations — real glyph rendering, real
antialiasing, real JPEG artefacts — rather than a drawing of text.

## Do not edit the PDFs by hand

Like the 835 corpus beside them, they are a fixed set: `eobDocumentText.test.js` asserts
against what `pdf-parse` finds in them, and `documentOcrLive.test.js` asserts against what
Azure reads out of them. Change `EOB_LINES` in the generator and re-run it, or add a new
fixture — never hand-edit an existing file.

See [`docs/RCM_EOB_INGESTION.md` §10](../../../../../docs/RCM_EOB_INGESTION.md) for the OCR
flow these support, and [`../README.md`](../README.md) for the 835 corpus.
