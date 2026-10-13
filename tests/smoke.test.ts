/**
 * Smoke tests for Sumi's Yjs + A2UI substrate.
 *
 * These run against the in-process modules; they don't spin up a real WS server
 * (that requires a listening socket — covered by manual integration runs).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { parseRoomName } from "../src/server/yjs-persistence";
import {
  createRelPosForEdit,
  getLineFromRelPos,
  addRelPosToEdit,
  type PendingEdit,
} from "../src/server/edit-position-tracker";
import { validateUiPatch, validateJsonRender } from "../src/a2ui/validate";
import {
  publishUiPatch,
  subscribeUiEvents,
  listUiEvents,
  resetUiEventBusForTests,
} from "../src/ui-bus/event-bus";
import { resetStorageForTests } from "../src/storage";

process.env.SUMI_DATA_DIR = `/tmp/sumi-test-${process.pid}`;

describe("parseRoomName", () => {
  it("parses uuid-based room names", () => {
    const r = parseRoomName("b140ffee-1a2b-3c4d-8e9f-0123456789ab-main.md");
    expect(r).toEqual({
      projectId: "b140ffee-1a2b-3c4d-8e9f-0123456789ab",
      fileId: "main.md",
    });
  });
  it("parses cuid-based room names", () => {
    const r = parseRoomName("cabcdefghijklmnopqrstuvwx-docs/intro.md");
    expect(r?.projectId).toBe("cabcdefghijklmnopqrstuvwx");
    expect(r?.fileId).toBe("docs/intro.md");
  });
  it("strips ws/ prefix", () => {
    const r = parseRoomName("ws/b140ffee-1a2b-3c4d-8e9f-0123456789ab-x.md");
    expect(r?.fileId).toBe("x.md");
  });
  it("rejects chat- and project- rooms", () => {
    expect(parseRoomName("chat-abc")).toBeNull();
    expect(parseRoomName("project-abc")).toBeNull();
  });
});

describe("RelPos tracking", () => {
  it("creates anchors that survive concurrent edits", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "line1\nline2\nline3\nline4\nline5\n");

    // Anchor around line 3
    const { startRelPos, endRelPos } = createRelPosForEdit(ytext, 3, 3);
    expect(startRelPos).not.toBeNull();
    expect(endRelPos).not.toBeNull();

    // Simulate a remote user inserting 2 lines at the top
    ytext.insert(0, "newA\nnewB\n");

    // Re-resolve: should now point to line 5
    const newStart = getLineFromRelPos(doc, ytext, startRelPos!);
    expect(newStart).toBe(5);
  });

  it("addRelPosToEdit attaches anchors to every block", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "a\nb\nc\nd\n");

    const edit: PendingEdit = {
      id: "e1",
      filePath: "x.md",
      projectId: "p1",
      blocks: [
        { startLine: 1, endLine: 2, updated: "A\nB" },
        { startLine: 3, endLine: 4, updated: "C\nD" },
      ],
      status: "pending",
      createdAt: Date.now(),
    };

    const result = addRelPosToEdit(edit, ytext);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].startRelPos).toBeDefined();
    expect(result.blocks[1].endRelPos).toBeDefined();
  });
});

describe("A2UI validate", () => {
  it("accepts structural patches", () => {
    expect(
      validateUiPatch({ type: "set_panel_visibility", panel: "ai", visible: true })
    ).not.toBeNull();
    expect(validateUiPatch({ type: "noop" })).not.toBeNull();
  });
  it("rejects unknown patch kinds", () => {
    expect(validateUiPatch({ type: "fly_to_moon" })).toBeNull();
    expect(validateUiPatch({ type: "set_panel_size", panel: "ai", widthPercent: 200 })).toBeNull();
  });
  it("accepts json-render payloads", () => {
    expect(
      validateJsonRender({
        kind: "progress",
        runId: "r1",
        status: "running",
        progress: 0.4,
      })
    ).not.toBeNull();
  });
});

describe("UI event bus", () => {
  beforeEach(() => {
    resetUiEventBusForTests();
    resetStorageForTests();
  });

  it("delivers live events to subscribers", async () => {
    const seen: unknown[] = [];
    const unsub = subscribeUiEvents("u1", (e) => seen.push(e.patch));
    await publishUiPatch({
      userId: "u1",
      projectId: "p1",
      patch: { type: "show_ai_chat" },
    });
    unsub();
    expect(seen).toEqual([{ type: "show_ai_chat" }]);
  });

  it("replays durable events after a simulated restart", async () => {
    resetStorageForTests(); // share the same instance via env
    await publishUiPatch({
      userId: "u2",
      projectId: "p1",
      patch: { type: "set_main_block", block: "editor" },
    });
    resetUiEventBusForTests();
    const events = await listUiEvents("u2", { limit: 10 });
    expect(events.length).toBe(1);
    expect(events[0].patch).toEqual({ type: "set_main_block", block: "editor" });
  });
});
