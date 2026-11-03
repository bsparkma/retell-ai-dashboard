# Fix: the two chronic dashboard test flakes

Branch `fix/dashboard-test-flakes` → `develop`. Not merged. **Test files only**: two RCM-owned test files, no component, backend or CI change. The change is **synchronization only**: every expectation keeps the same element and the same expected value, and none was removed.

## The two flakes, and the one cause

Both tests checked something that happens in a React **effect** right after waiting only for something that happens in the **commit**. React runs effects a moment after it commits the DOM. Under CPU load, RTL's `waitFor` can see the committed DOM and resume the test inside that moment.

| Test | What was awaited (commit) | What was then asserted (effect) | CI failure |
| --- | --- | --- | --- |
| `rcm-confirm-in-place.test.tsx` · "highlights and focuses the next unconfirmed figure, in the server's order" | the next row's `data-focused="true"` | `document.activeElement` is that row's "That is right" button. The focus is moved by the row's `useEffect` (`FieldConfirm.tsx:1382-1386`). | `expected <body>… to be <button …>` (staging-cd run 41373013129, attempt 2) |
| `rcm-ui-s3.test.tsx` · the key tests, e.g. "walks the check with the brackets…" | the pager's `claim-next` link | pressing `]` navigates to that link's target. The key listener is bound in `useRcmKeys`'s `useEffect` (`features/rcm/keys.ts:118-155`), re-bound on every render with that render's `onNext`. | `expected '/rcm/claims/c-1?from=b-1' to be '/rcm/claims/c-2?from=b-1'` (same run, attempt 1) |

The brief's "got a div" was the failure printout: the received element was `<body>`, and the `<div>` is its first child. Focus had not yet moved. It had not gone somewhere else.

### Product bug or test race? Test race, by probe

Before changing anything I made a throwaway copy of the confirm-in-place test. At the moment the original assertion ran, it recorded where focus was, then waited up to 1 s to see where focus ended up. I ran it under the conditions that reproduced the failure (40 runs, both files together, every core busy):

```
      1 PROBE immediate=BODY eventual=BUTTON
     39 PROBE immediate=BUTTON eventual=BUTTON
```

Focus never landed anywhere but the correct button, and when it was late it was on `<body>`, not another control. That rules out the stop-and-report case: this is not a product bug.

For s3, the pager link and the key handler's `onNext` come from the **same** render (`ClaimMatch.tsx` builds both from `pager`, lines 980 and 1002–1003), and `keysEnabled` defaults to true. So there is no second fetch the keys wait on, only the effect after the commit. A press in that gap reaches the previous render's listener, whose `onNext` was null because the claim list had not loaded yet. That is exactly "still on c-1".

## Reproduction (observed failure rates)

| Setup | rcm-confirm-in-place | rcm-ui-s3 |
| --- | --- | --- |
| File alone, 25 runs | 0/25 | — |
| Both files, 6 parallel copies × 4 rounds (24 runs) | 0/24 | 0/24 |
| Full dashboard suite, 6 runs | 0/6 | 0/6 |
| Both files, every core busy-looped, 20 runs | **1/20** | 0/20 |
| Same, 40 runs (the probe above) | **1/40** | 0/40 |
| CI, `staging-cd` on `f9d792e` | failed attempt 2 | failed attempt 1 |

This machine has 24 cores and the CI runner has 2, which is why it took a deliberately overloaded CPU to reproduce the first flake here. **rcm-ui-s3 did not fail locally in any of these runs** (0 in 94 file runs and 6 full suites). Its fix is reasoned from the component and the CI log, and it is the same mechanism as the reproduced one. I say so plainly rather than claim a reproduction I don't have.

## The fixes

**rcm-confirm-in-place.** The two expectations that were a `waitFor` plus a synchronous `expect` are now **both inside the one `waitFor`**. Same two subjects, same two expected values. The wait passes only when both hold on the same check. A component that focused the wrong control, or never moved focus, still fails at the timeout.

```diff
-    await waitFor(() =>
-      expect(screen.getByTestId(`rcm-confirm-field-${CLAIM_TOTAL}`).dataset.focused).toBe("true"),
-    );
-    expect(document.activeElement).toBe(screen.getByTestId(`rcm-confirm-yes-${CLAIM_TOTAL}`));
+    await waitFor(() => {
+      expect(screen.getByTestId(`rcm-confirm-field-${CLAIM_TOTAL}`).dataset.focused).toBe("true");
+      expect(document.activeElement).toBe(screen.getByTestId(`rcm-confirm-yes-${CLAIM_TOTAL}`));
+    });
```

**rcm-ui-s3.** The listener has no visible sign, so `waitFor` has nothing to watch. Instead, `threeClaims()`, the helper behind every key test in that block, now ends with `await effectsFlushed()`. That helper re-renders the **same element object** inside `act`.

React starts every root render with `flushPendingEffects()` (`react-dom-client.development.js:18945`, React 19.2.1), so the listener for the current pager is attached. React then bails out on the identical element, so no component renders again and nothing on the page changes: same wouter memory, same location, no remount. It uses public API only and is deterministic.

A bare `act(async () => {})` was considered and not used. `act` drains only work queued inside `act`, and the failing flush is queued outside it, on the real scheduler.

I also tried two other approaches and rejected them:
- **Waiting on React's scheduler directly:** not reachable. vitest loads React DOM through its own module runner, so the scheduler instance is not in Node's require cache.
- **Delaying the scheduler from inside the test:** the scheduler is loaded before a test file's hoisted code.

`renderAt` still returns what it returned; it now also remembers the last tree in `drawn`, which `afterEach` clears after `cleanup()`. Every edit is labelled `RULING (flake-fix)`. No assertion was changed, weakened or removed.

## Proof (after the fix)

```
isolated rcm-confirm-in-place: 25/25
isolated rcm-ui-s3: 25/25
contended both files: 40/40          (every core busy-looped — the setup that reproduced 1/20 and 1/40 before)
full suite 1: exit 0  Tests 3093 passed | 250 skipped (3343)
full suite 2: exit 0  Tests 3093 passed | 250 skipped (3343)
full suite 3: exit 0  Tests 3093 passed | 250 skipped (3343)
full suite 4: exit 0  Tests 3093 passed | 250 skipped (3343)
full suite 5: exit 0  Tests 3093 passed | 250 skipped (3343)
```

`pnpm run check` (tsc) exits 0.

## Review

A fresh-context reviewer was asked to verify assertion equivalence line by line. It approved in round 1 with no blockers, so no second round was needed. It confirmed:
- in each file, every expectation has the same subject and the same expected value;
- the only state newly accepted is "focused a few milliseconds late";
- the React source claim checks out, and the re-render bails out without remounting or resetting the router.

Its two nits:
1. The s3 comment's "no component re-renders" holds for this tree (no RTL `wrapper`, no StrictMode).
2. **A follow-up, not done here:** two existing "stands down" tests in rcm-ui-s3 could pass even if the key listener were never attached. "Stands down while the caret is in a field" only asserts the link is unchanged. "Stands down when the focus is already on a control" does not go through `threeClaims`. Giving them a positive control would add assertions, which is outside a synchronization-only change.

## For the RCM PM (post-hoc review)

These are RCM-owned test files. The change is synchronization only: no product code changed, and no assertion changed meaning. The diff is 2 files, +50 / −8.

## CI

PR #303. `build-test` run 41383038204 on `refs/pull/303/merge` (head `763c83b`) passed on the **first attempt**, with no fix pushes. Since then only this CI section has been added to the report. **Not merged.**
