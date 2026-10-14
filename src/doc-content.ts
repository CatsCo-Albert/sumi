/**
 * Shared doc-content helpers for API routes.
 *
 * The Yjs room is the live source of truth while clients are connected;
 * the persisted file (storage) is the canonical blob a fresh room seeds
 * from. "Current content" = ws-server /doc when the room is hot, else disk.
 */

import { getStorage } from "./storage";

const WS_PORT = () => (process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 12345);
const INTERNAL_SECRET = () => process.env.INTERNAL_API_SECRET || "";

export const docKey = (projectId: string, fileId: string) =>
  `sumi/${projectId}/files/${fileId}`;

/**
 * Best-effort read of the live document content.
 * Order: ws-server in-memory doc → persisted storage blob → null.
 */
export async function currentDocContent(
  projectId: string,
  fileId: string
): Promise<string | null> {
  // 1) Live Yjs room (authoritative while connected)
  try {
    const res = await fetch(
      `http://localhost:${WS_PORT()}/doc/${projectId}/${encodeURIComponent(fileId)}`
    );
    if (res.ok) {
      const d = (await res.json()) as { content?: string };
      if (typeof d.content === "string") return d.content;
    }
  } catch {
    // ws-server down — fall through to storage
  }

  // 2) Canonical persisted blob
  try {
    const storage = await getStorage();
    const key = docKey(projectId, fileId);
    if (await storage.exists(key)) {
      return (await storage.download(key)).toString("utf8");
    }
  } catch {
    // storage failure is non-fatal — caller decides
  }
  return null;
}

/**
 * Full-replace push into the ws-server (broadcasts to connected clients),
 * then persist to storage so a fresh room seeds the restored content.
 */
export async function pushDocContent(
  projectId: string,
  fileId: string,
  content: string
): Promise<void> {
  try {
    const storage = await getStorage();
    await storage.upload(docKey(projectId, fileId), content, "text/markdown");
  } catch (err) {
    console.error("[doc-content] storage upload failed:", err);
  }
  try {
    await fetch(
      `http://localhost:${WS_PORT()}/replace/${projectId}/${encodeURIComponent(fileId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_SECRET(),
        },
        body: JSON.stringify({ content }),
      }
    );
  } catch {
    // ws-server unreachable is non-fatal; next sync reloads from storage
  }
}
