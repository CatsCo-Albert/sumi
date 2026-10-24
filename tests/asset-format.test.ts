/**
 * What counts as an image, decided by the bytes.
 *
 * Found in review: the upload endpoint took the extension from `x-file-name` and the
 * type from `content-type`, then served the object back on this origin using the
 * extension. Both of those are set freely by whoever uploads, so `cat.png` with an
 * HTML body was stored as a PNG and served as one.
 *
 * These pin the decision to the leading bytes, and pin the one format that is markup
 * rather than an image — SVG has no magic number, so it is recognised separately.
 */

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { detectImage, looksLikeSvg } from "../src/asset-format";

/** Minimal real headers — the detectors only read the prefix. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(8),
]);
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("ftypavif", "latin1"),
  Buffer.alloc(8),
]);

describe("detectImage", () => {
  it("recognises the raster formats from their magic numbers", () => {
    expect(detectImage(PNG)).toEqual({ ext: "png", mime: "image/png" });
    expect(detectImage(JPEG)).toEqual({ ext: "jpg", mime: "image/jpeg" });
    expect(detectImage(GIF)).toEqual({ ext: "gif", mime: "image/gif" });
    expect(detectImage(WEBP)).toEqual({ ext: "webp", mime: "image/webp" });
    expect(detectImage(AVIF)).toEqual({ ext: "avif", mime: "image/avif" });
  });

  it("rejects HTML, whatever it claims to be", () => {
    // The original defect: the name said .png, so the file was stored and served as
    // one. The bytes are the only part of an upload the uploader cannot relabel.
    const html = Buffer.from("<!doctype html><script>alert(1)</script>", "utf8");
    expect(detectImage(html)).toBeNull();
  });

  it("rejects an executable and a plain text file", () => {
    expect(detectImage(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBeNull();
    expect(detectImage(Buffer.from("just some notes", "utf8"))).toBeNull();
  });

  it("rejects an empty buffer rather than guessing", () => {
    // Zero bytes is not "unknown format, allow it" — it is nothing to serve.
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });

  it("accepts SVG, which is markup and therefore handled separately", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "utf8");
    expect(detectImage(svg)).toEqual({ ext: "svg", mime: "image/svg+xml" });
  });
});

describe("looksLikeSvg", () => {
  it("accepts a bare svg root", () => {
    expect(looksLikeSvg(Buffer.from("<svg></svg>", "utf8"))).toBe(true);
  });

  it("accepts one behind an xml declaration", () => {
    const doc = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(looksLikeSvg(Buffer.from(doc, "utf8"))).toBe(true);
  });

  it("accepts one behind a comment", () => {
    const doc = "<!-- generated -->\n<svg></svg>";
    expect(looksLikeSvg(Buffer.from(doc, "utf8"))).toBe(true);
  });

  it("accepts a root with attributes on the same line", () => {
    expect(looksLikeSvg(Buffer.from('<svg width="10" height="10"></svg>', "utf8"))).toBe(true);
  });

  it("rejects XML that is not svg", () => {
    // An XML declaration alone is not enough: otherwise any XML document would be
    // accepted and served with an image content-type.
    const doc = '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"></html>';
    expect(looksLikeSvg(Buffer.from(doc, "utf8"))).toBe(false);
  });

  it("rejects HTML that merely mentions svg later on", () => {
    const doc = "<!doctype html><body><svg></svg></body>";
    expect(looksLikeSvg(Buffer.from(doc, "utf8"))).toBe(false);
  });
});
