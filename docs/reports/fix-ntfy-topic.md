# fix/ntfy-topic — wire the real ntfy topic into the loop (queue item 44)

**Lane: RED** (`.claude/` + `CLAUDE.md`; the queue file marks it RED). PR to `develop`,
not merged — Beau merges.

> **One step is NOT done: the live test alert (§3).** Claude Code's auto-mode classifier
> refused the `curl.exe` call to ntfy.sh as "data exfiltration", and the slice did not
> work around it. Beau, please run this once (shipper.md's exact shape) and check that
> the reply is JSON with `"event":"message"` (ntfy answers that only with HTTP 200):
>
> ```bash
> curl.exe -s -d "ntfy wire-up test — ignore" https://ntfy.sh/carein-bx7k2m-q9wp4r
> ```
>
> The same classifier may refuse the loop's own alerts from a main session. If it does,
> the loop's rules already say what happens: alert step refused ⇒ say so and stop; never
> work around it. A permission rule for this exact shape in Beau's user settings would
> clear it; that is his call, not the loop's.

## 1. Placeholder replaced

The placeholder topic → `carein-bx7k2m-q9wp4r` (ratified by Beau 2026-10-08 in the queue file) in:

| File | Change |
| --- | --- |
| `.claude/settings.json` | Notification hook URL |
| `.claude/agents/shipper.md` | Alert command and its caption (no longer "a placeholder") |
| `.claude/commands/next-slice.md` | BLOCKED alert in step 7 |
| `CLAUDE.md` §8.6 | Topic, command, and the "four files change together" note; the "not live until" line no longer lists the topic as outstanding |
| `docs/reports/feature-build-loop.md` | Three historical mentions reworded to "the placeholder (replaced by queue item 44)", because the spec requires zero remaining occurrences repo-wide |

`git grep -n` for the placeholder string over the whole repo at the final HEAD: **0 matches**
(round 1 of review caught two copies of it in this report itself; reworded, re-grepped).

## 2. Hardenings

- **Explicit scheme.** Every ntfy URL is now `https://ntfy.sh/carein-bx7k2m-q9wp4r`.
  `grep -rn ntfy.sh | grep -v https://ntfy.sh`: **0 matches**.
- **Curl allow narrowed.** `Bash(curl.exe:*)` →
  `Bash(curl.exe -s -d * https://ntfy.sh/carein-bx7k2m-q9wp4r)`. Every alert the loop
  sends has the shape `curl.exe -s -d "<message>" https://ntfy.sh/<topic>`. The
  Notification hook runs as a hook, which the permission rules don't gate, so it needs no
  allow entry.
  - Shape check (a regex stand-in for Claude Code's `*` glob, **not** the real permission
    engine): the four alert shapes (`NEEDS REVIEW…`, `BLOCKED…`, `Slice <n> on staging…`,
    `CI RED…`) and the test message all match. `curl.exe https://evil.example/x`, plain
    `http://ntfy.sh/<topic>`, and `https://ntfy.sh/other` do not.
  - **Still wider than "ntfy host only"** (reviewer's note; the spec's own example has the
    same shape): the middle `*` admits extra arguments, so
    `curl.exe -s -d x https://other.host https://ntfy.sh/<topic>` matches and also posts to
    the other host, and `-d @<file>` makes curl read a local file and post it — the
    `Read(.env)` denies don't cover curl reading a file. Far narrower than `curl.exe:*`,
    but tightening further (or dropping the allow and approving each alert) is Beau's call.
- **JSON parse:** `node -e "JSON.parse(...)"` passes — **12 allow, 32 deny** (unchanged
  counts; one allow entry replaced, the deny list untouched).

## 3. Verify — see the box at the top

The live alert was not sent (refused by the permission classifier). Everything else in
§3 is unchanged: alerts never carry a patient name, PatNum, phone, reading or amount.

## Lane

- **Orchestrator:** `node .claude/scripts/classify-lane.mjs --queue …44-ntfy-topic-wireup.md`
  → `LANE: RED` (`.claude/` ×3, `CLAUDE.md`, the queue file marks it RED). Its
  "removed text is asserted on by an existing test" hit is a **false positive**: the removed
  settings line contains the JSON key `"command"`, and the three flagged lines
  (`killMidDrainContract.test.js:155`, `rcmReseedScripts.test.js:72`,
  `rcmS10Scripts.test.js:195`) are comments/messages that use the English word "command".
  No test reads `.claude/settings.json`. Judgment: RED by path, nothing else.
- **Reviewer, round 1:** FAIL. The report itself still contained the placeholder literal
  twice, so the zero-occurrence claim was false. Fixed in `5821321`.
- **Reviewer, round 2:** PASS, `LANE: RED`. It ran the classifier independently (RED) and
  agreed the "asserted by an existing test" hit is a false positive. It judged the unsent
  §3 alert an honestly reported gap for a human to close, not a FAIL. Full gates on the
  merge tree: backend 3304 tests, 3301 pass, 0 fail, 3 skipped. Dashboard `check` clean;
  2478 passed, 174 skipped, 0 failed.
- **Final lane: RED** (orchestrator RED + reviewer RED).

## Gates

No application code and no tests changed, so the slice's gate is the JSON parse (above).
The backend and dashboard suites were not re-run; nothing they cover changed.

## Unfinished / for Beau

1. Run the test alert above.
2. The topic now lives in a committed file in the repo. Anyone with read access to the repo
   can post to it, or read it, unless the topic is access-controlled on ntfy. That was
   implied by the spec ("replace it everywhere"); noting it so it is a choice, not an
   accident.
