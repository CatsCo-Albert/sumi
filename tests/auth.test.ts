/**
 * Auth layer tests — CatsCo integration.
 *
 * These exercise subject caching, project/membership gating, and the
 * credential extraction helpers. Remote introspection is stubbed via env.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { getDb, resetDbForTests } from "../src/db";
import {
  upsertSubject,
  getSubject,
  createProject,
  getProject,
  listProjectsForSubject,
  grantMembership,
  revokeMembership,
  listMembers,
  upsertDocument,
  listDocuments,
} from "../src/auth/identity";
import { projectRoleFor, extractCredential } from "../src/auth/actor";
import { actorKey } from "../src/auth/catsco";
import type { IncomingMessage } from "http";

const TEST_DIR = `/tmp/sumi-catsco-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

beforeEach(async () => {
  resetDbForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("subjects", () => {
  it("caches user and agent subjects", async () => {
    const db = await getDb();
    upsertSubject(db, {
      subjectId: "u42",
      kind: "user",
      displayName: "Alice",
      username: "alice",
    });
    upsertSubject(db, {
      subjectId: "a77",
      kind: "agent",
      displayName: "ci-bot",
      username: "ci-bot",
      ownerUid: 42,
    });
    expect(getSubject(db, "u42")?.kind).toBe("user");
    expect(getSubject(db, "a77")?.ownerUid).toBe(42);
  });
});

describe("projects + membership", () => {
  it("grants and resolves roles for users and agents", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Alice" });
    upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Bob" });
    upsertSubject(db, {
      subjectId: "a9",
      kind: "agent",
      displayName: "ci",
      ownerUid: 1,
    });

    const project = createProject(db, {
      name: "docs",
      ownerSubjectId: "u1",
    });
    expect(getProject(db, project.id)?.ownerUid).toBe("u1");
    expect(projectRoleFor(db, project.id, "u1")).toBe("owner");

    grantMembership(db, {
      projectId: project.id,
      subjectId: "u2",
      role: "editor",
      grantedBy: "u1",
    });
    grantMembership(db, {
      projectId: project.id,
      subjectId: "a9",
      role: "viewer",
      grantedBy: "u1",
    });
    expect(projectRoleFor(db, project.id, "u2")).toBe("editor");
    expect(projectRoleFor(db, project.id, "a9")).toBe("viewer");

    // Stranger has no role
    upsertSubject(db, { subjectId: "u99", kind: "user", displayName: "X" });
    expect(projectRoleFor(db, project.id, "u99")).toBeNull();
  });

  it("revokes membership", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "B" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    grantMembership(db, {
      projectId: project.id,
      subjectId: "u2",
      role: "editor",
      grantedBy: "u1",
    });
    expect(projectRoleFor(db, project.id, "u2")).toBe("editor");
    revokeMembership(db, project.id, "u2");
    expect(projectRoleFor(db, project.id, "u2")).toBeNull();
  });

  it("lists members with display names", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    upsertSubject(db, { subjectId: "a9", kind: "agent", displayName: "bot" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    grantMembership(db, {
      projectId: project.id,
      subjectId: "a9",
      role: "viewer",
      grantedBy: "u1",
    });
    const members = listMembers(db, project.id);
    expect(members).toHaveLength(2);
    const agent = members.find((m) => m.subjectId === "a9");
    expect(agent?.role).toBe("viewer");
    expect(agent?.displayName).toBe("bot");
  });
});

describe("documents", () => {
  it("upserts and lists", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "A" });
    const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
    upsertDocument(db, { projectId: project.id, fileId: "a.md", title: "A" });
    upsertDocument(db, { projectId: project.id, fileId: "b.md" });
    const docs = listDocuments(db, project.id);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.fileId).sort()).toEqual(["a.md", "b.md"]);
  });
});

describe("extractCredential", () => {
  const mkReq = (headers: Record<string, string>) =>
    ({ headers }) as unknown as IncomingMessage;

  it("extracts Bearer JWT", () => {
    const url = new URL("http://x/");
    const cred = extractCredential(mkReq({ authorization: "Bearer abc" }), url);
    expect(cred).toEqual({ kind: "jwt", token: "abc" });
  });

  it("extracts ApiKey", () => {
    const url = new URL("http://x/");
    const cred = extractCredential(mkReq({ authorization: "ApiKey cc_x" }), url);
    expect(cred).toEqual({ kind: "apikey", token: "cc_x" });
  });

  it("extracts from query params", () => {
    const url = new URL("http://x/?token=tok1");
    expect(extractCredential(mkReq({}), url)).toEqual({
      kind: "jwt",
      token: "tok1",
    });
    const url2 = new URL("http://x/?api_key=cc_1");
    expect(extractCredential(mkReq({}), url2)).toEqual({
      kind: "apikey",
      token: "cc_1",
    });
  });

  it("returns null when nothing present", () => {
    expect(extractCredential(mkReq({}), new URL("http://x/"))).toBeNull();
  });
});

describe("actorKey", () => {
  it("formats", () => {
    expect(actorKey("user", 42)).toBe("u42");
    expect(actorKey("agent", 42)).toBe("a42");
  });
});
