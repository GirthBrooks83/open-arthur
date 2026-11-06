import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createBrowserManager, validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";
import type { StagehandModule } from "./stagehand.ts";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new WorkerError("INVALID_BODY", "A JSON request body is required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024)
      throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 64 KiB.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    return result as Record<string, unknown>;
  } catch {
    throw new WorkerError("INVALID_BODY", "A JSON object is required.");
  }
}

function requiredUrl(body: Record<string, unknown>): string {
  if (typeof body.url !== "string" || body.url.length > 8192)
    throw new WorkerError("INVALID_URL", "A URL of at most 8192 characters is required.");
  return body.url;
}

export async function createWorkerServer(options: {
  token: string;
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  allowFakeIpRange?: boolean;
  stagehand?: {
    ollamaUrl: string;
    model: string;
    chromiumPath?: string;
    loadModule?: () => Promise<StagehandModule>;
  };
}) {
  if (options.token.length < 32)
    throw new Error("WORKER_TOKEN must contain at least 32 characters.");
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const browser = await createBrowserManager(options);
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://worker").pathname;
      if (request.method === "GET" && pathname === "/health") {
        json(200, { status: "ok" });
        return;
      }
      const headerHash = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(headerHash, tokenHash))
        throw new WorkerError("UNAUTHORIZED", "Worker authentication is required.", 401);
      if (pathname === "/sessions" && request.method === "GET") {
        json(200, browser.list());
        return;
      }
      if (pathname === "/sessions" && request.method === "POST") {
        const body = await readBody(request);
        json(201, await browser.create(validateSessionId(body.id), requiredUrl(body)));
        return;
      }
      if (pathname === "/extract" && request.method === "POST") {
        // Extraction runs a local model against a live page and can
        // take far longer than a session call; give the socket room.
        request.socket.setTimeout(185_000);
        const body = await readBody(request);
        const url = requiredUrl(body);
        const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
        if (!instruction || instruction.length > 2000)
          throw new WorkerError(
            "INVALID_INSTRUCTION",
            "An instruction of 1–2000 characters is required.",
          );
        let fields: string[] | undefined;
        if (body.fields !== undefined) {
          if (
            !Array.isArray(body.fields) ||
            body.fields.length > 12 ||
            body.fields.some(
              (field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field),
            )
          )
            throw new WorkerError(
              "INVALID_FIELDS",
              "fields must be up to 12 field names (letters, digits, underscore).",
            );
          fields = [...new Set(body.fields as string[])];
        }
        json(200, await browser.extract(url, instruction, fields));
        return;
      }
      const match =
        /^\/sessions\/([^/]+)\/(navigate|close|screenshot|read|input|downloads)(?:\/([^/]+))?$/.exec(
          pathname,
        );
      if (!match) throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
      const id = validateSessionId(match[1]);
      const action = match[2];
      const downloadId = match[3];
      if (action === "navigate" && !downloadId && request.method === "POST")
        json(200, await browser.navigate(id, requiredUrl(await readBody(request))));
      else if (action === "close" && !downloadId && request.method === "POST")
        json(200, await browser.closeSession(id));
      else if (action === "input" && !downloadId && request.method === "POST")
        json(200, await browser.input(id, await readBody(request)));
      else if (action === "read" && !downloadId && request.method === "GET")
        json(200, await browser.read(id));
      else if (action === "screenshot" && !downloadId && request.method === "GET") {
        const bytes = await browser.screenshot(id);
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
        response.end(bytes);
      } else if (action === "downloads" && request.method === "GET") {
        if (!downloadId) json(200, await browser.downloads(id));
        else {
          const result = await browser.download(id, downloadId);
          response.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": result.bytes.length,
            "content-disposition": `attachment; filename="${result.metadata.name}"`,
          });
          response.end(result.bytes);
        }
      } else throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
    } catch (error) {
      const safe =
        error instanceof WorkerError
          ? error
          : new WorkerError(
              "WORKER_FAILURE",
              "The browser operation failed. Check worker health and reopen the session.",
              500,
            );
      if (!response.headersSent && !response.destroyed)
        json(safe.status, { error: { code: safe.code, message: safe.message } });
      else response.end();
    }
  });
  // Extraction (Stagehand + local model) legitimately runs longer
  // than a session call; only an operator who enabled it gets the
  // longer request budget.
  server.requestTimeout = options.stagehand ? 200_000 : 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
    },
  };
}
