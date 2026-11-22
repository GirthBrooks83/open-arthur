import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { atlasLaneProbe, resolveAtlasLane } from "./engine/atlas-lane.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`);
  // GitHub eyes: the verified level is per-process proof, so a
  // restart resets it — re-earn it automatically now that the
  // server is up, with one real read-only call through the
  // engine (engine/github-eyes.ts revalidateStartup). The
  // persisted record keeps the history; this restores the live
  // truth. Fire-and-forget: boot never waits on GitHub, and the
  // outcome lands in /api/health and the on-disk record.
  void agent.githubEyes
    .revalidateStartup()
    .then((status) =>
      console.log(
        `[OpenMuse] GitHub eyes startup revalidation: level=${status.level} revalidation=${status.revalidation}${status.lastError ? ` error=${status.lastError}` : ""}`,
      ),
    )
    .catch((error: unknown) =>
      console.log(
        `[OpenMuse] GitHub eyes startup revalidation failed to run: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  // ATLAS lane: "ready" is earned per process, exactly like the
  // eyes' verified level — one real read-only probe through the
  // lane's own Groq route now that the server is up
  // (engine/atlas-lane.ts). Fire-and-forget: boot never waits on
  // Groq, and the outcome lands in /api/health.
  void atlasLaneProbe
    .probe(resolveAtlasLane(config), process.env.GROQ_API_KEY)
    .then((status) =>
      console.log(
        `[OpenMuse] ATLAS lane startup probe: status=${status.status} probe=${status.probe.state}${status.probe.error ? ` error=${status.probe.error}` : ""}`,
      ),
    )
    .catch((error: unknown) =>
      console.log(
        `[OpenMuse] ATLAS lane startup probe failed to run: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
});
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
