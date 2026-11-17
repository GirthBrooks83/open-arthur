import { execFile } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The worker's network guard (src/network.ts) only allows public IPs on
// ports 80/443, and the redirect leg must prove that a navigation which
// *redirects* to a loopback address is rejected with NAVIGATION_FAILED.
// A fixture on a private or loopback address would be refused by the
// pre-navigation check before any redirect could happen, so the leg would
// test nothing — that is exactly the coverage httpbin used to provide and
// then silently stopped providing when it began refusing internal targets
// itself. The fixture therefore listens on a public IP that the test host
// assigns to its loopback interface for the duration of the test; no
// traffic leaves the host. Every private, reserved and documentation range
// is (correctly) rejected by the guard, so the address has to be a real
// public one. CI assigns it in the workflow's setup step; as root the
// fixture assigns it itself. Override with WORKER_TEST_FIXTURE_IP.
const FIXTURE_IP = process.env.WORKER_TEST_FIXTURE_IP ?? "45.33.32.156";
const FIXTURE_PORT = 80;
export const REDIRECT_TARGET = "http://127.0.0.1:8790/health";

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_PORT, FIXTURE_IP, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function addLoopbackAlias(): Promise<boolean> {
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  )
    return false;
  try {
    await execFileAsync("ip", ["addr", "add", `${FIXTURE_IP}/32`, "dev", "lo"]);
    return true;
  } catch {
    return false;
  }
}

async function removeLoopbackAlias(): Promise<void> {
  try {
    await execFileAsync("ip", ["addr", "del", `${FIXTURE_IP}/32`, "dev", "lo"]);
  } catch {
    /* Best effort: the address is test-scoped and CI runners are ephemeral. */
  }
}

function probeFixture(): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    // A direct socket request, never the environment's HTTP proxy: the
    // fixture must prove itself over the same local route the worker uses,
    // so a fixture that is not really answering can never produce a pass.
    const probe = request(
      { host: FIXTURE_IP, port: FIXTURE_PORT, path: "/redirect", agent: false },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location ?? null,
          }),
        );
      },
    );
    probe.on("error", reject);
    probe.end();
  });
}

export async function startRedirectFixture(): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  // Hit counter: every /redirect request counts, including the startup
  // self-probe below. The tests snapshot the counter before a leg and assert
  // it afterwards incremented by exactly the number of requests that leg is
  // expected to make (one per navigation). A leg whose navigation never
  // reaches the fixture — refused before any request, or failed against a
  // different address — leaves the counter short and fails, instead of
  // passing on an error code that proves nothing about the redirect guard.
  let hits = 0;
  const server = createServer((incoming, response) => {
    if (incoming.url === "/redirect") {
      hits += 1;
      response.writeHead(302, { location: REDIRECT_TARGET });
      response.end();
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Redirect fixture: only /redirect is served.");
    }
  });
  let aliasAdded = false;
  try {
    await listen(server);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL" || !(await addLoopbackAlias()))
      throw new Error(
        `The redirect fixture could not listen on ${FIXTURE_IP}:${FIXTURE_PORT}. ` +
          "The browser tests serve the fixture from a public IP assigned to the loopback " +
          "interface (see apps/worker/tests/redirect-fixture.ts); CI assigns it in the " +
          "workflow setup step. Locally, run as root or first run: " +
          `sudo ip addr add ${FIXTURE_IP}/32 dev lo`,
        { cause: error },
      );
    aliasAdded = true;
    await listen(server);
  }
  const probe = await probeFixture();
  if (probe.status !== 302 || probe.location !== REDIRECT_TARGET) {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (aliasAdded) await removeLoopbackAlias();
    throw new Error(
      `The redirect fixture answered ${probe.status} with Location ` +
        `${probe.location ?? "<none>"}; expected 302 to ${REDIRECT_TARGET}.`,
    );
  }
  return {
    url: `http://${FIXTURE_IP}/redirect`,
    hits: () => hits,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (aliasAdded) await removeLoopbackAlias();
    },
  };
}
