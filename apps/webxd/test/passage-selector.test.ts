import { describe, expect, it } from "vitest";
import { selectCanonicalPassage } from "../src/passage-selector.js";

describe("selectCanonicalPassage", () => {
  it("selects one repeatable bounded passage around the exact query", () => {
    const content = `${"early context ".repeat(80)}😀 selected exact phrase ${"late context ".repeat(80)}`;
    const first = selectCanonicalPassage(content, "selected exact phrase", 120);
    expect(first).toContain("😀 selected exact phrase");
    expect([...first]).toHaveLength(120);
    expect(selectCanonicalPassage(content, "selected exact phrase", 120)).toBe(first);
  });

  it("breaks equal term-score ties by canonical source order", () => {
    const first = `FIRST ${"alpha context ".repeat(20)}`;
    const second = `SECOND ${"alpha context ".repeat(20)}`;
    const selected = selectCanonicalPassage(`${first}\n\n${second}`, "alpha absent", 100);
    expect(selected).toContain("FIRST");
    expect(selected).not.toContain("SECOND");
  });
});
