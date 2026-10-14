"use client";

/**
 * Settings dialog — per-user editor preferences persisted to localStorage.
 * Keys are namespaced `sumi:setting:*` so they survive cross-project.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type Theme = "light" | "dark" | "system";

export interface EditorSettings {
  fontSize: number; // px, 12-18
  theme: Theme;
  autosaveDelayMs: number; // debounce for doc persistence
  vimMode: boolean; // stub — reserved
}

const DEFAULTS: EditorSettings = {
  fontSize: 14,
  theme: "system",
  autosaveDelayMs: 800,
  vimMode: false,
};

const KEY = "sumi:settings";

export function loadSettings(): EditorSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EditorSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: EditorSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
  // Broadcast so editor + preview pick it up without reload.
  window.dispatchEvent(new CustomEvent("sumi:settings-changed", { detail: s }));
}

export function useEditorSettings(): [EditorSettings, (s: EditorSettings) => void] {
  const [s, setS] = useState<EditorSettings>(DEFAULTS);
  useEffect(() => {
    setS(loadSettings());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as EditorSettings | undefined;
      if (detail) setS({ ...DEFAULTS, ...detail });
    };
    window.addEventListener("sumi:settings-changed", handler);
    return () => window.removeEventListener("sumi:settings-changed", handler);
  }, []);
  const save = (next: EditorSettings) => {
    setS(next);
    saveSettings(next);
  };
  return [s, save];
}

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useEditorSettings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const apply = <K extends keyof EditorSettings>(k: K, v: EditorSettings[K]) =>
    setSettings({ ...settings, [k]: v });

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="material-glass w-[380px] rounded-2xl border border-border p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">编辑器设置</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground/60 hover:text-foreground"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        {/* Theme */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
            主题
          </label>
          <div className="flex gap-1 rounded-lg border border-border/60 p-0.5">
            {(["light", "dark", "system"] as const).map((t) => (
              <button
                key={t}
                onClick={() => apply("theme", t)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
                  settings.theme === t
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}
              </button>
            ))}
          </div>
        </div>

        {/* Font size */}
        <div className="mb-4">
          <label className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            字号
            <span className="font-mono text-foreground">{settings.fontSize}px</span>
          </label>
          <input
            type="range"
            min={12}
            max={18}
            step={1}
            value={settings.fontSize}
            onChange={(e) => apply("fontSize", parseInt(e.target.value, 10))}
            className="w-full accent-primary"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground/60">
            <span>12</span>
            <span>14</span>
            <span>16</span>
            <span>18</span>
          </div>
        </div>

        {/* Autosave */}
        <div className="mb-4">
          <label className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            自动保存延迟
            <span className="font-mono text-foreground">{settings.autosaveDelayMs}ms</span>
          </label>
          <div className="flex gap-1">
            {[300, 800, 1500, 3000].map((ms) => (
              <button
                key={ms}
                onClick={() => apply("autosaveDelayMs", ms)}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                  settings.autosaveDelayMs === ms
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:text-foreground"
                )}
              >
                {ms === 300 ? "快" : ms === 800 ? "标准" : ms === 1500 ? "慢" : "3s"}
              </button>
            ))}
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          设置保存在本机，跨项目生效。
        </p>
      </div>
    </div>
  );
}
