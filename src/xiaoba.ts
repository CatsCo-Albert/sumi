/**
 * XiaoBa-CLI connection helpers.
 *
 * XiaoBa agents are CatsCo bots — they authenticate with the same
 * `cc_*` ApiKey they already use for cats-company. Sumi does the
 * introspection hop so the CLI doesn't need to know any internal secret.
 *
 * Typical usage from the CLI:
 *
 *   import { connectSumi } from "xiaoba-sumishim";
 *   const conn = await connectSumi({
 *     wsUrl: "wss://sumi.example.com",
 *     apiKey: process.env.CATSCO_API_KEY,   // cc_*
 *     projectId: "prj_xxx",
 *     fileId: "notes/intro.md",
 *   });
 *   conn.ytext.insert(0, "hello from xiaoba\n");
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

export interface SumiConnection {
  doc: Y.Doc;
  ytext: Y.Text;
  provider: WebsocketProvider;
  /** Graceful shutdown. */
  close: () => void;
}

export interface ConnectOptions {
  /** e.g. "wss://sumi.example.com" or "ws://localhost:1234" */
  wsUrl: string;
  /** CatsCo ApiKey — "cc_..." */
  apiKey: string;
  /** Sumi project id ("prj_...") */
  projectId: string;
  /** File path inside the project, e.g. "notes/intro.md" */
  fileId: string;
  /** Optional display name shown in other users' carets. */
  displayName?: string;
}

/**
 * Open a Yjs room. Resolves once `sync` fires (initial state delivered).
 * Throws if the WS server rejects the connection (bad key / no access).
 */
export async function connectSumi(opts: ConnectOptions): Promise<SumiConnection> {
  const roomName = `${opts.projectId}-${opts.fileId}`;
  const doc = new Y.Doc();
  const ytext = doc.getText("content");

  const provider = new WebsocketProvider(opts.wsUrl, roomName, doc, {
    params: { api_key: opts.apiKey },
  });

  if (opts.displayName) {
    provider.awareness.setLocalStateField("user", {
      name: opts.displayName,
      color: "#0A84FF",
      colorLight: "#0A84FF33",
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("sumi connect timeout"));
    }, 10_000);
    provider.once("sync", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    doc,
    ytext,
    provider,
    close: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

/**
 * Write into a document through the WS server — no awareness, no sync.
 * Useful for one-shot edits where you don't need live presence.
 *
 * Requires INTERNAL_API_SECRET — only usable server-side.
 */
export async function replaceDocument(opts: {
  wsHttpUrl: string;          // e.g. "http://localhost:1234"
  internalSecret: string;
  projectId: string;
  fileId: string;
  content: string;
}): Promise<boolean> {
  const res = await fetch(
    `${opts.wsHttpUrl}/replace/${opts.projectId}/${encodeURIComponent(opts.fileId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": opts.internalSecret,
      },
      body: JSON.stringify({ content: opts.content }),
    }
  );
  return res.ok;
}
