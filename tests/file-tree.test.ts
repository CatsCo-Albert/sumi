import { describe, it, expect } from "vitest";
import {
  buildFileTree,
  splitPath,
  parentFolder,
  docsInFolder,
  renameFolderPrefix,
  filterTree,
  highlightSegments,
  type FileTreeDoc,
} from "../lib/file-tree";

const doc = (fileId: string, title: string | null = null): FileTreeDoc => ({
  id: `id-${fileId}`,
  fileId,
  title,
});

describe("splitPath / parentFolder", () => {
  it("splits slash paths", () => {
    expect(splitPath("notes/intro.md")).toEqual(["notes", "intro.md"]);
    expect(splitPath("a/b/c.md")).toEqual(["a", "b", "c.md"]);
    expect(splitPath("solo.md")).toEqual(["solo.md"]);
  });
  it("parent folder", () => {
    expect(parentFolder("solo.md")).toBeNull();
    expect(parentFolder("notes/intro.md")).toBe("notes");
    expect(parentFolder("a/b/c.md")).toBe("a/b");
  });
});

describe("buildFileTree", () => {
  it("nests paths into folders", () => {
    const root = buildFileTree([
      doc("notes/intro.md"),
      doc("notes/todo.md"),
      doc("research/methodology.md"),
      doc("readme.md"),
    ]);
    expect(root.children.map((n) => n.name)).toEqual([
      "notes",
      "research",
      "readme.md",
    ]);
    const notes = root.children[0];
    expect(notes.kind).toBe("folder");
    expect(notes.children.map((n) => n.name)).toEqual(["intro.md", "todo.md"]);
  });

  it("handles 2+ nesting levels", () => {
    const root = buildFileTree([doc("a/b/c/deep.md")]);
    const a = root.children[0];
    const b = a.children[0];
    const c = b.children[0];
    expect(a.path).toBe("a");
    expect(b.path).toBe("a/b");
    expect(c.path).toBe("a/b/c");
    expect(c.children[0].name).toBe("deep.md");
    expect(c.children[0].kind).toBe("file");
  });

  it("sorts folders before files, alphabetical within each level", () => {
    const root = buildFileTree([
      doc("zebra.md"),
      doc("beta/x.md"),
      doc("alpha.md"),
      doc("alpha-dir/y.md"),
    ]);
    expect(root.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "folder:alpha-dir",
      "folder:beta",
      "file:alpha.md",
      "file:zebra.md",
    ]);
  });

  it("handles CJK / dots / dashes / underscores in names", () => {
    const root = buildFileTree([
      doc("中文目录/笔记_v2-final.md"),
      doc("file.name.with.dots.md"),
    ]);
    const folder = root.children.find((n) => n.name === "中文目录");
    expect(folder?.children[0].name).toBe("笔记_v2-final.md");
    expect(
      root.children.find((n) => n.name === "file.name.with.dots.md")?.kind
    ).toBe("file");
  });

  it("root-level files stay at root", () => {
    const root = buildFileTree([doc("a.md"), doc("b.md")]);
    expect(root.children.every((n) => n.kind === "file")).toBe(true);
  });
});

describe("docsInFolder / renameFolderPrefix", () => {
  const docs = [
    doc("notes/a.md"),
    doc("notes/sub/b.md"),
    doc("other/c.md"),
    doc("notes2/d.md"),
  ];
  it("collects docs recursively under folder", () => {
    expect(docsInFolder(docs, "notes").map((d) => d.fileId)).toEqual([
      "notes/a.md",
      "notes/sub/b.md",
    ]);
  });
  it("does not match sibling prefixes (notes vs notes2)", () => {
    expect(docsInFolder(docs, "notes").map((d) => d.fileId)).not.toContain(
      "notes2/d.md"
    );
  });
  it("rewrites prefixes on rename", () => {
    expect(renameFolderPrefix("notes/a.md", "notes", "docs")).toBe("docs/a.md");
    expect(renameFolderPrefix("notes/sub/b.md", "notes", "docs")).toBe(
      "docs/sub/b.md"
    );
    expect(renameFolderPrefix("other/c.md", "notes", "docs")).toBe(
      "other/c.md"
    );
    // nested rename
    expect(renameFolderPrefix("a/b/c.md", "a/b", "a/x")).toBe("a/x/c.md");
  });
});

describe("filterTree", () => {
  const tree = buildFileTree([
    doc("notes/intro.md"),
    doc("notes/todo.md"),
    doc("research/methodology.md"),
    doc("readme.md"),
  ]).children;

  it("returns all nodes for empty query", () => {
    expect(filterTree(tree, "")).toEqual(tree);
    expect(filterTree(tree, "  ")).toEqual(tree);
  });

  it("matches files by substring (case-insensitive)", () => {
    const r = filterTree(tree, "INTRO");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("notes");
    expect(r[0].children.map((n) => n.name)).toEqual(["intro.md"]);
  });

  it("keeps whole subtree when folder name matches", () => {
    const r = filterTree(tree, "notes");
    expect(r).toHaveLength(1);
    expect(r[0].children.map((n) => n.name)).toEqual(["intro.md", "todo.md"]);
  });

  it("keeps ancestor chain for deep matches", () => {
    const t = buildFileTree([doc("a/b/target.md"), doc("a/c/other.md")])
      .children;
    const r = filterTree(t, "target");
    expect(r[0].name).toBe("a");
    expect(r[0].children[0].name).toBe("b");
    expect(r[0].children[0].children[0].name).toBe("target.md");
  });

  it("root-level files match too", () => {
    const r = filterTree(tree, "readme");
    expect(r[0].name).toBe("readme.md");
    expect(r[0].kind).toBe("file");
  });
});

describe("highlightSegments", () => {
  it("splits at match boundaries", () => {
    expect(highlightSegments("notes/intro.md", "intro")).toEqual([
      { text: "notes/", match: false },
      { text: "intro", match: true },
      { text: ".md", match: false },
    ]);
  });
  it("case-insensitive", () => {
    expect(highlightSegments("README.md", "read")).toEqual([
      { text: "READ", match: true },
      { text: "ME.md", match: false },
    ]);
  });
  it("empty query → single unmatched segment", () => {
    expect(highlightSegments("a.md", "")).toEqual([
      { text: "a.md", match: false },
    ]);
  });
  it("multiple matches", () => {
    expect(highlightSegments("aXbXc", "x")).toEqual([
      { text: "a", match: false },
      { text: "X", match: true },
      { text: "b", match: false },
      { text: "X", match: true },
      { text: "c", match: false },
    ]);
  });
});
