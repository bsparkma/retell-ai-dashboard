/**
 * In-memory call store with optional file persistence.
 *
 * On startup, loads from STORE_FILE if it exists. All writes are synchronous
 * in-memory and asynchronously flushed to disk. This gives the dashboard
 * fast reads and durable storage without a database dependency.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import type { Call, CallFilters } from "./types.js";
import { filterCalls } from "./analytics.js";

// Anchor the data dir to the current working directory (new-dashboard/).
// Resolving via __dirname is unsafe because esbuild bundles this file into
// new-dashboard/dist/index.js — "../../data" then resolves to the project
// root instead of new-dashboard/data. PM2 sets cwd=new-dashboard and
// `npx tsx server/index.ts` is also run from there, so process.cwd() is
// stable across dev and prod. The CAREIN_DATA_DIR env var can override.
const DATA_DIR = path.resolve(
  process.env["CAREIN_DATA_DIR"] || path.join(process.cwd(), "data")
);
const STORE_FILE = path.resolve(DATA_DIR, "calls.json");

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

let calls: Call[] = [];
let initialized = false;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Loads call data from the JSON file (synchronous, called once at startup). */
export function loadStore(): void {
  if (initialized) return;
  initialized = true;
  ensureDataDir();

  if (existsSync(STORE_FILE)) {
    try {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        calls = parsed as Call[];
      }
    } catch {
      // Corrupt file — start fresh
      calls = [];
    }
  }
}

/** Flushes the current store state to disk asynchronously. */
async function persistAsync(): Promise<void> {
  ensureDataDir();
  await writeFile(STORE_FILE, JSON.stringify(calls, null, 2), "utf-8");
}

/** Overwrites the store file synchronously (used for seeding). */
export function persistSync(): void {
  ensureDataDir();
  writeFileSync(STORE_FILE, JSON.stringify(calls, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Returns all calls (newest first). */
export function getAllCalls(): Call[] {
  return [...calls].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

/** Returns a single call by ID, or undefined. */
export function getCallById(id: string): Call | undefined {
  return calls.find((c) => c.id === id);
}

/** Inserts a new call record. Throws if the ID already exists. */
export function insertCall(call: Call): void {
  if (calls.some((c) => c.id === call.id)) {
    throw new Error(`Call ${call.id} already exists`);
  }
  calls.unshift(call);
  persistAsync().catch(console.error);
}

/** Upserts a call record (insert or replace by ID). */
export function upsertCall(call: Call): void {
  const idx = calls.findIndex((c) => c.id === call.id);
  if (idx >= 0) {
    calls[idx] = call;
  } else {
    calls.unshift(call);
  }
  persistAsync().catch(console.error);
}

/** Updates fields on an existing call. Returns the updated call or undefined. */
export function updateCall(
  id: string,
  updates: Partial<Call>
): Call | undefined {
  const idx = calls.findIndex((c) => c.id === id);
  if (idx < 0) return undefined;
  calls[idx] = { ...calls[idx]!, ...updates };
  persistAsync().catch(console.error);
  return calls[idx];
}

/** Replaces the entire store (used by seeding). */
export function seedStore(data: Call[]): void {
  calls = [...data];
  persistSync();
}

/** Clears the store (used in tests). */
export function clearStore(): void {
  calls = [];
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Filters, paginates, and returns calls plus total count. */
export function queryCalls(
  filters: CallFilters
): { calls: Call[]; total: number } {
  const sorted = getAllCalls();
  const filtered = filterCalls(sorted, {
    office: filters.office,
    startDate: filters.startDate,
    endDate: filters.endDate,
    tag: filters.tag,
    outcome: filters.outcome,
    commlogStatus: filters.commlogStatus,
    search: filters.search,
  });

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  return {
    calls: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

/** Returns all unique offices in the store. */
export function getOffices(): string[] {
  const offices = new Set(calls.map((c) => c.office));
  return Array.from(offices).sort();
}

/** Returns all unique tags in the store. */
export function getTags(): string[] {
  const tags = new Set(calls.map((c) => c.tag));
  return Array.from(tags).sort();
}
