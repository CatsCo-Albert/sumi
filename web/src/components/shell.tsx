import { Show, createSignal } from "solid-js";
import { Button } from "@ui-sdk/solid/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/solid/dialog";
import { Input } from "@ui-sdk/solid/input";
import { workspace } from "../lib/workspace";
import { apiPath, writeToken } from "../lib/api";
import { currentRoute, navigateTo } from "../lib/route";
import { WorkspaceView } from "./workspace-view";

function SignIn() {
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const value = token().trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiPath("/api/auth/me"), {
        headers: { Authorization: `Bearer ${value}` },
      });
      if (!res.ok) {
        setError("无效的 CatsCo token");
        return;
      }
      writeToken(value);
      window.location.reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="signin">
      <form class="signin-card" onSubmit={submit}>
        <div class="signin-title">登录 Sumi</div>
        <div class="signin-hint">粘贴你的 CatsCo Bearer token（JWT）</div>
        <textarea
          class="signin-input"
          rows={4}
          required
          placeholder="eyJhbGciOiJIUzI1NiIs…"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
        <Show when={error()}>
          <div class="signin-error">{error()}</div>
        </Show>
        <Button type="submit" disabled={busy() || !token().trim()}>
          {busy() ? "…" : "登录"}
        </Button>
        <div class="signin-foot">Agent 接入：连接 WS 时加 ?api_key=cc_…</div>
      </form>
    </div>
  );
}

export function Shell() {
  const [ready, setReady] = createSignal(false);

  // A component body runs once, so this is the mount hook.
  void (async () => {
    const signedIn = await workspace.bootstrap();
    setReady(true);
    if (!signedIn) return;
    // Restore the document named in the URL, once the projects are known.
    const route = currentRoute();
    if (route.projectId) {
      await workspace.selectProject(route.projectId);
      if (route.fileId) workspace.selectDocument(route.fileId);
    }
  })();

  return (
    <Show
      when={ready()}
      fallback={<div class="boot">正在连接 Sumi…</div>}
    >
      <Show
        when={workspace.status() !== "signed-out"}
        fallback={<SignIn />}
      >
        <WorkspaceView />
      </Show>
    </Show>
  );
}

/** A dialog for creating a project or a document — one shape, two callers. */
export function NameDialog(props: {
  open: boolean;
  title: string;
  label: string;
  placeholder: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = createSignal("");

  return (
    <Show when={props.open}>
      <Dialog open onOpenChange={(next: boolean) => props.onOpenChange(next)}>
        <DialogContent>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.label}</DialogDescription>
          <Input
            aria-label={props.label}
            placeholder={props.placeholder}
            value={value()}
            onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
          />
          <div class="dialog-actions">
            <DialogClose>取消</DialogClose>
            <Button
              disabled={!value().trim()}
              onClick={async () => {
                await props.onSubmit(value().trim());
                setValue("");
                props.onOpenChange(false);
              }}
            >
              确定
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Show>
  );
}

export { navigateTo };
