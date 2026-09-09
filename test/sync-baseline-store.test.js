import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResponsivePageIrFromNodeTree } from "../codex-plugin/codex-design-bridge/shared/page-ir-responsive-v2.mjs";
import { SyncBaselineStore } from "../codex-plugin/codex-design-bridge/mcp/sync-baseline-store.mjs";

test("persists compact, validated Page IR as the common sync baseline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  const committed = await store.commit({
    pageIr: sampleIr(),
    sourceHash: "a".repeat(64),
    figma: { fileKey: "figma-file", rootNodeId: "42:17" },
    transactionId: "tx-1",
  });
  const restored = await store.get("landing-page");
  const raw = JSON.parse(await readFile(store.pathFor("landing-page"), "utf8"));

  assert.equal(committed.pageIrHash, restored.pageIrHash);
  assert.equal(restored.sourceHash, "a".repeat(64));
  assert.equal(restored.figma.rootNodeId, "42:17");
  assert.equal(raw.pageIr.nodes.icon.resource.base64, undefined);
  assert.equal(raw.pageIr.nodes.icon.resource.bytes > 0, true);
  assert.equal(raw.baselineVersion, 2);
  assert.equal(raw.pageIrSchemaVersion, 2);
  assert.equal(raw.runtimeIdentity.protocolVersion, 16);
});

test("keeps the previous baseline when a three-way merge conflicts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  const baseline = sampleIr();
  await store.commit({ pageIr: baseline, sourceHash: "a".repeat(64) });
  const html = structuredClone(baseline);
  const figma = structuredClone(baseline);
  html.nodes.title.content.characters = "HTML";
  figma.nodes.title.content.characters = "Figma";

  const result = await store.merge({
    pageId: "landing-page",
    htmlPageIr: html,
    figmaPageIr: figma,
    commit: true,
    sourceHash: "b".repeat(64),
  });
  const restored = await store.get("landing-page");

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, "concurrent_change");
  assert.equal(restored.sourceHash, "a".repeat(64));
  assert.equal(restored.pageIr.nodes.title.content.characters, "Hello");
});

test("commits a conflict-free three-way merge", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  const baseline = sampleIr();
  await store.commit({ pageIr: baseline, sourceHash: "a".repeat(64) });
  const html = structuredClone(baseline);
  const figma = structuredClone(baseline);
  html.nodes.title.tag = "h1";
  figma.nodes.title.name = "Figma title";

  const result = await store.merge({
    pageId: "landing-page",
    htmlPageIr: html,
    figmaPageIr: figma,
    commit: true,
    sourceHash: "b".repeat(64),
  });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.baseline.sourceHash, "b".repeat(64));
  assert.equal(result.baseline.pageIr.nodes.title.tag, "h1");
  assert.equal(result.baseline.pageIr.nodes.title.name, "Figma title");
});

test("rejects a tampered baseline instead of silently trusting it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  await store.commit({ pageIr: sampleIr() });
  const filePath = store.pathFor("landing-page");
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  raw.pageIr.nodes.title.content.characters = "tampered";
  await writeFile(filePath, JSON.stringify(raw), "utf8");

  await assert.rejects(store.get("landing-page"), (error) => error.code === "baseline_hash_mismatch");
});

test("rejects protocol 15 and v1 baseline records without migration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  await store.commit({ pageIr: sampleIr() });
  const filePath = store.pathFor("landing-page");
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  raw.baselineVersion = 1;
  raw.pageIrSchemaVersion = 1;
  raw.runtimeIdentity.protocolVersion = 15;
  await writeFile(filePath, JSON.stringify(raw), "utf8");
  await assert.rejects(
    store.get("landing-page"),
    (error) => error.code === "baseline_version_mismatch",
  );
});

test("replaces an incompatible baseline on a fresh current-build commit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  await store.commit({ pageIr: sampleIr(), sourceHash: "a".repeat(64) });
  const filePath = store.pathFor("landing-page");
  const stale = JSON.parse(await readFile(filePath, "utf8"));
  stale.runtimeIdentity.exactBuild = "0.9.0+codex.20260801000000";
  stale.sourceHash = "a".repeat(64);
  await writeFile(filePath, JSON.stringify(stale), "utf8");
  await assert.rejects(
    store.get("landing-page"),
    (error) => error.code === "baseline_version_mismatch",
  );

  const replacement = sampleIr();
  replacement.nodes.title.content.characters = "Fresh current build";
  const committed = await store.commit({
    pageIr: replacement,
    sourceHash: "b".repeat(64),
  });
  const restored = await store.get("landing-page");
  assert.equal(committed.sourceHash, "b".repeat(64));
  assert.equal(restored.pageIr.nodes.title.content.characters, "Fresh current build");
});

test("marks a persisted field conflict as explicitly resolved", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SyncBaselineStore(directory);
  const baseline = sampleIr();
  const html = structuredClone(baseline);
  const figma = structuredClone(baseline);
  html.nodes.title.content.characters = "HTML";
  figma.nodes.title.content.characters = "Figma";
  const conflict = await store.recordConflicts({
    changeSetId: "change-1",
    changeSetPath: ".figma-sync/workspace-changes/change-1.json",
    pageId: "landing-page",
    baseline: { pageIrHash: baseline.irHash },
    htmlPageIr: html,
    figmaPageIr: figma,
    conflicts: [{ pointer: "/nodes/title/content/characters", html: "HTML", figma: "Figma" }],
  });
  assert.equal(
    JSON.parse(await readFile(conflict.filePath, "utf8")).changeSetPath,
    ".figma-sync/workspace-changes/change-1.json",
  );

  const copied = await store.markConflictCopied(conflict.filePath, {
    copyPageId: "landing-page-figma-copy",
    transactionId: "tx-copy",
  });
  assert.equal(copied.status, undefined);
  assert.deepEqual(copied.copies[0], {
    pageId: "landing-page-figma-copy",
    transactionId: "tx-copy",
    copiedAt: copied.copies[0].copiedAt,
  });

  const resolved = await store.markConflictResolved(conflict.filePath, {
    resolution: "figma",
    transactionId: "tx-1",
    rollbackBaseline: {
      pageIr: baseline,
      sourceHash: "a".repeat(64),
      figma: { fileKey: "figma-file", rootNodeId: "root-node" },
      transactionId: "baseline-before",
    },
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution, "figma");
  assert.equal(resolved.transactionId, "tx-1");
  assert.equal(resolved.rollbackBaseline.pageIr.pageId, "landing-page");

  const reopened = await store.reopenConflict(conflict.filePath, {
    undoTransactionId: "tx-undo",
  });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.undoTransactionId, "tx-undo");
  assert.equal(reopened.resolvedAt, undefined);

  const resolvedHtml = await store.markConflictResolved(conflict.filePath, {
    resolution: "html",
    transactionId: "tx-html",
    rollbackBaseline: {
      pageIr: baseline,
      sourceHash: "a".repeat(64),
      figma: { fileKey: "figma-file", rootNodeId: "root-node" },
      transactionId: "baseline-before",
    },
  });
  assert.equal(resolvedHtml.resolution, "html");
  const reopenedHtml = await store.reopenConflict(conflict.filePath, {
    undoTransactionId: "tx-html-undo",
    expectedResolution: "html",
  });
  assert.equal(reopenedHtml.status, "open");
  assert.equal(reopenedHtml.undoTransactionId, "tx-html-undo");
});

function sampleIr() {
  const svg = Buffer.from("<svg viewBox='0 0 1 1'/>").toString("base64");
  return createResponsivePageIrFromNodeTree({
    pageId: "landing-page",
    projectKey: "project-1",
    name: "Landing",
    origin: { kind: "mixed", sourceFile: "index.html", figmaFileKey: "figma-file" },
    responsiveContract: {
      designViewport: { width: 402, height: 874 },
      runtimeViewports: [{ id: "mobile-402", width: 402, height: 874, devicePixelRatio: 1 }],
      previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
      breakpoints: [],
    },
    root: {
      id: "root",
      type: "frame",
      width: 402,
      height: 874,
      constraints: { horizontal: "MIN", vertical: "MIN" },
      layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
      layout: { kind: "flex", direction: "vertical" },
      children: [
        {
          id: "title", type: "text", width: 300, height: 60, text: "Hello",
          style: { fill: "#FFFFFF" },
          constraints: { horizontal: "STRETCH", vertical: "MIN" },
          layoutItem: { horizontalSizing: "fill", verticalSizing: "hug" },
          textAutoResize: "HEIGHT",
        },
        {
          id: "icon", type: "svg", width: 20, height: 20,
          constraints: { horizontal: "MIN", vertical: "MIN" },
          layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
          svg: { mimeType: "image/svg+xml", base64: svg },
        },
      ],
    },
  });
}
