/**
 * Tooth numbering and ordering — PINNED, not merely tested.
 *
 * `client/src/lib/hyg/dentition.ts` is the prototype's file VERBATIM (byte for
 * byte; the vendoring PR shows the diff is empty). It is the single source of
 * tooth ordering for every surface that will draw a tooth chart: the
 * Odontogram, the perio grid, the routing slip preview, the read-only findings
 * chart, tooth chip lists. The prototype's own comment records why that matters
 * — "that's how the 17→32 lower-arch bug crept in the first time."
 *
 * The lower arch is the whole point. Universal numbering runs clockwise from
 * the patient's upper right, so on screen the lower arch reads #32 → #17 left
 * to right: #32 sits directly beneath #1. Written the other way round, every
 * tooth a hygienist taps is the wrong one, and it is wrong in a way that reads
 * as plausible.
 *
 * This is the prototype's own test, ported alongside the file it guards. The
 * two type-level cases at the bottom are new: they are what stop the overloaded
 * `opposingTooth` from quietly collapsing to `number | string`, which would let
 * a primary letter be handed to a permanent-tooth caller.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LOWER_PERMANENT,
  LOWER_PRIMARY,
  UPPER_PERMANENT,
  UPPER_PRIMARY,
  opposingTooth,
  quadrantOf,
} from "@/lib/hyg/dentition";

describe("dentition arrays", () => {
  it("orders the upper permanent arch 1 -> 16", () => {
    expect(UPPER_PERMANENT[0]).toBe(1);
    expect(UPPER_PERMANENT[15]).toBe(16);
    expect(UPPER_PERMANENT).toHaveLength(16);
  });

  it("orders the lower permanent arch 32 -> 17", () => {
    expect(LOWER_PERMANENT[0]).toBe(32);
    expect(LOWER_PERMANENT[15]).toBe(17);
    expect(LOWER_PERMANENT).toHaveLength(16);
  });

  it("orders the upper primary arch A -> J", () => {
    expect(UPPER_PRIMARY[0]).toBe("A");
    expect(UPPER_PRIMARY[9]).toBe("J");
  });

  it("orders the lower primary arch T -> K", () => {
    expect(LOWER_PRIMARY[0]).toBe("T");
    expect(LOWER_PRIMARY[9]).toBe("K");
  });

  it("stacks the arches so #32 sits under #1 and T sits under A", () => {
    // The relationship the display order exists for, stated directly rather
    // than left implicit in two separate index assertions above.
    for (let i = 0; i < 16; i += 1) {
      expect(LOWER_PERMANENT[i]).toBe(33 - UPPER_PERMANENT[i]);
    }
    for (let i = 0; i < 10; i += 1) {
      expect(LOWER_PRIMARY[i]).toBe(opposingTooth(UPPER_PRIMARY[i]));
    }
  });
});

describe("quadrantOf", () => {
  it("maps permanent tooth numbers to quadrants", () => {
    expect(quadrantOf(1)).toBe("UR");
    expect(quadrantOf(8)).toBe("UR");
    expect(quadrantOf(9)).toBe("UL");
    expect(quadrantOf(16)).toBe("UL");
    expect(quadrantOf(17)).toBe("LL");
    expect(quadrantOf(24)).toBe("LL");
    expect(quadrantOf(25)).toBe("LR");
    expect(quadrantOf(32)).toBe("LR");
  });

  it("maps primary tooth letters to quadrants", () => {
    expect(quadrantOf("A")).toBe("UR");
    expect(quadrantOf("E")).toBe("UR");
    expect(quadrantOf("F")).toBe("UL");
    expect(quadrantOf("J")).toBe("UL");
    expect(quadrantOf("K")).toBe("LL");
    expect(quadrantOf("O")).toBe("LL");
    expect(quadrantOf("P")).toBe("LR");
    expect(quadrantOf("T")).toBe("LR");
  });

  it("throws rather than guessing at a tooth that does not exist", () => {
    // A silent fallback quadrant would put a finding on the wrong side of a
    // mouth. Refusing is the only honest answer to tooth 33.
    expect(() => quadrantOf(0)).toThrow();
    expect(() => quadrantOf(33)).toThrow();
    expect(() => quadrantOf("U")).toThrow();
  });
});

describe("opposingTooth", () => {
  it("mirrors permanent teeth across the arch", () => {
    expect(opposingTooth(1)).toBe(32);
    expect(opposingTooth(16)).toBe(17);
    expect(opposingTooth(8)).toBe(25);
    expect(opposingTooth(25)).toBe(8);
    expect(opposingTooth(32)).toBe(1);
    expect(opposingTooth(17)).toBe(16);
  });

  it("mirrors primary teeth across the arch", () => {
    expect(opposingTooth("A")).toBe("T");
    expect(opposingTooth("T")).toBe("A");
    expect(opposingTooth("J")).toBe("K");
    expect(opposingTooth("K")).toBe("J");
  });

  it("keeps the two dentitions in their own type lanes", () => {
    // The overload is load-bearing. Collapsed to `number | string` it would let
    // a primary letter reach a caller that is about to do arithmetic on it.
    expectTypeOf(opposingTooth(1)).toEqualTypeOf<number>();
    expectTypeOf(opposingTooth("A")).toEqualTypeOf<string>();
  });
});
