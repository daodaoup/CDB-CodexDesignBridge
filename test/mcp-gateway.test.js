import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "../codex-plugin/codex-design-bridge/vendor/ws/wrapper.mjs";
import { solidVisualReference } from "./helpers/visual-reference.js";

const gatewayPath = path.resolve(
  "codex-plugin",
  "codex-design-bridge",
  "mcp",
  "gateway.mjs",
);

test("lightweight gateways reuse one persistent CDB daemon", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-gateway-test-"));
  const environment = {
    ...process.env,
    CODEX_DESIGN_BRIDGE_RUNTIME_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_PORT: "0",
    CODEX_DESIGN_BRIDGE_WORKSPACE_PORT: "0",
    CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE: runtimeRoot,
    CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "7000",
  };
  t.after(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const first = startGateway(environment);
  const initialized = await first.request("initialize", {
    protocolVersion: "2025-06-18",
  });
  const listed = await first.request("tools/list");
  const firstHealth = await first.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });

  assert.equal(initialized.serverInfo.name, "codex-design-workspace");
  assert.ok(listed.tools.some((tool) => tool.name === "open_cdb"));
  assert.ok(listed.tools.some((tool) => tool.name === "get_cdb_health"));
  const workspaceUrl = firstHealth.structuredContent.health.workspaceUrl;
  assert.match(workspaceUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const workspaceResponse = await fetch(workspaceUrl);
  assert.equal(workspaceResponse.status, 200);
  assert.match(await workspaceResponse.text(), /window\.__CDB_STANDALONE__ = true/);

  const opened = await first.request("tools/call", {
    name: "open_cdb",
    arguments: { action: "auto" },
  });
  assert.equal(opened.structuredContent.workspace.mode, "launcher");
  await first.close();

  const second = startGateway(environment);
  const secondHealth = await second.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  assert.equal(
    secondHealth.structuredContent.health.pid,
    firstHealth.structuredContent.health.pid,
  );
  const stopped = await second.request("cdb/shutdown-if-idle", {});
  assert.equal(stopped.stopped, true);
  await second.close();
});

test("gateway keeps long tools alive independently from the daemon startup timeout", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-gateway-long-tool-"));
  const bridgePort = await getFreePort();
  const baseEnvironment = {
    ...process.env,
    CODEX_DESIGN_BRIDGE_RUNTIME_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_LEASE_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
    CODEX_DESIGN_BRIDGE_WORKSPACE_PORT: "0",
    CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE: runtimeRoot,
    CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "7000",
  };
  let socket;
  let daemonPid = 0;
  t.after(async () => {
    socket?.terminate();
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {}
    }
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const bootstrap = startGateway(baseEnvironment);
  const created = await bootstrap.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir: runtimeRoot,
      projectName: "long-tool-project",
      description: "Long gateway operation",
    },
  });
  const workspace = created.structuredContent.workspace;
  daemonPid = (await bootstrap.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  })).structuredContent.health.pid;
  const connection = await connectFigma({
    bridgePort,
    sessionId: "long-tool-session",
    projectKey: workspace.preflightReport.projectKey,
  });
  socket = connection.socket;
  await bootstrap.close();

  const gateway = startGateway({
    ...baseEnvironment,
    CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "50",
    CODEX_DESIGN_BRIDGE_REQUEST_TIMEOUT_MS: "10000",
  });
  t.after(() => gateway.close());
  const upsertPromise = connection.messages.next("page.upsert");
  const sendPromise = gateway.request("tools/call", {
    name: "send_preview_to_local_figma",
    arguments: { projectDir: workspace.projectDir },
  });
  const upsert = await upsertPromise;
  await new Promise((resolve) => setTimeout(resolve, 120));
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: upsert.page.pageId,
      sourceHash: upsert.page.sourceHash,
      nodeId: "71:1",
      fileKey: "long-tool-file",
      figmaPageId: "7:1",
      nodes: upsert.page.nodeIds.length,
      nodeMappings: upsert.page.nodeIds.map((pageNodeId, index) => ({
        pageNodeId,
        figmaNodeId: `71:${index + 1}`,
      })),
    },
  }));
  const sent = await sendPromise;
  assert.equal(sent.structuredContent.workspace.phase, "in_figma");
  assert.equal(sent.structuredContent.workspace.pages[0].syncState, "synced");

  await gateway.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir: workspace.projectDir, force: true },
  });
  assert.equal((await gateway.request("cdb/shutdown-if-idle", {})).stopped, true);
  daemonPid = 0;
});

test("a gateway replaces a killed daemon and immediately restores its local workspace", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-gateway-crash-"));
  const environment = {
    ...process.env,
    CODEX_DESIGN_BRIDGE_RUNTIME_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_LEASE_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_PORT: "0",
    CODEX_DESIGN_BRIDGE_WORKSPACE_PORT: "0",
    CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE: runtimeRoot,
    CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "7000",
  };
  const gateway = startGateway(environment);
  t.after(async () => {
    await gateway.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  await gateway.request("initialize", { protocolVersion: "2025-06-18" });
  const created = await gateway.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir: runtimeRoot,
      projectName: "crash-recovery-project",
      description: "Crash recovery page",
    },
  });
  const before = created.structuredContent.workspace;
  const firstHealth = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  const firstPid = firstHealth.structuredContent.health.pid;
  assert.equal(before.lease.owned, true);
  assert.equal(await fetch(before.previewUrl).then((response) => response.status), 200);

  const originalHtml = await readFile(path.join(before.projectDir, "index.html"), "utf8");
  const originalCss = await readFile(path.join(before.projectDir, "styles.css"), "utf8");
  const interruptedPatch = spawn(process.execPath, [
    path.resolve("scripts/test-fixtures/patch-transaction-crash.mjs"),
    before.projectDir,
    "index.html",
    "styles.css",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const interruptedExit = await new Promise((resolve, reject) => {
    interruptedPatch.once("error", reject);
    interruptedPatch.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(interruptedExit.signal, "SIGKILL");
  assert.equal(await readFile(path.join(before.projectDir, "index.html"), "utf8"), "first after");

  process.kill(firstPid, "SIGKILL");
  await waitForProcessExit(firstPid);

  const restartedHealth = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  const secondPid = restartedHealth.structuredContent.health.pid;
  assert.notEqual(secondPid, firstPid);

  const reopened = await gateway.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir: before.projectDir },
  });
  const restored = reopened.structuredContent.workspace;
  assert.equal(restored.phase, "ready");
  assert.equal(restored.lease.owned, true);
  assert.equal(restored.projectDir, before.projectDir);
  assert.equal(restored.activePageId, before.activePageId);
  assert.deepEqual(
    restored.pages.map((page) => page.id),
    before.pages.map((page) => page.id),
  );
  assert.equal(restored.summary, "已自动回滚 1 个被异常终止的源码事务。");
  assert.deepEqual(restored.changedFiles, ["index.html"]);
  assert.equal(await readFile(path.join(before.projectDir, "index.html"), "utf8"), originalHtml);
  assert.equal(await readFile(path.join(before.projectDir, "styles.css"), "utf8"), originalCss);
  assert.equal(await fetch(restored.previewUrl).then((response) => response.status), 200);

  const lease = JSON.parse(
    await readFile(path.join(runtimeRoot, "active-workspace.json"), "utf8"),
  );
  assert.equal(lease.ownerPid, secondPid);
  const runtimeEntries = await readdir(runtimeRoot);
  assert.equal(runtimeEntries.filter((entry) => entry.endsWith(".secret")).length, 1);
  assert.equal(runtimeEntries.filter((entry) => entry.endsWith(".sock")).length, 1);

  await gateway.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir: restored.projectDir, force: true },
  });
  const stopped = await gateway.request("cdb/shutdown-if-idle", {});
  assert.equal(stopped.stopped, true);
});

test("protocol 16 resumes accepted and completed offers across hard daemon crashes", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-gateway-offer-crash-"));
  const bridgePort = await getFreePort();
  const environment = {
    ...process.env,
    CODEX_DESIGN_BRIDGE_RUNTIME_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_LEASE_ROOT: runtimeRoot,
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
    CODEX_DESIGN_BRIDGE_WORKSPACE_PORT: "0",
    CODEX_DESIGN_BRIDGE_DEFAULT_WORKSPACE: runtimeRoot,
    CODEX_DESIGN_BRIDGE_STARTUP_TIMEOUT_MS: "7000",
  };
  const gateway = startGateway(environment);
  let daemonPid = 0;
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {}
    }
    await gateway.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  await gateway.request("initialize", { protocolVersion: "2025-06-18" });
  const created = await gateway.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir: runtimeRoot,
      projectName: "offer-crash-project",
      description: "Offer crash recovery",
    },
  });
  const workspace = created.structuredContent.workspace;
  const projectDir = workspace.projectDir;
  const projectKey = workspace.preflightReport.projectKey;
  const sessionId = "session-hard-crash-1234";
  const offerId = "offer-hard-crash-1234";
  ({ socket } = await connectFigma({ bridgePort, sessionId, projectKey }));
  const firstInbox = messageInbox(socket);
  const ackPromise = firstInbox.next("figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    ...protocol16(),
    responsiveContract: responsiveContract(),
    offerId,
    sessionId,
    figmaFileKey: "hard-crash-file",
    rootNodeId: "91:1",
    rootName: "Recovered page",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await ackPromise).state, "pending");
  const acceptMessage = firstInbox.next("figma.design.accept");
  await gateway.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: { offerId, action: "add_page", projectDir },
  });
  assert.equal((await acceptMessage).target.action, "add_page");

  daemonPid = (await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  })).structuredContent.health.pid;
  const firstClose = new Promise((resolve) => socket.once("close", resolve));
  process.kill(daemonPid, "SIGKILL");
  await Promise.all([waitForProcessExit(daemonPid), firstClose]);
  socket = null;

  const afterAcceptedCrash = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  daemonPid = afterAcceptedCrash.structuredContent.health.pid;
  await gateway.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const acceptedConnection = await connectFigma({ bridgePort, sessionId, projectKey });
  socket = acceptedConnection.socket;
  assert.equal(
    acceptedConnection.inbox.offers.find((offer) => offer.offerId === offerId)?.state,
    "accepted",
  );
  const acceptedInbox = messageInbox(socket);
  const completedPromise = acceptedInbox.next("figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    ...protocol16(),
    responsiveContract: responsiveContract(),
    offerId,
    sessionId,
    figma: {
      fileKey: "hard-crash-file",
      pageId: "9:1",
      pageName: "Recovered page",
      rootNodeId: "91:1",
      rootNodeName: "Recovered page",
    },
    pageSeed: {
      node: {
        id: "recovered-root",
        type: "frame",
        tag: "main",
        name: "Recovered page",
        width: 1440,
        height: 900,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: { fill: "#202020" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750, [32, 32, 32, 255]),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const completed = await completedPromise;
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.entry, "recovered-page.html");

  const secondClose = new Promise((resolve) => socket.once("close", resolve));
  process.kill(daemonPid, "SIGKILL");
  await Promise.all([waitForProcessExit(daemonPid), secondClose]);
  socket = null;
  const afterCompletedCrash = await gateway.request("tools/call", {
    name: "get_cdb_health",
    arguments: {},
  });
  daemonPid = afterCompletedCrash.structuredContent.health.pid;
  await gateway.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const completedConnection = await connectFigma({ bridgePort, sessionId, projectKey });
  socket = completedConnection.socket;
  const restoredOffer = completedConnection.inbox.offers.find(
    (offer) => offer.offerId === offerId,
  );
  assert.equal(restoredOffer?.state, "completed");
  assert.equal(restoredOffer?.result?.transactionId, completed.result.transactionId);
  const completedInbox = messageInbox(socket);
  const replayPromise = completedInbox.next("figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.result.query",
    ...protocol16(),
    offerId,
    sessionId,
  }));
  const replay = await replayPromise;
  assert.equal(replay.state, "completed");
  assert.equal(replay.result.transactionId, completed.result.transactionId);
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.pages.filter((page) => page.entry === "recovered-page.html").length,
    1,
  );

  socket.close();
  socket = null;
  await gateway.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir, force: true },
  });
  assert.equal(
    (await gateway.request("cdb/shutdown-if-idle", {})).stopped,
    true,
  );
  daemonPid = 0;
});

function startGateway(environment) {
  const child = spawn(process.execPath, [gatewayPath], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0;
  let buffer = "";
  let errors = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      if (response.error) waiter.reject(new Error(response.error.message));
      else waiter.resolve(response.result);
    }
  });

  return {
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out. ${errors}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      child.stdin.end();
      return new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", resolve);
      });
    },
  };
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Daemon ${pid} did not exit after SIGKILL.`);
}

async function connectFigma({ bridgePort, sessionId, projectKey }) {
  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = messageInbox(socket);
  const readyPromise = messages.next("plugin.ready");
  const inboxPromise = messages.next("figma.design.inbox");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: "0.9.0",
    sessionId,
    projectKey,
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await readyPromise;
  return { socket, inbox: await inboxPromise, messages };
}

function protocol16() {
  return {
    protocolVersion: 16,
    runtimeIdentity: {
      kind: "cdb-0.9-responsive-v2",
      protocolVersion: 16,
      pageIrSchemaVersion: 2,
      exactBuild: "0.9.0+codex.20260829100031",
    },
  };
}

function responsiveContract() {
  return {
    designViewport: { width: 1440, height: 900 },
    runtimeViewports: [{ id: "runtime-1440", width: 1440, height: 900, devicePixelRatio: 1 }],
    previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
    breakpoints: [],
  };
}

function messageInbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  });
  return {
    next(type) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
