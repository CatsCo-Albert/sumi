"use client";

import { useEffect, useState } from "react";

export interface SessionActor {
  kind: "user" | "agent";
  /** Sumi subject id — "u{uid}" or "a{uid}" */
  id: string;
  uid: number;
  name: string;
  username?: string;
  avatarUrl?: string;
}

/** Read the CatsCo token the user pasted on the sign-in screen. */
export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("sumi.token");
}

/** Get the credential to attach to API requests. */
export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useSession(): {
  actor: SessionActor | null;
  loading: boolean;
} {
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = getStoredToken();

    // No early return when the token is absent: behind the artifact gateway the
    // browser holds a viewer cookie instead, which is sent automatically. The
    // request decides who this is, not the presence of a stored token.
    fetch("/api/auth/me", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        return data.actor as SessionActor;
      })
      .then((a) => {
        if (!cancelled) {
          setActor(a);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { actor, loading };
}
