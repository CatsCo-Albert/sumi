/**
 * What an uploaded file actually is.
 *
 * The extension and the `content-type` header both come from the client, so neither
 * can decide what a file is: `x-file-name: cat.png` with an HTML body would be
 * stored as `.png` and served back on this origin — a stored XSS with an image's
 * name on it. The leading bytes are the only claim worth trusting, and even that
 * only far enough to pick a type.
 *
 * Kept out of the route so it can be tested without standing up auth and storage.
 */

import { Buffer } from "node:buffer";

export type ImageFormat = { ext: string; mime: string };

const MAGIC: Array<{ format: ImageFormat; test: (b: Buffer) => boolean }> = [
  {
    format: { ext: "png", mime: "image/png" },
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    format: { ext: "jpg", mime: "image/jpeg" },
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    format: { ext: "gif", mime: "image/gif" },
    test: (b) => b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a"),
  },
  {
    format: { ext: "webp", mime: "image/webp" },
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    format: { ext: "avif", mime: "image/avif" },
    test: (b) => b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && b.subarray(8, 12).toString("latin1").startsWith("avi"),
  },
];

/**
 * SVG, recognised as XML rather than by magic number (it has none).
 *
 * Bounded to the head of the file: the check only has to establish "this is a
 * document whose root is <svg>" before the parser would ever be reached, and reading
 * 10 MB to answer that is a waste.
 */
export function looksLikeSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096).toString("utf8").trimStart();
  if (head.startsWith("<svg")) return true;
  if (!head.startsWith("<?xml") && !head.startsWith("<!--")) return false;
  return /<svg[\s>]/.test(buf.subarray(0, 4096).toString("utf8"));
}

/** The verified format, or null when the bytes are not something we store. */
export function detectImage(buf: Buffer): ImageFormat | null {
  for (const { format, test } of MAGIC) {
    if (test(buf)) return format;
  }
  if (looksLikeSvg(buf)) return { ext: "svg", mime: "image/svg+xml" };
  return null;
}
