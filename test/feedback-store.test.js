import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FeedbackStore } from "../src/feedback-store.js";
import { prepareSvgAsset } from "../src/svg.js";

test("routes matching feedback to inbox and stale feedback to conflicts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-sync-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  const sourcePath = path.join(assets, "sample.svg");
  const original =
    '<svg viewBox="0 0 10 10"><rect id="box" data-figma-sync="target" width="10" height="10" fill="#fff"/></svg>';
  await writeFile(sourcePath, original);
  const prepared = prepareSvgAsset({
    svg: original,
    assetId: "sample.svg",
    sourcePath: "assets/sample.svg",
  });
  const registryEntry = { absolutePath: sourcePath, prepared };
  const store = new FeedbackStore(root);
  const feedback = {
    assetId: "sample.svg",
    sourceHash: prepared.sourceHash,
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
  };

  const pending = await store.record(feedback, registryEntry);
  assert.equal(pending.isConflict, false);
  assert.equal(pending.envelope.protocolVersion, 2);
  assert.equal(pending.envelope.state, "pending");

  await writeFile(sourcePath, original.replace("#fff", "#eee"));
  const conflict = await store.record(
    { ...feedback, feedbackId: "stale-feedback" },
    registryEntry,
  );
  assert.equal(conflict.isConflict, true);
  assert.equal(conflict.envelope.state, "conflict");
  assert.notEqual(
    conflict.envelope.source.expectedHash,
    conflict.envelope.source.currentHash,
  );

  const listed = await store.list();
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.conflicts.length, 1);
});

test("rejects feedback for an element outside the registered asset", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-sync-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "sample.svg");
  const svg =
    '<svg viewBox="0 0 10 10"><rect id="box" data-figma-sync="target" width="10" height="10"/></svg>';
  await writeFile(sourcePath, svg);
  const prepared = prepareSvgAsset({
    svg,
    assetId: "sample.svg",
    sourcePath: "sample.svg",
  });

  await assert.rejects(
    () =>
      new FeedbackStore(root).record(
        {
          assetId: "sample.svg",
          sourceHash: prepared.sourceHash,
          elementId: "other",
          kind: "annotations",
          annotations: [],
        },
        { absolutePath: sourcePath, prepared },
      ),
    /Unknown element/,
  );
});
