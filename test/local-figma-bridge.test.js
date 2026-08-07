import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { LocalFigmaBridge } from "../codex-plugin/codex-design-bridge/mcp/local-figma-bridge.mjs";

test("local Figma bridge auto-pairs, imports a page, and stores changes", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-bridge-"));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<link rel="stylesheet" href="./styles.css"><h1 data-codex-id="headline">Before</h1>',
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    runtimeVersion: "0.7.0+codex.test",
    onFastApply: async (result) => ({
      sourceHash: `synced-${result.pageId}`,
    }),
  });
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    await rm(projectDir, { recursive: true, force: true });
  });

  const pairingUrl = `http://localhost:${bridge.status().port}/api/pair`;
  const rejectedPairing = await fetch(pairingUrl, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(rejectedPairing.status, 403);

  const pairingResponse = await fetch(pairingUrl, {
    headers: { origin: "https://www.figma.com" },
  });
  const pairing = await pairingResponse.json();
  assert.equal(pairing.ok, true);
  assert.match(pairing.token, /^[a-f0-9]{48}$/);
  assert.equal(
    pairingResponse.headers.get("access-control-allow-origin"),
    "https://www.figma.com",
  );
  await assert.rejects(
    access(path.join(projectDir, ".codex", "design-bridge-token")),
  );

  const rejectedSocket = new WebSocket(
    `${pairing.wsUrl}?token=${pairing.token}`,
    { origin: "https://example.com" },
  );
  await new Promise((resolve, reject) => {
    rejectedSocket.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    rejectedSocket.once("open", () =>
      reject(new Error("Untrusted WebSocket origin was accepted.")),
    );
    rejectedSocket.once("error", () => {});
  });

  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  const inbox = messageInbox(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.close());

  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 9,
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const mismatch = await inbox.next("bridge.error");
  assert.equal(mismatch.code, "version_mismatch");
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().lastError, "version_mismatch");

  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 14,
      pluginVersion: "0.6.0",
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const buildMismatch = await inbox.next("bridge.error");
  assert.equal(buildMismatch.code, "version_mismatch");
  assert.match(buildMismatch.error, /0\.6\.0.*0\.7\.0/);

  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 13,
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const ready = await inbox.next("plugin.ready");
  assert.equal(ready.protocolVersion, 14);
  assert.equal(ready.runtimeVersion, "0.7.0+codex.test");
  assert.equal(ready.localWorkspace, true);
  assert.deepEqual(bridge.status().figmaPluginVersions, ["protocol-13"]);
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().lastError, "");

  const importPromise = bridge.pushPage(sampleManifest());
  const upsert = await inbox.next("page.upsert");
  assert.equal(upsert.page.pageId, "local-preview");
  socket.send(
    JSON.stringify({
      type: "page.import.result",
      result: {
        ok: true,
        pageId: upsert.page.pageId,
        nodeId: "12:34",
        fileKey: "test-file",
        nodes: upsert.page.nodeIds.length,
      },
    }),
  );
  const imported = await importPromise;
  assert.equal(imported.nodeCount, upsert.page.nodeIds.length);
  assert.equal(imported.figmaUrl, undefined);

  const secondManifest = sampleManifest();
  secondManifest.pageId = "settings-preview";
  secondManifest.name = "Settings preview";
  const secondImportPromise = bridge.pushPage(secondManifest);
  const secondUpsert = await inbox.next("page.upsert");
  assert.equal(secondUpsert.page.pageId, "settings-preview");
  socket.send(
    JSON.stringify({
      type: "page.import.result",
      result: {
        ok: true,
        pageId: secondUpsert.page.pageId,
        nodeId: "56:78",
        fileKey: "test-file",
        nodes: secondUpsert.page.nodeIds.length,
      },
    }),
  );
  await secondImportPromise;

  const capturePromise = bridge.captureChanges();
  const request = await inbox.next("page.changes.request");
  socket.send(
    JSON.stringify({
      type: "page.changes.record",
      requestId: request.requestId,
      changeSet: {
        changeSetId: "change-1",
        pageId: "local-preview",
        sourceHash: upsert.page.sourceHash,
        changes: [
          {
            nodeId: "headline",
            category: "text",
            property: "characters",
            from: "Before",
            to: "After",
            sourceRef: {
              selector: '[data-codex-id="headline"]',
            },
          },
        ],
        annotations: [],
        figma: { rootNodeId: "12:34" },
      },
    }),
  );
  socket.send(
    JSON.stringify({
      type: "page.changes.record",
      requestId: request.requestId,
      changeSet: {
        changeSetId: "change-2",
        pageId: "settings-preview",
        sourceHash: secondUpsert.page.sourceHash,
        changes: [
          {
            nodeId: "headline",
            category: "text",
            property: "characters",
            from: "After",
            to: "Again",
            sourceRef: {
              selector: '[data-codex-id="headline"]',
            },
          },
        ],
        annotations: [],
        figma: { rootNodeId: "56:78" },
      },
    }),
  );
  socket.send(
    JSON.stringify({
      type: "page.changes.complete",
      requestId: request.requestId,
      count: 2,
    }),
  );
  const captured = await capturePromise;
  assert.equal(captured.empty, false);
  assert.equal(captured.changeCount, 2);
  assert.equal(captured.pages, 2);
  assert.equal(captured.snapshotPaths.length, 2);
  assert.equal(captured.fastApply.appliedCount, 2);
  const accepted = await inbox.next("page.changes.ack");
  const secondAccepted = await inbox.next("page.changes.ack");
  assert.deepEqual(
    new Set([accepted.pageId, secondAccepted.pageId]),
    new Set(["local-preview", "settings-preview"]),
  );
  assert.equal(accepted.state, "applied");
  assert.equal(secondAccepted.state, "applied");
  assert.deepEqual(
    new Set([accepted.sourceHash, secondAccepted.sourceHash]),
    new Set(["synced-local-preview", "synced-settings-preview"]),
  );
  const stored = JSON.parse(await readFile(captured.snapshotPath, "utf8"));
  assert.equal(stored.changeSetId, "change-2");
  assert.equal(stored.changes[0].to, "Again");
  assert.match(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    />Again<\/h1>/,
  );
});

test("publishes manifest pages and accepts page-list import requests", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-catalog-"));
  const importedRequests = [];
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    onImportPages: async (pageIds) => importedRequests.push(pageIds),
  });
  bridge.setPageCatalog([
    {
      id: "home",
      name: "Home",
      entry: "index.html",
      route: "/",
      sourceHash: "home-hash",
      syncState: "not_imported",
    },
    {
      id: "settings",
      name: "Settings",
      entry: "index.html",
      route: "/settings",
      sourceHash: "settings-hash",
      syncState: "source_changed",
    },
  ]);
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    await rm(projectDir, { recursive: true, force: true });
  });

  const pairing = await fetch(`http://localhost:${bridge.status().port}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  const inbox = messageInbox(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.close());
  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 14,
      importedAssetIds: [],
      importedPageIds: [],
      changedPageIds: ["settings"],
    }),
  );
  await inbox.next("plugin.ready");
  const catalog = await inbox.next("page.catalog");
  assert.equal(catalog.pages.length, 2);
  assert.equal(
    catalog.pages.find((page) => page.id === "settings").state,
    "conflict",
  );

  socket.send(
    JSON.stringify({
      type: "page.import.request",
      pageIds: ["home", "missing"],
    }),
  );
  const result = await inbox.next("page.import.request.result");
  assert.equal(result.ok, true);
  assert.deepEqual(result.pageIds, ["home"]);
  assert.deepEqual(importedRequests, [["home"]]);
});

test("accepts a Figma-first page without importing a Codex page first", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-seed-"));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<link rel="stylesheet" href="./styles.css"><main data-codex-root data-codex-id="page-root"><p data-codex-id="figma-seed-placeholder">Waiting</p></main>',
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    onFastApply: async () => ({ sourceHash: "seed-hash-after" }),
  });
  bridge.setPageCatalog([{
    id: "seed-page",
    name: "Page",
    entry: "index.html",
    route: "/",
    sourceHash: "seed-hash-before",
    syncState: "not_imported",
    acceptsFigmaSeed: true,
  }]);
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    await rm(projectDir, { recursive: true, force: true });
  });

  const pairing = await fetch(`http://localhost:${bridge.status().port}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  const inbox = messageInbox(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.close());
  socket.send(JSON.stringify({
    type: "plugin.hello",
    protocolVersion: 14,
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await inbox.next("plugin.ready");
  const catalog = await inbox.next("page.catalog");
  assert.equal(catalog.pages[0].acceptsFigmaSeed, true);

  socket.send(JSON.stringify({
    type: "page.changes.record",
    requestId: "seed-request",
    changeSet: {
      changeSetId: "seed-change",
      pageId: "seed-page",
      sourceHash: "seed-hash-before",
      changes: [{
        nodeId: "page-root",
        nodeType: "FRAME",
        property: "pageSeed",
        sourceRef: { selector: '[data-codex-id="page-root"]' },
        to: {
          node: {
            id: "page-root",
            type: "frame",
            tag: "main",
            name: "Figma page",
            width: 390,
            height: 844,
            opacity: 1,
            visible: true,
            rotation: 0,
            style: { fill: { color: "#FFFFFF", opacity: 1 }, stroke: null, strokeWeight: 0, cornerRadius: 0 },
            layout: { mode: "VERTICAL", itemSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN" },
            children: [],
          },
        },
      }],
      annotations: [],
    },
  }));
  const accepted = await inbox.next("page.changes.ack");
  assert.equal(accepted.state, "applied");
  assert.equal(accepted.sourceHash, "seed-hash-after");
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.match(source, /data-codex-root data-codex-id="page-root"/);
  assert.doesNotMatch(source, /figma-seed-placeholder/);
});

function messageInbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.type === message.type,
    );
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
      if (index >= 0) {
        return Promise.resolve(messages.splice(index, 1)[0]);
      }
      return new Promise((resolve) => {
        waiters.push({ type, resolve });
      });
    },
  };
}

function sampleManifest() {
  return {
    protocolVersion: 3,
    pageId: "local-preview",
    name: "Local preview",
    sourceHash: "test-source",
    source: { file: "index.html", previewUrl: "http://127.0.0.1:3000/" },
    nodeIds: ["root", "headline"],
    root: {
      id: "root",
      type: "frame",
      name: "Root",
      width: 1440,
      height: 900,
      x: 0,
      y: 0,
      rotation: 0,
      visible: true,
      opacity: 1,
      sourceRef: { file: "index.html", selector: "body" },
      style: { fill: "#FFFFFF", radius: 0 },
      layout: {
        direction: "vertical",
        gap: 24,
        padding: { top: 40, right: 40, bottom: 40, left: 40 },
        align: "start",
        justify: "start",
      },
      children: [
        {
          id: "headline",
          type: "text",
          name: "Headline",
          width: 600,
          height: 64,
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          opacity: 1,
          sourceRef: {
            file: "index.html",
            selector: '[data-codex-id="headline"]',
          },
          style: { fill: "#111111" },
          text: "Before",
          textAlign: "left",
          font: {
            family: "Inter",
            style: "Regular",
            size: 48,
            lineHeight: 56,
            letterSpacing: 0,
          },
        },
      ],
    },
  };
}
