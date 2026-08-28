/**
 * Client permission map + route gating (Roles PR B).
 *
 * These are pure-function tests over lib/permissions. The point they defend is
 * that the CLIENT map never disagrees with the SERVER map — a nav item that
 * renders and then 403s on click is worse than one that was never shown.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACTIONS,
  DEFAULT_HOME,
  ROLE_HOME,
  can,
  canVisit,
  homeForRole,
  requiredActionFor,
} from "@/lib/permissions";

/** Every action name the backend map defines, parsed from its source. */
function serverActions(): string[] {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "backend", "config", "permissions.js"),
    "utf8",
  );
  const body = src.slice(src.indexOf("const PERMISSIONS = Object.freeze({"), src.indexOf("/** Every role that appears"));
  return [...body.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]).sort();
}

describe("client/server map agreement", () => {
  it("names exactly the actions the backend defines", () => {
    // Drift here is the bug class this file exists for: a client action the
    // server doesn't know silently hides a page forever; a server action the
    // client doesn't know silently shows one that 403s.
    expect([...ACTIONS]).toEqual(serverActions());
  });

  it("every route permission is a real action", () => {
    const known = new Set<string>(ACTIONS);
    for (const path of ["/dashboard", "/calls", "/admin", "/tc", "/tc/hygiene", "/analytics"]) {
      const action = requiredActionFor(path);
      expect(action, path).not.toBeNull();
      expect(known.has(action as string), `${path} → ${action}`).toBe(true);
    }
  });
});

describe("can()", () => {
  it("is true only for an action in the list", () => {
    expect(can(["voice.read", "tc.full"], "voice.read")).toBe(true);
    expect(can(["voice.read"], "admin.all")).toBe(false);
  });

  it("fails closed on a missing or malformed list", () => {
    expect(can(undefined, "voice.read")).toBe(false);
    expect(can([], "voice.read")).toBe(false);
  });
});

describe("requiredActionFor — longest prefix wins", () => {
  it("puts the three Hygiene pages on tc.hygiene, not tc.full", () => {
    expect(requiredActionFor("/tc/hygiene")).toBe("tc.hygiene");
    expect(requiredActionFor("/tc/hygiene/inbox")).toBe("tc.hygiene");
    expect(requiredActionFor("/tc/hygiene/submissions")).toBe("tc.hygiene");
  });

  it("keeps the rest of TC on tc.full", () => {
    for (const p of ["/tc", "/tc/dashboard", "/tc/cases/abc", "/tc/preauth", "/tc/library"]) {
      expect(requiredActionFor(p), p).toBe("tc.full");
    }
  });

  it("puts the Users page under admin.all via the /admin prefix", () => {
    expect(requiredActionFor("/admin")).toBe("admin.all");
    expect(requiredActionFor("/admin/users")).toBe("admin.all");
  });

  it("leaves shell routes unrestricted", () => {
    for (const p of ["/home", "/404", "/anything-else"]) {
      expect(requiredActionFor(p), p).toBeNull();
      expect(canVisit([], p), p).toBe(true);
    }
  });

  it("does not match a prefix that is merely a string prefix of another segment", () => {
    // "/tcx" must NOT inherit "/tc"'s permission.
    expect(requiredActionFor("/tcx")).toBeNull();
    expect(requiredActionFor("/administration")).toBeNull();
  });
});

describe("canVisit per role", () => {
  const PERMS: Record<string, string[]> = {
    admin: [...ACTIONS],
    office: ACTIONS.filter((a) => a !== "admin.all"),
    tc: ["voice.read", "tc.full", "tc.hygiene"],
    hygiene: ["tc.hygiene"],
  };

  it("hygiene can reach ONLY the three hygiene pages", () => {
    const allowed = ["/tc/hygiene", "/tc/hygiene/inbox", "/tc/hygiene/submissions"];
    for (const p of allowed) expect(canVisit(PERMS.hygiene, p), p).toBe(true);
    for (const p of ["/dashboard", "/calls", "/analytics", "/admin", "/admin/users", "/tc", "/tc/preauth"]) {
      expect(canVisit(PERMS.hygiene, p), p).toBe(false);
    }
  });

  it("office reaches everything except the admin surface", () => {
    expect(canVisit(PERMS.office, "/calls")).toBe(true);
    expect(canVisit(PERMS.office, "/tc")).toBe(true);
    expect(canVisit(PERMS.office, "/admin")).toBe(false);
    expect(canVisit(PERMS.office, "/admin/users")).toBe(false);
  });

  it("tc reaches TC and the voice READ pages", () => {
    expect(canVisit(PERMS.tc, "/tc")).toBe(true);
    expect(canVisit(PERMS.tc, "/calls")).toBe(true);
    expect(canVisit(PERMS.tc, "/admin")).toBe(false);
  });

  it("admin reaches everything", () => {
    for (const p of ["/calls", "/admin", "/admin/users", "/tc", "/tc/hygiene/inbox"]) {
      expect(canVisit(PERMS.admin, p), p).toBe(true);
    }
  });
});

describe("homeForRole", () => {
  it("lands hygiene on the inbox and tc on the TC dashboard", () => {
    expect(homeForRole("hygiene")).toBe("/tc/hygiene/inbox");
    expect(homeForRole("tc")).toBe("/tc/dashboard");
  });

  it("leaves office/admin on the module hub they have today", () => {
    expect(homeForRole("office")).toBe("/home");
    expect(homeForRole("admin")).toBe("/home");
  });

  it("falls back for an unresolved role", () => {
    expect(homeForRole(null)).toBe(DEFAULT_HOME);
  });

  it("sends every role somewhere it is actually allowed to be", () => {
    const PERMS: Record<string, string[]> = {
      admin: [...ACTIONS],
      // TWO actions an office user does not hold. `rcm.settings` joined
      // `admin.all` with the shadow gate: running the day and deciding what the
      // day is allowed to do are different authorities.
      office: ACTIONS.filter((a) => a !== "admin.all" && a !== "rcm.settings"),
      tc: ["voice.read", "tc.full", "tc.hygiene"],
      hygiene: ["tc.hygiene"],
      // The RCM reviewer tier (D-9): the workbench and nothing else.
      reviewer: ["rcm.read", "rcm.queue"],
      // The biller tier: everything the reviewer holds, plus the write tier —
      // and NOT rcm.post or rcm.settings.
      rcm_biller: ["rcm.read", "rcm.queue", "rcm.write"],
    };
    for (const role of Object.keys(ROLE_HOME) as (keyof typeof ROLE_HOME)[]) {
      // Otherwise the redirect would bounce forever between "not allowed here"
      // and "go home".
      expect(canVisit(PERMS[role], ROLE_HOME[role]), role).toBe(true);
    }
  });
});
