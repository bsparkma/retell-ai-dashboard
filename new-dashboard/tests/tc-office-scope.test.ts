/**
 * TC office scoping — the all-offices fan-out + shared-route suppression.
 *
 * There is no server-side all-offices query (backend requireOffice rejects
 * anything but a concrete office), so "All Offices" is a client-side fan-out.
 * These tests pin the contract that matters operationally: one office →
 * exactly one call; all-offices → one call per office, merged and tagged; one
 * office failing → the other office's rows still render behind an honest
 * partial notice (never a blank page).
 */
import { describe, expect, it, vi } from "vitest";
import {
  fanOutOfficeRows,
  fanOutOfficeValues,
  hardErrorMessage,
  isTcSharedRoute,
  officeScopeKey,
  officesOf,
  partialNotice,
  resolveTcOfficeScope,
  showsOfficeBadges,
  tagOffice,
  TC_SHARED_ROUTES,
} from "@/features/tc/officeScope";
import type { OfficeId } from "@shared/tc/contract";

const ROSTER = [{ officeId: "roland" }, { officeId: "valley" }];

describe("resolveTcOfficeScope", () => {
  it("scopes to the one selected office (no badges, writes allowed)", () => {
    const scope = resolveTcOfficeScope({ selection: "roland", roster: ROSTER });
    expect(scope.offices).toEqual(["roland"]);
    expect(scope.isAllOffices).toBe(false);
    expect(scope.showOfficeBadges).toBe(false);
    expect(scope.office).toBe("roland");
  });

  it("expands the all-offices sentinel to every TC office in the roster", () => {
    const scope = resolveTcOfficeScope({ selection: "all", roster: ROSTER });
    expect(scope.offices).toEqual(["roland", "valley"]);
    expect(scope.isAllOffices).toBe(true);
    expect(scope.showOfficeBadges).toBe(true);
    // Ambiguous for writes — pages fall back to the pick-an-office prompt.
    expect(scope.office).toBeNull();
  });

  it("ignores roster entries that aren't TC offices", () => {
    const scope = resolveTcOfficeScope({
      selection: "all",
      roster: [{ officeId: "roland" }, { officeId: "some-voice-only-line" }],
    });
    expect(scope.offices).toEqual(["roland"]);
    // One office in scope: no badges, and writes stay unambiguous.
    expect(scope.showOfficeBadges).toBe(false);
    expect(scope.office).toBe("roland");
  });

  it("gates (empty scope) on a selection that isn't a TC office", () => {
    const scope = resolveTcOfficeScope({ selection: "riley", roster: ROSTER });
    expect(scope.offices).toEqual([]);
    expect(scope.office).toBeNull();
  });

  it("reports an empty scope while the roster is still loading", () => {
    const scope = resolveTcOfficeScope({ selection: "all", roster: [], loading: true });
    expect(scope.offices).toEqual([]);
    expect(scope.loading).toBe(true);
  });

  it("keys a scope stably regardless of roster order", () => {
    expect(officeScopeKey(["valley", "roland"])).toBe(officeScopeKey(["roland", "valley"]));
  });
});

describe("selection helpers", () => {
  it("normalizes a single office and an office list", () => {
    expect(officesOf("roland")).toEqual(["roland"]);
    expect(officesOf(["roland", "valley"])).toEqual(["roland", "valley"]);
  });

  it("shows badges only for a multi-office selection", () => {
    expect(showsOfficeBadges("roland")).toBe(false);
    expect(showsOfficeBadges(["roland"])).toBe(false);
    expect(showsOfficeBadges(["roland", "valley"])).toBe(true);
  });

  it("stamps the queried office onto every row", () => {
    expect(tagOffice([{ caseId: "c1" }, { caseId: "c2" }], "valley")).toEqual([
      { caseId: "c1", officeId: "valley" },
      { caseId: "c2", officeId: "valley" },
    ]);
  });
});

describe("fanOutOfficeRows", () => {
  it("makes exactly one call for a single office", async () => {
    const fetchOne = vi.fn(async (o: OfficeId) => [{ id: `${o}-1` }]);
    const result = await fanOutOfficeRows(["roland"], fetchOne);

    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledWith("roland");
    expect(result.rows).toEqual([{ id: "roland-1", officeId: "roland" }]);
    expect(result.errors).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.failed).toBe(false);
    expect(partialNotice(result)).toBeNull();
    expect(hardErrorMessage(result)).toBeNull();
  });

  it("calls every office and merges the rows with an officeId tag", async () => {
    const fetchOne = vi.fn(async (o: OfficeId) => [{ id: `${o}-1` }, { id: `${o}-2` }]);
    const result = await fanOutOfficeRows(["roland", "valley"], fetchOne);

    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne.mock.calls.map((c) => c[0])).toEqual(["roland", "valley"]);
    expect(result.rows).toEqual([
      { id: "roland-1", officeId: "roland" },
      { id: "roland-2", officeId: "roland" },
      { id: "valley-1", officeId: "valley" },
      { id: "valley-2", officeId: "valley" },
    ]);
    expect(result.partial).toBe(false);
  });

  it("keeps the healthy office's rows and flags partial data when one office fails", async () => {
    const result = await fanOutOfficeRows(["roland", "valley"], async (o) => {
      if (o === "valley") throw new Error("Valley is down");
      return [{ id: "roland-1" }];
    });

    expect(result.rows).toEqual([{ id: "roland-1", officeId: "roland" }]);
    expect(result.errors).toEqual([{ officeId: "valley", message: "Valley is down" }]);
    expect(result.partial).toBe(true);
    expect(result.failed).toBe(false);
    expect(partialNotice(result)).toBe(
      "Showing partial data — Valley didn't load (Valley is down).",
    );
    // Partial is not a hard error — the page keeps rendering rows.
    expect(hardErrorMessage(result)).toBeNull();
  });

  it("reports a hard error only when every office fails", async () => {
    const result = await fanOutOfficeRows(["roland", "valley"], async () => {
      throw new Error("Backend offline");
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.partial).toBe(false);
    expect(result.failed).toBe(true);
    expect(partialNotice(result)).toBeNull();
    expect(hardErrorMessage(result)).toBe("Backend offline");
  });

  it("is a no-op on an empty scope", async () => {
    const fetchOne = vi.fn(async () => [{ id: "x" }]);
    const result = await fanOutOfficeRows([], fetchOne);
    expect(fetchOne).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.failed).toBe(false);
  });
});

describe("fanOutOfficeValues", () => {
  it("returns one value per office and survives a single-office failure", async () => {
    const result = await fanOutOfficeValues(["roland", "valley"], async (o) => {
      if (o === "valley") throw new Error("nope");
      return { count: 3 };
    });

    expect(result.values).toEqual([{ officeId: "roland", value: { count: 3 } }]);
    expect(result.partial).toBe(true);
    expect(result.errors[0]?.officeId).toBe("valley");
  });
});

describe("isTcSharedRoute", () => {
  it("suppresses the office picker only on genuinely office-agnostic routes", () => {
    for (const route of TC_SHARED_ROUTES) {
      expect(isTcSharedRoute(route)).toBe(true);
    }
    // The guide is static coaching content — no office-scoped read at all.
    expect(isTcSharedRoute("/tc/guide")).toBe(true);
  });

  it("keeps the picker on every office-scoped TC surface", () => {
    // The pipeline list is "/tc" — no prefix may swallow it.
    expect(isTcSharedRoute("/tc")).toBe(false);
    expect(isTcSharedRoute("/tc/dashboard")).toBe(false);
    expect(isTcSharedRoute("/tc/followups")).toBe(false);
    expect(isTcSharedRoute("/tc/nurture")).toBe(false);
    expect(isTcSharedRoute("/tc/preauth")).toBe(false);
    expect(isTcSharedRoute("/tc/hygiene")).toBe(false);
    expect(isTcSharedRoute("/tc/hygiene/inbox")).toBe(false);
    expect(isTcSharedRoute("/tc/cob")).toBe(false);
    // Pages DentaFlow treated as shared but which read per-office data here:
    // hiding the picker would bury the only control that changes the page.
    expect(isTcSharedRoute("/tc/financing")).toBe(false);
    expect(isTcSharedRoute("/tc/gallery")).toBe(false);
    expect(isTcSharedRoute("/tc/templates")).toBe(false);
    expect(isTcSharedRoute("/tc/templates/tmpl-1")).toBe(false);
    expect(isTcSharedRoute("/tc/communications")).toBe(false);
    expect(isTcSharedRoute("/tc/library")).toBe(false);
    expect(isTcSharedRoute("/tc/settings")).toBe(false);
    expect(isTcSharedRoute("/tc/reports")).toBe(false);
    // Case detail/prep/post-consult fetch with the selected office, so the
    // picker is also the recovery control for "not found in this office".
    expect(isTcSharedRoute("/tc/cases/case-1")).toBe(false);
    expect(isTcSharedRoute("/tc/cases/case-1/prep")).toBe(false);
    expect(isTcSharedRoute("/tc/cases/case-1/post-consult")).toBe(false);
  });

  it("leaves non-TC modules alone", () => {
    expect(isTcSharedRoute("/dashboard")).toBe(false);
    expect(isTcSharedRoute("/calls")).toBe(false);
    expect(isTcSharedRoute("/settings")).toBe(false);
  });
});
