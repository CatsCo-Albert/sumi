/**
 * Co-edit daemon — watches a local directory, syncs files ↔ Yjs docs.
 *
 * Inspired by Litewrite's AI-server-tool layer: the agent treats the file
 * system as the API. Daemon sits on the Sumi host (or any machine that can
 * reach the WS server), watches a folder, and pushes/pulls changes.
 *
 * Flow:
 *   Local file write → pending-edit proposal → human sees diff
 *   Remote doc change (Yjs update) → write to local file
 *   Local delete → no-op (don't delete docs from under users)
 *
 * Usage:
 *   npx tsx src/server/co-edit-daemon.ts \
 *     --dir /tmp/sumi-workspace \
 *     --project prj_x \
 *     --ws ws://localhost:12345 \
 *     --api-key cc_xxx
 */

import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";

interface WatchEntry {
  fileId: string;      // remote fileId (relative path)
  localPath: string;   // absolute path on disk
  doc: Y.Doc;
  ytext: Y.Text;
  provider: WebsocketProvider;
  /** Last local content hash — suppress echo loops. */
  localHash: string;
  /** Last remote content hash — same. */
  remoteHash: string;
  /** Whether we've done the initial sync. */
  initialized: boolean;
}

const watches = new Map<string, WatchEntry>();
let wsUrl = "";
let apiKey = "";
let httpBase = "";
let projectId = "";
let watchDir = "";

// -- args -------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") watchDir = argv[++i];
    else if (argv[i] === "--project") projectId = argv[++i];
    else if (argv[i] === "--ws") wsUrl = argv[++i];
    else if (argv[i] === "--api-key") apiKey = argv[++i];
  }
  if (!watchDir || !projectId || !wsUrl) {
    console.error(
      "usage: co-edit-daemon --dir <path> --project <id> --ws <url> [--api-key <key>]"
    );
    process.exit(1);
  }
  httpBase = wsUrl
    .replace("ws://", "http://")
    .replace("wss://", "https://")
    .replace(/\/$/, "");
  fs.mkdirSync(watchDir, { recursive: true });
}

// -- http helpers -----------------------------------------------------------

function httpRequest(
  method: string,
  url: string,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchRemote(fileId: string): Promise<{ content: string; contentHash: string } | null> {
  try {
    const r = await httpRequest(
      "GET",
      `${httpBase}/api/documents/content?projectId=${encodeURIComponent(projectId)}&fileId=${encodeURIComponent(fileId)}`
    );
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    return { content: d.content || "", contentHash: d.contentHash || "" };
  } catch {
    return null;
  }
}

async function pushPendingEdit(fileId: string, content: string): Promise<boolean> {
  try {
    // Whole-file block — co-edit is coarse, RelPos anchoring is for granular edits
    const r = await httpRequest(
      "POST",
      `${httpBase}/api/pending-edits`,
      JSON.stringify({
        projectId,
        fileId,
        blocks: [{ startLine: 1, endLine: 999999, updated: content }],
        description: "co-edit sync",
      })
    );
    return r.status === 200;
  } catch {
    return false;
  }
}

// -- file ↔ doc sync --------------------------------------------------------

function fileHash(content: string): string {
  // Simple non-crypto hash — enough for change detection
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

async function syncEntry(entry: WatchEntry) {
  const localPath = entry.localPath;
  const fileId = entry.fileId;

  // --- local → remote: file changed on disk → propose pending edit
  let localContent = "";
  try {
    localContent = fs.readFileSync(localPath, "utf-8");
  } catch {
    return; // file gone
  }
  const lh = fileHash(localContent);
  if (lh !== entry.localHash) {
    // Only push if local actually differs from remote — suppress echo
    const rt = entry.ytext.toString();
    if (localContent !== rt) {
      const ok = await pushPendingEdit(fileId, localContent);
      if (ok) {
        console.log(`[co-edit] ↑ local → remote pending_edit (${localContent.length}b)`);
      }
    }
    entry.localHash = lh;
  }

  // --- remote → local: doc content changed → write file
  const remoteContent = entry.ytext.toString();
  const rh = fileHash(remoteContent);
  if (rh !== entry.remoteHash) {
    try {
      fs.writeFileSync(localPath, remoteContent, "utf-8");
      console.log(`[co-edit] ↓ remote → local (${remoteContent.length}b)`);
    } catch (e) {
      console.error(`[co-edit] write ${localPath} failed:`, e);
    }
    entry.remoteHash = rh;
    entry.localHash = rh; // suppress echo from our own write
  }
}

function attachFile(fileId: string, localPath: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  const roomName = `${projectId}-${fileId}`;
  const provider = new WebsocketProvider(wsUrl, roomName, doc, {
    params: apiKey ? { api_key: apiKey } : {},
  });

  const entry: WatchEntry = {
    fileId,
    localPath,
    doc,
    ytext,
    provider,
    localHash: "",
    remoteHash: "",
    initialized: false,
  };
  watches.set(fileId, entry);

  // Observe Yjs updates → write to file
  ytext.observe(() => {
    // Defer to next tick so we don't hold the Yjs lock during fs I/O
    setTimeout(() => syncEntry(entry), 0);
  });

  provider.on("sync", async (synced: boolean) => {
    if (!synced || entry.initialized) return;
    entry.initialized = true;
    const rt = ytext.toString();
    let lt = "";
    try {
      lt = fs.readFileSync(localPath, "utf-8");
    } catch {
      /* file doesn't exist yet */
    }
    if (!lt && rt) {
      // Remote has content, local empty → pull
      fs.writeFileSync(localPath, rt, "utf-8");
      console.log(`[co-edit] init ↓ ${fileId} (${rt.length}b)`);
    } else if (lt && !rt) {
      // Local has content, remote empty → push
      const ok = await pushPendingEdit(fileId, lt);
      if (ok) console.log(`[co-edit] init ↑ ${fileId} (${lt.length}b)`);
    }
    entry.localHash = fileHash(fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf-8") : "");
    entry.remoteHash = fileHash(rt);
  });

  console.log(`[co-edit] watching ${fileId} → ${localPath}`);
}

// -- watch loop ---------------------------------------------------------------

function scanDir() {
  if (!fs.existsSync(watchDir)) return;
  const entries = fs.readdirSync(watchDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const fileId = e.name;
    if (watches.has(fileId)) continue;
    attachFile(fileId, path.join(watchDir, e.name));
  }
  // Check for deleted files — don't auto-delete remote docs, but stop watching
  for (const [fileId, entry] of watches) {
    if (!fs.existsSync(entry.localPath)) {
      entry.provider.destroy();
      entry.doc.destroy();
      watches.delete(fileId);
      console.log(`[co-edit] unwatched ${fileId} (local file removed)`);
    }
  }
}

// -- entry ------------------------------------------------------------------

async function main() {
  parseArgs();
  console.log(`[co-edit] daemon starting — dir=${watchDir} project=${projectId} ws=${wsUrl}`);
  scanDir();
  const scanInterval = setInterval(scanDir, 2000);
  const syncInterval = setInterval(() => {
    for (const entry of watches.values()) {
      if (entry.initialized) syncEntry(entry);
    }
  }, 1000);

  // Graceful shutdown
  const cleanup = () => {
    clearInterval(scanInterval);
    clearInterval(syncInterval);
    for (const e of watches.values()) {
      e.provider.destroy();
      e.doc.destroy();
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(console.error);
