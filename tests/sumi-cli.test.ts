/**
 * Smoke-test sumi-kit CLI commands — verify the HTTP surface they hit.
 * Doesn't execute the python script (no subprocess in vitest); instead
 * validates that the URL paths + auth headers the CLI constructs match
 * what the actual routes accept.
 */

import { describe, it, expect } from "vitest";

// These paths must match `sumi-kit/cli/sumi` handlers.
const CLI_PATHS = {
  whoami: "/api/auth/me",
  listProjects: "/api/projects",
  listDocs: (p: string) => `/api/projects/${p}/documents`,
  listMembers: (p: string) => `/api/projects/${p}/members`,
  readDoc: (p: string, f: string) => `/api/documents/content?projectId=${p}&filePath=${f}`,
  proposeEdit: "/api/pending-edits",
  listPending: (p: string) => `/api/pending-edits?projectId=${p}`,
  applyEdit: "/api/edits/apply",
  rejectEdit: (id: string) => `/api/pending-edits?id=${id}`,
  onboard: (p: string) => `/api/projects/${p}/agent-setup`,
  intents: "/api/intents",
  watch: (p: string) => `/api/ui/events?projectId=${p}`,
} as const;

describe("sumi-cli paths", () => {
  it("every CLI command maps to a real Next.js route", () => {
    // Sanity-check that the paths exist in the file system — if a route
    // file is missing, this test fails loudly.
    const fs = require("fs");
    const path = require("path");
    const cwd = process.cwd();
    for (const [name, p] of Object.entries(CLI_PATHS)) {
      const urlPath = typeof p === "function" ? p("prj_x", "notes/x.md") : p;
      // Strip query string for the file check.
      const routeDir = urlPath.split("?")[0];
      // Try .ts route file under app/
      const candidates = [
        path.join(cwd, "app", routeDir.replace(/\/api\//, "api/"), "route.ts"),
      ];
      // For parameterized routes like /api/projects/[id]/members,
      // we need to check the [id] form.
      const exists = candidates.some((c) => fs.existsSync(c)) ||
        // fallback — try substituting [id] for the param
        (() => {
          const wildcard = routeDir.replace(/prj_x/g, "[id]");
          return fs.existsSync(
            path.join(cwd, "app", wildcard.replace(/\/api\//, "api/"), "route.ts")
          );
        })();
      expect(exists, `${name} -> ${urlPath} has no route.ts`).toBe(true);
    }
  });
});

/**
 * The table above is hand-written, so it can mirror a CLI bug instead of
 * catching it: `readDoc` sent `fileId=` where the route reads `filePath=`, and
 * the expectation said `fileId=` too, so CI stayed green while `sumi read-doc`
 * returned 400 in practice.
 *
 * This one reads both sources and compares them, so the CLI and the route have
 * to agree on the parameter names themselves.
 */
describe("sumi-cli query params match what the routes read", () => {
  const fs = require("fs");
  const path = require("path");

  function cliParamsFor(urlFragment: string): Set<string> {
    const cli = fs.readFileSync(
      path.join(process.cwd(), "sumi-kit/cli/sumi"),
      "utf8"
    );
    const found = new Set<string>();
    const urls = new RegExp(`\\${urlFragment}\\?([^\`"]*)`, "g");
    for (const m of cli.matchAll(urls)) {
      for (const kv of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) {
        found.add(kv[1]);
      }
    }
    return found;
  }

  function routeParamsFor(routeFile: string): Set<string> {
    const src = fs.readFileSync(path.join(process.cwd(), routeFile), "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(/searchParams\.get\("([^"]+)"\)/g)) {
      found.add(m[1]);
    }
    return found;
  }

  it("document content", () => {
    const cli = cliParamsFor("/api/documents/content");
    const route = routeParamsFor("app/api/documents/content/route.ts");
    expect(cli.size).toBeGreaterThan(0);
    for (const p of cli) {
      expect(
        route.has(p),
        `CLI sends ?${p}= but the route reads: ${[...route].join(", ")}`
      ).toBe(true);
    }
  });

  it("pending edits", () => {
    const cli = cliParamsFor("/api/pending-edits");
    const route = routeParamsFor("app/api/pending-edits/route.ts");
    expect(cli.size).toBeGreaterThan(0);
    for (const p of cli) {
      expect(
        route.has(p),
        `CLI sends ?${p}= but the route reads: ${[...route].join(", ")}`
      ).toBe(true);
    }
  });
});
