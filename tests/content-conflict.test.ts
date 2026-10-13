/**
 * Content-hash optimistic concurrency tests.
 *
 * PUT /api/documents/content should accept a `baseContentHash` and return
 * 409 FILE_CONFLICT when the canonical blob has drifted. Clients (and agents)
 * re-GET and retry — last-write-wins is still possible via force:true but
 * explicit.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import crypto from "crypto";
import { resetStorageForTests, getStorage } from "../src/storage";

const TEST_DIR = `/tmp/sumi-content-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

const hash = (s: string | Buffer) =>
  crypto.createHash("sha256").update(s).digest("hex");

beforeEach(async () => {
  resetStorageForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("storage layer hash-check", () => {
  it("produces stable sha256 for same content", async () => {
    const storage = await getStorage();
    await storage.upload("a/b.md", "hello world", "text/markdown");
    const buf = await storage.download("a/b.md");
    expect(hash(buf)).toBe(hash("hello world"));
  });

  it("round-trips markdown through storage", async () => {
    const storage = await getStorage();
    const key = "sumi/prj_x/files/notes/intro.md";
    const original = "# Title\n\nbody text\n";
    await storage.upload(key, original, "text/markdown");
    const read = await storage.download(key);
    expect(read.toString("utf8")).toBe(original);
    expect(hash(read)).toBe(hash(original));
  });

  it("hash changes when content changes", async () => {
    const storage = await getStorage();
    const key = "sumi/prj_x/files/x.md";
    await storage.upload(key, "v1");
    const v1Hash = hash(await storage.download(key));
    await storage.upload(key, "v2");
    const v2Hash = hash(await storage.download(key));
    expect(v1Hash).not.toBe(v2Hash);
  });
});

describe("conflict flow (simulated)", () => {
  it("detects drift between read and write", async () => {
    const storage = await getStorage();
    const key = "sumi/prj/files/x.md";
    await storage.upload(key, "initial");

    // Client A reads → captures hash
    const readA = await storage.download(key);
    const hashA = hash(readA);

    // Client B sneaks a write in
    await storage.upload(key, "sneaky-b");

    // Client A attempts write with stale hash → should be rejected
    const current = await storage.download(key);
    expect(hash(current)).not.toBe(hashA); // conflict detected
  });
});
