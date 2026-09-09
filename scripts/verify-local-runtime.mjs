import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseArguments(process.argv.slice(2));
const pluginRoot = path.resolve(
  options.pluginRoot ||
    path.join(repositoryRoot, "codex-plugin", "codex-design-bridge"),
);
const manifest = JSON.parse(
  await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const gatewayPath = path.join(pluginRoot, "mcp", "gateway.mjs");
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "cdb-runtime-verification-"),
);
// Keep the Unix-domain socket below macOS's path-length limit. The mkdtemp
// directory is already isolated, so it can also serve as the runtime root.
const runtimeRoot = temporaryRoot;
const workspaceRoot = path.join(temporaryRoot, "workspace");
await mkdir(workspaceRoot, { recursive: true });

const gateway = startGateway(gatewayPath, {
  ...process.env,
  CODEX_DESIGN_BRIDGE_RUNTIME_ROOT: runtimeRoot,
  CODEX_DESIGN_BRIDGE_LEASE_ROOT: runtimeRoot,
  CODEX_DESIGN_BRIDGE_PORT: "0",
  CODEX_DESIGN_BRIDGE_WORKSPACE_PORT: "0",
  CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE: workspaceRoot,
  CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "10000",
});
let daemonPid = 0;
let report;

try {
  const initialized = await gateway.request("initialize", {
    protocolVersion: "2025-06-18",
  });
  assertEqual(initialized.serverInfo?.version, manifest.version, "gateway version");

  const createdResult = await gateway.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir: workspaceRoot,
      projectName: "runtime-crash-recovery",
      description: "CDB candidate runtime recovery verification",
    },
  });
  const created = createdResult.structuredContent?.workspace;
  assert(created?.phase === "ready", "temporary project did not become ready");
  assert(created?.lease?.owned === true, "temporary project lease is not owned");
  assert(
    (await fetch(created.previewUrl)).status === 200,
    "temporary preview did not respond",
  );

  const firstHealthResult = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  const firstHealth = firstHealthResult.structuredContent?.health;
  daemonPid = Number(firstHealth?.pid || 0);
  assert(daemonPid > 0, "first daemon PID is unavailable");
  assertEqual(firstHealth.version, manifest.version, "first daemon version");

  await terminateProcessTree(daemonPid);
  await waitForProcessExit(daemonPid, 5000);

  const secondHealthResult = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  const secondHealth = secondHealthResult.structuredContent?.health;
  const recoveredPid = Number(secondHealth?.pid || 0);
  assert(recoveredPid > 0, "recovered daemon PID is unavailable");
  assert(recoveredPid !== daemonPid, "gateway reused the terminated daemon PID");
  daemonPid = recoveredPid;

  const reopenedResult = await gateway.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir: created.projectDir },
  });
  const reopened = reopenedResult.structuredContent?.workspace;
  assert(reopened?.phase === "ready", "project did not reopen after daemon recovery");
  assertEqual(reopened.projectDir, created.projectDir, "recovered project path");
  assertEqual(reopened.activePageId, created.activePageId, "recovered active page");
  assert(reopened?.lease?.owned === true, "recovered project lease is not owned");
  assert(
    (await fetch(reopened.previewUrl)).status === 200,
    "recovered preview did not respond",
  );

  await gateway.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir: reopened.projectDir, force: true },
  });
  const stopped = await gateway.request("cdb/shutdown-if-idle", {});
  assert(stopped?.stopped === true, "recovered daemon did not stop cleanly");
  daemonPid = 0;

  report = {
    status: "passed",
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    pluginRoot,
    version: manifest.version,
    originalPid: firstHealth.pid,
    recoveredPid,
    projectRecovered: true,
    pageRecovered: true,
    previewRecovered: true,
    leaseRecovered: true,
  };
} catch (error) {
  report = {
    status: "failed",
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    pluginRoot,
    version: manifest.version,
    error: String(error?.stack || error),
  };
  process.exitCode = 1;
} finally {
  if (daemonPid > 0) {
    await terminateProcessTree(daemonPid).catch(() => {});
  }
  await gateway.close();
  if (!options.keepTemporaryFiles) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
  } else {
    report.temporaryRoot = temporaryRoot;
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath) {
    const reportPath = path.resolve(options.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

function parseArguments(args) {
  const parsed = {
    pluginRoot: "",
    reportPath: "",
    keepTemporaryFiles: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--plugin-root") {
      parsed.pluginRoot = requiredValue(args, ++index, argument);
    } else if (argument === "--report") {
      parsed.reportPath = requiredValue(args, ++index, argument);
    } else if (argument === "--keep-temporary-files") {
      parsed.keepTemporaryFiles = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function startGateway(gatewayPathValue, environment) {
  const child = spawn(process.execPath, [gatewayPathValue], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const active = pending.get(message.id);
    if (!active) return;
    pending.delete(message.id);
    clearTimeout(active.timer);
    if (message.error) active.reject(new Error(message.error.message));
    else active.resolve(message.result);
  });
  child.once("exit", (code, signal) => {
    for (const active of pending.values()) {
      clearTimeout(active.timer);
      active.reject(
        new Error(
          `gateway exited before responding (code=${code}, signal=${signal}): ${stderr}`,
        ),
      );
    }
    pending.clear();
  });

  return {
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`gateway request timed out: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    },
    async close() {
      lines.close();
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", reject);
      killer.once("exit", (code) => {
        if (code === 0 || !isProcessAlive(pid)) resolve();
        else reject(new Error(`taskkill.exe exited with code ${code}`));
      });
    });
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
}
