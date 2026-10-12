---
description: Build loop — run the next unswept slice from the PM queue, then stop.
---

You are the **orchestrator AND the builder**. One slice per run. Read `CLAUDE.md` first —
**§8 (the build loop) governs this command**, and §1–§7 govern the code.

1. **Pick the slice (read-only).** List
   `C:\Users\beau\carein cursor dashboard\pm-prompts\queue\` in filename order (ignore
   `done/`). Take the FIRST file that is **unswept**: its named branch has no PR yet
   (`gh pr list --state all --head <branch>`) and `docs/reports/<branch>.md` is not on
   `origin/develop`. Skip a file whose PR is already open, and say so. **Never write,
   move or rename anything in that folder or anywhere in the PROD folder** — the PM
   sweeps the queue.
   Read the queue file in full, plus `pm-prompts\README.md` (standing rules).
2. **Worktree + branch exactly as the queue file names them**, off fresh `origin/develop`:
   ```bash
   git -C "C:/Users/beau/carein cursor dashboard" fetch origin
   git -C "C:/Users/beau/carein cursor dashboard" worktree add "C:/Users/beau/carein-wt/<dir>" -b <branch> origin/develop
   ```
   All work happens in the worktree. Never `git stash`, `checkout -- .` or
   `reset --hard` anywhere.
3. **Build it yourself**, exactly as the queue file says — the queue files ARE the plan;
   there is no separate planner or coder agent (deliberate: one builder keeps context).
   Stay inside the slice; anything else goes in the report as a follow-up. Commit in
   imperative units with the repo's trailer.
4. **Run ALL gates on the merge tree** (`git fetch origin && git merge --no-edit
   origin/develop` first), with the REAL commands from CLAUDE.md §8.4 — there is no
   `npm test`. A known flake is re-run in isolation and stated; never edit a test to
   pass it.
5. **Write the report** at the path the queue file names (default
   `docs/reports/<branch>.md`): files changed, acceptance table with evidence per row,
   gate results, click-by-click test steps for staging, anything unfinished. Commit it.
6. **Classify the lane yourself**, before delegating:
   `node .claude/scripts/classify-lane.mjs --queue "<queue file path>"`, then the
   CLAUDE.md §8.3 list by judgment (including the shared-vocabulary grep). Script RED ⇒
   RED. Unsure ⇒ RED. Record your verdict and reasons; do NOT pass it to the reviewer.
7. **Delegate to the `reviewer` agent** with the queue file path and the branch/worktree
   only. On FAIL: fix the numbered items, re-run the gates, re-review — **max 2 fix
   rounds**; still FAIL ⇒ alert `curl.exe -s -d "BLOCKED slice <n>: <reason>"
   https://ntfy.sh/carein-bx7k2m-q9wp4r` and STOP.
8. **Lanes must agree.** Reviewer PASS + reviewer lane GREEN + your lane GREEN ⇒ GREEN.
   Any other combination ⇒ RED. Add the final lane and both verdicts to the report;
   commit.
9. **Delegate to the `shipper` agent** with: slice number, branch, lane, queue file path,
   one line of test steps.
10. **STOP** after the shipper's alert. Do not start the next slice. Beau replying `go`
    is the instruction to run `/next-slice` again.

## RED-LANE TRIGGERS (copied from CLAUDE.md §8.3 — any one ⇒ RED; when unsure ⇒ RED)

- **Any change that ADDS A VALUE TO A SHARED VOCABULARY** — a status CHECK constraint, an
  rcmVocabulary review reason, a procedure flag, an office key, a CommType/PayType
  DefNum, a module name, or any machine slug or route.
- Any Open Dental write path, or `odWriter.js` / `odPerioWriter.js`.
- Office / PatNum derivation, or CommType DefNums.
- `backend/migrations-tenant/` or `backend/migrations/`.
- `normalizeCall` or its preservation whitelist.
- Secrets, auth, or Key Vault config.
- `.github/workflows/`.
- `.claude/` or `CLAUDE.md`.
- `hygFixtureGate`, or any `*NoOdWrites*` test.
- The transcription breaker.
- **An edit that changes an EXISTING test's assertions.**
- Anything the queue file itself marks RED.

**Reviewer instruction (you apply it too, at step 6):** when a slice adds or changes any
status, enum, flag, reason code, route or slug, GREP THE WHOLE REPO for every reader of
that value (client unions, chip/label maps, CHECK constraints, tests) and FAIL if a
consumer was not updated. The classifier is a path+diff check the ORCHESTRATOR runs and
the REVIEWER independently re-runs; they must agree or the slice is RED.
Misclassifying red-as-green is the one unforgivable error.

Never: merge anything yourself, touch `main`, run `az`, flip an env var or an
entitlement, approve a deploy, or put a patient name / PatNum / phone / reading in any
file, commit, branch, report or alert.

$ARGUMENTS
