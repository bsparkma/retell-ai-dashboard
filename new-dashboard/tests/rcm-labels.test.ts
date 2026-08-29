/**
 * Every vocabulary member must have words a biller can read.
 *
 * Slice 5.5 added ten review reasons and flags to the backend and shipped them
 * with no frontend change, so they rendered as raw snake_case slugs — on
 * proposals they were also blocking. `rcmVocabulary.js` exists precisely so
 * that cannot happen, and this is the test that makes the promise enforceable
 * rather than aspirational.
 *
 * It reads the BACKEND vocabulary source, so adding a reason there without a
 * label here fails the dashboard suite. That is the point: the two files are a
 * pair, and nothing else was keeping them together.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  REVIEW_LABELS,
  FLAG_LABELS,
  FAILURE_LABELS,
  LINE_FLAG_LABELS,
  REASON_GATE,
  isBlockingReason,
  reviewLabel,
  label,
} from "../client/src/features/rcm/labels";
// Slice 6c — the attention vocabulary and the drain's own copy maps.
import { ATTENTION_LABELS, OBSERVATION_LABELS } from "../client/src/features/rcm/format";
import {
  blockedCopy,
  LINE_STATE_COPY,
  QUEUE_STATE_COPY,
  SHADOW_MODE_COPY,
  SHADOW_REFUSAL_SLUG,
} from "../client/src/features/rcm/posting";
import { QUEUE_COLLISION_COPY } from "../client/src/features/rcm/api";
// The RCM UX slice — the approval checklist's biller-language copy.
import {
  CHECK_COPY,
  checkDetail,
  checkTitle,
  checkWhy,
} from "../client/src/features/rcm/checks";

const VOCAB = fs.readFileSync(
  path.join(__dirname, "..", "..", "backend", "services", "rcm", "rcmVocabulary.js"),
  "utf8",
);

/**
 * Pull the string values out of one `const NAME = Object.freeze(...)` block.
 *
 * The vocabulary uses both shapes — an object of NAME: 'value' pairs for the
 * review reasons, a bare array for the flags — so this scans to whichever
 * closing token comes first rather than trying to express both in one regex.
 */
function members(name: string): string[] {
  const open = VOCAB.indexOf(`const ${name} = Object.freeze(`);
  expect(open, `rcmVocabulary.js must declare ${name}`).toBeGreaterThan(-1);

  // Scan to whichever closing token comes first. Neither sequence occurs inside
  // a vocabulary body, so a plain indexOf is enough and needs no escaping.
  const rest = VOCAB.slice(open);
  const ends = ["});", "]);"].map((t) => rest.indexOf(t)).filter((i) => i > -1);
  expect(ends.length, `${name} must be closed`).toBeGreaterThan(0);

  const body = rest.slice(0, Math.min(...ends));
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

describe("the RCM vocabulary is fully labelled", () => {
  it("labels every ERA review reason", () => {
    const unlabelled = members("ERA_REVIEW_REASONS").filter((r) => !REVIEW_LABELS[r]);
    expect(unlabelled, `unlabelled ERA review reasons: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every EOB review reason", () => {
    const unlabelled = members("EOB_REVIEW_REASONS").filter((r) => !REVIEW_LABELS[r]);
    expect(unlabelled, `unlabelled EOB review reasons: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every remittance flag", () => {
    const unlabelled = members("REMITTANCE_FLAGS").filter((f) => !FLAG_LABELS[f]);
    expect(unlabelled, `unlabelled remittance flags: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every EOB failure code", () => {
    const unlabelled = members("EOB_FAILURE_CODES").filter((c) => !FAILURE_LABELS[c]);
    expect(unlabelled, `unlabelled failure codes: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("reads the parameterised uncertain_line reason", () => {
    // The one member no lookup table can hold.
    expect(reviewLabel("uncertain_line:3")).toBe("Line 3 was read with low confidence");
    expect(reviewLabel("uncertain_line:12")).toBe("Line 12 was read with low confidence");
  });

  it("falls back to the slug rather than hiding an unknown value", () => {
    // A reason that vanished would make a proposal look cleaner than it is.
    expect(reviewLabel("something_new_from_the_backend")).toBe("something_new_from_the_backend");
    expect(label(FLAG_LABELS, "not_a_flag")).toBe("not_a_flag");
  });

  it("caught the exact members Slice 5.5 shipped unlabelled", () => {
    // Named individually so a regression points at the review that found them.
    for (const reason of [
      "unreadable_amount",
      "allowed_amount_mismatch",
      "partial_adjustment_segment",
      "claim_level_adjustments_present",
      "patient_resp_mismatch",
      "claim_line_allowed_mismatch",
      "totals_unreconciled",
    ]) {
      expect(REVIEW_LABELS[reason], reason).toBeTruthy();
      expect(reviewLabel(reason)).not.toBe(reason);
    }
    for (const flag of ["envelope_counts_mismatch", "envelope_incomplete", "multi_transaction_file"]) {
      expect(FLAG_LABELS[flag], flag).toBeTruthy();
    }
  });
});

/**
 * D-11's map is mirrored on the client so a chip can be coloured without a round
 * trip — and `labels.ts` says in its own header that a test keeps the two
 * honest. This is that test. It did not exist when the header claimed it did,
 * which is worse than no claim at all.
 *
 * A screen showing a reason in amber while the gate lets it through — or, far
 * worse, in grey while the gate withholds it — is the honest-states rule failing
 * in the most expensive place there is.
 */
describe("the D-11 gate map does not drift from the backend", () => {
  /** Pull `REASON_GATE`'s verdicts out of the backend source. */
  function backendGate(): Record<string, string> {
    const open = VOCAB.indexOf("const REASON_GATE = Object.freeze({");
    expect(open, "rcmVocabulary.js must declare REASON_GATE").toBeGreaterThan(-1);
    const body = VOCAB.slice(open, VOCAB.indexOf("});", open));
    // Strip block and line comments: half the map is prose explaining a verdict,
    // and prose is not an entry.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const out: Record<string, string> = {};
    for (const m of code.matchAll(/([a-z0-9_]+):\s*'(blocking|annotating)'/g)) out[m[1]] = m[2];
    return out;
  }

  it("agrees with the backend about every single slug", () => {
    const gate = backendGate();
    expect(Object.keys(gate).length).toBeGreaterThan(30);

    const disagreements: string[] = [];
    for (const [reason, verdict] of Object.entries(gate)) {
      const mine = REASON_GATE[reason];
      if (mine !== verdict) {
        disagreements.push(`${reason}: backend says ${verdict}, client says ${mine ?? "nothing"}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("names nothing the backend does not", () => {
    // A client-only verdict would paint a chip the gate disagrees with — a
    // screen arguing with the server about what stops a posting.
    const gate = backendGate();
    const orphans = Object.keys(REASON_GATE).filter((r) => !(r in gate));
    expect(orphans, `client verdicts the backend has none for: ${orphans.join(", ")}`).toEqual([]);
  });

  it("fails closed on an unknown slug, exactly like the backend", () => {
    expect(isBlockingReason("a_reason_nobody_has_written_yet")).toBe(true);
    expect(isBlockingReason("uncertain_line:3")).toBe(true);
    // And an annotating one really does read as not-blocking.
    expect(isBlockingReason("procedure_downcoded")).toBe(false);
    expect(isBlockingReason("allowed_amount_mismatch")).toBe(false);
  });

  it("labels every line flag, including the three Slice 5.5 added", () => {
    const unlabelled = members("LINE_FLAGS").filter((f) => !LINE_FLAG_LABELS[f]);
    expect(unlabelled, `unlabelled line flags: ${unlabelled.join(", ")}`).toEqual([]);
  });
});

/**
 * Slice 6c — the two maps the drain added, pinned against the backend the same
 * way the vocabulary above is.
 *
 * The 6b review found `labels.ts` describing a drift test that did not exist,
 * and on its first run that test caught the client failing OPEN on an unknown
 * slug. These two maps are the same shape of promise — "every reason a screen
 * can be handed has words a biller can read" — so they get the same enforcement
 * rather than a comment saying they should.
 */
describe("the drain's vocabularies", () => {
  const REMITTANCES = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "routes", "rcm", "remittances.js"),
    "utf8",
  );
  const DRAIN = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "services", "rcm", "postingDrain.js"),
    "utf8",
  );

  /** Every `reasons.push('x')` / `observations.push('x')` literal in the source. */
  function pushed(kind: "reasons" | "observations"): string[] {
    const found = new Set<string>();
    const re = new RegExp(`${kind}\\.push\\(\\s*'([a-z_]+)'`, "g");
    for (const m of REMITTANCES.matchAll(re)) found.add(m[1]);
    return [...found];
  }

  it("labels every attention OBLIGATION the list can raise", () => {
    const reasons = pushed("reasons");
    // Guard the guard: a regex that matched nothing would pass vacuously.
    expect(reasons).toContain("posting_failed");
    const unlabelled = reasons.filter((r) => !ATTENTION_LABELS[r]);
    expect(unlabelled, `unlabelled obligations: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every attention OBSERVATION the list can raise", () => {
    // `batch_${status}` is built from the batch status and is covered by its own
    // entries; only the literals are checked here.
    const observations = pushed("observations");
    expect(observations).toContain("claims_posted");
    expect(observations).toContain("claims_queued");
    const unlabelled = observations.filter((o) => !OBSERVATION_LABELS[o]);
    expect(unlabelled, `unlabelled observations: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("writes copy for every reason the drain can BLOCK a plan with", () => {
    /*
     * `blocked` means a human is being told to go do something. A slug with no
     * copy renders as itself, which tells them nothing — the exact failure the
     * fail-closed fallback in posting.ts exists to soften and this test exists to
     * stop happening at all.
     */
    /*
     * SCOPED TO `BLOCK_REASONS`, not to the whole file.
     *
     * This scraped every `NAME: 'slug',` line in postingDrain.js, which worked
     * only while that file had exactly one such map. The withdraw slice added a
     * second (`WITHDRAW_REASONS`) and this test immediately demanded BLOCKED
     * copy for `target_removed` and `manual` — reasons a plan can never be
     * blocked with. A drift test that reads a vocabulary by shape rather than by
     * name drifts onto the next thing shaped like it.
     */
    const reasonBlock = DRAIN.match(/const BLOCK_REASONS = Object\.freeze\(\{([\s\S]+?)^\}\);/m);
    expect(reasonBlock, "BLOCK_REASONS is no longer where this test looks").not.toBeNull();
    const slugs = [...reasonBlock![1].matchAll(/^\s+[A-Z_]+:\s*'([a-z_]+)',$/gm)].map((m) => m[1]);
    const blockReasons = slugs.filter((s) => s !== "already_received_matching");
    expect(blockReasons.length).toBeGreaterThan(5);
    // The withdrawal reasons live in their own map and are NOT block reasons.
    expect(blockReasons).not.toContain("target_removed");
    expect(blockReasons).not.toContain("manual");

    const missing = blockReasons.filter((r) => {
      const copy = blockedCopy(r);
      // The fallback returns the slug with its underscores swapped for spaces;
      // anything that produces THAT has no real copy written for it.
      return !copy || copy.label === r.replace(/_/g, " ");
    });
    expect(missing, `block reasons with no copy: ${missing.join(", ")}`).toEqual([]);
  });

  it("still fails closed on a block reason nobody has written copy for", () => {
    const copy = blockedCopy("a_refusal_from_a_later_slice");
    expect(copy).not.toBeNull();
    expect(copy!.label).toBe("a refusal from a later slice");
    expect(copy!.fix).toMatch(/no Open Dental call was made/);
    // And null in means null out — an unblocked plan shows no chip.
    expect(blockedCopy(null)).toBeNull();
  });

  it("labels every per-line state the CHECK constraint can hold", () => {
    /*
     * READ FROM THE MIGRATION THAT OWNS THE VOCABULARY *NOW*, which is 6d's.
     *
     * 6d added `recouped` by dropping and re-adding the CHECK, so the 6c
     * migration's list is no longer what the database will accept. A drift test
     * pointed at a superseded constraint is a drift test that stops drifting —
     * it would have passed while the client had no copy for a state a row can
     * really hold.
     */
    const MIGRATION = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "backend",
        "migrations-tenant",
        "1787260000000_rcm_recoupment_and_documents.js",
      ),
      "utf8",
    );
    const block = MIGRATION.match(/const LINE_STATUSES = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const states = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(states).toContain("skipped_already_posted");
    expect(states).toContain("recouped");

    const unlabelled = states.filter((s) => !(s in LINE_STATE_COPY));
    expect(unlabelled, `unlabelled line states: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("labels every plan state, and invents none the database cannot store", () => {
    /*
     * READ FROM THE MIGRATION THAT OWNS THE VOCABULARY *NOW*.
     *
     * The same trap the line-state test above already fell into once: this read
     * 6c's `QUEUE_STATUSES` long after a later migration re-keyed the CHECK. A
     * drift test pointed at a superseded constraint stops drifting — it passes
     * happily while the client has no copy for a state a row can really hold.
     */
    const MIGRATION = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "backend",
        "migrations-tenant",
        "1787300000000_rcm_posting_withdraw.js",
      ),
      "utf8",
    );
    const block = MIGRATION.match(/const QUEUE_STATUSES = \[([\s\S]+?)\];/);
    const stored = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(stored).toContain("blocked");
    expect(stored).toContain("withdrawn");

    /*
     * The client maps a LABEL to copy, never a stored word — the server ships
     * both — so what is checked here is that every stored word has SOME label the
     * server could send, and that the copy map holds nothing extra.
     */
    const labels = new Set(Object.keys(QUEUE_STATE_COPY));
    const serverLabels = new Set([
      "queued",
      "running",
      "posted",
      "partially_posted",
      "failed",
      "blocked",
      "withdrawn",
    ]);
    expect([...labels].filter((l) => !serverLabels.has(l))).toEqual([]);
    expect([...serverLabels].filter((l) => !labels.has(l))).toEqual([]);
    expect(stored.length).toBe(serverLabels.size);
  });
});

/**
 * The shadow gate — the refusal a biller reads most, in the weeks before posting
 * is switched on.
 *
 * The gate's slug is NOT a `blocked_reason`: no plan moves to `blocked` when
 * the switch is off, the refusal belongs to the route, and the plans stay
 * `approved`. That disjointness is the thing worth pinning — a slug that leaked
 * into `BLOCK_REASONS` would put a reason describing a PRACTICE into a map
 * whose every other member describes a ROW.
 */
describe("the shadow gate's words", () => {
  const GATE = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "services", "rcm", "postingGate.js"),
    "utf8",
  );
  const DRAIN_SRC = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "services", "rcm", "postingDrain.js"),
    "utf8",
  );

  it("uses the slug the backend actually sends", () => {
    const m = GATE.match(/const DRAIN_DISABLED = '([a-z_]+)';/);
    expect(m, "postingGate.js must declare DRAIN_DISABLED").not.toBeNull();
    expect(SHADOW_REFUSAL_SLUG).toBe(m![1]);
  });

  it("is not, and must never become, a per-plan block reason", () => {
    const reasonBlock = DRAIN_SRC.match(/const BLOCK_REASONS = Object\.freeze\(\{([\s\S]+?)^\}\);/m);
    expect(reasonBlock).not.toBeNull();
    const slugs = [...reasonBlock![1].matchAll(/^\s+[A-Z_]+:\s*'([a-z_]+)',$/gm)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(5);
    expect(slugs).not.toContain(SHADOW_REFUSAL_SLUG);
    // And the client has written no BLOCKED copy for it either — a chip for it
    // would render over a plan that is not blocked.
    expect(blockedCopy(SHADOW_REFUSAL_SLUG)!.label).toBe(SHADOW_REFUSAL_SLUG.replace(/_/g, " "));
  });

  it("says the same thing everywhere it is said", () => {
    /*
     * THREE SCREENS, ONE STRING. The Posting page's badge, its Drain button's
     * adjacent reason, and the RCM inbox's badge all read from this one object,
     * so a copy edit cannot land on two of them and miss the third.
     */
    expect(SHADOW_MODE_COPY.badge).toBe("Shadow");
    expect(SHADOW_MODE_COPY.reason("Roland")).toBe(
      "Posting is switched off for Roland (shadow mode). Approved plans wait here.",
    );
    expect(SHADOW_MODE_COPY.hint).toContain("Approved plans wait here");
  });

  it("never calls a switched-off practice an error", () => {
    /*
     * Nothing is wrong. The biller did her job, the plan is approved, and it is
     * SUPPOSED to sit there. Copy that said "failed" or "error" would send her
     * looking for a mistake she did not make.
     */
    const all = [
      SHADOW_MODE_COPY.badge,
      SHADOW_MODE_COPY.hint,
      SHADOW_MODE_COPY.fix,
      SHADOW_MODE_COPY.reason("Roland"),
    ].join(" ");
    for (const word of ["error", "failed", "failure", "problem", "wrong", "broken"]) {
      expect(all.toLowerCase(), `the shadow copy must not say "${word}"`).not.toContain(word);
    }
  });

  it("tells the biller what happens to the work she already did", () => {
    // The one thing the sentence has to do: stop her wondering whether the
    // approvals she just made are lost.
    expect(SHADOW_MODE_COPY.reason("Roland")).toMatch(/wait/i);
    expect(SHADOW_MODE_COPY.hint).toMatch(/wait/i);
    // And the banner says who can end it.
    expect(SHADOW_MODE_COPY.fix).toMatch(/administrator/i);
  });

  it("sends her to a page that is actually called that", () => {
    /*
     * THE DIRECTION IN THE COPY IS A CLAIM ABOUT TWO OTHER FILES.
     *
     * `fix` says "Admin → Office": the nav item in DashboardLayout.tsx and the
     * tab in Admin.tsx. Neither is importable — the nav array and the tab array
     * are both module-private literals — so this reads the source, the same way
     * `takebackLaneAgreement.test.js` pins the isTakeback callers.
     *
     * It is not hypothetical. The string said "Offices" while the tab said
     * "Office" from the day the card shipped, which is precisely the drift a
     * rename would cause and nothing would have caught.
     */
    const read = (p: string) =>
      fs.readFileSync(path.join(__dirname, "..", "client", "src", ...p.split("/")), "utf8");

    const navLabel = read("components/DashboardLayout.tsx").match(
      /path:\s*"\/admin",\s*label:\s*"([^"]+)"/,
    );
    expect(navLabel, "the /admin nav item moved — update this test and the copy").toBeTruthy();

    const tabLabel = read("pages/Admin.tsx").match(
      /\{\s*id:\s*"offices",\s*label:\s*"([^"]+)"/,
    );
    expect(tabLabel, "the offices tab moved — update this test and the copy").toBeTruthy();

    /*
     * A WORD BOUNDARY, not `toContain`. "Admin → Offices" CONTAINS
     * "Admin → Office", so a substring assertion passes on exactly the drift
     * this test exists to catch — which it did, on the first run.
     */
    const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expected = new RegExp(`${escape(navLabel![1])} → ${escape(tabLabel![1])}\\b(?!s)`);
    expect(
      SHADOW_MODE_COPY.fix,
      `the copy must send her to "${navLabel![1]} → ${tabLabel![1]}", exactly as those two are labelled`,
    ).toMatch(expected);
  });
});

/**
 * Slice 6c — the two queue-collision refusal codes.
 *
 * The approval panel renders the SERVER's sentence, which varies by plan status
 * and is always the better one. What this pins is that the client knows both
 * codes exist: a code the backend can throw and the client has never heard of
 * reaches a biller as a blank toast, which is the same failure shape as an
 * unlabelled reason slug one level up.
 */
describe("the queue-collision refusals", () => {
  const GATE = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "routes", "rcm", "approvalGate.js"),
    "utf8",
  );

  it("knows every queue-collision code the gate can throw", () => {
    const thrown = [...GATE.matchAll(/'(QUEUE_ALREADY_[A-Z]+)'/g)].map((m) => m[1]);
    expect(new Set(thrown)).toEqual(new Set(["QUEUE_ALREADY_RUNNING", "QUEUE_ALREADY_RAN"]));

    const unknown = thrown.filter((c) => !QUEUE_COLLISION_COPY[c]);
    expect(unknown, `codes with no client copy: ${unknown.join(", ")}`).toEqual([]);
  });

  it("does not say the same thing twice — the two codes mean opposite advice", () => {
    // RUNNING: waiting is the answer. RAN: waiting will never help.
    expect(QUEUE_COLLISION_COPY.QUEUE_ALREADY_RUNNING).not.toBe(
      QUEUE_COLLISION_COPY.QUEUE_ALREADY_RAN,
    );
    expect(QUEUE_COLLISION_COPY.QUEUE_ALREADY_RUNNING).toMatch(/wait/i);
    expect(QUEUE_COLLISION_COPY.QUEUE_ALREADY_RAN).toMatch(/by hand in Open Dental/i);
    expect(QUEUE_COLLISION_COPY.QUEUE_ALREADY_RAN).not.toMatch(/under way/i);
  });

  it("names nothing the backend cannot throw", () => {
    const thrown = new Set([...GATE.matchAll(/'(QUEUE_ALREADY_[A-Z]+)'/g)].map((m) => m[1]));
    const orphans = Object.keys(QUEUE_COLLISION_COPY).filter((c) => !thrown.has(c));
    expect(orphans, `client copy for codes the gate never sends: ${orphans.join(", ")}`).toEqual([]);
  });
});

/**
 * The RCM UX slice — every approval check has three strings, and two of them
 * are never the same one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST IS SHAPED LIKE THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * `approvalGate.js` owns WHICH conditions exist; `features/rcm/checks.ts` owns
 * what a biller reads. Two files for one list is exactly the arrangement that
 * went stale in Slice 5.5 and produced raw slugs on a blocking proposal, so it
 * is enforced the same way: this test reads the gate's own `CHECKS` block and
 * fails if a code has no copy here.
 *
 * The second half is §15.2's copy bug. `add('SNAPSHOT_CURRENT', usable, <a
 * ternary chain>)` evaluates its chain whether the check passed or not, so a
 * PASSING row printed "the confirmed claim is not among the candidates the
 * match recorded" beside a green tick. The rule that prevents it is that the
 * passing string and the failing string come from DIFFERENT FIELDS — and this
 * asserts they are also different WORDS, because a copy edit that made them
 * equal would restore the confusion without restoring the bug.
 */
describe("the approval checklist speaks a biller's language", () => {
  const GATE = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "routes", "rcm", "approvalGate.js"),
    "utf8",
  );

  /** Every key of the gate's own `CHECKS = Object.freeze({ ... })`. */
  function checkCodes(): string[] {
    const open = GATE.indexOf("const CHECKS = Object.freeze({");
    expect(open, "approvalGate.js must declare CHECKS").toBeGreaterThan(-1);
    const end = GATE.indexOf("\n});", open);
    expect(end, "CHECKS must be closed").toBeGreaterThan(open);
    const body = GATE.slice(open, end);
    return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)].map((m) => m[1]);
  }

  it("reads a real list off the gate rather than an empty one", () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, which is the way this kind of test dies quietly.
    const codes = checkCodes();
    expect(codes.length).toBeGreaterThanOrEqual(12);
    expect(codes).toContain("MATCH_CONFIRMED");
    expect(codes).toContain("SNAPSHOT_CURRENT");
  });

  it("has a title, a failure instruction and a pass confirmation for every check", () => {
    const missing = checkCodes().filter((code) => {
      const copy = CHECK_COPY[code];
      return !copy || !copy.title || !copy.fail || !copy.pass;
    });
    expect(missing, `checks with no biller-language copy: ${missing.join(", ")}`).toEqual([]);
  });

  it("names no check the gate does not evaluate", () => {
    const codes = new Set(checkCodes());
    const orphans = Object.keys(CHECK_COPY).filter((c) => !codes.has(c));
    expect(orphans, `copy for checks that do not exist: ${orphans.join(", ")}`).toEqual([]);
  });

  it("never prints the failure text on a check that passed — §15.2's copy bug", () => {
    for (const code of checkCodes()) {
      const copy = CHECK_COPY[code];
      expect(copy.pass, `${code} pass detail equals its failure detail`).not.toBe(copy.fail);
    }
  });

  it("starts every failure detail with a verb", () => {
    /*
     * "what to DO, starting with a verb" is the rule, and it is checkable:
     * the gate's own wording began "The match record is current and complete"
     * and "At least one procedure line has no ClaimProcNum" — descriptions of
     * a state, which is what left a biller reading five ✗ marks with nothing
     * to act on.
     */
    const notAVerb = /^(the|a|an|this|it|there|every|no|nobody|at least)\b/i;
    const offenders = checkCodes().filter((c) => notAVerb.test(CHECK_COPY[c].fail));
    expect(offenders, `failure details that do not start with a verb: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("keeps pass confirmations short — one line, not a restatement", () => {
    const long = checkCodes().filter((c) => CHECK_COPY[c].pass.length > 60);
    expect(long, `pass details that are not one short confirmation: ${long.join(", ")}`).toEqual([]);
  });

  it("renders the pass string on a pass and the instruction on a failure", () => {
    const passed = {
      code: "REVIEWED",
      label: "Reviewed by a person",
      passed: true,
      detail: null,
      fix: "Mark the claim reviewed, with a note.",
    };
    expect(checkTitle(passed)).toBe("Reviewed");
    expect(checkDetail(passed)).toBe("Reviewed.");
    expect(checkWhy(passed)).toBeNull();

    const failed = { ...passed, passed: false, detail: "nobody has dispositioned this claim" };
    expect(checkDetail(failed)).toBe("Add a note and mark this claim reviewed.");
    expect(checkWhy(failed)).toBe("nobody has dispositioned this claim");
  });

  it("drops the gate's leftover failure sentence from a PASSING SNAPSHOT_CURRENT", () => {
    /*
     * The bug, reproduced. The gate really does send this string with
     * `passed: true`, because its ternary chain has no branch for success.
     */
    const asTheGateSendsIt = {
      code: "SNAPSHOT_CURRENT",
      label: "The match record is current and complete",
      passed: true,
      detail: "the confirmed claim is not among the candidates the match recorded",
      fix: "Run the match again and re-confirm it.",
    };
    expect(checkDetail(asTheGateSendsIt)).toBe("Up to date.");
    expect(checkDetail(asTheGateSendsIt)).not.toContain("not among the candidates");
    expect(checkWhy(asTheGateSendsIt)).toBeNull();
  });

  it("keeps the one passing detail that IS a fact", () => {
    // MATCH_CONFIRMED sends `ClaimNum 53784` on a pass, which is worth reading.
    const linked = {
      code: "MATCH_CONFIRMED",
      label: "Matched to an Open Dental claim",
      passed: true,
      detail: "ClaimNum 53784",
      fix: "Open the claim, run the match, and confirm the right one.",
    };
    expect(checkDetail(linked)).toContain("53784");
  });

  it("falls back to the gate's own words for a check nobody has re-worded", () => {
    // FAIL READABLE, like every other map in this module. An unmapped code must
    // render the server's sentence rather than nothing.
    const future = {
      code: "SOME_FUTURE_CHECK",
      label: "The server's own label",
      passed: false,
      detail: null,
      fix: "The server's own fix.",
    };
    expect(checkTitle(future)).toBe("The server's own label");
    expect(checkDetail(future)).toBe("The server's own fix.");
  });
});
