# Fix: the day-card "Slip" chip label becomes "Router"

Branch `fix/hyg-progress-router-label` off `origin/develop` (`a51d1cd`), worktree
`C:\Users\beau\carein-wt\hyg-router-label`. **PR #277 → develop, not merged.**

## Change

This is a display-text change only. In `new-dashboard/client/src/features/hyg/progress.ts`,
`STEP_NAMES.slip` is now `"Router"`.

| Chip before | Chip after |
| --- | --- |
| `Slip ✓ In chart` | `Router ✓ In chart` |
| `Slip: Ready` | `Router: Ready` |
| `Slip: Drafting` | `Router: Drafting` |
| `Slip: Sending…` | `Router: Sending…` |
| `Slip: Failed` | `Router: Failed` |
| `Slip —` | `Router —` |

Screen-reader text is built from the same label, so the not-started chip is read as
"Router — not started". No other `sr-only` or `aria` text names this step.

These are unchanged:
- the internal `StepKey` `slip`
- the backend staged-write kind `router`
- `HygDayProgressResponseSchema` and its `steps.slip` field
- `data-testid="hyg-step-slip"`

There is no backend, contract or migration change, and no Open Dental read or write.

## Tests

The only test change is the four visible-text chip assertions in
`tests/hyg-day-progress.test.tsx`, updated from Slip to Router. No other expectation changed.

```
pnpm run check (tsc --noEmit)   clean
pnpm run test                   Test Files 187 passed | 37 skipped (224)
                                Tests 2872 passed | 215 skipped (3087)
```

CI: run 40544945649 `build-test` passed in 6m27s. It checked out `refs/pull/277/merge` =
`0e69fcd` ("Merge 374bda5 into a51d1cd"). It was green on the first push; no fix pushes were
needed.

## Screenshots

The screenshots were regenerated with `HYG_SHOTS=1` and `scripts/shoot-hyg.mjs` at 1180×820,
in light and dark.

| Shot | Result |
| --- | --- |
| `hyg-progress-01-list` | Shows "Router". |
| `hyg-progress-02-chairs` | Shows "Router". The chips still fit the 288px chair columns. |
| `hyg-progress-03-unavailable` | Byte-identical to before, because it has no step chips. |

In the 01 and 02 dumps, "Slip" appears 0 times and the four Router chips appear once each.

![Chair columns](../screenshots/hyg/hyg-progress-02-chairs-1180x820-light.png)
