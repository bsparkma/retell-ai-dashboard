
---

## 13. W-11 — the remittance's "run match" silently skips a confirmed claim

### 13.1 The re-match did not happen

Reported re-matched and confirmed on 2026-09-08. The stored record says
otherwise — **nothing moved**:

| | Value | |
| --- | --- | --- |
| `od_match_at` | `2026-09-04T01:40:29.189Z` | the ORIGINAL match |
| `od_match_confirmed_at` | `2026-09-04T01:40:40.660Z` | the original confirmation |
| `confirmed.linePairs[0].billedDeltaCents` | **`-7000`** | unchanged |
| `confirmed.supersedes.confirmedAt` | `2026-09-04T01:27:24.002Z` | an EARLIER confirmation, so the force path does work — it just did not run |

The gate, read straight out of `previewRecoupment` on the live build:

```
postable: false      withheld: 1      failed checks: 1

PATIENT_RESPONSIBILITY_MATCHES — "Patient's number can't be trusted yet …
  Look at D0220."
verdict.state: red
problems: [ od_fee_disagrees — "D0220 was billed -$35.00 on the remittance
            and $35.00 in Open Dental" ]
```

Every other check passes, including `TAKEBACK_ACKNOWLEDGED` ("This is a takeback
— confirmed by typing -29.00") and `MATCH_TAKEN_FOR_A_TAKEBACK`. The recoupment
total is `-2900`, the batch balances, and `defaultPath` is `adjustment`. **One
check stands between this claim and an enabled Approve, and it is the frozen
`-7000`.**

### 13.2 Why the press did nothing

There are two different controls both wired to the `run-match` action, and only
one of them forces:

| Screen | Wiring | On an already-confirmed claim |
| --- | --- | --- |
| the claim's own Match page | `ClaimMatch.tsx:450` — `runMatch(claim.odMatchStatus === "confirmed")` | **forces**, releases the confirmation, re-reads Open Dental, writes a NEW snapshot |
| the remittance page | `RemittanceDetail.tsx:469` — `runBatchMatch` | `runClaimMatch` **without** `force`, which **throws** `This claim already has a confirmed Open Dental match` — and `runBatchMatch`'s own header records that the catch **swallows it and the loop carries on** |

So the batch button reports a run that did nothing, with no visible refusal on
the claim that was skipped. On a partly-worked remittance that is the *mundane*
outcome, which is exactly what makes it easy to read as success.

**Not a defect in the fix, and not a bad press** — it is a screen that cannot
say "I skipped the one claim you were trying to re-match".

### 13.3 What actually moves it

Open **claim 53863's own Match page** (into the claim from the R3 remittance),
run the match there — the page forces because the claim is confirmed — then
confirm 53863. Forcing requires posting permission (`mayReleaseConfirmed`).

Then the delta should read **0**, not `-7000`, and
`PATIENT_RESPONSIBILITY_MATCHES` should pass. **[CC] re-reads the snapshot and
the gate before anything is approved.**

