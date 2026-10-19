/**
 * What the ask dock shows.
 *
 * The dock has no history, so the only question its state has to answer is "what
 * happened to the newest ask in this document". That decision is pure and lives in
 * lib/ask-dock.ts, so it can be pinned here rather than inferred from the UI.
 */

import { describe, it, expect } from "vitest";
import { askDockState, type AskIntentLike } from "../lib/ask-dock";

const P = "prj_a";
const SCOPE = { projectId: P, fileId: "notes.md" };

function intent(over: Partial<AskIntentLike> = {}): AskIntentLike {
  return {
    id: "int_1",
    projectId: P,
    fileId: "notes.md",
    status: "open",
    prompt: "改一下标题",
    answerText: null,
    answerEditId: null,
    createdAt: 1000,
    ...over,
  };
}

describe("askDockState", () => {
  it("is idle with nothing asked", () => {
    expect(askDockState([], SCOPE)).toEqual({ kind: "idle" });
  });

  it("is idle without a project", () => {
    // No project means no scope to ask into; showing an answer here would be
    // showing someone else's.
    expect(
      askDockState([intent({ status: "answered", answerText: "好" })], {
        projectId: null,
        fileId: null,
      })
    ).toEqual({ kind: "idle" });
  });

  it("reports waiting for an open ask", () => {
    expect(askDockState([intent()], SCOPE)).toEqual({
      kind: "waiting",
      prompt: "改一下标题",
    });
  });

  it("reports waiting while claimed", () => {
    expect(askDockState([intent({ status: "claimed" })], SCOPE).kind).toBe("waiting");
  });

  it("shows the answer once answered", () => {
    const state = askDockState(
      [intent({ status: "answered", answerText: "已经改成新标题了" })],
      SCOPE
    );
    expect(state).toEqual({
      kind: "answered",
      prompt: "改一下标题",
      answer: "已经改成新标题了",
      editId: null,
    });
  });

  it("carries the pending-edit id when the answer came with one", () => {
    const state = askDockState(
      [
        intent({
          status: "answered",
          answerText: "我改了几处",
          answerEditId: "edit_9",
        }),
      ],
      SCOPE
    );
    expect(state).toMatchObject({ kind: "answered", editId: "edit_9" });
  });

  it("keeps waiting when an answer is empty", () => {
    // An answered row with nothing to show is not something to display; an empty
    // box would read as a reply that vanished.
    const state = askDockState(
      [intent({ status: "answered", answerText: "   " })],
      SCOPE
    );
    expect(state.kind).toBe("waiting");
  });

  it("ignores closed asks", () => {
    expect(askDockState([intent({ status: "closed" })], SCOPE)).toEqual({
      kind: "idle",
    });
  });

  it("ignores other documents", () => {
    expect(askDockState([intent({ fileId: "other.md" })], SCOPE)).toEqual({
      kind: "idle",
    });
  });

  it("ignores other projects", () => {
    expect(askDockState([intent({ projectId: "prj_b" })], SCOPE)).toEqual({
      kind: "idle",
    });
  });

  it("shows the newest ask, not the first in the list", () => {
    // The API returns newest-first, but the dock must not depend on ordering.
    const older = intent({
      id: "old",
      status: "answered",
      answerText: "旧答复",
      createdAt: 1000,
    });
    const newer = intent({
      id: "new",
      status: "answered",
      answerText: "新答复",
      createdAt: 2000,
    });
    expect(askDockState([older, newer], SCOPE)).toMatchObject({
      kind: "answered",
      answer: "新答复",
    });
    expect(askDockState([newer, older], SCOPE)).toMatchObject({
      kind: "answered",
      answer: "新答复",
    });
  });

  it("prefers a newer unanswered ask over an older answer", () => {
    // Leaving the previous answer on screen would read as a reply to the new
    // question, which is the confusing half of a chat panel without the benefit.
    const answered = intent({
      id: "answered",
      status: "answered",
      answerText: "上一个问题的答复",
      createdAt: 1000,
    });
    const justAsked = intent({ id: "asked", status: "open", createdAt: 2000 });

    const state = askDockState([answered, justAsked], SCOPE);
    expect(state.kind).toBe("waiting");
  });

  it("treats a project-wide scope as matching every document in it", () => {
    // When no document is open the surface is project-wide.
    const state = askDockState([intent({ fileId: "anything.md" })], {
      projectId: P,
      fileId: null,
    });
    expect(state.kind).toBe("waiting");
  });

  it("keeps a project-scope ask visible while a document is open", () => {
    // Asked from the project list, answered while the user is in a document. If the
    // scope filter dropped it, the answer would vanish at the moment the user went
    // looking for somewhere to apply it — the row exists and the dock says nothing.
    const projectScoped = intent({ fileId: null, status: "answered", answerText: "先补测试" });
    expect(askDockState([projectScoped], SCOPE)).toEqual({
      kind: "answered",
      prompt: "改一下标题",
      answer: "先补测试",
      editId: null,
    });
  });

  it("still hides another document's ask from this document", () => {
    // The other direction, which must not regress into "show everything": a
    // doc-scoped ask belongs to its document alone.
    const other = intent({ fileId: "other.md", status: "answered", answerText: "别处" });
    expect(askDockState([other], SCOPE)).toEqual({ kind: "idle" });
  });

  it("handles rows with missing timestamps", () => {
    const a = intent({ id: "a", createdAt: null });
    const b = intent({ id: "b", createdAt: 5, prompt: "有时间的那个" });
    expect(askDockState([a, b], SCOPE)).toMatchObject({
      kind: "waiting",
      prompt: "有时间的那个",
    });
  });

  it("trims the prompt it reports", () => {
    const state = askDockState([intent({ prompt: "  带空格的问题  " })], SCOPE);
    expect(state).toMatchObject({ prompt: "带空格的问题" });
  });
});
