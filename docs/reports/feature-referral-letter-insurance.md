# Referral letter insurance — NEEDS REVIEW (RED)

**Branch:** `feature/referral-letter-insurance`, cut from `origin/develop` at `1474aec` (includes the merged #265).
**Lane:** RED. It adds Open Dental reads (read only) to the send path and puts more PHI in the specialist letter.
**Pushed for review. Not merged.** No migration, and no shared-contract change, so the bundle is not regenerated.

---

## Decision: two reads, not one batched read

The one-read-per-send pins now expect **two separate audited reads**. Each send makes:

1. **The contact read**, unchanged from #265: one `GET /patients/{PatNum}`, audited as `tc_referral.letter_contact_lookup`. The patient notice still reuses it, so the notice adds no read of its own.
2. **The insurance read**, which is new: `GET /patplans?PatNum`, and then for each plan (primary, secondary):
   - `GET /inssubs/{n}`
   - `GET /insplans/{n}`
   - `GET /carriers/{n}`
   - `GET /patients/{Subscriber}`, only when the subscriber isn't the patient, and only for the name.

   It's audited first, as its own READ, `tc_referral.letter_insurance_lookup`.

**Why two reads:**
- **They fail independently.** If the insurance chain fails, the letter still shows the phone, email and date of birth, and the reverse also holds. A batched read would have to fail both blocks together, or report a partial result as one outcome.
- **Separate audit rows.** Each READ row names what was looked at, so the trail shows a contact lookup and an insurance lookup as two things.
- **One batched GET isn't possible.** The plan, carrier and subscriber records are separate Open Dental resources.

The reads run one after the other (contact, then insurance), so their order is deterministic.

**Existing reader checked first:** `odReads.getInsuranceSnapshot` already walks the same chain. I didn't reuse it because it also reads benefits and pages through every claim the patient has had (for the TC money panel). That's more PHI and more calls than a letter needs. The RCM module has no Open Dental insurance reader; `claimMatch`'s subscriber ID comes from the 835, not from Open Dental.

## Pre-existing test edits, for ratification (7 lines, none is a copy change)

| File : line (develop) | Was | Now | Why |
|---|---|---|---|
| `tcReferralLetterEnrichment.test.js:191` | `doesNotMatch(text, /available from our office on request/)` | `!text.includes(DOB_LINE)` | The brief has the insurance fallback reuse that same phrase. The pin's intent, that the DOB line did not fall back, is kept, and now stated exactly |
| `tcReferralLetterEnrichment.test.js:195` | `odCalls` = `[/patients/12827]` | `[/patients/12827, /patplans]` | The second (insurance) read |
| `tcReferralLetterEnrichment.test.js:248` | `odCalls.length <= 1` | `/patients/*` calls `<= 1` | "Never more than one contact read" still holds. When Open Dental is down, the insurance read is also attempted (and also falls back) |
| `tcReferralLetterEnrichment.test.js:263` | `odCalls.length === 0` after the contact audit fails | `['/patplans']` | Still no contact read when its audit fails. The insurance read has its own trail, so it still runs |
| `tcReferralLinks.test.js:310` (+ its comment at 309) | `[roland /patients/12827]` | `+ [roland /patplans]` | The second read. The notice still reuses the contact read |
| `tcReferralLinks.test.js:385` | `[/patients/12827]` | `+ /patplans` | The same |
| `tcReferralLinks.test.js:540` | `[/patients/12827]` | `+ /patplans` | The same |

In those harnesses `/patplans` answers 404, so the letter shows the honest insurance fallback. No other assertion in them changed. The `G:` guard test passes unedited.

## What the letter says

The section sits after "Patient contact" and before "We are referring…". It appears in the plain text, and in the HTML, which is rendered from the same text. The values below are synthetic:

```
Insurance on file:
Primary insurance:
Carrier: Example Dental Mutual
Plan/group name: ACME WIDGETS PPO
Group number: GRP-40417
Subscriber ID: XQZ7781234
Secondary insurance:
Carrier: Sample Benefit Co
Plan/group name: SPOUSE PLAN PREMIER
Group number: G-88213
Subscriber ID: SBC-55102
Subscriber: Jordan Example (relationship to patient: spouse)
```

- **The subscriber line** appears only when the subscriber is someone other than the patient. Relationships come from `patplan.Relationship` (the enum name, or the database integer), and anything else reads "not on file".
- **A missing field** reads "not on file".
- **No plan on file** (`/patplans` returns 200 with an empty list): `Insurance on file: none.`
- **Any failed read in the chain**, or Open Dental not connected, or the audit write failing: `Insurance on file: available from our office on request.`
  - This fails closed: half a plan is never shown with the missing half as "not on file".
  - The letter still sends.
- **Plans shown:** primary and secondary only. A tertiary plan is ignored.
- **Another patient's plans:** `/patplans` rows are filtered to this patient's PatNum, so if Open Dental ignores the list filter, another patient's plan can't reach the letter.

## No SSN, ever

- **The SSN field is never read.** The subscriber's patient record is used for `FName` and `LName` only. A guard test fails if the module ever references an SSN field.
- **SSN-shaped IDs are withheld.** Practices have historically used SSNs as subscriber IDs, so an ID made of nine digits (with or without dashes or spaces) is not printed. The letter says "Subscriber ID: withheld from this email; please call our office". **Judgment call for Beau:** a carrier whose real member IDs are exactly nine digits would also be withheld. Changing that is a one-line edit if you'd rather print them.
- **Tested:** the synthetic SSN `123-45-6789` sits on both mocked patient records, and the tests assert it never appears in the letter, the patient email, the events, the audit rows or the tokens.

## PHI containment (test-pinned)

- **Tested:** carrier, group name, group number, subscriber ID and subscriber name never appear in the patient email, an event note, an audit row or a link token.
- **Never handed over:** `notifyPatient` is never given the insurance, and a guard test checks its call site.
- **Public pages:** `referralLinkWebhooks.js`, `emailWebhooks.js` and `referralLetter.js` never reference the insurance module or the insurance section (guard test). The public routes are unchanged.
- **Logs:** the module's only log line names the office, never a value, PatNum or name.

## Guardrails

- **Open Dental:** zero writes. Every harness client throws on any non-GET, and the module has no write method (guard test).
- **Send gateway:** `referralSend.js` is still the only send gateway. It never names an OD client (the existing `G:` guard passes).
- **Unchanged:** the claim, gate and transition logic.
- **Office:** comes from the referral, read through `assertOfficeMatch(office, getOdOffice(office))`. A test confirms valley reads valley's client only.
- **Mocks:** Open Dental and ACS are mocked throughout.

## Tests

New file: `backend/routes/tc/tcReferralLetterInsurance.test.js`, 16 tests.
- The full block, with exact text and HTML.
- The read order and its parameters, and the audit row.
- PHI containment, and no SSN anywhere.
- SSN-shaped IDs withheld.
- "Not on file" fields, and no subscriber line for the patient's own plan.
- A missing subscriber record, and an unknown relationship.
- No plans.
- Another patient's rows filtered out.
- Five failure modes, each falling back for the whole section while the contact block survives.
- An audit failure means no insurance read.
- The module's outcomes, including office derivation, a tertiary plan ignored, and a nonsense answer.
- The composer, including a CR/LF that can't forge a line.
- The guard test.

## Verification

| Gate | Result |
|---|---|
| `pnpm run check` (tsc) | clean |
| Dashboard `vitest run` | 183 files passed / 34 skipped; 2821 tests passed, 204 skipped, **0 failed** |
| `node --check server.js` | OK |
| Backend `node --test` | 4072 tests: **4069 pass, 0 fail**, 3 skipped |

## Follow-ups (not built)

- **Termed coverage:** a plan whose `inssub.DateTerm` has passed is still listed. A "Coverage ended" line would be a small addition if wanted.
