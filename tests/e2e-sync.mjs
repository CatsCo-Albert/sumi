/**
 * E2E smoke: spin up ws-server, connect two Yjs clients via y-websocket,
 * edit in one, assert it lands in the other.
 *
 * Run: WS_PORT=12345 node tests/e2e-sync.mjs
 * (Assumes ws-server is already listening on $WS_PORT)
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const WS_PORT = process.env.WS_PORT || 12345;
const room = "e2e-proj-test.md";
const url = `ws://localhost:${WS_PORT}`;

const docA = new Y.Doc();
const docB = new Y.Doc();

const pA = new WebsocketProvider(url, room, docA);
const pB = new WebsocketProvider(url, room, docB);

await Promise.all([
  new Promise((r) => pA.once("sync", r)),
  new Promise((r) => pB.once("sync", r)),
]);
console.log("✅ both synced");

const textA = docA.getText("content");
const textB = docB.getText("content");

textA.insert(0, "Hello from A\n");
await new Promise((r) => setTimeout(r, 300));
console.log("B sees:", JSON.stringify(textB.toString()));

textB.insert(textB.length, "Hello from B\n");
await new Promise((r) => setTimeout(r, 300));
console.log("A sees:", JSON.stringify(textA.toString()));

if (
  textA.toString() === "Hello from A\nHello from B\n" &&
  textB.toString() === "Hello from A\nHello from B\n"
) {
  console.log("✅ E2E sync PASSED");
  pA.destroy();
  pB.destroy();
  process.exit(0);
} else {
  console.error("❌ E2E sync FAILED");
  console.error("  A:", JSON.stringify(textA.toString()));
  console.error("  B:", JSON.stringify(textB.toString()));
  pA.destroy();
  pB.destroy();
  process.exit(1);
}
