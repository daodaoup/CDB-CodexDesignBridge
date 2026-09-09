import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesignOfferStore,
  validateDesignOffer,
} from "../codex-plugin/codex-design-bridge/mcp/design-offer-store.mjs";

test("stores protocol 16 offers atomically and restores only the current exact identity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-offers-"));
  const filePath = path.join(directory, "offers.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(filePath);

  const first = await store.receive(sampleOffer());
  assert.equal(first.duplicate, false);
  assert.equal(first.offer.state, "pending");
  const duplicate = await store.receive(sampleOffer());
  assert.equal(duplicate.duplicate, true);
  assert.equal((await store.list()).length, 1);

  await store.transition("offer-12345678", "accepted", {
    target: { action: "create_project", workspaceDir: "/tmp/designs" },
  });
  const restored = new DesignOfferStore(filePath);
  assert.equal((await restored.get("offer-12345678")).state, "accepted");
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).protocolVersion, 16);
});

test("rejects conflicting, unsupported, and oversized offers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-offers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(path.join(directory, "offers.json"));
  await store.receive(sampleOffer());
  await assert.rejects(
    store.receive({ ...sampleOffer(), rootNodeId: "99:2" }),
    (error) => error.code === "offer_identity_conflict",
  );
  assert.throws(
    () => validateDesignOffer({ ...sampleOffer(), rootType: "TEXT" }),
    (error) => error.code === "unsupported_root",
  );
  assert.throws(
    () => validateDesignOffer({ ...sampleOffer(), estimatedNodeCount: 501 }),
    (error) => error.code === "node_limit_exceeded",
  );
});

test("rejects protocol 15 messages and old recovery stores without migration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-offers-old-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(
    () => validateDesignOffer({ ...sampleOffer(), protocolVersion: 15 }),
    (error) => error.code === "version_mismatch",
  );
  const filePath = path.join(directory, "offers.json");
  await writeFile(filePath, JSON.stringify({ protocolVersion: 15, offers: [] }), "utf8");
  await assert.rejects(
    new DesignOfferStore(filePath).load(),
    (error) => error.code === "store_identity_mismatch",
  );
});

test("keeps only the newest pending offer for the same Figma root", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-offers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(path.join(directory, "offers.json"));
  await store.receive(sampleOffer());

  const latest = await store.receive({
    ...sampleOffer(),
    offerId: "offer-87654321",
    sessionId: "session-87654321",
    createdAt: "2026-08-12T00:01:00.000Z",
  });

  assert.equal(latest.duplicate, false);
  assert.equal((await store.get("offer-12345678")).state, "ignored");
  assert.deepEqual(
    (await store.list()).map((offer) => offer.offerId),
    ["offer-87654321"],
  );
});

test("stores a validated page payload once and rejects identity changes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-payloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(path.join(directory, "offers.json"));
  await store.receive(sampleOffer());
  await store.transition("offer-12345678", "accepted", {
    target: { action: "create_project" },
  });
  const payload = samplePayload();
  const first = await store.receivePayload(payload);
  assert.equal(first.duplicate, false);
  assert.equal(first.offer.state, "payload_received");
  assert.equal(first.offer.payloadSummary.resourceCount, 0);
  assert.equal(first.offer.payloadSummary.pageId, "offer-12345678");
  assert.match(first.offer.payloadSummary.pageIrHash, /^[a-f0-9]{64}$/);
  assert.match(first.offer.payloadPath, /offers-payloads/);
  const storedPayload = JSON.parse(await readFile(first.offer.payloadPath, "utf8"));
  assert.equal(storedPayload.pageIr.schemaVersion, 2);
  assert.equal(Object.keys(storedPayload.pageIr.nodes).length, 1);
  assert.equal((await store.receivePayload(payload)).duplicate, true);
  await assert.rejects(
    store.receivePayload({
      ...payload,
      pageSeed: { node: { ...payload.pageSeed.node, name: "Changed" } },
    }),
    (error) => error.code === "payload_identity_conflict",
  );
});

test("creates a fresh page identity even when the Figma root still has an old link", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-payloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(path.join(directory, "offers.json"));
  await store.receive({
    ...sampleOffer(),
    linkedProjectKey: "old-project-key",
    linkedPageId: "old-page-id",
  });
  await store.transition("offer-12345678", "accepted", {
    target: { action: "create_project" },
  });

  const received = await store.receivePayload(samplePayload());
  const storedPayload = JSON.parse(await readFile(received.offer.payloadPath, "utf8"));
  assert.equal(storedPayload.pageIr.pageId, "offer-12345678");
  assert.equal(storedPayload.pageIr.projectKey, "");
  assert.equal(received.offer.payloadSummary.pageId, "offer-12345678");
});

test("rejects a payload whose node report does not match Page IR", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdb-payloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesignOfferStore(path.join(directory, "offers.json"));
  await store.receive(sampleOffer());
  await store.transition("offer-12345678", "accepted", { target: { action: "create_project" } });
  const payload = samplePayload();
  payload.report.nodeCount = 2;

  await assert.rejects(store.receivePayload(payload), (error) => error.code === "node_report_mismatch");
});

function sampleOffer() {
  return {
    type: "figma.design.offer",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    offerId: "offer-12345678",
    sessionId: "session-12345678",
    figmaFileKey: "figma-file",
    rootNodeId: "42:17",
    rootName: "首页",
    rootType: "FRAME",
    width: 402,
    height: 874,
    responsiveContract: responsiveContract(),
    estimatedNodeCount: 107,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function samplePayload() {
  return {
    type: "figma.design.payload",
    protocolVersion: 16,
    runtimeIdentity: runtimeIdentity(),
    offerId: "offer-12345678",
    sessionId: "session-12345678",
    figma: { rootNodeId: "42:17", rootNodeName: "首页" },
    pageSeed: {
      node: {
        id: "page-root",
        type: "frame",
        name: "首页",
        width: 402,
        height: 874,
        constraints: { horizontal: "MIN", vertical: "MIN" },
        layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
        layout: { kind: "none", direction: "none" },
        children: [],
      },
    },
    referenceImage: sampleVisualReference(),
    responsiveContract: responsiveContract(),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: "2026-08-12T00:01:00.000Z",
  };
}

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

function runtimeIdentity(exactBuild = "0.9.0+codex.20260829100031") {
  return {
    kind: "cdb-0.9-responsive-v2",
    protocolVersion: 16,
    pageIrSchemaVersion: 2,
    exactBuild,
  };
}

function responsiveContract() {
  return {
    designViewport: { width: 402, height: 874 },
    runtimeViewports: [{ id: "figma-402", width: 402, height: 874, devicePixelRatio: 1 }],
    previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
    breakpoints: [],
  };
}
