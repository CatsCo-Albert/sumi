/**
 * Sumi → XiaoBa dashboard, on loopback only.
 *
 * Two things live on the other side of this file, and both are the dashboard's
 * rather than Sumi's:
 *
 *   - `POST /api/artifacts/:id/mcp/attach` makes this app's MCP endpoint visible
 *     to the bot, and binds artifactId → sessionKey so an answer can be routed
 *     back to the conversation that asked.
 *   - `POST /api/artifacts/events` lets a person's interaction in the page wake
 *     that conversation, through a2ui_action / a2ui_state_change envelopes.
 *
 * It has to be Sumi that calls them. The dashboard binds only 127.0.0.1 and
 * sends no CORS headers, so a page served from the public preview origin cannot
 * reach either one — the browser request would be blocked before it left. The
 * page talks to Sumi over its own existing channel; Sumi, already on this
 * machine, does the last hop.
 *
 * Nothing here throws for an expected failure. A closed gate, an unreachable
 * dashboard and a rejected payload are all states the caller must be able to
 * report honestly, and an exception thrown three layers down turns "the bot
 * cannot see you right now" into a stack trace.
 */

/** Why an attempt did not succeed, in the terms a caller can act on. */
export type BridgeFailure =
  /** The dashboard refused: its attach/events gate is closed. Fixable by config. */
  | "disabled"
  /** Nothing answered on that port, or it took too long. */
  | "unreachable"
  /** The dashboard answered and said no: bad url, bad envelope, unknown artifact. */
  | "rejected"
  /** The dashboard itself failed. Retry may work. */
  | "server_error"
  /** This deployment did not configure the dashboard at all. */
  | "unconfigured";

export interface BridgeError {
  ok: false;
  reason: BridgeFailure;
  message: string;
  status?: number;
  /** The dashboard's own error code, like `mcp_attach_requires_auth`. */
  code?: string;
}

export type BridgeResult<T> = { ok: true; value: T } | BridgeError;

export interface AttachValue {
  artifactId: string;
  serverId: string;
  url: string;
  attachedManagers: number;
  sessionBound: boolean;
}

export interface DetachValue {
  artifactId: string;
  existed: boolean;
  sessionUnbound: boolean;
}

/** One interaction in the page, as the dashboard's envelope wants it. */
export interface Interaction {
  kind: "a2ui_action" | "a2ui_form_submit" | "a2ui_state_change";
  /** The component the person touched, in the page's own ref space. */
  componentId: string;
  /** For `a2ui_action`; the api method a press ran. */
  actionName?: string;
  /** For `a2ui_action`. */
  params?: Record<string, unknown>;
  /** For `a2ui_form_submit`. */
  formData?: Record<string, unknown>;
  /** For `a2ui_state_change`. */
  state?: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  /** Idempotency key: a replayed batch then collapses instead of double-waking. */
  clientEventId?: string;
}

export interface BridgeClientOptions {
  /** Dashboard origin. Loopback by default; there is no reason to point elsewhere. */
  baseUrl?: string;
  /** Sent as a Bearer token when the dashboard requires one. */
  apiKey?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Per-request deadline. The dashboard answers from memory; a slow reply is a broken one. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3800";
const DEFAULT_TIMEOUT_MS = 8_000;

function reasonForStatus(status: number): BridgeFailure {
  if (status === 403) return "disabled";
  if (status >= 500) return "server_error";
  return "rejected";
}

/**
 * Read the dashboard's error body without assuming its shape.
 *
 * Both endpoints answer `{ok:false, code, error}` today, but a proxy or a future
 * version could answer anything; the message still has to say something true.
 */
function parseErrorBody(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message:
      typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
          : undefined,
  };
}

export class ArtifactBridgeClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BridgeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.XIAOBA_DASHBOARD_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ""
    );
    this.apiKey = options.apiKey ?? process.env.DASHBOARD_API_KEY?.trim() ?? undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async post<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      // A refused connection and a deadline are the same fact for the caller:
      // the dashboard is not answering. They are not the same as a rejection.
      return { ok: false, reason: "unreachable", message };
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const { code, message } = parseErrorBody(parsed);
      return {
        ok: false,
        reason: reasonForStatus(response.status),
        status: response.status,
        ...(code ? { code } : {}),
        message: message ?? `dashboard answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }

    return { ok: true, value: (parsed ?? {}) as T };
  }

  /**
   * Make this app's MCP endpoint visible to the bot, and bind the conversation.
   *
   * `url` must be loopback: the dashboard rejects anything else unless a remote
   * attach was explicitly allowed, and there is no reason to allow it when Sumi
   * answers on 127.0.0.1 already.
   */
  async attach(input: {
    artifactId: string;
    sessionKey: string;
    url: string;
  }): Promise<BridgeResult<AttachValue>> {
    const result = await this.post<AttachValue>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/mcp/attach`,
      { url: input.url, sessionKey: input.sessionKey }
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        artifactId: input.artifactId,
        serverId: result.value.serverId ?? "",
        url: result.value.url ?? input.url,
        attachedManagers: result.value.attachedManagers ?? 0,
        sessionBound: result.value.sessionBound === true,
      },
    };
  }

  async detach(
    artifactId: string,
    options: { unbindSession?: boolean } = {}
  ): Promise<BridgeResult<DetachValue>> {
    const result = await this.post<DetachValue>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/mcp/detach`,
      options.unbindSession ? { unbindSession: true } : {}
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        artifactId,
        existed: result.value.existed === true,
        sessionUnbound: result.value.sessionUnbound === true,
      },
    };
  }

  /**
   * Send people's interactions to the conversation, so the bot can wake.
   *
   * Batched because the dashboard accepts up to 100 per request and because a
   * burst of typing changes is one thing to react to, not forty. Every event
   * carries its own clientEventId so a retry that actually landed the first time
   * collapses instead of waking the conversation twice.
   */
  async emit(input: {
    artifactId: string;
    sessionKey?: string;
    interactions: Interaction[];
  }): Promise<BridgeResult<{ accepted: number; deduplicated: number }>> {
    if (input.interactions.length === 0) {
      return { ok: true, value: { accepted: 0, deduplicated: 0 } };
    }

    const events = input.interactions.map((interaction) => ({
      kind: interaction.kind,
      artifactId: input.artifactId,
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      componentId: interaction.componentId,
      ...(interaction.actionName ? { actionName: interaction.actionName } : {}),
      ...(interaction.params ? { params: interaction.params } : {}),
      ...(interaction.formData ? { formData: interaction.formData } : {}),
      ...(interaction.state ? { state: interaction.state } : {}),
      ...(interaction.previousState ? { previousState: interaction.previousState } : {}),
      ...(interaction.clientEventId ? { clientEventId: interaction.clientEventId } : {}),
    }));

    const result = await this.post<{ results?: Array<{ accepted?: boolean; deduplicated?: boolean }> }>(
      "/api/artifacts/events",
      { events }
    );
    if (!result.ok) return result;

    const results = Array.isArray(result.value.results) ? result.value.results : [];
    return {
      ok: true,
      value: {
        accepted: results.filter((entry) => entry.accepted !== false).length,
        deduplicated: results.filter((entry) => entry.deduplicated === true).length,
      },
    };
  }

  /**
   * Attach, retrying a transient failure a bounded number of times.
   *
   * `disabled` is deliberately not retried: the gate is closed until someone
   * changes the environment, and hammering it would only fill the log with the
   * same line. `unreachable` and `server_error` are worth another attempt — a
   * dashboard restarting after a config change looks exactly like this.
   */
  async ensureAttached(
    input: { artifactId: string; sessionKey: string; url: string },
    options: { attempts?: number; delayMs?: number } = {}
  ): Promise<BridgeResult<AttachValue>> {
    const attempts = Math.max(1, options.attempts ?? 3);
    const delayMs = options.delayMs ?? 500;
    let last: BridgeResult<AttachValue> = {
      ok: false,
      reason: "unconfigured",
      message: "no attempt was made",
    };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.attach(input);
      if (last.ok) return last;
      if (last.reason === "disabled" || last.reason === "rejected" || last.reason === "unconfigured") {
        return last;
      }
      if (attempt < attempts) await this.sleep(delayMs * attempt);
    }
    return last;
  }
}

/**
 * What this process last learned about each artifact, so a caller can say why
 * the bot cannot see the page instead of quietly doing nothing.
 */
export interface BridgeState {
  artifactId: string;
  attached: boolean;
  sessionKey?: string;
  lastError?: BridgeError;
  at: number;
}

const states = new Map<string, BridgeState>();

export function rememberBridgeState(state: BridgeState): void {
  states.set(state.artifactId, state);
}

export function bridgeState(artifactId: string): BridgeState | undefined {
  return states.get(artifactId);
}

export function resetBridgeStateForTests(): void {
  states.clear();
}

/** The MCP endpoint the bot should reach. Loopback, by construction. */
export function sumiMcpUrl(appPort = Number(process.env.APP_PORT || 8794)): string {
  return process.env.SUMI_MCP_URL || `http://127.0.0.1:${appPort}/sumi/mcp`;
}

/** The artifact this deployment was published as. */
export function configuredArtifactId(): string {
  return (process.env.CATSCO_ARTIFACT_APP_ID || "").trim();
}

/** The conversation this deployment answers to, when one is pinned. */
export function configuredSessionKey(): string {
  return (process.env.SUMI_ARTIFACT_SESSION_KEY || "").trim();
}