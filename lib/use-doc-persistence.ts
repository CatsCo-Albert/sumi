"use client";

/**
 * Persist the Yjs doc to canonical storage after idle.
 *
 * The Yjs room is the live source of truth; this hook snapshots it to
 * `/api/documents/content` every AUTOSAVE_DEBOUNCE_MS of user-idle so
 * a fresh client can seed without replaying Redis updates.
 *
 * Also fetches the canonical content on mount for `initialContent`.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getAuthHeaders } from "@/lib/use-session";

const AUTOSAVE_DEBOUNCE_MS = 2_000;
const SAVE_ENDPOINT = "/api/documents/content";

export interface PersistenceState {
  /** Loaded once from canonical storage — pass to `initialContent`. */
  initialContent: string | null;
  loading: boolean;
  /** Latest save error (cleared on next success). */
  error: string | null;
  /** Timestamp of last successful save. */
  lastSavedAt: number | null;
}

/**
 * Watch a Y.Text-ish content source and debounce-save it via PUT.
 *
 * `onContentChange` is expected to be called from the editor on every
 * keystroke; we debounce here.
 */
export function useDocPersistence(
  projectId: string | null,
  fileId: string | null
): PersistenceState & {
  /** Call from `onContentChange`. Triggers a debounced save. */
  scheduleSave: (content: string) => void;
} {
  const [initialContent, setInitialContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContent = useRef<string | null>(null);

  // Load canonical content once
  useEffect(() => {
    if (!projectId || !fileId) {
      setInitialContent("");
      setLoading(false);
      return;
    }
    setLoading(true);
    const url = `${SAVE_ENDPOINT}?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(fileId)}`;
    fetch(url, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { content: "", exists: false }))
      .then((d) => {
        setInitialContent(d.exists ? d.content : "");
        setLoading(false);
      })
      .catch(() => {
        setInitialContent("");
        setLoading(false);
      });
  }, [projectId, fileId]);

  const flush = useCallback(async () => {
    if (!projectId || !fileId || pendingContent.current === null) return;
    const content = pendingContent.current;
    pendingContent.current = null;
    try {
      const res = await fetch(SAVE_ENDPOINT, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, filePath: fileId, content }),
      });
      if (res.ok) {
        setLastSavedAt(Date.now());
        setError(null);
      } else {
        setError(`save failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, fileId]);

  const scheduleSave = useCallback(
    (content: string) => {
      pendingContent.current = content;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
    },
    [flush]
  );

  // Flush on unmount / page hide
  useEffect(() => {
    const onHide = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        flush();
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flush();
    };
  }, [flush]);

  return { initialContent, loading, error, lastSavedAt, scheduleSave };
}
