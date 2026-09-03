/**
 * Module-entitlement client logic — /auth/me tenant parsing and active-module
 * resolution (the pure core of ModuleContext).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODULE,
  MODULE_IDS,
  entitledModuleIds,
  isModuleId,
  resolveActiveModule,
} from "../client/src/lib/modules";
import { parseAuthUser, parseTenant } from "../client/src/lib/auth";

describe("parseTenant / parseAuthUser modules field", () => {
  it("parses modules from the /auth/me tenant payload", () => {
    const tenant = parseTenant({ slug: "carein", displayName: "CareIN", modules: ["voice"] });
    expect(tenant).toEqual({ slug: "carein", displayName: "CareIN", modules: ["voice"] });
  });

  it("defaults modules to [] when the backend omits the field (older backend)", () => {
    const tenant = parseTenant({ slug: "carein", displayName: "CareIN" });
    expect(tenant?.modules).toEqual([]);
  });

  it("drops non-string entries and tolerates a malformed modules value", () => {
    expect(
      parseTenant({ slug: "s", displayName: "D", modules: ["voice", 7, null, "tc"] })?.modules,
    ).toEqual(["voice", "tc"]);
    expect(parseTenant({ slug: "s", displayName: "D", modules: "voice" })?.modules).toEqual([]);
  });

  it("threads modules through the full /auth/me body", () => {
    const user = parseAuthUser({
      authenticated: true,
      user: { name: "Beau", email: "b@carein.ai", tenantId: "tid" },
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
    });
    expect(user?.tenant?.modules).toEqual(["voice", "tc"]);
  });
});

describe("entitledModuleIds", () => {
  it("narrows to known module ids, preserving canonical order", () => {
    expect(entitledModuleIds(["tc", "voice", "bogus"])).toEqual(["voice", "tc"]);
    expect(entitledModuleIds([])).toEqual([]);
    expect(entitledModuleIds(undefined)).toEqual([]);
  });
});

describe("resolveActiveModule", () => {
  it("keeps the remembered selection while it is still entitled", () => {
    expect(resolveActiveModule("tc", ["voice", "tc"])).toBe("tc");
  });

  it("falls back to voice when the remembered module is revoked or unknown", () => {
    expect(resolveActiveModule("tc", ["voice"])).toBe("voice");
    expect(resolveActiveModule("garbage", ["voice"])).toBe("voice");
    expect(resolveActiveModule(null, ["voice"])).toBe("voice");
  });

  it("falls back to the first entitled module when voice is not entitled", () => {
    expect(resolveActiveModule(null, ["tc"])).toBe("tc");
  });

  it("degrades to the default when nothing is entitled (renders nothing upstream)", () => {
    expect(resolveActiveModule(null, [])).toBe(DEFAULT_MODULE);
  });
});

describe("isModuleId", () => {
  it("accepts exactly the CHECK-constraint vocabulary", () => {
    // Derived from MODULE_IDS rather than restated, so a module added to the
    // client registry without being added here cannot pass vacuously. The
    // negative cases below are what the assertion is really for.
    for (const id of MODULE_IDS) expect(isModuleId(id)).toBe(true);
    expect(isModuleId("hyg")).toBe(true); // added with migration 1788100000000
    expect(isModuleId("perio")).toBe(false); // the next name nobody has registered
    expect(isModuleId("carein")).toBe(false); // pre-rename id must not survive client-side
    expect(isModuleId(3)).toBe(false);
  });
});
