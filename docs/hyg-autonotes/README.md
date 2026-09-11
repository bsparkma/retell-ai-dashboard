# The practice's Open Dental auto notes, vendored

`autonotes.json` is Beau's export of Valley/Roland's Open Dental **AutoNotes** and
**AutoNoteControls** — the SOAP templates and pick-lists the hygienists document with today.
It is READ-ONLY reference data. Nothing at runtime reads it.

## Why it is in the repo

`new-dashboard/shared/hyg/noteTemplates.ts` re-states five of these templates as code, so the
note CareIN composes reads like the note the hygienist would otherwise have typed. A
re-statement can drift from its source silently, so the source is committed beside it and
`backend/services/hyg/autonoteParity.test.js` reads THIS FILE and fails the build when the
two disagree about a template's existence, a control's name, or a control's options.

## What is modelled, and what is deliberately not

Modelled (the hygienist's own visit notes):

| AutoNoteName | Visit type |
| --- | --- |
| `Adult Prophy NP` | `adult_prophy_np` |
| `Adult Prophy Recall ` | `adult_prophy_recall` |
| `Child Prophy NP` | `child_prophy_np` |
| `Child Prophy Recall` | `child_prophy_recall` |
| `Perio Maint` | `perio_maint` |

(The trailing space in `Adult Prophy Recall ` is in the practice's own data. The parity test
matches on the trimmed name so a tidy-up in Open Dental cannot turn into a red build.)

NOT modelled, on purpose:

- `SRP Upper` / `SRP Lower`, `FMD/4346`, `LAPT CO2 laser`, `T&A Laser` — these carry
  anesthetic, carps and quadrant detail, which is its own slice.
- Every doctor-exam template (`Comp Exam …`, `Periodic Exam`, `New Comp Exam`,
  `Limited Exam`, `New Limited Exam Note`, `Comp/Lim Exam`) — those are the doctor's note,
  not the hygienist's.
- `T&A …` — a second practice's variants of the same notes.
- `Fluoride Foam` / `Fluoride Varnish` — procedure notes, not visit notes.
- `LW Signature` / `Raegan McGee ` — these ARE signature blocks, and they are where
  `backend/config/hygStaff.js` gets its names and licence numbers. They are staff, not
  patients.

## PHI

There is none here, and there must never be. These are templates and pick-lists; the only
personal names in the file are the practice's own clinicians.
