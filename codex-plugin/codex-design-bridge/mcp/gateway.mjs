import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(root, "..");
const desiredVersion = JSON.parse(
  readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
).version;
const runtimeRoot = process.env.CODEX_DESIGN_BRIDGE_RUNTIME_ROOT ||
  (process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "Codex Design Bridge", "runtime")
    : path.join(tmpdir(), "codex-design-bridge-runtime"));
const daemonKey = runtimeKey(desiredVersion);
const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\codex-design-bridge-${runtimeKey(runtimeRoot)}-${daemonKey}`
  : path.join(runtimeRoot, `bridge-${daemonKey}.sock`);
const startupTimeoutMs = Number(process.env.CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS || 4_000);
const requestTimeoutMs = Number(process.env.CODEX_DESIGN_BRIDGE_REQUEST_TIMEOUT_MS || 180_000);

let sequence = 0;
let readyPromise;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return;

  let daemonReady = false;
  try {
    await ensureDaemon();
    daemonReady = true;
    const response = await daemonRequest(
      request.method,
      request.params ?? {},
      request.id,
      requestTimeoutMs,
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32001,
        message: daemonReady
          ? `CDB 操作未能在 ${requestTimeoutMs}ms 内完成：${String(error?.message || error)}`
          : `CDB 后台服务未能在 ${startupTimeoutMs}ms 内就绪：${String(error?.message || error)}`,
      },
    })}\n`);
    readyPromise = undefined;
  }
});

function ensureDaemon() {
  const previous = readyPromise;
  readyPromise = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {}
      const current = await tryRuntimeInfo();
      if (current?.version === desiredVersion) return current;
    }
    return startOrConnect();
  })();
  return readyPromise;
}

async function startOrConnect() {
  await mkdir(runtimeRoot, { recursive: true });
  const existing = await tryRuntimeInfo();
  if (existing?.version === desiredVersion) return existing;

  const logFile = openSync(path.join(runtimeRoot, "daemon.log"), "a");
  const child = spawn(process.execPath, [path.join(root, "daemon.mjs")], {
    detached: true,
    env: {
      ...process.env,
      CDB_MCP_TRANSPORT: "daemon",
      CDB_DAEMON_KEY: daemonKey,
    },
    stdio: ["ignore", logFile, logFile],
    windowsHide: true,
  });
  closeSync(logFile);
  child.unref();
  await waitUntil(async () => {
    const status = await tryRuntimeInfo();
    return status?.version === desiredVersion;
  }, startupTimeoutMs);
  return tryRuntimeInfo();
}

async function tryRuntimeInfo() {
  try {
    const response = await daemonRequest("cdb/runtime-info", {}, ++sequence, 500);
    return response.result;
  } catch {
    return null;
  }
}

function daemonRequest(method, params, id = ++sequence, timeoutMs = startupTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("连接超时")), timeoutMs);
    const finish = (error, response) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
  });
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("启动超时");
}

function runtimeKey(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
