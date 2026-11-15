import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  GITHUB_MCP_DEFAULT_URL,
  GITHUB_READ_ONLY_SERVER_TOOLS,
  GitHubEyes,
  GitHubEyesError,
  HttpMcpTransport,
  type McpCallResult,
  type McpToolInfo,
  type McpTransport,
} from "../apps/server/src/engine/github-eyes.ts";

// GitHub eyes (engine/github-eyes.ts), proven entirely against
// fakes: a scripted McpTransport for the client logic and a fake
// fetch for the HTTP transport. No test uses a real token or the
// network — the live leg (a real read through the hosted MCP
// server) stays pending until the owner supplies the read-only PAT.
//
// The enforcement tests are the point of the feature: the fake
// server OFFERS write tools (merge_pull_request, push_files, ...),
// and the client must neither register nor invoke them.

const READ_TOOLS: McpToolInfo[] = [
  { name: "search_repositories" },
  { name: "list_branches" },
  { name: "list_commits" },
  { name: "get_commit" },
  { name: "list_pull_requests" },
  { name: "pull_request_read" },
  { name: "list_issues" },
  { name: "issue_read" },
  { name: "actions_list" },
];

const WRITE_TOOLS: McpToolInfo[] = [
  { name: "create_pull_request" },
  { name: "merge_pull_request" },
  { name: "push_files" },
  { name: "create_or_update_file" },
  { name: "delete_file" },
  { name: "issue_write" },
  { name: "add_issue_comment" },
  { name: "actions_run_trigger" },
];

class FakeTransport implements McpTransport {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  initializeCount = 0;
  failInitialize = false;
  result: McpCallResult = {
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
  };
  constructor(private readonly offered: McpToolInfo[] = [...READ_TOOLS, ...WRITE_TOOLS]) {}
  async initialize(): Promise<void> {
    this.initializeCount++;
    if (this.failInitialize) throw new Error("handshake refused");
  }
  async listTools(): Promise<McpToolInfo[]> {
    return this.offered;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args });
    return this.result;
  }
}

test("allowlist: only read tools register; offered write tools are blocked by name", async () => {
  const eyes = new GitHubEyes({ token: "test-token", transport: new FakeTransport() });
  const status = await eyes.connect();
  assert.equal(status.wired, true);
  assert.equal(status.level, "wired");
  assert.deepEqual(
    [...status.registeredTools].sort(),
    [
      "github_get_commit",
      "github_get_issue",
      "github_get_pull_request",
      "github_list_branches",
      "github_list_commits",
      "github_list_issues",
      "github_list_pull_requests",
      "github_list_workflow_runs",
      "github_repo_overview",
    ].sort(),
  );
  assert.deepEqual([...status.blockedTools].sort(), WRITE_TOOLS.map((tool) => tool.name).sort());
  for (const name of status.blockedTools)
    assert.equal(GITHUB_READ_ONLY_SERVER_TOOLS.has(name), false);
});

test("allowlist: a write-named tool cannot be invoked even though the server offers it", async () => {
  const transport = new FakeTransport();
  const eyes = new GitHubEyes({ token: "test-token", transport });
  await eyes.connect();
  for (const writeTool of ["merge_pull_request", "push_files", "issue_write", "delete_file"]) {
    await assert.rejects(
      eyes.callServerTool(writeTool, { owner: "GirthBrooks83", repo: "open-arthur" }),
      (error: unknown) =>
        error instanceof GitHubEyesError && /not in the read-only allowlist/.test(error.message),
    );
  }
  // The guard fired before the transport: zero calls ever left the client.
  assert.equal(transport.calls.length, 0);
});

test("allowlist: method dispatch is pinned — write-flavoured methods are refused pre-transport", async () => {
  const transport = new FakeTransport();
  const eyes = new GitHubEyes({ token: "test-token", transport });
  await eyes.connect();
  await assert.rejects(
    eyes.callServerTool("pull_request_read", {
      method: "merge",
      owner: "o",
      repo: "r",
      pullNumber: 47,
    }),
    /not in the read-only method allowlist/,
  );
  await assert.rejects(
    eyes.callServerTool("actions_list", { method: "run_workflow", owner: "o", repo: "r" }),
    /not in the read-only method allowlist/,
  );
  await assert.rejects(
    eyes.callServerTool("issue_read", { owner: "o", repo: "r", issue_number: 1 }),
    /not in the read-only method allowlist/,
  );
  assert.equal(transport.calls.length, 0);
});

test("allowlist: a server offering only write tools never reaches wired", async () => {
  const eyes = new GitHubEyes({ token: "test-token", transport: new FakeTransport(WRITE_TOOLS) });
  const status = await eyes.connect();
  assert.equal(status.wired, false);
  assert.equal(status.level, "configured");
  assert.deepEqual(status.registeredTools, []);
  assert.match(status.lastError ?? "", /no allowlisted read tools/);
});

test("status levels: off -> configured -> wired -> verified, never skipping", async () => {
  const off = new GitHubEyes({});
  assert.equal(off.status().level, "off");
  assert.equal(off.status().configured, false);

  const transport = new FakeTransport();
  const eyes = new GitHubEyes({ token: "test-token", transport });
  assert.equal(eyes.status().level, "configured");
  assert.equal(eyes.status().verified, false);

  await eyes.connect();
  assert.equal(eyes.status().level, "wired");
  assert.equal(eyes.status().verified, false);

  const result = await eyes.readTool("github_list_branches", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.deepEqual(result, { ok: true });
  const status = eyes.status();
  assert.equal(status.level, "verified");
  assert.equal(status.verified, true);
  assert.ok(status.lastVerifiedAt);
});

test("status levels: a failed handshake stays at configured with the error recorded", async () => {
  const transport = new FakeTransport();
  transport.failInitialize = true;
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const status = await eyes.connect();
  assert.equal(status.level, "configured");
  assert.equal(status.wired, false);
  assert.match(status.lastError ?? "", /handshake refused/);
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /not connected/);
});

test("tools: agent tools translate to the right server calls", async () => {
  const transport = new FakeTransport();
  const eyes = new GitHubEyes({ token: "test-token", transport });

  await eyes.readTool("github_repo_overview", { owner: "GirthBrooks83", repo: "open-arthur" });
  assert.deepEqual(transport.calls.at(-1), {
    name: "search_repositories",
    args: { query: "repo:GirthBrooks83/open-arthur", minimal_output: false },
  });

  await eyes.readTool("github_get_pull_request", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
    pullNumber: 47,
    view: "files",
  });
  assert.deepEqual(transport.calls.at(-1), {
    name: "pull_request_read",
    args: {
      method: "get_files",
      owner: "GirthBrooks83",
      repo: "open-arthur",
      pullNumber: 47,
      perPage: 100,
    },
  });

  await eyes.readTool("github_get_pull_request", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
    pullNumber: 47,
  });
  const prCall = transport.calls.at(-1);
  assert.ok(prCall);
  assert.equal((prCall.args as { method?: string }).method, "get");

  await eyes.readTool("github_get_issue", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
    issue_number: 3,
    view: "comments",
  });
  assert.deepEqual(transport.calls.at(-1), {
    name: "issue_read",
    args: { method: "get_comments", owner: "GirthBrooks83", repo: "open-arthur", issue_number: 3 },
  });

  await eyes.readTool("github_list_workflow_runs", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
    workflow: "ci.yml",
  });
  assert.deepEqual(transport.calls.at(-1), {
    name: "actions_list",
    args: {
      method: "list_workflow_runs",
      owner: "GirthBrooks83",
      repo: "open-arthur",
      resource_id: "ci.yml",
    },
  });

  await eyes.readTool("github_get_commit", { owner: "o", repo: "r", sha: "abc123" });
  assert.deepEqual(transport.calls.at(-1), {
    name: "get_commit",
    args: { owner: "o", repo: "r", sha: "abc123", detail: "stats" },
  });
});

test("tools: an error result and an unknown view come back as { error }, never as data", async () => {
  const transport = new FakeTransport();
  transport.result = { isError: true, content: [{ type: "text", text: "404 Not Found" }] };
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_list_issues", { owner: "o", repo: "r" });
  assert.deepEqual(read, { error: "404 Not Found" });
  assert.equal(eyes.status().verified, false);

  const badView = await eyes.readTool("github_get_pull_request", {
    owner: "o",
    repo: "r",
    pullNumber: 1,
    view: "explode",
  });
  assert.match((badView as { error: string }).error, /Unknown pull request view/);
});

test("tools: oversized results are capped with a truncation marker", async () => {
  const transport = new FakeTransport();
  transport.result = {
    content: [{ type: "text", text: JSON.stringify({ patch: "x".repeat(40_000) }) }],
  };
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = (await eyes.readTool("github_get_pull_request", {
    owner: "o",
    repo: "r",
    pullNumber: 47,
    view: "diff",
  })) as { truncatedText: string };
  assert.ok(read.truncatedText.length < 25_000);
  assert.match(read.truncatedText, /Truncated at 24000 characters/);
});

// --- HTTP transport, against a fake fetch -------------------------------

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { jsonrpc: string; id?: number; method: string; params?: unknown };
}

function fakeFetch(responder: (call: CapturedRequest, index: number) => Response) {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const call: CapturedRequest = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"],
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function jsonRpcResponse(id: number, result: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("transport: handshake order, auth + read-only headers, session replay, JSON results", async () => {
  const { calls, fetchFn } = fakeFetch((call) => {
    if (call.body.method === "initialize")
      return jsonRpcResponse(
        call.body.id ?? 0,
        { protocolVersion: "2025-03-26" },
        {
          "mcp-session-id": "session-123",
        },
      );
    if (call.body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (call.body.method === "tools/list")
      return jsonRpcResponse(call.body.id ?? 0, { tools: [{ name: "list_branches" }] });
    if (call.body.method === "tools/call")
      return jsonRpcResponse(call.body.id ?? 0, {
        content: [{ type: "text", text: '[{"name":"main"}]' }],
      });
    throw new Error(`unexpected method ${call.body.method}`);
  });
  const transport = new HttpMcpTransport({
    url: "https://api.githubcopilot.com/mcp/",
    token: "test-token",
    fetchFn,
  });
  await transport.initialize();
  const tools = await transport.listTools();
  assert.deepEqual(tools, [{ name: "list_branches" }]);
  const result = await transport.callTool("list_branches", { owner: "o", repo: "r" });
  assert.equal(result.content?.[0]?.text, '[{"name":"main"}]');

  assert.deepEqual(
    calls.map((call) => call.body.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  for (const call of calls) {
    assert.equal(call.headers.Authorization, "Bearer test-token");
    assert.equal(call.headers["X-MCP-Readonly"], "true");
    assert.equal(call.headers["X-MCP-Toolsets"], "repos,issues,pull_requests,actions");
  }
  // The session id issued at initialize is replayed afterwards.
  assert.equal(calls[0]?.headers["Mcp-Session-Id"], undefined);
  assert.equal(calls[2]?.headers["Mcp-Session-Id"], "session-123");
});

test("transport: SSE-framed responses are parsed for the matching id", async () => {
  const { fetchFn } = fakeFetch((call) => {
    if (call.body.method === "initialize")
      return jsonRpcResponse(call.body.id ?? 0, { protocolVersion: "2025-03-26" });
    if (call.body.method === "notifications/initialized") return new Response("", { status: 202 });
    const sse = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}`,
      "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result: { tools: [{ name: "get_commit" }] } })}`,
      "",
    ].join("\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const transport = new HttpMcpTransport({
    url: "https://api.githubcopilot.com/mcp/",
    token: "test-token",
    fetchFn,
  });
  await transport.initialize();
  assert.deepEqual(await transport.listTools(), [{ name: "get_commit" }]);
});

test("transport: HTTP failures surface the status only, never the body", async () => {
  const { fetchFn } = fakeFetch(() => new Response("sensitive provider body", { status: 401 }));
  const transport = new HttpMcpTransport({
    url: "https://api.githubcopilot.com/mcp/",
    token: "test-token",
    fetchFn,
  });
  await assert.rejects(transport.initialize(), (error: unknown) => {
    assert.ok(error instanceof GitHubEyesError);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive provider body/);
    return true;
  });
});

// --- Round 2: exact repository resolution (ATLAS examination point 1) ---

function searchResult(...repos: Array<Record<string, unknown>>): McpCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          total_count: repos.length,
          incomplete_results: false,
          items: repos,
        }),
      },
    ],
  };
}

test("overview: the exact full_name match is returned alone; other repositories are dropped", async () => {
  const transport = new FakeTransport();
  transport.result = searchResult(
    { full_name: "SomeoneElse/other", description: "foreign" },
    { full_name: "GirthBrooks83/open-arthur", description: "ours", stargazers_count: 3 },
  );
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.deepEqual(read, {
    full_name: "GirthBrooks83/open-arthur",
    description: "ours",
    stargazers_count: 3,
  });
  assert.equal(JSON.stringify(read).includes("SomeoneElse"), false);
  assert.equal(eyes.status().verified, true);
});

test("overview: full_name matching is case-insensitive", async () => {
  const transport = new FakeTransport();
  transport.result = searchResult({ full_name: "GirthBrooks83/open-arthur", description: "ours" });
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "girthbrooks83",
    repo: "OPEN-ARTHUR",
  });
  assert.deepEqual(read, { full_name: "GirthBrooks83/open-arthur", description: "ours" });
});

test("overview: a lookup returning only a different repository is an error, never an overview", async () => {
  const transport = new FakeTransport();
  transport.result = searchResult({ full_name: "SomeoneElse/other", description: "foreign" });
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.match((read as { error: string }).error, /not among the lookup results/);
  // No foreign repository data leaks into the answer.
  assert.equal(JSON.stringify(read).includes("SomeoneElse"), false);
  assert.equal(eyes.status().verified, false);
});

test("overview: an empty lookup result is an error and never verifies", async () => {
  const transport = new FakeTransport();
  transport.result = searchResult();
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.match((read as { error: string }).error, /not among the lookup results/);
  assert.equal(eyes.status().verified, false);
});

test("overview: an unparseable lookup payload is an error and never verifies", async () => {
  const transport = new FakeTransport();
  transport.result = { content: [{ type: "text", text: "<html>not json</html>" }] };
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.match((read as { error: string }).error, /unparseable data/);
  assert.equal(eyes.status().verified, false);
});

test("overview: a search error result passes through as an error, never as data", async () => {
  const transport = new FakeTransport();
  transport.result = { isError: true, content: [{ type: "text", text: "search blew up" }] };
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_repo_overview", {
    owner: "GirthBrooks83",
    repo: "open-arthur",
  });
  assert.deepEqual(read, { error: "search blew up" });
  assert.equal(eyes.status().verified, false);
});

// --- Round 2: read-only endpoint (ATLAS examination point 2) -------------

test("endpoint: the default MCP URL is the hosted read-only variant", () => {
  assert.equal(GITHUB_MCP_DEFAULT_URL, "https://api.githubcopilot.com/mcp/readonly");
});

// --- Round 2: failure handling (ATLAS examination point 3) ---------------
// None of these may silently succeed: each must surface as { error },
// return no inspection data, and never advance the level to verified.

function handshakeOk(call: CapturedRequest): Response | undefined {
  if (call.body.method === "initialize")
    return jsonRpcResponse(call.body.id ?? 0, { protocolVersion: "2025-03-26" });
  if (call.body.method === "notifications/initialized") return new Response("", { status: 202 });
  if (call.body.method === "tools/list")
    return jsonRpcResponse(call.body.id ?? 0, { tools: READ_TOOLS });
  return undefined;
}

function eyesOverFetch(
  responder: (call: CapturedRequest, index: number) => Response,
  timeoutMs?: number,
): GitHubEyes {
  const { fetchFn } = fakeFetch(responder);
  const transport = new HttpMcpTransport({
    url: "https://api.githubcopilot.com/mcp/readonly",
    token: "test-token",
    fetchFn,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return new GitHubEyes({ token: "test-token", transport });
}

test("failure: HTTP 401 on a tool call (expired/revoked token) is an error, never verified", async () => {
  const eyes = eyesOverFetch(
    (call) => handshakeOk(call) ?? new Response("unauthorized", { status: 401 }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /HTTP 401/);
  const status = eyes.status();
  assert.equal(status.wired, true);
  assert.equal(status.verified, false);
  assert.equal(status.level, "wired");
});

test("failure: HTTP 401 at the handshake leaves the level at configured", async () => {
  const eyes = eyesOverFetch(() => new Response("unauthorized", { status: 401 }));
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /not connected/);
  const status = eyes.status();
  assert.equal(status.level, "configured");
  assert.equal(status.verified, false);
  assert.match(status.lastError ?? "", /HTTP 401/);
});

test("failure: HTTP 403 on a tool call is an error, never verified", async () => {
  const eyes = eyesOverFetch(
    (call) => handshakeOk(call) ?? new Response("forbidden", { status: 403 }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /HTTP 403/);
  assert.equal(eyes.status().verified, false);
});

test("failure: HTTP 500 (server error) on a tool call is an error, never verified", async () => {
  const eyes = eyesOverFetch(
    (call) => handshakeOk(call) ?? new Response("internal error", { status: 500 }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /HTTP 500/);
  assert.equal(eyes.status().verified, false);
  assert.equal(eyes.status().level, "wired");
});

test("failure: a non-JSON MCP response is an error, never data", async () => {
  const eyes = eyesOverFetch(
    (call) =>
      handshakeOk(call) ??
      new Response("this is not json", { status: 200, headers: { "content-type": "text/plain" } }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /returned no result/);
  assert.equal(eyes.status().verified, false);
});

test("failure: well-formed JSON that is not a JSON-RPC message is an error", async () => {
  const eyes = eyesOverFetch(
    (call) =>
      handshakeOk(call) ??
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /returned no result/);
  assert.equal(eyes.status().verified, false);
});

test("failure: a null JSON-RPC result is a malformed-result error, never data", async () => {
  const eyes = eyesOverFetch(
    (call) =>
      handshakeOk(call) ??
      new Response(JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /malformed result/);
  assert.equal(eyes.status().verified, false);
});

test("failure: an MCP error object in a well-formed response is an error, never data", async () => {
  const eyes = eyesOverFetch(
    (call) =>
      handshakeOk(call) ??
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.body.id,
          error: { code: -32603, message: "server exploded" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /server exploded/);
  assert.equal(eyes.status().verified, false);
});

test("failure: a transport timeout is an error, never verified", async () => {
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
    const ok = handshakeOk({ url: "", headers: {}, body });
    if (ok) return ok;
    // tools/call never answers; only the client's own abort ends it.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const transport = new HttpMcpTransport({
    url: "https://api.githubcopilot.com/mcp/readonly",
    token: "test-token",
    fetchFn,
    timeoutMs: 25,
  });
  const eyes = new GitHubEyes({ token: "test-token", transport });
  const read = await eyes.readTool("github_list_branches", { owner: "o", repo: "r" });
  assert.match((read as { error: string }).error, /GitHub MCP request failed/);
  assert.equal(eyes.status().verified, false);
  assert.equal(eyes.status().level, "wired");
});

// --- Health surfacing -----------------------------------------------------

const baseConfig = (dataDir: string, githubMcpToken?: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...(githubMcpToken ? { githubMcpToken } : {}),
});

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
let offDb: Store, offServer: Awaited<ReturnType<typeof createApp>>, offDirectory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-github-eyes-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, baseConfig(directory, "test-token"));
  offDirectory = await mkdtemp(join(tmpdir(), "openmuse-github-eyes-off-"));
  offDb = await createStore({ dataDir: join(offDirectory, "db") });
  offServer = await createApp(offDb, baseConfig(offDirectory));
});

after(async () => {
  await server?.agent?.stop();
  await offServer?.agent?.stop();
  await db?.close();
  await offDb?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (offDirectory) await rm(offDirectory, { recursive: true, force: true });
});

test("health: with a token, github reports configured and the level stays 'configured' until a real connect", async () => {
  const response = await server.app.request("/api/health");
  assert.equal(response.status, 200);
  const health = (await response.json()) as {
    integrations: { github: boolean; githubWired: boolean };
    githubEyes: { level: string; configured: boolean; wired: boolean; verified: boolean };
  };
  assert.equal(health.integrations.github, true);
  assert.equal(health.integrations.githubWired, true);
  // Nothing has connected yet in this process: the honest level is
  // "configured", not "wired" or "verified".
  assert.deepEqual(
    {
      level: health.githubEyes.level,
      configured: health.githubEyes.configured,
      wired: health.githubEyes.wired,
      verified: health.githubEyes.verified,
    },
    { level: "configured", configured: true, wired: false, verified: false },
  );
});

test("health: without a token, github reports off and no eyes are claimed", async () => {
  const response = await offServer.app.request("/api/health");
  const health = (await response.json()) as {
    integrations: { github: boolean };
    githubEyes: { level: string; configured: boolean };
  };
  assert.equal(health.integrations.github, false);
  assert.equal(health.githubEyes.level, "off");
  assert.equal(health.githubEyes.configured, false);
});
