# Report: queue item 29, the build loop (`feature/build-loop`)

**PR #228** → `develop`. https://github.com/bsparkma/retell-ai-dashboard/pull/228
**RED LANE — NEEDS REVIEW.** This PR touches `.claude/` and `CLAUDE.md`, so it is red by its own rules. The PM reviews it before merge, and Beau merges it. Nothing here auto-merges.

> ## The loop is NOT live.
> It goes live only when **(a)** Beau's one-time setup below is done, and **(b)** the canary slice (queue item 30) has run green end-to-end through the loop.
> Until both are true, nothing in `.claude/` should be trusted to merge anything.

## Files

| File | What it is |
| --- | --- |
| `.claude/commands/next-slice.md` | **Orchestrator and builder.** Picks the first unswept queue file. The queue folder is read-only to the loop. Builds that one slice in its own worktree, runs the real gates on the merge tree and writes the report. Classifies the lane, delegates to `reviewer` (at most 2 fix rounds, then BLOCKED), requires the two lane verdicts to agree, delegates to `shipper`, then stops. Also carries the red-lane trigger list and the vocabulary-grep instruction. |
| `.claude/commands/fix.md` | `/fix` → branch `fix/<slice>-<short>`. Same gates, same reviewer, same two-lane shipper. |
| `.claude/agents/reviewer.md` | Model `opus`; tools Read/Grep/Glob/Bash, read-only. Fresh context. Checks every acceptance row with evidence, runs the gates (a flake claim with no isolation run is a FAIL), checks for patient data and runs the shared-vocabulary sweep. Classifies the lane independently. Output is PASS+lane or a numbered FAIL. Carries the **guardrail list verbatim** (see row 4). |
| `.claude/agents/shipper.md` | Model `haiku`; tools Read/Bash. GREEN and RED flows, ntfy alerts and the never-list (details below). |
| `.claude/scripts/classify-lane.mjs` | Read-only lane check based on paths and the diff. It is not application code, and nothing imports it. It can only push a slice toward RED. When unsure it says RED; an error also means RED. |
| `.claude/settings.json` | New. It did not exist on `origin/develop` (`git ls-tree origin/develop .claude` was empty). Holds the allow and deny lists and the Notification hook. |
| `CLAUDE.md` | New **§8 The build loop** at the bottom: the 2026-10-02 amendment, the two lanes, the red list and vocabulary rule, the real gates and known flakes, the never-list, and the alerts with an ntfy topic placeholder (replaced by queue item 44). |
| `.gitignore` | `.claude/` was ignored. It is now `**/.claude/*` (still ignored at every depth), with exactly four negations: `!/.claude/settings.json`, `!/.claude/commands/`, `!/.claude/agents/`, `!/.claude/scripts/`. `git check-ignore` confirms `.claude/settings.local.json`, `.claude/worktrees/…` and `new-dashboard/.claude/…` are still ignored. |

### How the shipper works
- **GREEN:**
  1. Push.
  2. `gh pr create --base develop --fill`.
  3. `gh pr checks --watch`.
  4. Confirm `build-test` passed.
  5. `gh pr merge --auto --merge <n>`.
  6. Confirm MERGED.
  7. Send `Slice <n> on staging. Test: …`.
- **RED:** push, create the PR, send `NEEDS REVIEW slice <n>: <reason>`, stop.
- **Checks fail:** run `gh pr ready --undo` (a held PR is a draft), send `CI RED slice <n>`, stop. Never retry the merge.

This **reorders one step of the spec on purpose.** The spec runs `merge --auto` before `checks --watch`. Here the merge is requested only after CI is already green. If develop's branch protection were missing, `--auto` would merge at once with no brakes. With this order, nothing untested reaches staging even then. When protection does exist, `--auto` still honours it. This is stricter than the spec and does not contradict it.

## Acceptance

| # | Row | Status | Evidence |
| --- | --- | --- | --- |
| 1 | All files exist as specced; zero application code in the diff | **PASS** | `git diff --name-only origin/develop...HEAD` lists only `.claude/**` (6 files), `CLAUDE.md`, `.gitignore`, and this report. A filter excluding those paths returns nothing ("no app code in diff"). CRLF check: `--shortstat` with and without `--ignore-all-space --ignore-blank-lines` matched. CI `build-test` on PR #228 passed in 4m48s. |
| 2 | Lane classifier on two synthetic diffs (one green, one red migration), with the reviewer's independent concurrence | **PASS** | See the next section. The independent reviewer (a fresh subagent) agrees GREEN on the green diff and RED on the migration. Its first run also **caught a false GREEN in my original green demo**, and the classifier was fixed as a result. |
| 3 | settings.json deny list contains every spec item verbatim; existing settings preserved | **PASS** | Deny includes `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git reset --hard:*)`, `Bash(rm -rf:*)`, `Bash(az:*)`, `Bash(gh pr merge --admin:*)`, `Bash(gh pr create --base main:*)`, `Bash(* --base main*)`, `Bash(git push origin main:*)`, `Bash(* origin main*)`, `Read(./.env)`, `Read(./.env.*)`, `Read(**/.env)` and `Read(**/.env.*)`. It also has hardening variants: `--force-with-lease`, `+ref`, `HEAD:main`, `--base=main`, `-B main`, `rm -fr`, mid-command `az`, and no direct push to develop. Allow covers the spec's list plus `gh pr view`, `gh pr list` and `gh pr ready --undo`. Hook: `curl.exe -s -d "Claude needs you"` to the ntfy placeholder topic (replaced by queue item 44). `node -e JSON.parse(...)` reports JSON OK (12 allow, 32 deny). There were no existing settings to preserve: `origin/develop` has no `.claude/`. The PROD folder's local `.claude/settings.local.json` (git-ignored) was not touched and stays ignored. |
| 4 | Reviewer agent file carries the full guardrail list verbatim | **PASS** | The excerpts were spliced from `CLAUDE.md` with `sed` (no retyping), then checked with a node script that tests whether `reviewer.md` contains each CLAUDE.md line range as one contiguous block. All four ranges came back VERBATIM: preamble rules L7–13 (396 chars); **§3 Hard rules in full, rules 1–8 plus the fixture table**, L564–632 (4963 chars); §5 Conventions non-negotiables L833–841 (619 chars); §8.5 never-list (506 chars). |
| 5 | Report states plainly that the loop is NOT live until setup is done and the canary has run green | **PASS** | The banner at the top of this report, and the last paragraph of CLAUDE.md §8.6. |

## Row 2 — the classifier demo

The synthetic diffs live only in the scratch directory. They were never applied to any branch.

**DIFF A, green: a pure UI copy change** in `new-dashboard/client/src/pages/NotFound.tsx`:
```diff
-            It may have been moved or deleted.
+            It may have moved, or it no longer exists.
```
**DIFF B, red: a new tenant migration**:
```diff
+++ b/backend/migrations-tenant/1790300000000_demo_add_note_flag.js   (new file)
+exports.up = (pgm) => { pgm.addColumn('hyg_visit', { demo_flag: { type: 'text', notNull: false } }); };
```

| | Orchestrator (me): `classify-lane.mjs --diff-file` plus judgment | Independent reviewer (fresh subagent given `reviewer.md`) |
| --- | --- | --- |
| DIFF A | `LANE: GREEN` (exit 0). By judgment: copy only, no vocabulary, no test asserts the old text. | **GREEN.** Its notes: the `-` line exists at NotFound.tsx:33. A repo-wide grep for "moved or deleted" finds only that line. Two tests render the page (voicelab-page.test.tsx:193, tc-routing.test.tsx:102/111), but both key on the unchanged "Page Not Found" h2. No snapshots. No assertion breaks. |
| DIFF B | `LANE: RED` (exit 2): `backend/migrations-tenant/…: database migration (backend/migrations*/)` | **RED.** The migrations-tenant trigger fires. Vocabulary sweep: no readers of `demo_flag`. |

**The demo found a real false GREEN, and that changed the classifier.** My first green demo was a copy change on `Home.tsx`, from "Choose where you want to work today." to new wording. The script said GREEN. The reviewer said **RED**, because `new-dashboard/tests/module-home.test.tsx:190` asserts `getByText(/Choose where you want to work/)`. Shipping that change either breaks a test or requires editing an existing assertion, which is a red trigger. The script had missed it because the broken test was not in the diff. This is the same class of failure as the shared-vocabulary rule, and the disagreement rule (lanes disagree ⇒ RED) would have held the slice anyway.

Fixes:
- Commit `933e87e`: for text removed from a non-test file, the classifier greps the test tree for 4-word windows.
- Commit `0bbc372`: also matches short text nodes whole (headings, button labels) and splits template literals at `${}`.

Re-run results:
- Original Home.tsx diff: now `RED — removed text is asserted on by an existing test: new-dashboard/tests/module-home.test.tsx:190`.
- Changing NotFound's "Page Not Found" heading: RED, with the three hits.
- `Welcome back, ${firstName}` → `Hello, …`: GREEN, which is correct because no test asserts "Welcome back".
- This branch itself: RED (`.claude/`, `CLAUDE.md`, `.gitignore`, and the queue file marks it RED).

**Known limits of the script.** The reviewer listed these; they are why the script's GREEN is "necessary, not sufficient":
- It cannot see a test that asserts copy through a shared constant, label map, aria-label or title.
- Its vocabulary rules match single-line shapes only. A new slug added as a plain map key (`LABELS = { archived: … }`), an array entry, or across several lines can come out GREEN.

The reviewer's manual whole-repo vocabulary grep (CLAUDE.md §8.3) is the actual gate for these cases. Making the script catch every map key would make nearly every diff RED.

## Beau's one-time setup (not attempted; all are Beau's)

1. **GitHub → Settings → Branches:** a protection rule on `develop` requiring a PR and the **`build-test`** status check.
2. **GitHub → Settings → General:** tick **Allow auto-merge**.
3. **ntfy:** install the app and subscribe to a **random, private topic**. Replace the placeholder topic everywhere it appears (done in queue item 44): `.claude/settings.json`, `.claude/agents/shipper.md`, `.claude/commands/next-slice.md` and CLAUDE.md §8.6. That replacement is itself a `.claude/` change, so it is RED: Beau commits it.
4. **Merge this PR (#228).**
5. Then run the **canary, queue item 30** (`feature/hyg-shots-ci`). It touches `.github/workflows/`, so the correct outcome is: build → reviewer PASS → **classified RED** → PR + NEEDS REVIEW buzz → stop. **If it auto-merges, the classifier is broken: stop using the loop.** The generic guide also calls for one trivial GREEN slice end-to-end after that.

## Notes and conflicts

- **"No self-merges" is not in CLAUDE.md as text.** A grep of CLAUDE.md and DEV_PROD_WORKFLOW.md found nothing. So §8.1 states the 2026-10-02 amendment as a rule in its own right, and says plainly that there was no literal line to amend.
- **"A held PR is a DRAFT"** (DEV_PROD_WORKFLOW.md §2) is referenced, not contradicted:
  - A RED PR that the PM review holds becomes a draft via `gh pr ready --undo`.
  - A loop PR whose CI went red is also held as a draft.
  - The loop never runs `gh pr ready <n>`.
  - This PR is open as a normal PR, because no review has held it yet.
- **The shipper reorders one step** (CI green before `merge --auto`); see above. It is stricter than the spec.
- **Red-list additions beyond the spec**, all on the "unsure ⇒ red" side: `.gitignore` (it could un-ignore `data/` or `recordings/`), dependency and lockfiles (the tc contract bundle is byte-compared), deploy/infra config, `backend/scripts/` (several of these write to OD), `server.js` (the mount table), file deletions and renames, and possible phone numbers in added lines.
- **Unswept queue items.** `next-slice` defines "unswept" as the first queue file whose branch has no PR and no report on develop. The queue still holds 22/24/25 and 35–37, which may already have PRs. So for now, "first unswept" is decided by PR state, not by file order alone.
- **Environment:** `C:\Users\beau\carein cursor dashboard\.git\` (PROD) holds stale `packed-refs.lock` (Oct 7) and `index.lock` (Sep 11) files. Every commit printed a `packed-refs.lock: File exists` warning, but the commits and the push succeeded. I did not touch them, because removing them means touching the PROD folder. Beau should delete them once no git process is running there.
- **Gates:** this slice changes no backend or dashboard code, so I did not re-run the local test gates. CI `build-test` on the PR's merge ref passed.
