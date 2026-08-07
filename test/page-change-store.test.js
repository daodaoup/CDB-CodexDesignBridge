import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PageChangeStore } from "../src/page-change-store.js";
import { preparePageManifest } from "../src/page.js";

test("stores matching page ChangeSets and conflicts without overwriting source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-page-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pages = path.join(root, "pages");
  await mkdir(pages);
  const sourcePath = path.join(pages, "page.figma-page.json");
  const original = JSON.stringify(pageManifest());
  await writeFile(sourcePath, original);
  const registryEntry = {
    absolutePath: sourcePath,
    prepared: preparePageManifest({
      json: original,
      sourcePath: "pages/page.figma-page.json",
    }),
  };
  const store = new PageChangeStore(root);
  const changeSet = {
    changeSetId: "change-set-1",
    pageId: "sample-page",
    sourceHash: registryEntry.prepared.sourceHash,
    changes: [
      {
        nodeId: "title",
        category: "text",
        property: "fontSize",
        from: 32,
        to: 40,
      },
    ],
    annotations: [],
  };

  const pending = await store.record(changeSet, registryEntry);
  assert.equal(pending.envelope.protocolVersion, 3);
  assert.equal(pending.envelope.state, "pending");

  await writeFile(sourcePath, original.replace("Hello", "Changed source"));
  const conflict = await store.record(
    { ...changeSet, changeSetId: "change-set-2" },
    registryEntry,
  );
  assert.equal(conflict.envelope.state, "conflict");
  assert.notEqual(
    conflict.envelope.page.expectedHash,
    conflict.envelope.page.currentHash,
  );

  await assert.rejects(
    () =>
      store.record(
        {
          ...changeSet,
          changes: [{ nodeId: "unknown", property: "width", to: 100 }],
        },
        registryEntry,
      ),
    /Unknown page node/,
  );
});

function pageManifest() {
  return {
    pageId: "sample-page",
    root: {
      id: "root",
      type: "frame",
      width: 800,
      height: 600,
      children: [
        {
          id: "title",
          type: "text",
          width: 400,
          height: 60,
          text: "Hello",
          style: { fill: "#111111" },
        },
      ],
    },
  };
}
