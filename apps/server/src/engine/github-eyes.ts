import type { Config } from "../config.ts";

// GitHub eyes — READ-ONLY GitHub inspection for the agent (owner's
// decision, 2026-11-14: "GitHub eyes first", deliberately limited
// first deployment). Until now the engine had no GitHub tool and no
// MCP client at all: the agent could not see its own repository,
// branches, commits, issues or pull requests.
//
// Route: the official GitHub MCP Server (github/github-mcp-server),
// hosted remote endpoint — no local server to run, free, and it
// accepts a personal access token in the Authorization header. The
// bridge below is a small hand-rolled MCP (JSON-RPC over streamable
// HTTP) client, following the same fetch-adapter shape as the memory
// lanes (engine/mem0.ts): no new dependency, fully stub-able in
// tests.
//
// READ-ONLY IS ENFORCED HERE, IN THIS CODE — not by the token, not
// by server configuration:
//   1. Registration: after tools/list, only server tools on
//      GITHUB_READ_ONLY_SERVER_TOOLS are registered with the agent.
//      Anything else the server offers (create_pull_request,
//      merge_pull_request, push_files, issue_write, ...) is dropped
//      and never becomes an agent tool.
//   2. Invocation: callServerTool re-checks the allowlist (and, for
//      method-dispatched tools, a per-tool method allowlist) BEFORE
//      the transport is touched. A non-allowlisted name cannot be
//      invoked through this client by any caller, however the
//      server is configured.
//   3. Server-side narrowing as a third, never-relied-on layer: the
//      transport defaults to the hosted server's /readonly URL
//      variant (the same server's read-only mode, per GitHub's
//      remote-server documentation) and additionally asks for the
//      read-only toolset view (X-MCP-Readonly: true, X-MCP-Toolsets
//      pinned to repos,issues,pull_requests,actions).
// Read access therefore cannot quietly become write access by
// configuration drift: the allowlist is a constant in this file,
// and the token Joseph supplies is itself fine-grained read-only
// (see docs/integrations.md), so the layers agree.
//
// Status honesty (configured / wired / verified — the levels are
// never conflated):
//   configured — GITHUB_MCP_TOKEN is present in the environment.
//   wired      — an MCP initialize + tools/list handshake completed
//                and at least one allowlisted tool is registered.
//   verified   — at least one allowlisted tools/call returned a
//                real (non-error) result through this client.
// `status()` is a synchronous peek at cached state; connecting is
// lazy (first tool use), so server boot never waits on GitHub.

// The hosted server's read-only URL mode (GitHub's remote-server
// documentation): the same MCP endpoint with read-only enforced
// server-side as well. A belt only — the in-code allowlist below is
// the relied-upon barrier, and GITHUB_MCP_URL can still override
// this for tests / Enterprise hosting.
export const GITHUB_MCP_DEFAULT_URL = "https://api.githubcopilot.com/mcp/readonly";
export const GITHUB_MCP_TOOLSETS = "repos,issues,pull_requests,actions";

// The ONLY server tools this client will ever register or invoke.
// Every entry is a pure read in the upstream server. Write tools
// (create_pull_request, merge_pull_request, push_files, issue_write,
// actions_run_trigger, ...) are deliberately absent — absence here
// is the enforcement, not a configuration default.
export const GITHUB_READ_ONLY_SERVER_TOOLS: ReadonlySet<string> = new Set([
  "search_repositories",
  "list_branches",
  "list_commits",
  "get_commit",
  "list_pull_requests",
  "pull_request_read",
  "list_issues",
  "issue_read",
  "actions_list",
]);

// Method-dispatched server tools: even an allowlisted tool may only
// be called with these methods. All are reads. (actions_list also
// offers no write methods upstream, but the pin means a future
// upstream addition cannot slip a trigger through this client.)
export const GITHUB_TOOL_METHOD_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  pull_request_read: new Set([
    "get",
    "get_diff",
    "get_status",
    "get_files",
    "get_commits",
    "get_review_comments",
    "get_reviews",
    "get_comments",
    "get_check_runs",
  ]),
  issue_read: new Set(["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"]),
  actions_list: new Set([
    "list_workflows",
    "list_workflow_runs",
    "list_workflow_jobs",
    "list_workflow_run_artifacts",
  ]),
};

export class GitHubEyesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubEyesError";
  }
}

// The transport seam. HttpMcpTransport is the real implementation;
// tests substitute a scripted fake, so no test ever needs a token
// or the network.
export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpTransport {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 20_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";

// Minimal MCP client over streamable HTTP: JSON-RPC 2.0 POSTs,
// responses accepted as plain JSON or as an SSE stream (the hosted
// server may answer either). Session id, when the server issues
// one, is captured and replayed per the MCP transport spec.
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private nextId = 1;

  constructor(options: { url: string; token: string; fetchFn?: FetchFn; timeoutMs?: number }) {
    this.url = options.url;
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "open-arthur-github-eyes", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.rpc("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) throw new GitHubEyesError("GitHub MCP tools/list returned no tools");
    return tools.filter(
      (tool): tool is McpToolInfo =>
        Boolean(tool) && typeof tool === "object" && typeof (tool as McpToolInfo).name === "string",
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    // A well-formed JSON-RPC envelope can still carry a malformed
    // result (null, a string, ...). That is a failed call, never
    // data — reject it here instead of letting the shaper trip over
    // it or, worse, present it as an inspection result.
    if (!result || typeof result !== "object")
      throw new GitHubEyesError("GitHub MCP tools/call returned a malformed result");
    return result as McpCallResult;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
      // Server-side narrowing (layer 3 — see the module comment).
      // The in-code allowlist stays authoritative even if these
      // headers are ignored or the endpoint changes.
      "X-MCP-Readonly": "true",
      "X-MCP-Toolsets": GITHUB_MCP_TOOLSETS,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  private async post(body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GitHubEyesError(
        `GitHub MCP request failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    if (!response.ok) {
      // Never echo the response body: it is provider text, and the
      // status line is all the diagnosis this layer may surface.
      throw new GitHubEyesError(`GitHub MCP request failed with HTTP ${response.status}`);
    }
    return text;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const raw = await this.post({ jsonrpc: "2.0", id, method, params });
    const message = pickJsonRpcMessage(raw, id);
    if (!message) throw new GitHubEyesError(`GitHub MCP ${method} returned no result`);
    if (message.error) {
      const detail =
        typeof message.error === "object" &&
        message.error !== null &&
        typeof (message.error as { message?: unknown }).message === "string"
          ? (message.error as { message: string }).message
          : "unknown error";
      throw new GitHubEyesError(`GitHub MCP ${method} failed: ${detail}`);
    }
    return message.result;
  }
}

// A streamable-HTTP response is either one JSON body or an SSE
// stream of `data:` lines; find the JSON-RPC message for our id.
function pickJsonRpcMessage(
  raw: unknown,
  id: number,
): { result?: unknown; error?: unknown } | undefined {
  if (typeof raw !== "string") return undefined;
  const candidates: unknown[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Fall through to the SSE scan below.
    }
  }
  for (const line of raw.split("\n")) {
    const data = line.replace(/^data:\s*/, "");
    if (data === line || !data.startsWith("{")) continue;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Not a JSON data line; ignore.
    }
  }
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      (candidate as { id?: unknown }).id === id &&
      ("result" in candidate || "error" in candidate)
    )
      return candidate as { result?: unknown; error?: unknown };
  }
  return undefined;
}

// The agent-facing tools, each mapped to exactly one allowlisted
// server call. `view` arguments translate to the server tools'
// `method` dispatch, pinned to the method allowlist above.
export const GITHUB_EYES_TOOL_NAMES = [
  "github_repo_overview",
  "github_list_branches",
  "github_list_commits",
  "github_get_commit",
  "github_list_pull_requests",
  "github_get_pull_request",
  "github_list_issues",
  "github_get_issue",
  "github_list_workflow_runs",
] as const;
export type GitHubEyesToolName = (typeof GITHUB_EYES_TOOL_NAMES)[number];

// Which server tool each agent tool needs; an agent tool is only
// registered when its server tool survived the allowlist ∩ offered
// intersection at connect time.
export const GITHUB_EYES_TOOL_SERVER_TOOL: Readonly<Record<GitHubEyesToolName, string>> = {
  github_repo_overview: "search_repositories",
  github_list_branches: "list_branches",
  github_list_commits: "list_commits",
  github_get_commit: "get_commit",
  github_list_pull_requests: "list_pull_requests",
  github_get_pull_request: "pull_request_read",
  github_list_issues: "list_issues",
  github_get_issue: "issue_read",
  github_list_workflow_runs: "actions_list",
};

const PULL_REQUEST_VIEWS: Readonly<Record<string, string>> = {
  get: "get",
  files: "get_files",
  diff: "get_diff",
  commits: "get_commits",
  status: "get_status",
  reviews: "get_reviews",
  check_runs: "get_check_runs",
};

const ISSUE_VIEWS: Readonly<Record<string, string>> = {
  get: "get",
  comments: "get_comments",
  labels: "get_labels",
};

// Cap on text returned to the agent per call, so a full PR diff
// cannot flood the model's context in one step; the marker says
// what happened and the follow-up (files view, per-commit reads)
// stays available.
export const GITHUB_RESULT_CHAR_CAP = 24_000;

export type GitHubEyesLevel = "off" | "configured" | "wired" | "verified";

export interface GitHubEyesStatus {
  configured: boolean;
  wired: boolean;
  verified: boolean;
  level: GitHubEyesLevel;
  // Agent tool names currently registered (post-allowlist).
  registeredTools: string[];
  // Server tools the server offered that the allowlist refused —
  // the visible proof the enforcement did something.
  blockedTools: string[];
  lastError?: string;
  lastVerifiedAt?: string;
}

export class GitHubEyes {
  private readonly token?: string;
  private readonly transport?: McpTransport;
  private connectPromise?: Promise<void>;
  private registeredServerTools = new Set<string>();
  private blockedTools: string[] = [];
  private wiredFlag = false;
  private verifiedFlag = false;
  private lastError?: string;
  private lastVerifiedAt?: string;

  constructor(options: { token?: string; url?: string; transport?: McpTransport }) {
    this.token = options.token?.trim() ? options.token.trim() : undefined;
    this.transport =
      options.transport ??
      (this.token
        ? new HttpMcpTransport({ url: options.url ?? GITHUB_MCP_DEFAULT_URL, token: this.token })
        : undefined);
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  status(): GitHubEyesStatus {
    const level: GitHubEyesLevel = !this.configured
      ? "off"
      : this.verifiedFlag
        ? "verified"
        : this.wiredFlag
          ? "wired"
          : "configured";
    return {
      configured: this.configured,
      wired: this.wiredFlag,
      verified: this.verifiedFlag,
      level,
      registeredTools: GITHUB_EYES_TOOL_NAMES.filter((name) =>
        this.registeredServerTools.has(GITHUB_EYES_TOOL_SERVER_TOOL[name]),
      ),
      blockedTools: [...this.blockedTools],
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastVerifiedAt ? { lastVerifiedAt: this.lastVerifiedAt } : {}),
    };
  }

  // Connect (initialize + tools/list) and compute the registration
  // set: offered ∩ allowlist. Idempotent; concurrent callers share
  // one attempt. A failed attempt records lastError and leaves the
  // level at "configured" — never "wired" on a hope.
  async connect(): Promise<GitHubEyesStatus> {
    if (!this.transport) return this.status();
    if (this.wiredFlag) return this.status();
    this.connectPromise ??= (async () => {
      try {
        await this.transport?.initialize();
        const offered = (await this.transport?.listTools()) ?? [];
        const offeredNames = offered.map((tool) => tool.name);
        this.registeredServerTools = new Set(
          offeredNames.filter((name) => GITHUB_READ_ONLY_SERVER_TOOLS.has(name)),
        );
        this.blockedTools = offeredNames.filter((name) => !GITHUB_READ_ONLY_SERVER_TOOLS.has(name));
        this.wiredFlag = this.registeredServerTools.size > 0;
        if (!this.wiredFlag) this.lastError = "GitHub MCP offered no allowlisted read tools";
        else this.lastError = undefined;
      } catch (error) {
        this.wiredFlag = false;
        this.lastError = error instanceof Error ? error.message : "GitHub MCP connect failed";
      } finally {
        this.connectPromise = undefined;
      }
    })();
    await this.connectPromise;
    return this.status();
  }

  // The guarded raw call. The allowlist check runs BEFORE the
  // transport is touched, so a write-named tool cannot be invoked
  // through this client even if a caller asks for it directly and
  // even if the server offers it. `validate` (optional) inspects
  // the raw result BEFORE shaping — and therefore before the
  // verified level can be earned — and throws to reject a payload
  // that must not be presented as inspection data.
  async callServerTool(
    name: string,
    args: Record<string, unknown>,
    validate?: (result: McpCallResult) => McpCallResult,
  ): Promise<unknown> {
    if (!GITHUB_READ_ONLY_SERVER_TOOLS.has(name))
      throw new GitHubEyesError(
        `GitHub tool "${name}" is not in the read-only allowlist and cannot be invoked`,
      );
    const methodAllowlist = GITHUB_TOOL_METHOD_ALLOWLIST[name];
    if (methodAllowlist) {
      const method = args.method;
      if (typeof method !== "string" || !methodAllowlist.has(method))
        throw new GitHubEyesError(
          `GitHub tool "${name}" method ${JSON.stringify(method)} is not in the read-only method allowlist`,
        );
    }
    if (!this.transport)
      throw new GitHubEyesError("GitHub eyes are not configured (GITHUB_MCP_TOKEN is unset)");
    const status = await this.connect();
    if (!status.wired)
      throw new GitHubEyesError(
        `GitHub eyes are not connected${this.lastError ? `: ${this.lastError}` : ""}`,
      );
    if (!this.registeredServerTools.has(name))
      throw new GitHubEyesError(`GitHub tool "${name}" was not offered by the MCP server`);
    const result = await this.transport.callTool(name, args);
    return this.shapeResult(validate ? validate(result) : result);
  }

  // Execute one agent-facing tool by name. Returns the shaped,
  // size-capped result, or { error } by value (the engine's tool
  // wrapper treats an `error` string as a failed, non-grounding
  // result — the same contract as the other lanes).
  async readTool(name: GitHubEyesToolName, args: Record<string, unknown>): Promise<unknown> {
    try {
      const call = translateToolCall(name, args);
      if (name === "github_repo_overview") {
        // The overview resolves through a SEARCH (the hosted
        // toolset offers no direct get-repository read), and a
        // search payload is not proof of identity: validate the
        // exact repository before anything is presented.
        const owner = typeof args.owner === "string" ? args.owner.trim() : "";
        const repo = typeof args.repo === "string" ? args.repo.trim() : "";
        if (!owner || !repo) return { error: "github_repo_overview requires owner and repo" };
        return await this.callServerTool(call.serverTool, call.args, (result) =>
          exactRepositoryResult(result, owner, repo),
        );
      }
      return await this.callServerTool(call.serverTool, call.args);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "GitHub read failed" };
    }
  }

  private shapeResult(result: McpCallResult): unknown {
    const texts = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    const text = texts.join("\n");
    if (result.isError) return { error: text || "GitHub tool call failed" };
    // A real, non-error read through this client is the verified
    // level's evidence — recorded here, nowhere else.
    this.verifiedFlag = true;
    this.lastVerifiedAt = new Date().toISOString();
    if (!text) return { ok: true };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) return capValue(parsed);
    return { text: capText(text) };
  }
}

// Exact-repository validation for the overview tool. A search
// result can contain other repositories (or none), so the payload
// is never trusted as-is: only an entry whose `full_name` exactly
// matches the requested owner/repo (case-insensitive — GitHub
// names are case-insensitive) survives, and it is returned ALONE,
// so no other repository's data can ride along into the overview.
// No exact match — or a payload that cannot be parsed and checked
// — throws: an error, never a misleading overview of a different
// repository, and (because this runs before shaping) never a
// verified mark for an inspection that did not happen.
function exactRepositoryResult(result: McpCallResult, owner: string, repo: string): McpCallResult {
  if (result.isError) return result;
  const text = (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHubEyesError(
      `Repository lookup for ${owner}/${repo} returned unparseable data; refusing to present an unverified overview`,
    );
  }
  const record =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.items)
      ? (record.items as unknown[])
      : typeof record?.full_name === "string"
        ? [parsed]
        : [];
  const expected = `${owner}/${repo}`.toLowerCase();
  const match = candidates.find(
    (candidate) =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      typeof (candidate as { full_name?: unknown }).full_name === "string" &&
      (candidate as { full_name: string }).full_name.toLowerCase() === expected,
  );
  if (!match)
    throw new GitHubEyesError(
      `Repository ${owner}/${repo} was not among the lookup results; refusing to present a different repository's overview`,
    );
  return { content: [{ type: "text", text: JSON.stringify(match) }] };
}

function capText(text: string): string {
  if (text.length <= GITHUB_RESULT_CHAR_CAP) return text;
  return `${text.slice(0, GITHUB_RESULT_CHAR_CAP)}\n[Truncated at ${GITHUB_RESULT_CHAR_CAP} characters — narrow the request (another page, the files view, or a single commit) for the rest.]`;
}

function capValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= GITHUB_RESULT_CHAR_CAP) return value;
  return { truncatedText: capText(serialized) };
}

function translateToolCall(
  name: GitHubEyesToolName,
  args: Record<string, unknown>,
): { serverTool: string; args: Record<string, unknown> } {
  const owner = args.owner;
  const repo = args.repo;
  switch (name) {
    case "github_repo_overview":
      return {
        serverTool: "search_repositories",
        args: { query: `repo:${owner}/${repo}`, minimal_output: false },
      };
    case "github_list_branches":
      return {
        serverTool: "list_branches",
        args: pick(args, ["owner", "repo", "page", "perPage"]),
      };
    case "github_list_commits":
      return {
        serverTool: "list_commits",
        args: pick(args, ["owner", "repo", "sha", "path", "page", "perPage"]),
      };
    case "github_get_commit":
      return {
        serverTool: "get_commit",
        args: { ...pick(args, ["owner", "repo", "sha"]), detail: args.detail ?? "stats" },
      };
    case "github_list_pull_requests":
      return {
        serverTool: "list_pull_requests",
        args: pick(args, ["owner", "repo", "state", "page", "perPage"]),
      };
    case "github_get_pull_request": {
      const view = typeof args.view === "string" ? args.view : "get";
      const method = PULL_REQUEST_VIEWS[view];
      if (!method) throw new GitHubEyesError(`Unknown pull request view ${JSON.stringify(view)}`);
      return {
        serverTool: "pull_request_read",
        args: {
          method,
          ...pick(args, ["owner", "repo", "pullNumber"]),
          ...(view === "files" ? { perPage: 100 } : {}),
        },
      };
    }
    case "github_list_issues":
      return {
        serverTool: "list_issues",
        args: pick(args, ["owner", "repo", "state", "labels", "page", "perPage"]),
      };
    case "github_get_issue": {
      const view = typeof args.view === "string" ? args.view : "get";
      const method = ISSUE_VIEWS[view];
      if (!method) throw new GitHubEyesError(`Unknown issue view ${JSON.stringify(view)}`);
      return {
        serverTool: "issue_read",
        args: { method, ...pick(args, ["owner", "repo", "issue_number"]) },
      };
    }
    case "github_list_workflow_runs":
      return {
        serverTool: "actions_list",
        args: {
          method: "list_workflow_runs",
          ...pick(args, ["owner", "repo", "page", "perPage"]),
          ...(typeof args.workflow === "string" && args.workflow
            ? { resource_id: args.workflow }
            : {}),
        },
      };
    default:
      throw new GitHubEyesError(`Unknown GitHub eyes tool ${JSON.stringify(name)}`);
  }
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

export function githubEyesFor(config: Config): GitHubEyes {
  return new GitHubEyes({ token: config.githubMcpToken, url: config.githubMcpUrl });
}
