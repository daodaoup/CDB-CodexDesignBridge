import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { BridgeServer } from "../src/server.js";

test("sends prepared assets to a plugin and persists feedback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-sync-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  const svgPath = path.join(assets, "sample.svg");
  const svg =
    '<svg viewBox="0 0 10 10"><rect id="box" data-figma-sync="target" width="10" height="10" fill="#fff"/></svg>';
  await writeFile(svgPath, svg);
  const pages = path.join(root, "pages");
  await mkdir(pages);
  await writeFile(
    path.join(pages, "landing.figma-page.json"),
    JSON.stringify(samplePage()),
  );

  const logger = { log() {}, warn() {}, error() {} };
  const token = "a".repeat(48);
  const desktopTaskStates = [];
  const pluginClientCounts = [];
  const pageImportResults = [];
  const server = new BridgeServer({
    rootDirectory: root,
    assetsDirectory: "assets",
    host: "127.0.0.1",
    port: 0,
    token,
    watchFiles: false,
    logger,
    onDesignTask(task) {
      desktopTaskStates.push(task.state);
    },
    onClientChange(count) {
      pluginClientCounts.push(count);
    },
    onPageImportResult(result) {
      pageImportResults.push(result);
    },
    async codexExecutor({ lastMessagePath }) {
      await writeFile(lastMessagePath, "Updated the frontend.\n", "utf8");
      return { exitCode: 0, stdout: "updated", stderr: "" };
    },
  });
  const connection = await server.start();
  t.after(() => server.stop());

  const healthResponse = await fetch(`http://${connection.host}:${connection.port}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.assets, 1);
  assert.equal(health.pages, 1);

  const localhostSocket = new WebSocket(
    `ws://localhost:${connection.port}/ws?token=${token}`,
  );
  t.after(() => localhostSocket.terminate());
  await onceOpen(localhostSocket);

  const webSocket = new WebSocket(`${connection.wsUrl}?token=${token}`);
  const messages = createMessageQueue(webSocket);
  t.after(() => webSocket.terminate());
  await onceOpen(webSocket);
  const hello = await messages.next("bridge.hello");
  assert.equal(hello.protocolVersion, 11);

  webSocket.send(JSON.stringify({ type: "plugin.hello", protocolVersion: 14 }));
  const assetMessage = await messages.next("asset.upsert");
  assert.equal(assetMessage.asset.assetId, "sample.svg");
  assert.deepEqual(assetMessage.asset.elementIds, ["box"]);
  const pageMessage = await messages.next("page.upsert");
  assert.equal(pageMessage.page.pageId, "landing-page");
  assert.deepEqual(pageMessage.page.nodeIds, ["landing-root", "hero-title"]);
  assert.equal(server.getPluginClientCount(), 1);
  assert.deepEqual(pluginClientCounts, [1]);
  webSocket.send(
    JSON.stringify({
      type: "page.import.result",
      result: { ok: true, pageId: "landing-page", nodes: 2 },
    }),
  );
  await waitFor(() => pageImportResults.length === 1);
  assert.deepEqual(pageImportResults[0], {
    ok: true,
    pageId: "landing-page",
    nodes: 2,
  });

  webSocket.send(
    JSON.stringify({
      type: "design.generate",
      requestId: "design-request-1",
      design: sampleDesign(),
    }),
  );
  const queuedTask = await messages.next("design.task");
  assert.equal(queuedTask.task.state, "queued");
  const runningTask = await messages.next("design.task");
  assert.equal(runningTask.task.state, "running");
  const completedTask = await messages.next("design.task");
  assert.equal(completedTask.task.state, "completed");
  assert.deepEqual(desktopTaskStates, ["queued", "running", "completed"]);
  const storedDesignStatus = JSON.parse(
    await readFile(
      path.join(
        root,
        ".figma-sync",
        "design-requests",
        completedTask.task.taskId,
        "status.json",
      ),
      "utf8",
    ),
  );
  assert.equal(storedDesignStatus.state, "completed");

  webSocket.send(
    JSON.stringify({
      type: "feedback.record",
      requestId: "request-1",
      feedback: {
        feedbackId: "feedback-1",
        assetId: "sample.svg",
        sourceHash: assetMessage.asset.sourceHash,
        elementId: "box",
        kind: "properties",
        changes: [
          {
            category: "appearance",
            property: "fill",
            from: "#FFFFFF",
            to: "#000000",
          },
        ],
        annotations: [],
      },
    }),
  );
  const ack = await messages.next("feedback.ack");
  assert.equal(ack.state, "pending");
  const saved = JSON.parse(await readFile(path.join(root, ack.path), "utf8"));
  assert.equal(saved.elementId, "box");
  assert.equal(saved.changes[0].to, "#000000");

  webSocket.send(
    JSON.stringify({
      type: "page.changes.record",
      requestId: "page-request-1",
      changeSet: {
        changeSetId: "page-change-1",
        pageId: "landing-page",
        sourceHash: pageMessage.page.sourceHash,
        changes: [
          {
            nodeId: "hero-title",
            category: "text",
            property: "fontSize",
            from: 48,
            to: 56,
          },
        ],
        annotations: [],
      },
    }),
  );
  const pageAck = await messages.next("page.changes.ack");
  assert.equal(pageAck.state, "pending");
  const savedPageChanges = JSON.parse(
    await readFile(path.join(root, pageAck.path), "utf8"),
  );
  assert.equal(savedPageChanges.page.pageId, "landing-page");
  assert.equal(savedPageChanges.changes[0].to, 56);

  await rm(svgPath);
  server.scheduleFileRefresh(svgPath);
  await messages.next("asset.remove");
  webSocket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 14,
      importedAssetIds: ["sample.svg"],
    }),
  );
  const staleAssetRemoval = await messages.next("asset.remove");
  assert.equal(staleAssetRemoval.assetId, "sample.svg");
  webSocket.send(
    JSON.stringify({
      type: "feedback.record",
      requestId: "request-after-delete",
      feedback: {
        feedbackId: "feedback-after-delete",
        assetId: "sample.svg",
        sourceHash: assetMessage.asset.sourceHash,
        elementId: "box",
        kind: "annotations",
        changes: [],
        annotations: [{ label: "Restore this asset" }],
      },
    }),
  );
  const deletedAck = await messages.next("feedback.ack");
  assert.equal(deletedAck.state, "conflict");
  const deletedFeedback = JSON.parse(
    await readFile(path.join(root, deletedAck.path), "utf8"),
  );
  assert.equal(deletedFeedback.source.currentHash, null);
  assert.equal(deletedFeedback.annotations[0].label, "Restore this asset");
});

test("rejects unauthenticated websocket clients and out-of-root pushes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-sync-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"));
  const server = new BridgeServer({
    rootDirectory: root,
    port: 0,
    token: "b".repeat(48),
    watchFiles: false,
    logger: { log() {}, warn() {}, error() {} },
  });
  const connection = await server.start();
  t.after(() => server.stop());

  const unauthorized = new WebSocket(`${connection.wsUrl}?token=wrong`);
  await assert.rejects(() => onceOpen(unauthorized), /Unexpected server response: 401/);

  const response = await fetch(`http://${connection.host}:${connection.port}/api/push`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: path.join(root, "outside.svg") }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /inside/);
});

function samplePage() {
  return {
    pageId: "landing-page",
    root: {
      id: "landing-root",
      type: "frame",
      width: 1440,
      height: 900,
      style: { fill: "#101114" },
      children: [
        {
          id: "hero-title",
          type: "text",
          width: 720,
          height: 80,
          text: "Built by Codex",
          font: {
            family: "Inter",
            style: "Bold",
            size: 48,
            lineHeight: 56,
          },
          style: { fill: "#FFFFFF" },
        },
      ],
    },
  };
}

function sampleDesign() {
  return {
    protocolVersion: 3,
    designId: "existing-figma-screen",
    capturedAt: "2026-07-29T00:00:00.000Z",
    figma: {
      fileKey: "file-key",
      pageId: "1:1",
      pageName: "Page 1",
      rootNodeId: "2:1",
      rootNodeName: "Existing screen",
    },
    screenshot: {
      mimeType: "image/png",
      base64: Buffer.from([137, 80, 78, 71]).toString("base64"),
      width: 1440,
      height: 900,
    },
    root: {
      stableId: "screen-root",
      nodeId: "2:1",
      name: "Existing screen",
      type: "FRAME",
      properties: { width: 1440, height: 900 },
      annotations: [],
      sourceRef: null,
      children: [],
    },
  };
}

function onceOpen(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });
}

async function waitFor(predicate, timeout = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createMessageQueue(webSocket) {
  const buffered = [];
  const waiters = [];
  webSocket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      buffered.push(message);
    }
  });

  return {
    next(type, timeout = 3000) {
      const index = buffered.findIndex((message) => message.type === type);
      if (index >= 0) {
        return Promise.resolve(buffered.splice(index, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) {
            waiters.splice(waiterIndex, 1);
          }
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeout);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}
