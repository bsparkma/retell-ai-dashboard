/**
 * MT-2b3: an office key is a FORMAT on the wire, and the SERVER decides which
 * keys are a practice's offices (backend/platform/officeGate.js, pinned route
 * by route in backend/test/officeGateWiring.test.js).
 *
 * This pins the client/shared half:
 *   - OfficeKeySchema accepts exactly what the old two-value enums accepted for
 *     roland/valley, refuses 'unknown' as they did, and accepts any other
 *     well-formed key (the server refuses it if it is not yours);
 *   - the roster helpers derive the offices from the server's roster;
 *   - no `["roland", "valley"]` pair survives in shared/, the client or the
 *     dashboard server outside the two named exceptions.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { OFFICE_KEY_PATTERN, OfficeKeySchema, isOfficeKey } from "@shared/officeKey";
import { OfficeId } from "@shared/tc/contract";
import { OfficeIdSchema, isOfficeId } from "@shared/hyg/contract";
import { LEGACY_OFFICES, legacyLocationToOffice, parseLegacyOffice } from "@shared/tc/legacy";
import {
  FALLBACK_OFFICE_KEYS,
  asOfficeKey,
  servedOfficeKeys,
  servedOfficeKeysOrFallback,
} from "@/lib/officeKeys";
import { sendToTcState } from "@/lib/sendToTc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("OfficeKeySchema", () => {
  test("roland and valley parse exactly as they did under the two-value enum", () => {
    for (const k of ["roland", "valley"]) {
      expect(OfficeKeySchema.safeParse(k).success).toBe(true);
      expect(OfficeId.safeParse(k).success).toBe(true);
      expect(OfficeIdSchema.safeParse(k).success).toBe(true);
      expect(isOfficeId(k)).toBe(true);
    }
  });

  test("'unknown' and malformed keys are refused, as the enum refused them", () => {
    for (const bad of ["unknown", "Roland", "VALLEY", "", " roland", "a", "1office", "x".repeat(33), null, 7, ["roland"]]) {
      expect(isOfficeKey(bad)).toBe(false);
      expect(OfficeId.safeParse(bad).success).toBe(false);
      expect(isOfficeId(bad)).toBe(false);
    }
  });

  test("any other well-formed key parses: WHOSE office it is, is the server's call", () => {
    for (const k of ["fortsmith", "office-3", "tulsa_2", "ab", "a".repeat(32)]) {
      expect(isOfficeKey(k)).toBe(true);
    }
  });

  test("the pattern is the database CHECK's (MT-2b2)", () => {
    expect(OFFICE_KEY_PATTERN.source).toBe("^[a-z][a-z0-9_-]{1,31}$");
  });
});

describe("roster helpers", () => {
  const roster = [
    { officeId: "roland" },
    { officeId: "valley" },
    { officeId: "unknown" },
    { officeId: "roland" },
    { officeId: "Not An Office" },
  ];

  test("servedOfficeKeys: roster order, 'unknown' / malformed / duplicates dropped", () => {
    expect(servedOfficeKeys(roster)).toEqual(["roland", "valley"]);
    expect(servedOfficeKeys([{ officeId: "valley" }, { officeId: "fortsmith" }])).toEqual(["valley", "fortsmith"]);
    expect(servedOfficeKeys([])).toEqual([]);
  });

  test("the fallback answers only when the roster names no office", () => {
    expect(servedOfficeKeysOrFallback([])).toEqual(["roland", "valley"]);
    expect(servedOfficeKeysOrFallback([{ officeId: "unknown" }])).toEqual(["roland", "valley"]);
    expect(servedOfficeKeysOrFallback([{ officeId: "valley" }])).toEqual(["valley"]);
    expect([...FALLBACK_OFFICE_KEYS]).toEqual(["roland", "valley"]);
  });

  test("asOfficeKey", () => {
    expect(asOfficeKey("roland")).toBe("roland");
    expect(asOfficeKey("unknown")).toBeNull();
    expect(asOfficeKey(null)).toBeNull();
  });

  test("send to TC still hides for 'unknown' and a missing office, and still offers roland/valley", () => {
    const base = { odPatientId: 12828, odPatientName: "Test, MangoTest" };
    const decide = (call: typeof base & { officeId: string | null }) => sendToTcState(call, true);
    expect(decide({ ...base, officeId: "unknown" }).kind).toBe("hidden");
    expect(decide({ ...base, officeId: null }).kind).toBe("hidden");
    expect(decide({ ...base, officeId: "roland" }).kind).not.toBe("hidden");
    expect(decide({ ...base, officeId: "valley" }).kind).not.toBe("hidden");
  });
});

describe("legacy import", () => {
  test("files only under the legacy app's two locations; the CLI refuses any other office", () => {
    expect([...LEGACY_OFFICES]).toEqual(["roland", "valley"]);
    expect(legacyLocationToOffice("riley")).toBe("valley");
    expect(legacyLocationToOffice("roland")).toBe("roland");
    expect(legacyLocationToOffice(null)).toBe("roland");
    expect(parseLegacyOffice("valley")).toBe("valley");
    // 'fortsmith' passes the FORMAT; a legacy import must still refuse it.
    expect(() => parseLegacyOffice("fortsmith")).toThrow(/one of: roland, valley/);
    expect(() => parseLegacyOffice("rolnd")).toThrow();
  });
});

/** Files allowed to spell the pair, and why. Adding one is a review decision. */
const PAIR_EXCEPTIONS: Record<string, string> = {
  "client/src/lib/officeKeys.ts": "FALLBACK_OFFICE_KEYS: the roster-failure fallback (disclosed follow-up)",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("no hard-coded office pair survives in shared/, the client or the dashboard server", () => {
  const PAIR =
    /\[\s*["']roland["']\s*,\s*["']valley["']\s*\]|z\.enum\(\s*\[\s*["']roland["']\s*,\s*["']valley["']\s*\]\s*\)|=== ["']roland["'] \|\| [\w.]+ === ["']valley["']/;
  const files = ["shared", "client/src", "server"].flatMap((d) => sources(path.join(ROOT, d)));
  expect(files.length).toBeGreaterThan(200);
  const offenders = files
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .filter((rel) => PAIR.test(readFileSync(path.join(ROOT, rel), "utf8")))
    .filter((rel) => !(rel in PAIR_EXCEPTIONS));
  // The legacy import spells its two locations one at a time (shared/tc/legacy.ts),
  // so it needs no exception.
  expect(offenders).toEqual([]);
});

test("the client's All-offices sentinel can never be read as an office key", async () => {
  const { ALL_OFFICES } = await import("@/contexts/OfficeContext");
  expect(ALL_OFFICES).toBe("all");
  expect(isOfficeKey(ALL_OFFICES)).toBe(false);
  expect(OfficeId.safeParse(ALL_OFFICES).success).toBe(false);
});

test("selectedServedOffice: on the roster once it has loaded; the shape alone while it has not", async () => {
  const { selectedServedOffice } = await import("@/lib/officeKeys");
  const roster = [{ officeId: "roland" }, { officeId: "valley" }, { officeId: "unknown" }];
  expect(selectedServedOffice("valley", roster)).toBe("valley");
  expect(selectedServedOffice("riley", roster)).toBeNull();
  expect(selectedServedOffice("all", roster)).toBeNull();
  expect(selectedServedOffice("roland", [])).toBe("roland");
  expect(selectedServedOffice("unknown", [])).toBeNull();
});
