import { createWorkerServer } from "./server.ts";

const token = process.env.WORKER_TOKEN ?? "";
const worker = await createWorkerServer({
  token,
  allowFakeIpRange: process.env.WORKER_ALLOW_FAKE_IP_RANGE === "true",
  dataDir: process.env.WORKER_DATA_DIR ?? ".openmuse/browser-profiles",
  maxSessions: 3,
  idleTimeoutMs: 30 * 60_000,
  // Agent browser (Stagehand) extraction: opt-in, local model only.
  // WORKER_STAGEHAND_CHROMIUM points at a Chromium executable when the
  // Stagehand-bundled one is not usable on this host.
  stagehand:
    process.env.WORKER_STAGEHAND_ENABLED === "true"
      ? {
          ollamaUrl: process.env.WORKER_STAGEHAND_OLLAMA_URL ?? "http://127.0.0.1:11434",
          model: process.env.WORKER_STAGEHAND_MODEL ?? "llama3.2:1b",
          chromiumPath: process.env.WORKER_STAGEHAND_CHROMIUM || undefined,
        }
      : undefined,
});
worker.server.listen(8790, process.env.WORKER_HOST ?? "127.0.0.1", () => {
  console.log("OpenMuse browser worker listening on port 8790");
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
