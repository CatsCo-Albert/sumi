/**
 * Invite link construction.
 *
 * The panel used to build this inline as `${origin}/?invite=…`, which drops the
 * deployment base path: behind the artifact gateway the app lives at
 * `/<app-id>/`, so the copied link pointed at the gateway root and 404'd.
 *
 * NEXT_PUBLIC_BASE_PATH is read when lib/api-path is first evaluated, so it is
 * set here before the import rather than inside a test.
 */

import { describe, it, expect } from "vitest";

process.env.NEXT_PUBLIC_BASE_PATH = "/sumi";
const { inviteUrl } = await import("../lib/invite-link");

describe("inviteUrl", () => {
  it("keeps the deployment base path", () => {
    expect(inviteUrl("prj_abc", "https://artifact.catsco.cc")).toBe(
      "https://artifact.catsco.cc/sumi/?invite=prj_abc"
    );
  });

  it("escapes the project id", () => {
    expect(inviteUrl("prj_a b", "https://host")).toBe(
      "https://host/sumi/?invite=prj_a%20b"
    );
  });

  it("does not produce a bare-origin link", () => {
    // The exact shape that 404s behind the gateway.
    const url = inviteUrl("prj_abc", "https://artifact.catsco.cc");
    expect(url).not.toBe("https://artifact.catsco.cc/?invite=prj_abc");
    expect(new URL(url).pathname).toBe("/sumi/");
  });
});
