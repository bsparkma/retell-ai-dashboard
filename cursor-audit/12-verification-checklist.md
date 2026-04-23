# 12 — Verification & Rotation Checklist

This document covers two things:

1. **Things only ops can verify** — items the audit couldn't confirm from the repo alone.
2. **The Retell key rotation + cleanup procedure** — concrete steps with commands.

It is a living checklist. Cross items off as they are completed.

Companion docs:
- **[11-evidence-and-confidence.md](./11-evidence-and-confidence.md)** — what the audit proved with code evidence
- **[08-prioritized-fix-roadmap.md](./08-prioritized-fix-roadmap.md)** — what to fix in what order

---

## Part 1 — STOP. The Retell key is publicly leaked.

### What the audit confirmed (Phase A1, completed)

- The Retell API key `key_5286…eba586` exists in this repo's git history starting at the **initial commit (`2f0e920`)**.
- The repo is **`https://github.com/bsparkma/retell-ai-dashboard`** and is **PUBLIC** on GitHub.
- The repo was created `2025-07-10` and last pushed `2026-03-27`. The key has been publicly searchable for ~9 months.
- After the Phase A scrub, the key no longer appears at HEAD in any live (non-worktree, non-audit) file. It still appears in:
  - **Git history** (3 commits: `2f0e920`, `615113a`, `6137a1c`) — cannot be removed retroactively in a way that helps; the key has already been scraped by every secret-scanning bot on the internet.
  - **7 local git worktrees** (`.claude/worktrees/*` and `new-dashboard/.claude/worktrees/*`) — these are not tracked in git, only on the developer's machine.
  - **Audit citations** (`cursor-audit/*.md`, `audit/*.md`) — left intentionally so this report documents what the leak was.

### Code-side cleanup (Phase B-P0-01, completed)

- [x] Stripped the leaked Retell key from every live (non-history, non-worktree) file.
- [x] Removed the dangerous default fallback in `docker-compose.dev.yml` so the
      compose stack now refuses to start without `RETELL_API_KEY` set in the
      environment.
- [x] Replaced the hardcoded key in `setup.sh` with a placeholder.
- [x] Added `backend/.env.example`, `frontend/.env.example`, and updated
      `new-dashboard/.env.example` so a new clone is configured by env vars
      instead of by editing source.
- [x] Verified `.env`, `backend/.env`, `frontend/.env`, and `new-dashboard/.env`
      are all in `.gitignore` (confirmed by `git check-ignore -v`).

The remaining work in this section is the rotation itself, which only ops can
perform in the Retell dashboard. Steps below.

### What ops MUST do (in this order)

#### Step 1 — Check the Retell account for unauthorized usage

Log in at https://dashboard.retellai.com.

- [ ] Look at billing for the past 9 months. Anything unexplained → assume compromise.
- [ ] Look at the call log for inbound/outbound calls you did not make.
- [ ] Look at agents/phone numbers — anything you did not create.

If anything looks wrong, contact Retell support (`support@retellai.com`) and tell them the key was on a public GitHub repo.

#### Step 2 — Rotate the key

In the Retell dashboard:

- [ ] Generate a new API key.
- [ ] Update the production droplet `.env` (`/root/retell-ai-dashboard/backend/.env`) with the new key.
- [ ] Update `new-dashboard/.env` if separately configured.
- [ ] Restart PM2: `pm2 restart all`.
- [ ] Verify the dashboard still loads calls and that webhooks still arrive.
- [ ] **Delete (revoke)** the old key `key_5286…eba586` from the Retell dashboard.
- [ ] Smoke-test: place one inbound test call to the production phone number, confirm it appears in the dashboard, end-to-end.

#### Step 3 — Clean local worktrees (developer machine)

The 7 worktrees still contain copies of the leaked key on the developer's local disk. They are not in git, so they don't leak further, but they're worthless once their branches are merged or abandoned, and they bloat search results.

Run these from `c:\Users\beau\carein cursor dashboard`:

```powershell
# Inspect each worktree first
git worktree list

# For each worktree you no longer need, do:
git worktree remove --force .claude/worktrees/blissful-feistel
git worktree remove --force .claude/worktrees/flamboyant-dhawan
git worktree remove --force new-dashboard/.claude/worktrees/charming-turing
git worktree remove --force new-dashboard/.claude/worktrees/competent-solomon
git worktree remove --force new-dashboard/.claude/worktrees/elegant-montalcini
git worktree remove --force new-dashboard/.claude/worktrees/keen-golick
git worktree remove --force new-dashboard/.claude/worktrees/quizzical-ellis

# Delete the corresponding branches if abandoned (review first)
git branch -D claude/blissful-feistel  # ...repeat for each
```

> **Don't blindly delete a worktree** if you still need its un-merged work. Run `git status` and `git diff main` in each one first, or check with the team.

- [ ] Confirm `git worktree list` shows only the main checkout.
- [ ] Confirm `cd <repo> && rg "key_5286"` (after worktree removal) returns only the audit files in `cursor-audit/` and `audit/`.

#### Step 4 — Add gitignore + secret-scan guardrail

- [ ] Add to `.gitignore`:
  ```
  .claude/worktrees/
  new-dashboard/.claude/worktrees/
  ```
- [ ] Enable [GitHub secret scanning push protection](https://docs.github.com/en/code-security/secret-scanning/push-protection-for-repositories-and-organizations) on the repo (free for public repos).
- [ ] Optional: install [`gitleaks`](https://github.com/gitleaks/gitleaks) as a pre-commit hook.

#### Step 5 — Decide what to do about the public repo

Options:

- **A. Make the repo private** (recommended). Anyone with the URL still has the cloned history, but no new scrapers will see it.
  ```
  gh repo edit bsparkma/retell-ai-dashboard --visibility private --accept-visibility-change-consequences
  ```
- **B. Leave public, accept that the key is permanently burned, rely on rotation + revocation.** This is fine if the only secret in history is this Retell key (which it appears to be) — but verify with `git log --all -p | grep -iE "(api[_-]?key|secret|token|password).*=.*['\"][a-z0-9_]{16,}"`.
- **C. Force-push history rewrite** (using `git filter-repo`). This does **not** unleak the key — it's been public for 9 months — and it breaks every clone. Only worth doing if there are other secrets in history that have *not* been rotated.

- [ ] Decision recorded.

---

## Part 2 — Verification of "Likely" findings

`cursor-audit/11-evidence-and-confidence.md` lists a handful of issues classified as **Likely** rather than **Confirmed** because they require runtime evidence, not just code review. This section gives you the exact tests to run to confirm or refute them.

### LK-01 — Duplicate webhooks create duplicate CommLog entries

**Hypothesis:** Retell retries on 5xx, and `openDentalSync.js` doesn't track which `call_id`s have already been written, so a retried webhook creates a second CommLog row.

**Test:** see `cursor-audit/scripts/test-duplicate-webhook.js` (Phase A3 deliverable).

- [ ] Run against a non-prod backend or a sandbox Open Dental.
- [ ] Confirm whether one CommLog or two appear after sending the same webhook twice.
- [ ] If two: confirmed; ship the idempotency fix in P1.

### LK-02 — Phone format mismatch breaks patient lookup

**Hypothesis:** Retell sends `+15551234567`. Open Dental stores `(555) 123-4567`. The `LIKE %query%` match in `openDentalSync.js` won't match.

**Test:** see `cursor-audit/scripts/test-phone-normalization.js` (Phase A4 deliverable).

- [ ] Run against the production OD database (read-only).
- [ ] Confirm whether any common storage formats (`(555) 123-4567`, `555-123-4567`, `5551234567`) are missed.
- [ ] If yes: confirmed; ship phone normalization in P1.

### LK-03 — Open Dental REST timeouts hang the request

**Hypothesis:** `axios` calls in `openDental.js` set no `timeout`, so a slow OD instance can hang the dashboard request indefinitely.

**Test:**
- [ ] During a known slow period, time a `/api/open-dental/calendar?date=YYYY-MM-DD` request.
- [ ] If anything > 30 s without erroring, confirmed.
- [ ] Fix: add `timeout: 10000` to the axios instance.

### LK-04 — Mango Voice scraper breaks on UI changes

**Hypothesis:** Puppeteer selectors in `services/mangoScraper.js` are tightly coupled to the current Mango DOM. A UI update breaks them silently.

**Test:**
- [ ] Check `data/` and PM2 logs for the past 7 days. Are there any "Mango fetch failed" errors or empty result sets?
- [ ] If there are silent failures, confirmed.
- [ ] Mitigation: alerting on consecutive scrape failures + fallback to "data unavailable" UI state.

### LK-05 — `acquireTimeout`/`timeout` options silently ignored by `mysql2`

**Hypothesis:** Newer `mysql2/promise` versions ignore these options on `createPool`. The pool will still work, but timeouts won't fire.

**Test:**
```bash
cd backend
node -e "console.log(require('mysql2/package.json').version)"
```
- [ ] If `>= 3.0.0`, the options are likely ignored. Use `connectTimeout` for connection-establish timeout and `query()` callback / `Promise.race` for query timeout.

### LK-06 — `morgan('combined')` access logs may include phone numbers in URLs

**Hypothesis:** Some routes accept caller phone in the query string (e.g., patient lookup endpoints). morgan logs the full request line, so the number lands in `/var/log/...` plaintext.

**Test:**
- [ ] On the droplet: `pm2 logs --lines 500 | grep -E "phone|caller_number"`.
- [ ] If any phone number appears in URL form, confirmed.
- [ ] Fix: switch to a custom morgan format that redacts query strings, or move phone numbers to POST bodies.

---

## Part 3 — Items only ops can confirm

These cannot be checked from the repo at all. Bring this list to the deployment owner.

### Retell agent configuration

- [ ] Open Retell dashboard → the live agent prompt that answers calls.
- [ ] Confirm: does it instruct the AI to say "this call may be recorded" on the first turn?
- [ ] Confirm: does it tell the AI to direct medical emergencies (chest pain, can't breathe, severe bleeding) to **call 911**?
- [ ] Confirm: does it have any function-call tools attached (lookup, booking)? If no — the dashboard's "AgentBuilder" UI is decorative; nothing the AI says is configurable from this codebase.
- [ ] Save a copy of the current agent prompt + voice settings to a private place (this is the actual "config of record").

### Compliance

- [ ] Has a **BAA** (Business Associate Agreement) been signed with Retell AI? (Required to handle PHI.)
- [ ] Has a BAA been signed with **OpenAI**? (Currently `callAnalyzer.js` sends transcript snippets to OpenAI for summarization. Standard OpenAI API does not include a BAA — you need their Enterprise/ZDR tier.)
- [ ] Has a BAA been signed with **Deepgram**?
- [ ] Has a BAA been signed with **DigitalOcean**? (DO offers BAA on Premium support plans.)
- [ ] Has a BAA been signed with **Cloudflare**? (Required if cloudflared tunnel routes any PHI-bearing traffic.)
- [ ] Patient consent: are callers verbally informed that their call is recorded and that an AI is handling the call?

### Network exposure

- [ ] What ports are open on the droplet to the public internet? (Run `nmap` from outside.)
- [ ] Is the backend `:5000` reachable directly, or only via Nginx + Cloudflare tunnel?
- [ ] Is there a firewall rule restricting Retell's webhook source IPs?
- [ ] Is HTTPS enforced everywhere (no plain `http://carein-do.flamingketchup.com` access)?

### Disk & backup

- [ ] Is the droplet's disk encrypted at rest? (DigitalOcean: encryption is enabled by default on most volumes — verify in the control panel.)
- [ ] Is `data/unified_calls.json` (transcripts) backed up? Where? Encrypted? How long retained?
- [ ] Are call recordings stored in `backend/recordings/`? If yes, what's the retention policy? Encryption?
- [ ] Open Dental DB backups: encrypted? Off-site?

### Access controls

- [ ] Who has SSH access to the droplet? Is key-based auth enforced (no passwords)?
- [ ] Who has admin access to the Retell dashboard? Is 2FA on?
- [ ] Who has admin access to the GitHub repo?

---

## Part 4 — Sign-off

When every box in Part 1 is checked, the **P0-01 (key rotation)** item from `08-prioritized-fix-roadmap.md` is complete.

When every box in Parts 2 and 3 is checked, the **Likely** items in `11-evidence-and-confidence.md` can be promoted to **Confirmed** or **Refuted**, and the roadmap can be re-prioritized accordingly.

| Section                    | Owner | Date completed |
|----------------------------|-------|----------------|
| Part 1 — Key rotation      |       |                |
| Part 2 — Likely findings   |       |                |
| Part 3 — Ops verification  |       |                |
