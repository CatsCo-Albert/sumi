/**
 * Yjs Redis persistence.
 *
 * Stores incremental Yjs updates in Redis so the full CRDT structure
 * (including RelativePosition) survives server restarts.
 *
 * Redis layout:
 *   yjs:{projectId}:{fileId-b64url}:updates  List of update buffers
 *   yjs:{projectId}:{fileId-b64url}:meta     Hash of metadata
 *
 * Env:
 *   REDIS_URL — optional; if unset, runs in-memory only.
 */

import * as Y from "yjs";
import { getRedis, closeRedis } from "./redis-client";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function getKeyPrefix(projectId: string, fileId: string): string {
  // base64url keeps encoding reversible + Redis-Cluster-safe (no hash tags needed
  // across keys — we never issue multi-key commands spanning slots).
  const b64url = Buffer.from(fileId, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sumi:${projectId}:${b64url}`;
}

const getUpdatesKey = (p: string, f: string) => `${getKeyPrefix(p, f)}:updates`;
const getMetaKey = (p: string, f: string) => `${getKeyPrefix(p, f)}:meta`;

// ---------------------------------------------------------------------------
// Room name
// ---------------------------------------------------------------------------

/**
 * Parse "projectId-fileId" → { projectId, fileId }.
 *
 * Room name format: `{projectId}-{fileId}` where projectId is a UUID or cuid
 * and fileId may contain hyphens. Returns null for reserved room prefixes
 * (chat-*, project-*).
 */
export function parseRoomName(
  roomName: string
): { projectId: string; fileId: string } | null {
  let cleanName = roomName;
  if (cleanName.startsWith("ws/")) cleanName = cleanName.slice(3);
  if (cleanName.startsWith("project-") || cleanName.startsWith("chat-")) {
    return null;
  }

  const projectIdPattern =
    /^((?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})|(?:c[a-z0-9]{24})|(?:[a-zA-Z0-9_-]+))-(.+)$/i;
  const m = cleanName.match(projectIdPattern);
  if (!m) return null;
  return { projectId: m[1], fileId: m[2] };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Restore updates from Redis into `doc`. Returns true when state was loaded. */
export async function restoreDocument(
  doc: Y.Doc,
  projectId: string,
  fileId: string
): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (!redis) return false;

    const updates = await redis.lrangeBuffer(getUpdatesKey(projectId, fileId), 0, -1);
    if (!updates || updates.length === 0) return false;

    for (const update of updates) {
      Y.applyUpdate(doc, new Uint8Array(update));
    }

    const state = Y.encodeStateAsUpdate(doc);
    if (state.length <= 2) return false; // empty doc

    await redis.hset(getMetaKey(projectId, fileId), {
      lastRestore: Date.now().toString(),
      updateCount: updates.length.toString(),
      stateSize: state.length.toString(),
    });

    console.log(`📥 Restored ${projectId}/${fileId} from Redis (${updates.length} updates)`);
    return true;
  } catch (err) {
    console.error(`❌ restoreDocument ${projectId}/${fileId} failed:`, err);
    return false;
  }
}

/** Append a single update to Redis (called from doc.on("update")). */
export async function storeUpdate(
  update: Uint8Array,
  projectId: string,
  fileId: string
): Promise<void> {
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.rpush(getUpdatesKey(projectId, fileId), Buffer.from(update));
    await redis.hset(getMetaKey(projectId, fileId), {
      lastUpdate: Date.now().toString(),
    });
    await redis.hincrby(getMetaKey(projectId, fileId), "totalUpdates", 1);
  } catch (err) {
    console.error(`❌ storeUpdate ${projectId}/${fileId} failed:`, err);
  }
}

/** Merge all updates into one snapshot. Call periodically to bound list size. */
export async function compactDocument(
  projectId: string,
  fileId: string
): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (!redis) return false;
    const updatesKey = getUpdatesKey(projectId, fileId);
    const updates = await redis.lrangeBuffer(updatesKey, 0, -1);
    if (!updates || updates.length < 10) return false;

    const doc = new Y.Doc();
    for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    const multi = redis.multi();
    multi.del(updatesKey);
    multi.rpush(updatesKey, Buffer.from(snapshot));
    await multi.exec();

    await redis.hset(getMetaKey(projectId, fileId), {
      lastCompact: Date.now().toString(),
      compactedFrom: updates.length.toString(),
    });
    console.log(`🗜️ Compacted ${projectId}/${fileId}: ${updates.length} → 1`);
    return true;
  } catch (err) {
    console.error(`❌ compactDocument ${projectId}/${fileId} failed:`, err);
    return false;
  }
}

/** Remove all persisted data for a doc. */
export async function clearPersistence(
  projectId: string,
  fileId: string
): Promise<void> {
  try {
    const redis = await getRedis();
    if (!redis) return;
    // Delete separately (Redis Cluster CROSSSLOT safety — keys have no hash tags).
    await redis.del(getUpdatesKey(projectId, fileId));
    await redis.del(getMetaKey(projectId, fileId));
  } catch (err) {
    console.error(`❌ clearPersistence ${projectId}/${fileId} failed:`, err);
  }
}

/** Install an `update` listener that persists each update. Returns cleanup fn. */
export function bindDocumentToPersistence(
  doc: Y.Doc,
  projectId: string,
  fileId: string
): () => void {
  const handler = (update: Uint8Array) => {
    // fire-and-forget; sync flow must not block on Redis
    storeUpdate(update, projectId, fileId).catch((err) =>
      console.error("persistence write failed:", err)
    );
  };
  doc.on("update", handler);
  return () => doc.off("update", handler);
}

export async function closeAllPersistence(): Promise<void> {
  await closeRedis();
}
