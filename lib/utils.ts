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
