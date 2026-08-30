'use strict';

/**
 * /api/rcm — the Revenue Cycle Management module (Slice 3: the mount).
 *
 * ONE mount in server.js, behind requireModule('rcm') + the rcm.read/rcm.write
 * permission pair. Ships DARK in the same sense TC did: no tenant is entitled
 * to 'rcm' yet, so every route below 403s MODULE_NOT_ENTITLED in every
 * environment until Beau flips the entitlement from the Platform Console.
 *
 * Slice 3 was PLUMBING. Two endpoints existed to prove the chain end to end and
 * to give Slices 4–7 a door to build behind:
 *   GET  /summary   per-office counts across claims / batches / posting queue
 *   GET  /claims    office-scoped claim list, paginated
 *
 * Slice 4 added EOB ingestion, and with it the module's first mutation:
 *   POST /eob       multipart PDF → Blob + rcm_eob_uploads row + queued extraction
 *   GET  /eob       office-scoped upload list + the extraction cost-breaker state
 *
 * Slice 5 added the machine-readable source alongside it:
 *   POST /era       multipart 835 → Blob + parsed proposals, deduplicated by
 *                   the office-scoped remittance key
 *   GET  /era       office-scoped upload list with each remittance's dedupe state
 *
 * The two are deliberately siblings rather than one endpoint: an EOB PDF must
 * be READ by a model and can be wrong, an 835 is PARSED and can only be
 * malformed. They produce the same rcm_* proposal rows and share nothing else.
 *
 * Slice 6a turned the module from an intake pipe into something a biller can
 * open. It added the review workbench and the Open Dental matching underneath
 * it — and the module's FIRST Open Dental traffic, which is GET-only:
 *   GET  /remittances[/:id]        the list and the detail
 *   POST /remittances/:id/match    sequential, paced batch match
 *   GET  /claims/:id               one claim: lines, adjustments, snapshot
 *   POST /claims/:id/match         read OD, rank candidates, store a snapshot
 *   POST /claims/:id/confirm-match a human picks one       (attributed, D-5)
 *   POST /claims/:id/review        worklist hygiene         (attributed, D-5)
 *   GET  /uploads/:id/document     the authorised source-document proxy
 *
 * Slice 6b made the workbench's Approve button real — and it is the first thing
 * under this mount that AUTHORISES money to move, without moving any:
 *   GET  /remittances/:id/approval  the pre-flight checklist, per claim
 *   POST /remittances/:id/approve   write the posting plan   (attributed, D-5)
 *
 * ZERO OPEN DENTAL WRITES, AND ZERO OPEN DENTAL CALLS ON THE APPROVE PATH.
 *
 * The only transport reachable from the match layer is `apiGetRaw` on the
 * office's own client, which has no write counterpart. The approval gate reaches
 * no Open Dental module at all: it re-reads what a match already recorded and
 * writes an intent. `rcmNoOdWrites.test.js` drives approve to SUCCESS against a
 * client whose every verb throws and asserts not one was called — approving is
 * not posting, and that is a test rather than a sentence. It also names the one
 * file allowed to write `rcm_posting_queue` (./approvalGate.js).
 *
 * `POST /remittances/:id/approve` is deliberately NOT in QUEUE_PATHS below, so
 * the mount's requireReadWrite demands `rcm.write` for it by construction. The
 * CHECKLIST beside it is a GET and therefore runs on `rcm.read`, which the
 * `reviewer` tier holds: seeing why a claim is withheld is not a posting act.
 *
 * The shadow gate added the module's narrowest tier on top of all of this.
 * `POST /posting/drain`, `POST /posting/queue/:id/withdraw` and
 * `POST /posting/queue/:id/attach-document` each carry an explicit
 * `requirePermission('rcm.post')`, and `GET|PUT /office-settings/:office` carry
 * `requirePermission('rcm.settings')`. `rcm_biller` holds `rcm.read`,
 * `rcm.queue` and `rcm.write` and neither of those two — a biller uploads,
 * matches, confirms, reviews and APPROVES, and stops at the chart.
 *
 * The same is true of 6d's two additions. `POST /remittances/:id/approve-
 * recoupment` and `POST /posting/queue/:id/attach-document` are BOTH absent from
 * QUEUE_PATHS, so both demand `rcm.write` by construction — a `reviewer` never
 * reaches either handler. Their GET counterparts (`/remittances/:id/recoupment`,
 * the posting detail) run on `rcm.read`, so the person who did the reviewing can
 * see what a takeback would do without being able to authorise it.
 *
 * NOT here, and not yet: reconciliation, VCC and metrics (8/9), Stedi, and the
 * patient-portion flow (PRD-deferred; the key is not entitled for it at all).
 * The only tables anything under this mount touches are rcm_* and the platform
 * audit_log.
 */

const express = require('express');

const { requireOffice } = require('./helpers');

const router = express.Router();

/**
 * OFFICE SCOPING IS ROUTER-WIDE, AND THAT IS THE ORDERING CONSTRAINT.
 *
 * `requireOffice` is registered BEFORE every route mount below, so every route
 * in this module — including one added next year by someone who never read this
 * file — gets `?office=roland|valley` validated before its handler runs and
 * finds it on req.rcmOffice. Office therefore comes from the server-validated
 * query param on every RCM route, never from a body, a header, or a default.
 *
 * The TC module learned this the hard way in the opposite direction: its voice
 * handoff carries office in the BODY (a frozen external contract), so
 * `/cases/from-call` MUST be registered above the `/cases` router that applies
 * requireOffice — express matches mounts in registration order, and getting
 * that order wrong 400s a live integration. See routes/tc/index.js.
 *
 * RCM has no such exception today, and this ordering is what keeps it that way.
 * If one ever becomes necessary, it must be mounted ABOVE this line, with the
 * reason written at the mount — and `rcmMountOrder.test.js` will fail until it
 * is added to that test's documented-exception list, so the exception cannot be
 * introduced silently.
 */
router.use(requireOffice);

/**
 * THE QUEUE ROUTES — the enumerated exceptions to the mount's write gate (D-9).
 *
 * The mount is `requireReadWrite('rcm.read', 'rcm.write')`, applied by HTTP
 * METHOD, so every POST under /api/rcm demands `rcm.write` by default. These
 * three are POSTs that a read-tier reviewer must be able to press: running a
 * match reads Open Dental and changes no chart, and marking a claim reviewed
 * has no Open Dental effect at all. They are exempted from the pair at the
 * mount and each carries its own `requirePermission('rcm.queue')` instead — the
 * "a specific gate narrows the general one" idiom config/permissions.js
 * documents, used here to WIDEN by one tier rather than to narrow.
 *
 * Mount-relative and anchored: `/claims/:id/confirm-match` must not match, and
 * a new POST added under either router must not accidentally land inside one.
 * `rcmGuard.test.js` walks every route in this module and fails if a path is
 * exempted here without its own gate.
 *
 * @type {ReadonlyArray<RegExp>}
 */
const QUEUE_PATHS = Object.freeze([
  /^\/claims\/[^/]+\/match$/,
  /^\/claims\/[^/]+\/review$/,
  /*
   * THE PER-LINE WRITE-OFF DECISION (Stage B1). Same tier, same argument as the
   * review marker above it.
   *
   * It writes four columns on one of OUR rows and reaches no chart, no posting
   * and no other claim. Deciding that the office absorbs a line is the reviewing
   * act; authorising money to move is `rcm.write`, at the gate, and this route
   * cannot reach it.
   */
  /^\/claims\/[^/]+\/lines\/[^/]+\/decision$/,
  /^\/remittances\/[^/]+\/match$/,
  /*
   * THE FOUR WORKLIST STATES (Stage A). Same tier, same argument.
   *
   * Parking a check and setting one aside change WHICH QUEUE a remittance
   * appears in and nothing else — no Open Dental call, no chart, no plan, no
   * money. `POST /claims/:id/review` has been exempted here since 6a for exactly
   * that reason, and it ALSO takes a remittance out of the needs-attention view.
   * A `reviewer` who can disposition every claim on a check must be able to say
   * "I am coming back to this one" about the check.
   *
   * Both are REVERSIBLE, which is what separates them from every other way of
   * taking something off this module's board: `withdrawn` is terminal, and it
   * lives on `rcm.post` beside the drain.
   */
  /^\/remittances\/[^/]+\/park$/,
  /^\/remittances\/[^/]+\/unpark$/,
  /^\/remittances\/[^/]+\/set-aside$/,
  /^\/remittances\/[^/]+\/restore$/,
]);

router.use('/summary', require('./summary'));
router.use('/claims', require('./claims'));
// Slice 4. The module's first WRITE surface — POST /eob is what the unused
// rcm.write action at the server.js mount has been waiting for. It stores a PDF
// and queues an extraction; the extraction produces PROPOSAL rows in rcm_*.
// Still no Open Dental anywhere under this mount (eobNoOdImports.test.js).
router.use('/eob', require('./eob'));
// Slice 5. The same shape for the machine-readable source: an 835 is parsed
// rather than read by a model, so it needs no extraction queue — but it lands
// in the same rcm_* proposal tables, behind the same rcm.write demanded by the
// mount's requireReadWrite for every non-GET method, and the same
// requireOffice above. Still no Open Dental (eraNoOdImports covers this one).
router.use('/era', require('./era'));
// Slice 6a — the review workbench, and Slice 6b's approval gate on top of it.
// `/remittances` is the screen a biller opens a check on; `/uploads/:id/document`
// is the authorised proxy back to the bytes it was parsed from. Both sit BELOW
// requireOffice like everything else, so a cross-office read is a miss rather
// than a refusal somebody had to remember.
router.use('/remittances', require('./remittances'));
router.use('/uploads', require('./documents'));
/*
 * Slice 6c — THE DRAIN. The first Open Dental WRITE under this mount, and the
 * only one anywhere in the module.
 *
 *   GET  /posting/queue[/:id]  the plans, their states, the read-back evidence
 *   POST /posting/drain        write to a patient's chart
 *
 * `POST /posting/drain` is deliberately NOT in QUEUE_PATHS, so the mount's
 * requireReadWrite demands `rcm.write` for it by construction — a `reviewer`
 * never reaches the handler. The two GETs are GETs and therefore run on
 * `rcm.read`, which `reviewer` holds: watching a plan post, and reading why one
 * is blocked, is not a posting act.
 *
 * There is NO cron and no timer behind this. A human presses the button. The one
 * automatic thing is the startup sweep wired in server.js, which re-homes rows a
 * dead process left mid-flight back to `approved` — it does not drain.
 *
 * `rcmNoOdWrites.test.js` still guards the module, in a stronger form: exactly
 * ONE file may reach an Open Dental write verb
 * (`services/rcm/odPostingWrites.js`), driving every other surface still yields
 * no write verb at all, and driving the drain yields exactly the forced order's
 * verbs, in order, and nothing else.
 */
router.use('/posting', require('./posting'));
/*
 * THE SHADOW GATE'S SWITCH.
 *
 *   GET  /office-settings/:office   the state, who last changed it, when
 *   PUT  /office-settings/:office   flip it
 *
 * Both carry their own `requirePermission('rcm.settings')` — `admin` and
 * nothing else, narrower than the `rcm.post` that presses Drain. NOT in
 * QUEUE_PATHS: the PUT is a mutation and must clear the mount's `rcm.write`
 * before the narrower gate even runs, and the GET is a GET.
 *
 * Two conditions gate an Open Dental write in this module and neither replaces
 * the other: `OFFICES_ENABLED_FOR_POSTING` says a practice has been VALIDATED
 * (a code change, with the evidence in the same commit — §9), and this row says
 * an administrator has switched it ON. Roland clears the first and ships to
 * production with the second off, so a biller can work real EOBs to `approved`
 * while a chart write stays impossible.
 */
router.use('/office-settings', require('./officeSettings'));

module.exports = router;
module.exports.QUEUE_PATHS = QUEUE_PATHS;
