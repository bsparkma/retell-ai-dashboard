import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import Retell from "retell-sdk";
import { loadStore, seedStore, queryCalls, getCallById, insertCall, updateCall, getAllCalls, getOffices, getTags } from "./lib/store.js";
import { ingestRetellWebhook, validateWebhookPayload, IngestionError } from "./lib/ingestion.js";
import { computeAnalytics, filterCalls } from "./lib/analytics.js";
import { createCommlogWriter } from "./lib/commlog.js";
import { SEED_CALLS } from "./lib/seed.js";
import type { CallFilters, CommlogStatus } from "./lib/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commlogWriter = createCommlogWriter();

// ---------------------------------------------------------------------------
// Environment config — read once at startup, never mutated
// ---------------------------------------------------------------------------

const RETELL_API_KEY = (process.env["RETELL_API_KEY"] ?? "").trim();
const USE_SEED_DATA = process.env["USE_SEED_DATA"] === "true";

if (!RETELL_API_KEY) {
  console.warn(
    "[WARN] RETELL_API_KEY not set — Retell webhook signature verification " +
    "is DISABLED. Set RETELL_API_KEY before receiving live traffic."
  );
}
if (USE_SEED_DATA) {
  console.warn(
    "[WARN] USE_SEED_DATA=true — loading seed fixture data and ignoring any " +
    "persisted calls. Unset this env var in production."
  );
}

async function startServer() {
  // Load data:
  // - USE_SEED_DATA=true                        → always load seed fixtures (dev/demo).
  // - Otherwise, dev (NODE_ENV !== "production") → load persisted store; seed if empty
  //                                                so a fresh clone has something to show.
  // - Otherwise, production                     → load persisted store; an empty store
  //                                                STAYS empty (we don't want synthetic
  //                                                seed calls appearing as real data).
  if (USE_SEED_DATA) {
    seedStore(SEED_CALLS);
  } else {
    loadStore();
    if (getAllCalls().length === 0 && process.env["NODE_ENV"] !== "production") {
      seedStore(SEED_CALLS);
    }
  }

  const app = express();
  const server = createServer(app);

  // ---------------------------------------------------------------------------
  // Retell webhook — MUST be registered before app.use(express.json()) so
  // express.raw() can capture the body as a Buffer for signature verification.
  // Retell.verify() requires the raw bytes; re-serialising parsed JSON breaks it.
  // ---------------------------------------------------------------------------

  app.post("/api/webhook/retell", express.raw({ type: "*/*" }), async (req, res) => {
    // Convert raw buffer to string — Retell.verify expects a string.
    const rawBody = (req.body as Buffer).toString("utf-8");
    const sigHeader = req.headers["x-retell-signature"];
    // Express can return string | string[] | undefined; normalise to string.
    // Empty string → Retell.verify returns false (correct: missing header = reject).
    const signature: string = Array.isArray(sigHeader)
      ? (sigHeader[0] ?? "")
      : (sigHeader ?? "");

    // Verify signature when RETELL_API_KEY is present; warn-and-continue when absent.
    if (RETELL_API_KEY) {
      if (!Retell.verify(rawBody, RETELL_API_KEY, signature)) {
        console.warn("[WARN] Retell webhook rejected: invalid x-retell-signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    // Parse JSON manually (express.json() has not run on this route).
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    // Validate structure.
    try {
      validateWebhookPayload(body);
    } catch (err) {
      if (err instanceof IngestionError) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }

    // Acknowledge non-call events immediately (204 = received, no content).
    const event = (body as Record<string, unknown>)["event"] as string;
    if (event !== "call_ended" && event !== "call_analyzed" && event !== "call_completed") {
      res.status(204).send();
      return;
    }

    // Ingest.
    let call;
    try {
      call = ingestRetellWebhook(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ingestion failed";
      res.status(422).json({ error: msg });
      return;
    }

    // Deduplication.
    if (getCallById(call.id)) {
      res.json({ received: true, processed: false, reason: "duplicate", id: call.id });
      return;
    }

    insertCall(call);

    // Async commlog write (MockCommlogWriter — OD writes are DRY-RUN only).
    commlogWriter.write({
      callId: call.id,
      callerName: call.callerName,
      callerNumber: call.callerNumber,
      office: call.office,
      startedAt: call.startedAt,
      durationSeconds: call.durationSeconds,
      summary: call.summary,
      tag: call.tag,
      outcome: call.outcome,
    }).then((result) => {
      if (result.success) {
        updateCall(call.id, {
          commlogStatus: "written",
          commlogWrittenAt: new Date().toISOString(),
          commlogError: null,
        });
      } else {
        updateCall(call.id, {
          commlogStatus: "failed",
          commlogError: result.error ?? "Unknown error",
        });
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Commlog write failed";
      updateCall(call.id, { commlogStatus: "failed", commlogError: msg });
    });

    res.status(201).json({ received: true, processed: true, id: call.id });
  });

  // JSON parser for all other routes (must be after the raw-body webhook above).
  app.use(express.json({ limit: "2mb" }));

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", calls: getAllCalls().length });
  });

  // ---------------------------------------------------------------------------
  // Calls — GET /api/calls
  // ---------------------------------------------------------------------------

  app.get("/api/calls", (req, res) => {
    const {
      office,
      start_date: startDate,
      end_date: endDate,
      tag,
      outcome,
      commlog_status: commlogStatus,
      search,
      limit: limitStr,
      offset: offsetStr,
    } = req.query as Record<string, string | undefined>;

    const filters: CallFilters = {
      office: office || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      tag: tag || undefined,
      outcome: outcome || undefined,
      commlogStatus: commlogStatus as CommlogStatus | undefined,
      search: search || undefined,
      limit: limitStr ? Math.max(1, Math.min(500, parseInt(limitStr, 10))) : 100,
      offset: offsetStr ? Math.max(0, parseInt(offsetStr, 10)) : 0,
    };

    const { calls, total } = queryCalls(filters);
    res.json({ calls, total, offices: getOffices(), tags: getTags() });
  });

  // ---------------------------------------------------------------------------
  // Call detail — GET /api/calls/:id
  // ---------------------------------------------------------------------------

  app.get("/api/calls/:id", (req, res) => {
    const call = getCallById(req.params["id"] ?? "");
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(call);
  });

  // ---------------------------------------------------------------------------
  // Retry commlog write — POST /api/calls/:id/retry-commlog
  // ---------------------------------------------------------------------------

  app.post("/api/calls/:id/retry-commlog", async (req, res) => {
    const call = getCallById(req.params["id"] ?? "");
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }

    updateCall(call.id, { commlogStatus: "pending", commlogError: null });

    try {
      const result = await commlogWriter.write({
        callId: call.id,
        callerName: call.callerName,
        callerNumber: call.callerNumber,
        office: call.office,
        startedAt: call.startedAt,
        durationSeconds: call.durationSeconds,
        summary: call.summary,
        tag: call.tag,
        outcome: call.outcome,
      });

      if (result.success) {
        const updated = updateCall(call.id, {
          commlogStatus: "written",
          commlogWrittenAt: new Date().toISOString(),
          commlogError: null,
        });
        res.json({ success: true, call: updated });
      } else {
        const updated = updateCall(call.id, {
          commlogStatus: "failed",
          commlogError: result.error ?? "Unknown error",
        });
        res.status(422).json({ success: false, error: result.error, call: updated });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Commlog write failed";
      const updated = updateCall(call.id, { commlogStatus: "failed", commlogError: msg });
      res.status(500).json({ success: false, error: msg, call: updated });
    }
  });

  // ---------------------------------------------------------------------------
  // Analytics — GET /api/analytics/calls
  // ---------------------------------------------------------------------------

  app.get("/api/analytics/calls", (req, res) => {
    const {
      days: daysStr,
      office,
      start_date: startDateParam,
      end_date: endDateParam,
    } = req.query as Record<string, string | undefined>;

    const days = daysStr ? Math.max(1, Math.min(365, parseInt(daysStr, 10))) : 30;
    const endDate = endDateParam || new Date().toISOString().slice(0, 10);
    const startDate = startDateParam ||
      new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

    let calls = getAllCalls();
    if (office) {
      calls = filterCalls(calls, { office });
    }

    // Filter to date range
    const inRange = filterCalls(calls, { startDate, endDate });

    const result = computeAnalytics(inRange, startDate, endDate);
    res.json({ success: true, ...result });
  });

  // ---------------------------------------------------------------------------
  // Meta — GET /api/calls/meta (offices + tags for filter dropdowns)
  // ---------------------------------------------------------------------------

  app.get("/api/calls/meta", (_req, res) => {
    res.json({ offices: getOffices(), tags: getTags() });
  });

  // ---------------------------------------------------------------------------
  // Seed reset — POST /api/dev/seed (development only)
  // ---------------------------------------------------------------------------

  if (process.env["NODE_ENV"] !== "production") {
    app.post("/api/dev/seed", (_req, res) => {
      seedStore(SEED_CALLS);
      res.json({ seeded: SEED_CALLS.length });
    });
  }

  // ---------------------------------------------------------------------------
  // Static files (production)
  // ---------------------------------------------------------------------------

  const staticPath =
    process.env["NODE_ENV"] === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  app.get("*", (_req, res) => {
    const indexPath = path.join(staticPath, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(404).send("Not found");
      }
    });
  });

  const port = process.env["PORT"] || 3000;

  server.listen(port, () => {
    console.log(`CareIN Dashboard server running on http://localhost:${port}/`);
    console.log(`Calls loaded: ${getAllCalls().length}`);
  });
}

startServer().catch(console.error);
