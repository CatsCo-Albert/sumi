/**
 * Cross-member collaboration through the agent bridge.
 *
 * The bridge used to answer only from the caller's own pages, which made an
 * agent useless as a collaborator: it could look at its own automation browser
 * and never at the person it was working with. These tests pin down the rule —
 * the unit of addressing is the project, and membership is what makes a caller
 * allowed to address it.
 *
 * The cases that matter most are the refusals: a page that was not asked must
 * not be able to answer, and a write must not fan out to several tabs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  listPages,
  listProjectPages,
  registerPage,
  resetPageRegistry,
  touchPage,
} from "../src/ui-bus/page-registry";
import {
  callAgent,
  pendingAgentCalls,
  resetAgentBridgeForTests,
  settleAgentCall,
} from "../src/ui-bus/agent-bridge";
import {
  listMarks,
  markSummary,
  recordMarks,
  resetMarkLedger,
} from "../src/ui-bus/mark-ledger";
import {
  resetUiEventBusForTests,
  subscribeUiEvents,
} from "../src/ui-bus/event-bus";

const PROJECT = "prj_test";
const OTHER_PROJECT = "prj_other";
const ME = "a574";
const THEM = "u275";

/**
 * Request ids, captured as the bridge publishes them.
 *
 * `callAgent` mints the id itself, so a test cannot pass one in. Subscribing is
 * what a real page does, which makes this the honest way to observe it: it also
 * proves the request reached the member the page belongs to.
 */
const seen: Array<{ userId: string; requestId: string }> = [];

function capture(): void {
  for (const userId of [THEM, ME]) {
    subscribeUiEvents(userId, (event) => {
      const patch = event.patch as { requestId?: string };
      if (patch?.requestId) seen.push({ userId, requestId: patch.requestId });
    });
  }
}

/** The id of the newest published request for one page's owner. */
function requestIdFor(userId: string): string {
  const last = [...seen].reverse().find((entry) => entry.userId === userId);
  if (!last) throw new Error(`no request published for ${userId}`);
  return last.requestId;
}

beforeEach(() => {
  resetPageRegistry();
  resetAgentBridgeForTests();
  resetMarkLedger();
  resetUiEventBusForTests();
  seen.length = 0;
  capture();
});

describe("page registry across members", () => {
  it("lists another member's page when asked by project", () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT, filePath: "notes.md" });
    registerPage({ userId: ME, clientId: "c_agent", projectId: PROJECT, filePath: null });

    // The per-person view still exists and is still scoped to one person.
    expect(listPages(ME, PROJECT).map((p) => p.clientId)).toEqual(["c_agent"]);

    // The project view is what makes collaboration possible.
    expect(listProjectPages(PROJECT).map((p) => p.clientId).sort()).toEqual([
      "c_agent",
      "c_user",
    ]);
  });

  it("does not leak a page into another project", () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });
    expect(listProjectPages(OTHER_PROJECT)).toEqual([]);
  });

  it("moves a page between projects when it switches document", () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });
    touchPage(THEM, "c_user", { projectId: OTHER_PROJECT });

    // A page that switched projects must stop answering as part of the old one,
    // or an agent would keep seeing work that is no longer on screen.
    expect(listProjectPages(PROJECT)).toEqual([]);
    expect(listProjectPages(OTHER_PROJECT).map((p) => p.clientId)).toEqual(["c_user"]);
  });

  it("drops a page from both indexes when it closes", () => {
    const close = registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });
    close();
    expect(listProjectPages(PROJECT)).toEqual([]);
    expect(listPages(THEM)).toEqual([]);
  });
});

describe("callAgent addressing", () => {
  it("reads another member's page and attributes the answer to them", async () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT, filePath: "notes.md" });

    const answer = callAgent({ projectId: PROJECT, userId: ME, call: "snapshot", input: {} });
    // The request goes to the member whose page it is, not to the caller.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((entry) => entry.userId)).toEqual([THEM]);

    expect(settleAgentCall(requestIdFor(THEM), "c_user", { ok: true, value: [] }, "notes.md")).toBe(
      true
    );
    const result = (await answer) as {
      pages: Array<{ clientId: string; userId: string }>;
    };
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].clientId).toBe("c_user");
    // Without this the caller cannot tell whose screen it just read.
    expect(result.pages[0].userId).toBe(THEM);
  });

  it("refuses a write when more than one page is open", async () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });
    registerPage({ userId: ME, clientId: "c_agent", projectId: PROJECT });

    await expect(
      callAgent({ projectId: PROJECT, userId: ME, call: "act", input: { steps: [] } })
    ).rejects.toThrow(/ambiguous_page/);
  });

  it("refuses a write to a page that is not open", async () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });
    await expect(
      callAgent({
        projectId: PROJECT,
        userId: ME,
        clientId: "c_missing",
        call: "act",
        input: { steps: [] },
      })
    ).rejects.toThrow(/page_not_open/);
  });

  it("never settles a call from a page it did not ask", async () => {
    registerPage({ userId: THEM, clientId: "c_user", projectId: PROJECT });

    const answer = callAgent({ projectId: PROJECT, userId: ME, call: "snapshot", input: {} });
    await new Promise((r) => setTimeout(r, 10));
    const id = requestIdFor(THEM);

    // A page that joined afterwards must not be able to answer on its behalf.
    expect(settleAgentCall(id, "c_stranger", { ok: true, value: [] })).toBe(false);
    expect(pendingAgentCalls()).toBe(1);

    expect(settleAgentCall(id, "c_user", { ok: true, value: [] })).toBe(true);
    expect(pendingAgentCalls()).toBe(0);
    await answer;
  });

  it("fails loudly when nobody has the project open", async () => {
    await expect(
      callAgent({ projectId: PROJECT, userId: ME, call: "snapshot", input: {} })
    ).rejects.toThrow(/no page answered/);
  });
});

describe("mark ledger across members", () => {
  it("reports marks from every member's page in the project", () => {
    recordMarks({
      requestId: "r1",
      clientId: "c_user",
      userId: THEM,
      projectId: PROJECT,
      filePath: "notes.md",
      marks: [{ ref: "btn", kind: "read", component: "button" }],
    });
    recordMarks({
      requestId: "r2",
      clientId: "c_agent",
      userId: ME,
      projectId: PROJECT,
      filePath: null,
      marks: [{ ref: "tab", kind: "changed", component: "tab" }],
    });

    // Project scope: the question a collaborator actually asks.
    expect(listMarks({ projectId: PROJECT })).toHaveLength(2);
    expect(markSummary({ projectId: PROJECT }).members.sort()).toEqual([ME, THEM].sort());

    // Still narrowable to one person when that is the question.
    expect(listMarks({ userId: THEM, projectId: PROJECT })).toHaveLength(1);
  });

  it("does not count another project's marks", () => {
    recordMarks({
      requestId: "r3",
      clientId: "c_x",
      userId: THEM,
      projectId: OTHER_PROJECT,
      filePath: null,
      marks: [{ ref: "x", kind: "read" }],
    });
    expect(listMarks({ projectId: PROJECT })).toHaveLength(0);
  });
});
