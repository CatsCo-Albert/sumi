import { describe, it, expect } from "vitest";
import { extractHeadings, headingForLine } from "../lib/outline";

describe("extractHeadings", () => {
  it("parses h1–h6", () => {
    const md = [
      "# one",
      "## two",
      "### three",
      "#### four",
      "##### five",
      "###### six",
    ].join("\n");
    const hs = extractHeadings(md);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hs.map((h) => h.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
    expect(hs.map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("skips headings inside fenced code blocks", () => {
    const md = [
      "# real",
      "```",
      "# fake",
      "```",
      "## also real",
      "~~~",
      "# tildes fake",
      "~~~",
      "# last",
    ].join("\n");
    const hs = extractHeadings(md);
    expect(hs.map((h) => h.text)).toEqual(["real", "also real", "last"]);
    expect(hs.map((h) => h.line)).toEqual([1, 5, 9]);
  });

  it("handles unclosed fence — everything after is code", () => {
    const md = ["# a", "```", "# b"].join("\n");
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["a"]);
  });

  it("rejects non-heading # lines", () => {
    const md = ["#hash nospace", "x # not heading", "    # indented 4 spaces"].join(
      "\n"
    );
    expect(extractHeadings(md)).toEqual([]);
  });

  it("allows up to 3 leading spaces", () => {
    expect(extractHeadings("   # ok")[0].text).toBe("ok");
  });

  it("strips closing hash runs", () => {
    expect(extractHeadings("## Title ##")[0].text).toBe("Title");
    expect(extractHeadings("# Title ###")[0].text).toBe("Title");
  });

  it("strips inline marks for display", () => {
    expect(extractHeadings("# **Bold** and `code` and [link](u)")[0].text).toBe(
      "Bold and code and link"
    );
  });

  it("empty heading (bare #)", () => {
    expect(extractHeadings("#")[0].text).toBe("");
    expect(extractHeadings("#")[0].level).toBe(1);
  });

  it("maps to correct 1-based line numbers with blank lines", () => {
    const md = ["# a", "", "", "## b"].join("\n");
    const hs = extractHeadings(md);
    expect(hs[1].line).toBe(4);
  });
});

describe("headingForLine", () => {
  const hs = extractHeadings(
    ["# A", "text", "## B", "text", "# C", "text"].join("\n")
  ); // A@1, B@3, C@5

  it("returns the heading containing the cursor line", () => {
    expect(headingForLine(hs, 1)?.text).toBe("A");
    expect(headingForLine(hs, 2)?.text).toBe("A");
    expect(headingForLine(hs, 4)?.text).toBe("B");
    expect(headingForLine(hs, 6)?.text).toBe("C");
  });

  it("returns null above the first heading", () => {
    const md = ["text", "# A"].join("\n");
    expect(headingForLine(extractHeadings(md), 1)).toBeNull();
  });

  it("empty doc → null", () => {
    expect(headingForLine([], 1)).toBeNull();
  });
});
