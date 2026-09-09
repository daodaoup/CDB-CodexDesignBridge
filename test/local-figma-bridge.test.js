import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "../codex-plugin/codex-design-bridge/vendor/ws/wrapper.mjs";
import { LocalFigmaBridge } from "../codex-plugin/codex-design-bridge/mcp/local-figma-bridge.mjs";
import { DesignOfferStore } from "../codex-plugin/codex-design-bridge/mcp/design-offer-store.mjs";
import { SyncBaselineStore } from "../codex-plugin/codex-design-bridge/mcp/sync-baseline-store.mjs";
import { preparePageManifest } from "../codex-plugin/codex-design-bridge/shared/page.mjs";
import { responsivePageIrToPageSeedNode as pageIrToPageSeedNode } from "../codex-plugin/codex-design-bridge/shared/page-ir-responsive-v2.mjs";

function runtimeIdentity(exactBuild = "0.9.0+codex.20260829100031") {
  return {
    kind: "cdb-0.9-responsive-v2",
    protocolVersion: 16,
    pageIrSchemaVersion: 2,
    exactBuild,
  };
}

function responsiveContract(width = 402, height = 874) {
  return {
    designViewport: { width, height },
    runtimeViewports: [{ id: `figma-${width}`, width, height, devicePixelRatio: 1 }],
    previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
    breakpoints: [],
  };
}

test("accepts protocol 16 exact-build design offers idempotently and replays results", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-offer-"));
  const offerStore = new DesignOfferStore(path.join(projectDir, "offers.json"));
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    runtimeVersion: "0.9.0+codex.20260829100031",
    offerStore,
    onDesignPayload: async (receivedOffer) => ({
      projectDir: path.join(projectDir, "generated"),
      pageId: receivedOffer.payloadSummary.pageId,
      preflightStatus: "pass",
    }),
  });
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
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "session-12345678",
  }));
  assert.equal((await inbox.next("plugin.ready")).protocolVersion, 16);
  await inbox.next("figma.design.inbox");
  const offer = {
    type: "figma.design.offer",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    offerId: "offer-12345678",
    sessionId: "session-12345678",
    figmaFileKey: "file-1",
    rootNodeId: "42:17",
    rootName: "Home",
    rootType: "FRAME",
    width: 402,
    height: 874,
    responsiveContract: responsiveContract(),
    estimatedNodeCount: 20,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  socket.send(JSON.stringify(offer));
  assert.equal((await inbox.next("figma.design.offer.ack")).duplicate, false);
  await inbox.next("figma.design.inbox");
  socket.send(JSON.stringify(offer));
  assert.equal((await inbox.next("figma.design.offer.ack")).duplicate, true);
  socket.send(JSON.stringify({
    type: "figma.design.result.query",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    sessionId: offer.sessionId,
    offerId: offer.offerId,
  }));
  assert.equal((await inbox.next("figma.design.result")).state, "pending");
  const acceptPromise = bridge.acceptDesignOffer(offer.offerId, {
    action: "create_project",
    workspaceDir: projectDir,
  });
  const accepted = await inbox.next("figma.design.accept");
  assert.equal(accepted.rootNodeId, "42:17");
  assert.equal(accepted.target.action, "create_project");
  await acceptPromise;
  socket.send(JSON.stringify({
    type: "figma.design.progress",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    offerId: offer.offerId,
    sessionId: offer.sessionId,
    phase: "collecting",
    completed: 1,
    total: 20,
    message: "Collecting layers",
  }));
  await inbox.next("figma.design.inbox");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    offerId: offer.offerId,
    sessionId: offer.sessionId,
    figma: { rootNodeId: "42:17", rootNodeName: "Home" },
    pageSeed: { node: {
      id: "page-root",
      type: "frame",
      name: "Home",
      width: 402,
      height: 874,
      constraints: { horizontal: "MIN", vertical: "MIN" },
      layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
      layout: { kind: "none", direction: "none" },
      children: [],
    } },
    referenceImage: sampleVisualReference(),
    responsiveContract: responsiveContract(),
    report: { nodeCount: 1, resourceBytes: 0, resourceCount: 0, degradations: [] },
    capturedAt: "2026-08-12T00:01:00.000Z",
  }));
  const payloadResult = await inbox.next("figma.design.result");
  assert.equal(payloadResult.state, "completed");
  assert.equal(payloadResult.result.preflightStatus, "pass");
  assert.equal((await offerStore.get(offer.offerId)).payloadSummary.nodeCount, 1);
  assert.equal((await offerStore.get(offer.offerId)).state, "completed");
});

function sampleVisualReference() {
  const bytes = readFileSync(new URL(
    "./fixtures/page-ir-responsive-v2/screenshots/home-402x874.png",
    import.meta.url,
  ));
  return {
    mimeType: "image/png",
    base64: bytes.toString("base64"),
    width: 402,
    height: 874,
  };
}

test("replaces an older project connection and sends page imports only to the latest client", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-client-replace-"));
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    runtimeVersion: "0.9.0+codex.20260829100031",
    projectKey: "shared-project-key",
  });
  await bridge.start();
  t.after(async () => {
    await bridge.stop();
    await rm(projectDir, { recursive: true, force: true });
  });
  const pairing = await fetch(`http://localhost:${bridge.status().port}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());

  const firstSocket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  const firstInbox = messageInbox(firstSocket);
  await new Promise((resolve, reject) => {
    firstSocket.once("open", resolve);
    firstSocket.once("error", reject);
  });
  t.after(() => firstSocket.close());
  firstSocket.send(JSON.stringify({
    type: "plugin.hello",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "first-session-1234",
    projectKey: "shared-project-key",
  }));
  await firstInbox.next("plugin.ready");

  const secondSocket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  const secondInbox = messageInbox(secondSocket);
  await new Promise((resolve, reject) => {
    secondSocket.once("open", resolve);
    secondSocket.once("error", reject);
  });
  t.after(() => secondSocket.close());
  secondSocket.send(JSON.stringify({
    type: "plugin.hello",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "second-session-1234",
    projectKey: "shared-project-key",
  }));
  assert.equal((await firstInbox.next("session.replaced")).reason, "newer_connection");
  await secondInbox.next("plugin.ready");

  const importPromise = bridge.pushPage(sampleManifest());
  const upsert = await secondInbox.next("page.upsert");
  secondSocket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: upsert.page.pageId,
      sourceHash: upsert.page.sourceHash,
      nodeId: "22:1",
      fileKey: "latest-file",
      figmaPageId: "2:1",
      nodes: upsert.page.nodeIds.length,
      nodeMappings: [{ pageNodeId: "root", figmaNodeId: "22:1" }],
    },
  }));
  await importPromise;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstInbox.count("page.upsert"), 0);
});

test("honors the configured Figma long-operation timeout for a slow page import", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-slow-import-"));
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    runtimeVersion: "0.9.0+codex.20260829100031",
    projectKey: "slow-import-project",
    operationTimeoutMs: 100,
  });
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
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "slow-import-session",
    projectKey: "slow-import-project",
  }));
  await inbox.next("plugin.ready");

  const importPromise = bridge.pushPage(sampleManifest());
  const upsert = await inbox.next("page.upsert");
  await new Promise((resolve) => setTimeout(resolve, 35));
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: upsert.page.pageId,
      sourceHash: upsert.page.sourceHash,
      nodeId: "52:1",
      fileKey: "slow-file",
      figmaPageId: "5:1",
      nodes: upsert.page.nodeIds.length,
      nodeMappings: upsert.page.nodeIds.map((pageNodeId, index) => ({
        pageNodeId,
        figmaNodeId: `52:${index + 1}`,
      })),
    },
  }));
  const imported = await importPromise;
  assert.equal(imported.ok, true);
  assert.equal(imported.nodeCount, 2);
});

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
    runtimeVersion: "0.9.0+codex.20260829100031",
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
      protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
      pluginVersion: "0.6.0",
      sessionId: "outdated-session",
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const buildMismatch = await inbox.next("bridge.error");
  assert.equal(buildMismatch.code, "version_mismatch");
  assert.match(buildMismatch.error, /0\.6\.0.*0\.9\.0/);

  socket.send(JSON.stringify({
    type: "plugin.hello",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity("0.9.0+codex.20260825000000"),
    pluginVersion: "0.9.0",
    sessionId: "stale-exact-build",
  }));
  assert.equal((await inbox.next("bridge.error")).code, "runtime_identity_mismatch");

  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 13,
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const legacyMismatch = await inbox.next("bridge.error");
  assert.equal(legacyMismatch.code, "version_mismatch");

  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
      pluginVersion: "0.9.0",
      sessionId: "session-current-only",
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  const ready = await inbox.next("plugin.ready");
  assert.equal(ready.protocolVersion, 16);
  assert.equal(ready.runtimeVersion, "0.9.0+codex.20260829100031");
  assert.equal(ready.localWorkspace, true);
  assert.deepEqual(bridge.status().figmaPluginVersions, ["0.9.0"]);
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
        nodeMappings: [
          { pageNodeId: "root", figmaNodeId: "12:34" },
          { pageNodeId: "headline", figmaNodeId: "12:35" },
        ],
      },
    }),
  );
  const imported = await importPromise;
  assert.equal(imported.nodeCount, upsert.page.nodeIds.length);
  assert.equal(imported.figmaUrl, undefined);
  const importBaseline = await new SyncBaselineStore(projectDir).get("local-preview");
  assert.equal(importBaseline.sourceHash, upsert.page.sourceHash);
  assert.equal(importBaseline.figma.rootNodeId, "12:34");
  assert.equal(importBaseline.pageIr.nodes.headline.content.characters, "Before");
  assert.equal(importBaseline.pageIr.nodes.headline.figma.nodeId, "12:35");
  assert.equal(importBaseline.nodeMappings.find((entry) => entry.pageNodeId === "headline").figmaNodeId, "12:35");

  socket.send(JSON.stringify({
    type: "plugin.hello",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "session-current-only",
    importedAssetIds: [],
    importedPageIds: ["local-preview"],
  }));
  await inbox.next("plugin.ready");
  await inbox.next("page.catalog");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    inbox.count("page.upsert"),
    0,
    "repeated hello on the same connection must not replay imported pages",
  );

  const conflictManifest = sampleManifest();
  conflictManifest.sourceHash = "html-conflict-source";
  conflictManifest.root.style.fill = "#F0F4FF";
  const conflictImport = bridge.pushPage(conflictManifest, {
    conflictResolution: {
      direction: "html",
      transactionId: "conflict-html:bridge-test",
    },
  });
  const conflictUpsert = await inbox.next("page.upsert");
  assert.equal(
    conflictUpsert.page.conflictResolution.transactionId,
    "conflict-html:bridge-test",
  );
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: conflictUpsert.page.pageId,
      nodeId: "12:34",
      fileKey: "test-file",
      nodes: conflictUpsert.page.nodeIds.length,
      sourceHash: upsert.page.sourceHash,
      transactionId: "",
    },
  }));
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: conflictUpsert.page.pageId,
      nodeId: "12:34",
      fileKey: "test-file",
      nodes: conflictUpsert.page.nodeIds.length,
      sourceHash: conflictUpsert.page.sourceHash,
      transactionId: "conflict-html:bridge-test",
    },
  }));
  await conflictImport;
  const conflictBaseline = await new SyncBaselineStore(projectDir).get("local-preview");
  assert.equal(conflictBaseline.sourceHash, conflictUpsert.page.sourceHash);
  assert.equal(conflictBaseline.pageIr.nodes.root.appearance.fill, "#F0F4FF");

  const mismatchedManifest = structuredClone(conflictManifest);
  mismatchedManifest.sourceHash = "html-conflict-source-mismatch";
  mismatchedManifest.root.style.fill = "#F0F4FE";
  const mismatchedConflictImport = bridge.pushPage(mismatchedManifest, {
    conflictResolution: {
      direction: "html",
      transactionId: "conflict-html:bridge-test-mismatch",
    },
  });
  const mismatchedUpsert = await inbox.next("page.upsert");
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: mismatchedUpsert.page.pageId,
      nodeId: "12:34",
      fileKey: "test-file",
      nodes: mismatchedUpsert.page.nodeIds.length,
      sourceHash: mismatchedUpsert.page.sourceHash,
      transactionId: "",
    },
  }));
  await assert.rejects(
    mismatchedConflictImport,
    (error) => error.code === "figma_conflict_transaction_mismatch",
  );
  const preservedBaseline = await new SyncBaselineStore(projectDir).get("local-preview");
  assert.equal(preservedBaseline.sourceHash, conflictBaseline.sourceHash);
  assert.equal(preservedBaseline.pageIr.nodes.root.appearance.fill, "#F0F4FF");
  await bridge.baselineStore.commit({
    pageIr: importBaseline.pageIr,
    sourceHash: importBaseline.sourceHash,
    figma: importBaseline.figma,
    transactionId: importBaseline.transactionId,
  });
  bridge.pages.set(upsert.page.pageId, upsert.page);

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
        protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
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
        protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
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
  let resetCount = 0;
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    projectName: "Music workspace",
    projectKey: "music-project-key",
    onImportPages: async (pageIds) => importedRequests.push(pageIds),
    onResetWorkspace: async () => {
      resetCount += 1;
    },
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
  assert.equal(pairing.projectName, "Music workspace");
  assert.equal(pairing.projectKey, "music-project-key");
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
      protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
      pluginVersion: "0.9.0",
      sessionId: "workspace-session-1234",
      importedAssetIds: [],
      importedPageIds: [],
      changedPageIds: ["settings"],
    }),
  );
  const ready = await inbox.next("plugin.ready");
  assert.equal(ready.projectName, "Music workspace");
  assert.equal(ready.projectKey, "music-project-key");
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

  socket.send(JSON.stringify({ type: "workspace.reset.request" }));
  const reset = await inbox.next("workspace.reset.result");
  assert.equal(reset.ok, true);
  assert.equal(resetCount, 1);
  assert.equal(bridge.status().unsentChanges, false);
  assert.deepEqual(bridge.status().pageStates, []);
});

test("accepts a Figma-first page without importing a Codex page first", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-seed-"));
  const seedHashAfter = "a".repeat(64);
  await writeFile(
    path.join(projectDir, "index.html"),
    '<link rel="stylesheet" href="./styles.css"><main data-codex-root data-codex-id="page-root"><p data-codex-id="figma-seed-placeholder">Waiting</p></main>',
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const bridge = new LocalFigmaBridge(projectDir, {
    port: 0,
    onFastApply: async () => ({ sourceHash: seedHashAfter }),
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
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    pluginVersion: "0.9.0",
    sessionId: "seed-session-1234",
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
      protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
      changeSetId: "seed-change",
      pageId: "seed-page",
      sourceHash: "seed-hash-before",
      responsiveContract: responsiveContract(),
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
            figmaNodeId: "42:1",
            width: 402,
            height: 874,
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
      figma: { fileKey: "figma-seed-file", rootNodeId: "42:1", rootNodeName: "Figma page" },
    },
  }));
  const accepted = await inbox.next("page.changes.ack");
  assert.equal(accepted.state, "applied");
  assert.equal(accepted.sourceHash, seedHashAfter);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.match(source, /data-codex-root data-codex-id="page-root"/);
  assert.doesNotMatch(source, /figma-seed-placeholder/);
  const seedBaseline = await new SyncBaselineStore(projectDir).get("seed-page");
  assert.notEqual(seedBaseline.transactionId, "seed-change");
  assert.equal(seedBaseline.sourceHash, seedHashAfter);
  assert.equal(seedBaseline.pageIr.origin.kind, "figma");
  assert.equal(seedBaseline.figma.fileKey, "figma-seed-file");
  assert.equal(seedBaseline.nodeMappings.find((entry) => entry.pageNodeId === "page-root").figmaNodeId, "42:1");
});

test("preflights complete Figma snapshots with a three-way Page IR merge", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-page-ir-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const baselineManifest = sampleManifest();
  const imageBase64 = Buffer.from("stable-image-resource").toString("base64");
  baselineManifest.nodeIds.push("cover");
  baselineManifest.root.children.push({
    id: "cover",
    type: "image",
    tag: "img",
    name: "Cover",
    width: 160,
    height: 160,
    x: 0,
    y: 80,
    rotation: 0,
    visible: true,
    opacity: 1,
    sourceRef: { file: "cover.png", selector: '[data-codex-id="cover"]' },
    constraints: { horizontal: "MIN", vertical: "MIN" },
    layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
    style: { fill: "#FFFFFF" },
    image: { mimeType: "image/png", base64: imageBase64 },
  });
  const prepared = preparePageManifest({
    json: JSON.stringify(baselineManifest),
    sourcePath: "index.html",
  });
  let htmlManifest = baselineManifest;
  const bridge = new LocalFigmaBridge(projectDir, {
    projectKey: "project-1",
    onCaptureHtmlPage: async () => structuredClone(htmlManifest),
  });
  const mappedBaseline = structuredClone(prepared.pageIr);
  mappedBaseline.nodes.root.figma = { nodeId: "42:17" };
  mappedBaseline.nodes.headline.figma = { nodeId: "42:18" };
  await bridge.baselineStore.commit({
    pageIr: mappedBaseline,
    sourceHash: prepared.sourceHash,
    figma: { fileKey: "figma-file", rootNodeId: "42:17" },
  });
  const seed = pageIrToPageSeedNode(mappedBaseline);
  seed.children[0].text = "From Figma";
  // Compact baselines intentionally exclude resource bytes. A current Figma
  // snapshot supplies them again and must not be overwritten by that compact
  // metadata before Page IR validation.
  seed.children[1].image = { mimeType: "image/png", base64: imageBase64 };
  const changeSet = {
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    changeSetId: "page-ir-change-1",
    pageId: "local-preview",
    sourceHash: prepared.sourceHash,
    changes: [{ nodeId: "headline", property: "characters", to: "From Figma" }],
    figma: { fileKey: "figma-file", rootNodeId: "42:17", rootNodeName: "Root" },
    pageSnapshot: {
      responsiveContract: responsiveContract(1440, 900),
      pageSeed: { node: seed },
      report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
      capturedAt: "2026-08-18T00:00:00.000Z",
    },
  };

  const clean = await bridge.prepareThreeWaySync(changeSet);
  assert.equal(clean.merge.conflicts.length, 0);
  assert.equal(clean.merge.merged.nodes.headline.content.characters, "From Figma");
  assert.equal(clean.figmaPageIr.nodes.cover.resource.bytes, Buffer.byteLength("stable-image-resource"));

  htmlManifest = structuredClone(baselineManifest);
  htmlManifest.root.children[0].text = "From HTML";
  const conflict = await bridge.prepareThreeWaySync(changeSet);
  assert.equal(conflict.merge.conflicts.length, 1);
  assert.equal(conflict.merge.conflicts[0].reason, "concurrent_change");
  assert.match(conflict.conflictRecord.filePath, /\.cdb\/sync-conflicts\/page-ir-change-1\.json$/);
  assert.equal((await bridge.baselineStore.get("local-preview")).pageIr.nodes.headline.content.characters, "Before");
});

test("preserves normalized Page IR across browser capture preparation", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-capture-metadata-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const manifest = sampleManifest();
  const prepared = preparePageManifest({
    json: JSON.stringify(manifest),
    sourcePath: "index.html",
  });
  const normalizedPageIr = structuredClone(prepared.pageIr);
  normalizedPageIr.nodes.root.sourceRef.file = "index.html";
  const bridge = new LocalFigmaBridge(projectDir, {
    onCaptureHtmlPage: async () => ({
      ...manifest,
      pageIr: normalizedPageIr,
    }),
  });

  const captured = await bridge.captureHtmlPageIr("local-preview");
  assert.equal("legacySourceHash" in captured, false);
  assert.equal(captured.pageIr.nodes.root.sourceRef.file, "index.html");
});

test("automatically rolls back a linked-page transaction when HTML readback diverges", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-linked-rollback-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const originalSource = '<link rel="stylesheet" href="./styles.css"><main data-codex-id="root"><span data-codex-id="headline">Before</span></main>';
  await writeFile(path.join(projectDir, "index.html"), originalSource, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const baselineManifest = sampleManifest();
  baselineManifest.root.sourceRef.selector = '[data-codex-id="root"]';
  const divergentManifest = structuredClone(baselineManifest);
  divergentManifest.root.children[0].text = "Unexpected readback";
  const prepared = preparePageManifest({
    json: JSON.stringify(baselineManifest),
    sourcePath: "index.html",
  });
  let captureCount = 0;
  let rollbackResult = null;
  const bridge = new LocalFigmaBridge(projectDir, {
    projectKey: "project-1",
    onCaptureHtmlPage: async () => structuredClone(
      captureCount++ < 2 ? baselineManifest : divergentManifest,
    ),
    onFastApply: async ({ fastApply }) => ({
      fastApply,
      sourceHash: "b".repeat(64),
    }),
    onFastRollback: async (result) => {
      rollbackResult = result;
    },
  });
  bridge.setPageCatalog([{
    id: "local-preview",
    name: "Local preview",
    entry: "index.html",
    route: "/",
    sourceHash: prepared.sourceHash,
    syncState: "synced",
  }]);
  await bridge.baselineStore.commit({
    pageIr: prepared.pageIr,
    sourceHash: prepared.sourceHash,
    figma: { fileKey: "figma-file", rootNodeId: "42:17", rootNodeName: "Root" },
  });
  const seed = pageIrToPageSeedNode(prepared.pageIr);
  seed.children[0].text = "From Figma";

  await assert.rejects(
    bridge.applyDesignPayloadToLinkedPage({
      offer: {
        offerId: "linked-rollback",
        figmaFileKey: "figma-file",
        rootNodeId: "42:17",
        rootName: "Root",
        linkedPageId: "local-preview",
      },
      pageId: "local-preview",
      payload: {
        protocolVersion: 16,
        runtimeIdentity: runtimeIdentity(),
        figma: { pageId: "1:1" },
        pageSeed: { node: seed },
        responsiveContract: responsiveContract(1440, 900),
        report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
      },
    }),
    (error) => error.code === "page_ir_readback_mismatch" && error.rollback?.status === "committed",
  );
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), originalSource);
  assert.equal(rollbackResult.reason, "page_ir_readback_mismatch");
  assert.ok(rollbackResult.rollback.undoneTransactionId);
});

test("automatically rolls back when linked-page HTML readback throws", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-linked-readback-error-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const originalSource = '<main data-codex-id="root"><span data-codex-id="headline">Before</span></main>';
  await writeFile(path.join(projectDir, "index.html"), originalSource, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const baselineManifest = sampleManifest();
  baselineManifest.root.sourceRef.selector = '[data-codex-id="root"]';
  const prepared = preparePageManifest({
    json: JSON.stringify(baselineManifest),
    sourcePath: "index.html",
  });
  let captureCount = 0;
  let rollbackResult = null;
  const bridge = new LocalFigmaBridge(projectDir, {
    projectKey: "project-1",
    onCaptureHtmlPage: async () => {
      if (captureCount++ < 2) return structuredClone(baselineManifest);
      throw new Error("synthetic browser capture failure");
    },
    onFastApply: async ({ fastApply }) => ({
      fastApply,
      sourceHash: "b".repeat(64),
    }),
    onFastRollback: async (result) => {
      rollbackResult = result;
    },
  });
  bridge.setPageCatalog([{
    id: "local-preview",
    name: "Local preview",
    entry: "index.html",
    route: "/",
    sourceHash: prepared.sourceHash,
    syncState: "synced",
  }]);
  await bridge.baselineStore.commit({
    pageIr: prepared.pageIr,
    sourceHash: prepared.sourceHash,
    figma: { fileKey: "figma-file", rootNodeId: "42:17", rootNodeName: "Root" },
  });
  const seed = pageIrToPageSeedNode(prepared.pageIr);
  seed.children[0].text = "From Figma";

  await assert.rejects(
    bridge.applyDesignPayloadToLinkedPage({
      offer: {
        offerId: "linked-readback-error",
        figmaFileKey: "figma-file",
        rootNodeId: "42:17",
        rootName: "Root",
        linkedPageId: "local-preview",
      },
      pageId: "local-preview",
      payload: {
        protocolVersion: 16,
        runtimeIdentity: runtimeIdentity(),
        figma: { pageId: "1:1" },
        pageSeed: { node: seed },
        responsiveContract: responsiveContract(1440, 900),
        report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
      },
    }),
    (error) => error.code === "page_ir_readback_failed" && error.rollback?.status === "committed",
  );
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), originalSource);
  assert.equal(rollbackResult.reason, "page_ir_readback_failed");
  assert.ok(rollbackResult.rollback.undoneTransactionId);
});

test("applies a conflict-free snapshot, verifies HTML readback, and advances the baseline", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-page-ir-apply-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<link rel="stylesheet" href="./styles.css"><main data-codex-id="root"><span data-codex-id="headline">Before</span></main>',
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const baselineManifest = sampleManifest();
  const postManifest = structuredClone(baselineManifest);
  postManifest.root.children[0].text = "From Figma";
  let captureCount = 0;
  let committed = null;
  const bridge = new LocalFigmaBridge(projectDir, {
    projectKey: "project-1",
    onCaptureHtmlPage: async () => structuredClone(captureCount++ === 0 ? baselineManifest : postManifest),
    onFastApply: async ({ fastApply }) => ({ fastApply }),
    onSyncCommitted: async (result) => { committed = result; },
  });
  const prepared = preparePageManifest({
    json: JSON.stringify(baselineManifest),
    sourcePath: "index.html",
  });
  bridge.pages.set(prepared.pageId, prepared);
  await bridge.baselineStore.commit({ pageIr: prepared.pageIr, sourceHash: prepared.sourceHash });
  const seed = pageIrToPageSeedNode(prepared.pageIr);
  seed.children[0].text = "From Figma";
  const sent = [];
  const client = {
    webSocket: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) },
  };
  await bridge.handleMessage(client, Buffer.from(JSON.stringify({
    type: "page.changes.record",
    requestId: "page-ir-request",
    changeSet: {
      protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
      changeSetId: "page-ir-apply-1",
      pageId: "local-preview",
      sourceHash: prepared.sourceHash,
      changes: [{
        nodeId: "headline",
        nodeType: "TEXT",
        property: "characters",
        sourceRef: { file: "index.html", selector: '[data-codex-id="headline"]' },
        from: "Before",
        to: "From Figma",
      }],
      annotations: [],
      figma: { fileKey: "figma-file", rootNodeId: "42:17", rootNodeName: "Root" },
      pageSnapshot: {
        responsiveContract: responsiveContract(1440, 900),
        pageSeed: { node: seed },
        report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
        capturedAt: "2026-08-18T00:00:00.000Z",
      },
    },
  })));

  const ack = sent.find((message) => message.type === "page.changes.ack");
  const expectedPost = preparePageManifest({ json: JSON.stringify(postManifest), sourcePath: "index.html" });
  assert.equal(ack.state, "applied");
  assert.equal(ack.sourceHash, expectedPost.sourceHash);
  assert.equal(committed.pageId, "local-preview");
  assert.equal(committed.sourceHash, expectedPost.sourceHash);
  assert.match(await readFile(path.join(projectDir, "index.html"), "utf8"), />From Figma<\/span>/);
  const baseline = await bridge.baselineStore.get("local-preview");
  assert.equal(baseline.pageIr.nodes.headline.content.characters, "From Figma");
  assert.equal(baseline.sourceHash, expectedPost.sourceHash);
});

test("blocks source writes when HTML and Figma change the same shared Page IR field", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "local-figma-page-ir-conflict-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const sourcePath = path.join(projectDir, "index.html");
  const originalSource = '<main data-codex-id="root"><span data-codex-id="headline">From HTML</span></main>';
  await writeFile(sourcePath, originalSource, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const baselineManifest = sampleManifest();
  const htmlManifest = structuredClone(baselineManifest);
  htmlManifest.root.children[0].text = "From HTML";
  const prepared = preparePageManifest({ json: JSON.stringify(baselineManifest), sourcePath: "index.html" });
  const bridge = new LocalFigmaBridge(projectDir, {
    onCaptureHtmlPage: async () => structuredClone(htmlManifest),
  });
  bridge.pages.set(prepared.pageId, prepared);
  await bridge.baselineStore.commit({ pageIr: prepared.pageIr, sourceHash: prepared.sourceHash });
  const seed = pageIrToPageSeedNode(prepared.pageIr);
  seed.children[0].text = "From Figma";
  const sent = [];
  await bridge.handleMessage(
    { webSocket: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) } },
    Buffer.from(JSON.stringify({
      type: "page.changes.record",
      requestId: "conflict-request",
      changeSet: {
        protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
        changeSetId: "page-ir-conflict-1",
        pageId: "local-preview",
        sourceHash: prepared.sourceHash,
        changes: [{
          nodeId: "headline",
          nodeType: "TEXT",
          property: "characters",
          sourceRef: { file: "index.html", selector: '[data-codex-id="headline"]' },
          from: "Before",
          to: "From Figma",
        }],
        annotations: [],
        figma: { rootNodeId: "42:17", rootNodeName: "Root" },
        pageSnapshot: {
          responsiveContract: responsiveContract(1440, 900),
          pageSeed: { node: seed },
          report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
          capturedAt: "2026-08-18T00:00:00.000Z",
        },
      },
    })),
  );

  const ack = sent.find((message) => message.type === "page.changes.ack");
  assert.equal(ack.state, "pending");
  assert.equal(ack.fastApply.pending[0].reason, "page_ir_conflict");
  assert.equal(await readFile(sourcePath, "utf8"), originalSource);
  assert.equal((await bridge.baselineStore.get("local-preview")).pageIr.nodes.headline.content.characters, "Before");
  assert.equal(
    JSON.parse(await readFile(path.join(projectDir, ".cdb", "sync-conflicts", "page-ir-conflict-1.json"), "utf8")).conflicts.length,
    1,
  );
  const figmaManifest = structuredClone(baselineManifest);
  figmaManifest.root.children[0].text = "From Figma";
  let resolutionCapture = 0;
  bridge.onCaptureHtmlPage = async () => structuredClone(resolutionCapture++ === 0 ? htmlManifest : figmaManifest);
  const resolution = await bridge.resolveThreeWaySync({
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    changeSetId: "page-ir-conflict-1",
    pageId: "local-preview",
    sourceHash: prepared.sourceHash,
    changes: [{
      nodeId: "headline",
      nodeType: "TEXT",
      property: "characters",
      sourceRef: { file: "index.html", selector: '[data-codex-id="headline"]' },
      from: "Before",
      to: "From Figma",
    }],
    annotations: [],
    figma: { rootNodeId: "42:17", rootNodeName: "Root" },
    pageSnapshot: {
      responsiveContract: responsiveContract(1440, 900),
      pageSeed: { node: seed },
      report: { nodeCount: 2, resourceBytes: 0, resourceCount: 0, degradations: [] },
      capturedAt: "2026-08-18T00:00:00.000Z",
    },
  }, "figma");
  assert.equal(resolution.resolution, "figma");
  assert.match(await readFile(sourcePath, "utf8"), />From Figma<\/span>/);
  assert.equal((await bridge.baselineStore.get("local-preview")).pageIr.nodes.headline.content.characters, "From Figma");
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
    count(type) {
      return messages.filter((message) => message.type === type).length;
    },
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
    responsiveContract: responsiveContract(1440, 900),
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
