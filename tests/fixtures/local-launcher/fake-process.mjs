// A configurable fake Core/Runner process for Launcher supervision tests.
// It is a REAL child process; behavior is driven entirely by environment vars
// so a single fixture covers ready/hang/crash/stubborn scenarios.
//
//   FAKE_MODE        ready | hang | crash | stubborn   (default: ready)
//   FAKE_READY_EVENT the JSON `event` string to print on stdout once ready
//   FAKE_PORT        if set, opens a loopback TCP server on this port
//   FAKE_CRASH_AFTER_MS  ms after ready before exiting non-zero (crash mode)
import net from "node:net";

const mode = process.env.FAKE_MODE ?? "ready";
const readyEvent = process.env.FAKE_READY_EVENT ?? "fake.ready";
const port = process.env.FAKE_PORT ? Number.parseInt(process.env.FAKE_PORT, 10) : undefined;

function announceReady() {
  process.stdout.write(`${JSON.stringify({ event: readyEvent, pid: process.pid })}\n`);
}

function stayAlive() {
  // Keep the event loop busy so the process persists until signalled.
  setInterval(() => {}, 1 << 30);
}

async function openPort() {
  if (port === undefined) return;
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
    // Keep a reference so the server holds the process open.
    globalThis.__fakeServer = server;
  });
}

if (mode === "hang") {
  // Never becomes ready; never opens the port.
  stayAlive();
} else if (mode === "crash") {
  announceReady();
  const after = process.env.FAKE_CRASH_AFTER_MS
    ? Number.parseInt(process.env.FAKE_CRASH_AFTER_MS, 10)
    : 30;
  setTimeout(() => process.exit(1), after);
} else if (mode === "stubborn") {
  // Becomes ready but refuses SIGTERM, forcing an escalation to SIGKILL.
  process.on("SIGTERM", () => {
    process.stdout.write(`${JSON.stringify({ event: "fake.ignored_sigterm" })}\n`);
  });
  await openPort();
  announceReady();
  stayAlive();
} else {
  // ready: open the port (if any), announce readiness, exit cleanly on SIGTERM.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  await openPort();
  announceReady();
  stayAlive();
}
