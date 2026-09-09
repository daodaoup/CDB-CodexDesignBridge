import { mkdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

process.env.CDB_MCP_TRANSPORT = "daemon";

const { cleanup, handleRequest, runtimeStatus } = await import("./server.mjs");
const { startLocalWorkspaceServer } = await import("./local-workspace-server.mjs");
const runtimeRoot = process.env.CODEX_DESIGN_BRIDGE_RUNTIME_ROOT ||
  (process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "Codex Design Bridge", "runtime")
    : path.join(tmpdir(), "codex-design-bridge-runtime"));
const daemonKey = process.env.CDB_DAEMON_KEY || runtimeKey(runtimeStatus().version);
const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\codex-design-bridge-${runtimeKey(runtimeRoot)}-${daemonKey}`
  : path.join(runtimeRoot, `bridge-${daemonKey}.sock`);

await mkdir(runtimeRoot, { recursive: true });
const defaultWorkspaceDir = process.env.CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE ||
  path.join(homedir(), "Codex Design Bridge Projects");
await mkdir(defaultWorkspaceDir, { recursive: true });

const requestedWorkspacePort = Number.parseInt(
  process.env.CODEX_DESIGN_BRIDGE_WORKSPACE_PORT || "9846",
  10,
);
let localWorkspace;
try {
  localWorkspace = await startLocalWorkspaceServer({
    handleRequest,
    port: Number.isFinite(requestedWorkspacePort) ? requestedWorkspacePort : 9846,
    initialArguments: { workspaceDir: defaultWorkspaceDir },
  });
} catch (error) {
  if (error?.code !== "EADDRINUSE" || process.env.CODEX_DESIGN_BRIDGE_WORKSPACE_PORT) throw error;
  localWorkspace = await startLocalWorkspaceServer({
    handleRequest,
    port: 0,
    initialArguments: { workspaceDir: defaultWorkspaceDir },
  });
}
process.env.CODEX_DESIGN_BRIDGE_WORKSPACE_URL = localWorkspace.url;

const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) void respond(socket, line);
    }
  });
});

async function respond(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return;

  try {
    let result;
    if (request.method === "cdb/runtime-info") {
      result = runtimeStatus();
    } else if (request.method === "cdb/shutdown-if-idle") {
      const status = runtimeStatus();
      const idle = !status.sessionActive && !status.unsentChanges;
      result = { stopped: idle, status };
      if (idle) setTimeout(() => void shutdown(), 25);
    } else {
      result = await handleRequest(request.method, request.params ?? {});
    }
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    socket.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: error?.code || -32603, message: String(error?.message || error) },
    })}\n`);
  }
}

async function removeStaleSocket() {
  if (process.platform !== "win32") {
    await rm(socketPath, { force: true });
  }
}

async function listen() {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || process.platform === "win32") throw error;
    const occupied = await canConnect();
    if (occupied) process.exit(0);
    await removeStaleSocket();
    await new Promise((resolve, reject) => {
      server.removeAllListeners("error");
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  }
}

function canConnect() {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await localWorkspace.stop();
  await cleanup({ exit: false });
  await removeStaleSocket();
  process.exit(0);
}

await listen();
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function runtimeKey(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
