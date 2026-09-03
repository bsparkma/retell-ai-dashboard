import { describe, expect, it } from "vitest"
import { LOWER_PERMANENT, LOWER_PRIMARY, UPPER_PERMANENT, UPPER_PRIMARY, opposingTooth, quadrantOf } from "./dentition"

describe("dentition arrays", () => {
  it("orders the upper permanent arch 1 -> 16", () => {
    expect(UPPER_PERMANENT[0]).toBe(1)
    expect(UPPER_PERMANENT[15]).toBe(16)
    expect(UPPER_PERMANENT).toHaveLength(16)
  })

  it("orders the lower permanent arch 32 -> 17", () => {
    expect(LOWER_PERMANENT[0]).toBe(32)
    expect(LOWER_PERMANENT[15]).toBe(17)
    expect(LOWER_PERMANENT).toHaveLength(16)
  })

  it("orders the upper primary arch A -> J", () => {
    expect(UPPER_PRIMARY[0]).toBe("A")
    expect(UPPER_PRIMARY[9]).toBe("J")
  })

  it("orders the lower primary arch T -> K", () => {
    expect(LOWER_PRIMARY[0]).toBe("T")
    expect(LOWER_PRIMARY[9]).toBe("K")
  })
})

describe("quadrantOf", () => {
  it("maps permanent tooth numbers to quadrants", () => {
    expect(quadrantOf(1)).toBe("UR")
    expect(quadrantOf(8)).toBe("UR")
    expect(quadrantOf(9)).toBe("UL")
    expect(quadrantOf(16)).toBe("UL")
    expect(quadrantOf(17)).toBe("LL")
    expect(quadrantOf(24)).toBe("LL")
    expect(quadrantOf(25)).toBe("LR")
    expect(quadrantOf(32)).toBe("LR")
  })

  it("maps primary tooth letters to quadrants", () => {
    expect(quadrantOf("A")).toBe("UR")
    expect(quadrantOf("E")).toBe("UR")
    expect(quadrantOf("F")).toBe("UL")
    expect(quadrantOf("J")).toBe("UL")
    expect(quadrantOf("K")).toBe("LL")
    expect(quadrantOf("O")).toBe("LL")
    expect(quadrantOf("P")).toBe("LR")
    expect(quadrantOf("T")).toBe("LR")
  })
})

describe("opposingTooth", () => {
  it("mirrors permanent teeth across the arch", () => {
    expect(opposingTooth(1)).toBe(32)
    expect(opposingTooth(16)).toBe(17)
    expect(opposingTooth(8)).toBe(25)
    expect(opposingTooth(25)).toBe(8)
    expect(opposingTooth(32)).toBe(1)
    expect(opposingTooth(17)).toBe(16)
  })

  it("mirrors primary teeth across the arch", () => {
    expect(opposingTooth("A")).toBe("T")
    expect(opposingTooth("T")).toBe("A")
    expect(opposingTooth("J")).toBe("K")
    expect(opposingTooth("K")).toBe("J")
  })
})
