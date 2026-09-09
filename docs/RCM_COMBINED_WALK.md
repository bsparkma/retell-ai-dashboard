
---

## 14. The takeback gate goes green — [CC], 2026-09-09

Re-matched and re-confirmed from **the claim's own Match page** (the forcing one,
per [§13.2](#132-why-the-press-did-nothing)). The record moved this time:

| | Before | After |
| --- | --- | --- |
| `od_match_at` | `2026-09-04T01:40:29.189Z` | **`2026-09-09T01:56:57.921Z`** |
| `od_match_confirmed_at` | `2026-09-04T01:40:40.660Z` | **`2026-09-09T01:57:30.389Z`** |
| `confirmed.linePairs[0].billedDeltaCents` | **`-7000`** | **`0`** |
| `confidence` | 100 | 100 |
| still paired to | `odClaimProcNum 535780` | `odClaimProcNum 535780` |

**`odAmountsAsRead` is byte-identical across the re-match** — billed `3500`,
`insPaidCents 2900`, `writeOffCents 600`, `ClaimStatus "R"`. The chart did not
change; the arithmetic did. That is the W-6 fix and nothing else.

The gate, read out of `previewRecoupment` on the live build:

```
postable: true        withheld: 0        failing checks: 0
verdict.state: green
verdict.sentence: "Patient will owe $0.00 once posted — matches the EOB."
problems: []

recoupmentTotalCents: -2900   typedTotalExpected: "-29.00"
paths: [adjustment, supplemental]   defaultPath: adjustment   balanced: true
```

**This is the first parser-produced reversal 835 ever to reach an enabled Approve
in this system.** Before `7647dd1` both branches were red — a reversal that paired
went red on `od_fee_disagrees`, and one that did not went red on
`line_not_in_chart` — so the takeback lane had never been green end to end.
[§6](#6-findings)'s W-6 is now proven live on real data through the real gate, not
only in a regression test.

**Stopped at the button, per the PM.** Nothing is approved.

