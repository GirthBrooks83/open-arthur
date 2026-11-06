import { z } from "zod";
import { WorkerError } from "./errors.ts";

// Agent browser (Stagehand) extraction for the browser worker.
//
// This is the worker-side half of the "agent browser": the API server
// stays a thin client (it never runs a browser or a model), while this
// worker — the process that already owns Chromium and the SSRF egress
// guard — additionally offers POST /extract: open a page and pull
// specific information out of it with Stagehand, using a LOCAL model
// (Ollama) so the lane stays at $0. The design follows the lab proof
// (2026-11-04, stagehand-run): Stagehand 4.x created with a custom
// generate() that forwards structured-generation requests to Ollama's
// native /api/chat with the JSON schema passed through, and a locally
// launched Chromium. Extraction is the scope: observe/act were not
// proven against the small local model and are deliberately not
// exposed here.
//
// The Stagehand module is imported lazily, only when the operator
// enables the lane (WORKER_STAGEHAND_ENABLED=true), so a worker that
// never uses it does not pay its load cost. The narrow interfaces
// below are the exact surface this module uses; they also give tests
// a seam (loadModule) to substitute a fake Stagehand.

export interface StagehandPage {
  goto(url: string): Promise<unknown>;
  title(): Promise<string>;
  // Stagehand 4.3's page abstraction returns a Promise here (its raw
  // CDP page returns a string); awaiting covers both, and skipping
  // the await silently yields "{}" instead of the final URL.
  url(): string | Promise<string>;
}
export interface StagehandBrowser {
  context: { pages(): Promise<StagehandPage[]> };
  close(): Promise<void>;
}
export interface StagehandInstance {
  extract(instruction: string, schema: z.ZodType): Promise<{ data: Record<string, unknown> }>;
  close(): Promise<void>;
}
export interface StagehandModule {
  localBrowser: {
    launch(options: Record<string, unknown>): Promise<StagehandBrowser>;
  };
  Stagehand: {
    create(options: Record<string, unknown>): Promise<StagehandInstance>;
  };
}

export interface StagehandExtractorOptions {
  ollamaUrl: string;
  model: string;
  chromiumPath?: string;
  userDataDir: string;
  // Where the launched browser sends its traffic. The worker passes
  // its own validating egress proxy here, so Stagehand navigation gets
  // the same SSRF treatment as Playwright sessions.
  proxyUrl?: string;
  loadModule?: () => Promise<StagehandModule>;
  logError?: (message: string) => void;
}

const EXTRACT_TIMEOUT_MS = 175_000;
// One extraction request gets ONE overall budget, shared across the
// first attempt and the single retry: on this hardware one attempt
// (two local-model calls at 60–80 s each, plus page work) can take
// ~150 s, so a retry that restarted the full attempt budget could
// never finish inside the caller's timeout — it would end as a
// severed socket instead of an answer. The total sits below the
// worker socket (185 s), worker request (200 s), and API client
// (180 s) budgets, with room for the response to travel back.
const EXTRACT_TOTAL_MS = 160_000;
// A retry is only worth starting if enough budget remains to give
// the fresh browser a real chance.
const EXTRACT_RETRY_MIN_REMAINING_MS = 30_000;

// Field names become keys of the extraction schema, so they are kept
// to plain identifiers (the server route validates the same shape).
export function buildExtractSchema(fields?: string[]): z.ZodType {
  if (fields && fields.length > 0) {
    const shape: Record<string, z.ZodString> = {};
    for (const field of fields) shape[field] = z.string();
    return z.object(shape);
  }
  return z.object({ summary: z.string() });
}

type GenerateParams = {
  systemPrompt?: string;
  messages: { content: unknown }[];
  responseFormat?: { type?: string; name?: string; schema?: unknown };
  temperature?: number;
};

function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      const text = (block as { text?: unknown })?.text;
      if (typeof text !== "string")
        throw new TypeError("Stagehand sent a non-text content block to the local model");
      return text;
    })
    .join("\n");
}

// The proven local-model bridge: Stagehand's structured generation is
// forwarded to Ollama with the JSON schema passed as `format`, which
// is what makes a 1B-class local model answer in shape.
function makeGenerate(options: StagehandExtractorOptions) {
  return async (params: GenerateParams) => {
    const isStructured = params.responseFormat?.type === "json_schema";
    const messages: { role: string; content: string }[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    for (const message of params.messages)
      messages.push({ role: "user", content: textOf(message.content) });
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: false,
      options: { temperature: params.temperature ?? 0 },
    };
    if (isStructured) body.format = params.responseFormat?.schema;
    const response = await fetch(`${options.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Local model (Ollama) answered HTTP ${response.status}`);
    const data = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = data.message?.content ?? "";
    const usage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };
    if (isStructured) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Local model returned non-JSON for a structured extraction");
      }
      return {
        role: "assistant",
        content: { type: "text", text },
        outputFormat: "json_schema",
        structuredContent: parsed,
        usage,
      };
    }
    return { role: "assistant", content: { type: "text", text }, outputFormat: "text", usage };
  };
}

export function createStagehandExtractor(options: StagehandExtractorOptions) {
  const logError = options.logError ?? ((message: string) => console.error(message));
  let browser: StagehandBrowser | undefined;
  let stagehand: StagehandInstance | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function ensure() {
    if (stagehand && browser) return { stagehand, browser };
    const load =
      options.loadModule ??
      (async () => (await import("@browserbasehq/stagehand")) as unknown as StagehandModule);
    const module = await load();
    browser = await module.localBrowser.launch({
      headless: true,
      ...(options.chromiumPath ? { executablePath: options.chromiumPath } : {}),
      chromiumSandbox: false,
      // The proxy goes in as a raw Chrome arg, never as Stagehand's
      // typed `proxy` launch option: in Stagehand 4.3.0 the typed
      // option breaks the CDP attach ("CDP websocket failed to
      // open"), and so does a `--proxy-bypass-list` arg — both proven
      // in the lab (typed option FAIL, arg+bypass FAIL, arg alone
      // OK). No bypass list is safe here: the URL guard has already
      // blocked local targets before navigation.
      args: [
        "--disable-dev-shm-usage",
        ...(options.proxyUrl ? [`--proxy-server=${options.proxyUrl}`] : []),
      ],
      userDataDir: options.userDataDir,
    });
    stagehand = await module.Stagehand.create({
      browser,
      model: { generate: makeGenerate(options) },
    });
    return { stagehand, browser };
  }

  async function reset() {
    const oldStagehand = stagehand;
    const oldBrowser = browser;
    stagehand = undefined;
    browser = undefined;
    await oldStagehand?.close().catch(() => {});
    await oldBrowser?.close().catch(() => {});
  }

  async function run(
    url: string,
    instruction: string,
    fields?: string[],
  ): Promise<{ url: string; title: string; data: Record<string, unknown> }> {
    const { stagehand: instance, browser: launched } = await ensure();
    const [page] = await launched.context.pages();
    if (!page) throw new Error("Stagehand browser opened no page");
    await page.goto(url);
    const result = await instance.extract(instruction, buildExtractSchema(fields));
    const title = await page.title().catch(() => "");
    const finalUrl = await page.url();
    return { url: finalUrl, title: title.slice(0, 300), data: result.data ?? {} };
  }

  // One attempt, bounded by whichever is smaller: the per-attempt
  // ceiling or the time left in the request's overall budget.
  async function attempt(
    url: string,
    instruction: string,
    fields: string[] | undefined,
    budgetMs: number,
  ): Promise<{ url: string; title: string; data: Record<string, unknown> }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(url, instruction, fields),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkerError(
                  "STAGEHAND_TIMEOUT",
                  "The agent browser extraction timed out.",
                  504,
                ),
              ),
            Math.min(EXTRACT_TIMEOUT_MS, budgetMs),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const failed = () =>
    new WorkerError(
      "STAGEHAND_FAILED",
      "The agent browser could not extract from the page. Check that the local model is running and try again.",
      502,
    );

  return {
    extract(
      url: string,
      instruction: string,
      fields?: string[],
    ): Promise<{ url: string; title: string; data: Record<string, unknown> }> {
      const operation = queue.then(async () => {
        const startedAt = Date.now();
        const remaining = () => EXTRACT_TOTAL_MS - (Date.now() - startedAt);
        try {
          return await attempt(url, instruction, fields, remaining());
        } catch (error) {
          if (error instanceof WorkerError) throw error; // timeout: no retry
          logError(`stagehand extract failed: ${error instanceof Error ? error.stack : error}`);
          // A wedged browser or a dead model must not poison later calls.
          await reset();
          // The lab browser occasionally drops its CDP connection
          // under load and recovers on a fresh launch; extraction is
          // read-only, so one retry on that failure class is safe —
          // but only when enough of the request's overall budget is
          // left for the fresh attempt to actually finish.
          const message = error instanceof Error ? error.message : String(error);
          if (!/cdp|rpc client|websocket|connection closed|target closed/i.test(message))
            throw failed();
          if (remaining() < EXTRACT_RETRY_MIN_REMAINING_MS) throw failed();
          try {
            return await attempt(url, instruction, fields, remaining());
          } catch (retryError) {
            if (retryError instanceof WorkerError) throw retryError;
            logError(
              `stagehand extract retry failed: ${retryError instanceof Error ? retryError.stack : retryError}`,
            );
            await reset();
            throw failed();
          }
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    close: async () => {
      await queue.catch(() => {});
      await reset();
    },
  };
}
