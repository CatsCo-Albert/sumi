import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Deterministic collaborator color from a user id. */
const COLLAB_COLORS = [
  "#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F",
  "#64D2FF", "#FFD60A", "#98989D", "#FF6482", "#5E5CE6",
];

export function getUserColorById(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return COLLAB_COLORS[hash % COLLAB_COLORS.length];
}

export function generateUserColor(): string {
  return COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
}

const NAMES = [
  "Snow Leopard", "Sea Otter", "Monarch", "Heron", "Fox",
  "Badger", "Wolf", "Lynx", "Osprey", "Kestrel",
];

export function generateUserName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}

/**
 * Resolve the collaboration WebSocket URL used by the browser editor.
 *
 * Precedence: explicit prop → NEXT_PUBLIC_WS_URL → same host on WS_PORT.
 * The port used to be hard-coded to 1234, which silently pointed every
 * non-default deployment (including reverse-proxied ones) at the wrong port.
 * NEXT_PUBLIC_WS_PORT lets the deployed build agree with the server's WS_PORT.
 */
export function resolveWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;

  if (typeof window === "undefined") return "ws://localhost:1234";

  const port = process.env.NEXT_PUBLIC_WS_PORT || "1234";
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.hostname}:${port}`;
}
