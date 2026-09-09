import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAGE_IR_RESPONSIVE_IDENTITY,
  PAGE_IR_RESPONSIVE_PROTOCOL_VERSION,
  PAGE_IR_RESPONSIVE_SCHEMA_VERSION,
  RESPONSIVE_ACCEPTANCE_WIDTHS,
  ResponsivePageIrValidationError,
  compactResponsivePageIr,
  createResponsivePageIrFromFigmaPayload,
  diffResponsivePageIr,
  hashResponsivePageIr,
  normalizeResponsivePageIr,
  responsivePageIrToPageSeedNode,
  responsivePageIrPropertyOwner,
  validateResponsivePageIr,
} from "../codex-plugin/codex-design-bridge/shared/page-ir-responsive-v2.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "test/fixtures/page-ir-responsive-v2");
const exactBuild = "0.9.0+codex.20260824090000";

test("freezes the real home and search-explore 0.8 baselines as immutable M0 fixtures", async () => {
  const fixture = JSON.parse(await readFile(path.join(fixtureRoot, "fixture.json"), "utf8"));

  assert.equal(fixture.frozenFromExactBuild, "0.8.0+codex.20260823004648");
  assert.equal(fixture.contract.pageIrBaselineSchemaVersion, 1);
  assert.equal(fixture.contract.targetPageIrSchemaVersion, 2);
  assert.equal(fixture.contract.previewScaleIsDisplayOnly, true);
  assert.equal(fixture.contract.legacyIdentityAccepted, false);
  assert.deepEqual(
    fixture.pages.map(({ name, designViewport, nodeCount, mappingCount }) => ({ name, designViewport, nodeCount, mappingCount })),
    [
      { name: "home", designViewport: { width: 402, height: 874 }, nodeCount: 69, mappingCount: 69 },
      { name: "search-explore", designViewport: { width: 402, height: 905 }, nodeCount: 69, mappingCount: 69 },
    ],
  );

  for (const page of fixture.pages) {
    assert.notEqual(page.figma.rootNodeId, "");
    assert.equal(page.runtimeViewports[0].width, page.designViewport.width);
    assert.equal(page.previewScale.value, 1);
    for (const record of Object.values(page.files)) {
      const bytes = await readFile(path.join(fixtureRoot, record.file));
      assert.equal(bytes.length, record.bytes, record.file);
      assert.equal(sha256(bytes), record.sha256, record.file);
    }
    const screenshot = await readFile(path.join(fixtureRoot, page.files.screenshot.file));
    assert.deepEqual(pngDimensions(screenshot), page.designViewport);
  }
});

test("normalizes Page IR Responsive v2 deterministically without mixing the three viewport concepts", () => {
  const input = sampleIr();
  input.runtimeViewports.reverse();
  const normalized = normalizeResponsivePageIr(input, { expectedExactBuild: exactBuild });

  assert.equal(normalized.schemaVersion, PAGE_IR_RESPONSIVE_SCHEMA_VERSION);
  assert.equal(normalized.protocolVersion, PAGE_IR_RESPONSIVE_PROTOCOL_VERSION);
  assert.equal(normalized.identity.kind, PAGE_IR_RESPONSIVE_IDENTITY);
  assert.deepEqual(normalized.designViewport, { width: 402, height: 874 });
  assert.deepEqual(normalized.runtimeViewports.map(({ width }) => width), [320, 402]);
  assert.deepEqual(normalized.previewScale, { mode: "fit-window", value: 0.75, breakpointId: null });
  assert.equal(normalized.breakpoints[0].overrides.title.sizing.horizontal.mode, "fill");
  assert.equal(normalized.nodes.title.textFlow.overflow, "ellipsis");
  assert.equal(normalized.irHash, hashResponsivePageIr(normalized, { expectedExactBuild: exactBuild }));
  assert.equal(validateResponsivePageIr(normalized, { expectedExactBuild: exactBuild }), true);

  const tampered = structuredClone(normalized);
  tampered.nodes.title.geometry.width += 1;
  assert.throws(() => validateResponsivePageIr(tampered), /hash does not match/u);
});

test("creates Responsive v2 directly from a protocol 16 Figma payload without a v1 migration", () => {
  const payload = {
    protocolVersion: 16,
    offerId: "offer-responsive",
    runtimeIdentity: {
      kind: "cdb-0.9-responsive-v2",
      protocolVersion: 16,
      pageIrSchemaVersion: 2,
      exactBuild,
    },
    figma: { fileKey: "figma-file", rootNodeId: "42:1", rootNodeName: "Responsive" },
    responsiveContract: {
      designViewport: { width: 402, height: 874 },
      runtimeViewports: [{ id: "mobile-402", width: 402, height: 874, devicePixelRatio: 1 }],
      previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
      breakpoints: [],
    },
    pageSeed: {
      node: {
        id: "root",
        type: "frame",
        tag: "main",
        name: "Responsive",
        figmaNodeId: "42:1",
        width: 402,
        height: 874,
        constraints: { horizontal: "MIN", vertical: "MIN" },
        layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
        layout: { kind: "flex", direction: "vertical", itemSpacing: 16, counterAxisSpacing: 0 },
        children: [{
          id: "title",
          type: "text",
          tag: "h1",
          name: "Title",
          width: 300,
          height: 40,
          text: "Responsive title",
          textTruncation: "ENDING",
          maxLines: 1,
          textAutoResize: "NONE",
          constraints: { horizontal: "STRETCH", vertical: "MIN" },
          layoutItem: { horizontalSizing: "fill", verticalSizing: "hug" },
        }],
      },
    },
    report: { degradations: [] },
  };

  const pageIr = createResponsivePageIrFromFigmaPayload(payload, {
    pageId: "responsive-page",
    projectKey: "project-09",
    exactBuild,
  });
  assert.equal(pageIr.schemaVersion, 2);
  assert.equal(pageIr.nodes.title.sizing.horizontal.mode, "fill");
  assert.equal(pageIr.nodes.title.sizing.vertical.mode, "hug");
  assert.deepEqual(pageIr.nodes.title.constraints, { horizontal: "STRETCH", vertical: "MIN" });
  assert.deepEqual(pageIr.nodes.title.textFlow, {
    wrap: "no-wrap",
    overflow: "ellipsis",
    autoHeight: false,
    fallbackFamilies: [],
  });
  const seed = responsivePageIrToPageSeedNode(pageIr);
  assert.equal(seed.layout.itemSpacing, 16);
  assert.equal(seed.layout.counterAxisSpacing, 0);
  assert.deepEqual(seed.children[0].layoutItem, {
    horizontalSizing: "fill",
    verticalSizing: "hug",
    align: "stretch",
  });
  assert.equal(compactResponsivePageIr(pageIr).irHash, pageIr.irHash);

  const withoutContract = structuredClone(payload);
  delete withoutContract.responsiveContract;
  assert.throws(
    () => createResponsivePageIrFromFigmaPayload(withoutContract, { exactBuild }),
    /missing responsiveContract/u,
  );
});

test("keeps display-only preview scale out of the semantic hash while reporting it as a system diff", () => {
  const before = normalizeResponsivePageIr(sampleIr());
  const after = structuredClone(before);
  after.previewScale = { mode: "one-to-one", value: 1, breakpointId: null };

  assert.equal(hashResponsivePageIr(before), hashResponsivePageIr(after));
  assert.deepEqual(
    diffResponsivePageIr(before, after).map(({ pointer, owner }) => ({ pointer, owner })),
    [
      { pointer: "/previewScale/mode", owner: "system" },
      { pointer: "/previewScale/value", owner: "system" },
    ],
  );
});

test("assigns HTML, Figma, Shared, and System ownership to responsive fields", () => {
  const before = normalizeResponsivePageIr(sampleIr());
  const after = structuredClone(before);
  after.designViewport.width = 430;
  after.runtimeViewports[0].height = 700;
  after.nodes.title.sizing.horizontal.max = 360;
  after.identity.exactBuild = "0.9.0+codex.20260824090001";

  assert.equal(responsivePageIrPropertyOwner("/designViewport/width"), "figma");
  assert.equal(responsivePageIrPropertyOwner("/runtimeViewports/0/height"), "html");
  assert.equal(responsivePageIrPropertyOwner("/nodes/title/sizing/horizontal/max"), "shared");
  assert.equal(responsivePageIrPropertyOwner("/identity/exactBuild"), "system");
  assert.throws(() => diffResponsivePageIr(before, after), /exact build identity differs/u);
});

test("rejects Page IR v1, protocol 15, legacy exact builds, and mismatched exact caches", () => {
  const v1 = sampleIr();
  v1.schemaVersion = 1;
  assert.throws(() => normalizeResponsivePageIr(v1), /schema 2 is required/u);

  const protocol15 = sampleIr();
  protocol15.protocolVersion = 15;
  assert.throws(() => normalizeResponsivePageIr(protocol15), /protocol 16 is required/u);

  const oldBuild = sampleIr();
  oldBuild.identity.exactBuild = "0.8.0+codex.20260823004648";
  assert.throws(() => normalizeResponsivePageIr(oldBuild), /0\.9 cachebuster identity/u);

  assert.throws(
    () => normalizeResponsivePageIr(sampleIr(), { expectedExactBuild: "0.9.0+codex.20260824090001" }),
    /does not match/u,
  );
});

test("fails closed when supported nodes omit adaptation semantics", () => {
  for (const field of ["sizing", "constraints", "overflow"]) {
    const input = sampleIr();
    input.nodes.title[field] = null;
    assert.throws(
      () => normalizeResponsivePageIr(input),
      /supported nodes require explicit sizing, constraints, and overflow/u,
      field,
    );
  }

  const missingTextFlow = sampleIr();
  missingTextFlow.nodes.title.textFlow = null;
  assert.throws(() => normalizeResponsivePageIr(missingTextFlow), /supported text requires explicit textFlow/u);
});

test("accepts an explicit unsupported node but never invents missing sizing or constraints", () => {
  const input = sampleIr();
  input.nodes.title.adaptation = { status: "unsupported", reason: "runtime DOM measurement is not deterministic" };
  input.nodes.title.sizing = null;
  input.nodes.title.constraints = null;
  input.nodes.title.overflow = null;
  input.nodes.title.textFlow = null;
  input.degradations.push({
    nodeId: "title",
    reason: "unsupported_responsive_semantics",
    message: "Runtime DOM measurement is outside the static Page IR contract.",
  });

  const normalized = normalizeResponsivePageIr(input);
  assert.equal(normalized.nodes.title.adaptation.status, "unsupported");
  assert.equal(normalized.nodes.title.sizing, null);
  assert.equal(normalized.nodes.title.constraints, null);
});

test("requires explicit, non-overlapping breakpoint ranges and known node overrides", () => {
  const overlapping = sampleIr();
  overlapping.breakpoints.push({
    id: "wide-mobile",
    minWidth: 399,
    maxWidth: 430,
    viewport: { width: 430, height: 874 },
    overrides: {},
  });
  assert.throws(() => normalizeResponsivePageIr(overlapping), /breakpoint ranges must not overlap/u);

  const unknownNode = sampleIr();
  unknownNode.breakpoints[0].overrides.missing = {
    sizing: fixedSizing(),
  };
  assert.throws(() => normalizeResponsivePageIr(unknownNode), /unknown node/u);

  const unsupportedWidth = sampleIr();
  unsupportedWidth.runtimeViewports[0].width = 390;
  assert.throws(() => normalizeResponsivePageIr(unsupportedWidth), /outside the 0\.9 acceptance contract/u);
  assert.deepEqual(RESPONSIVE_ACCEPTANCE_WIDTHS, [320, 375, 402, 430, 768, 1440]);
});

test("keeps all six acceptance widths stable for ten Figma/Page IR round trips", () => {
  for (const width of RESPONSIVE_ACCEPTANCE_WIDTHS) {
    const height = width <= 430 ? 874 : width === 768 ? 1024 : 900;
    const responsiveContract = {
      designViewport: { width, height },
      runtimeViewports: [{ id: `acceptance-${width}`, width, height, devicePixelRatio: 1 }],
      previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
      breakpoints: [],
    };
    let pageIr = createResponsivePageIrFromFigmaPayload({
      protocolVersion: 16,
      offerId: `offer-${width}`,
      runtimeIdentity: {
        kind: "cdb-0.9-responsive-v2",
        protocolVersion: 16,
        pageIrSchemaVersion: 2,
        exactBuild,
      },
      figma: {
        fileKey: "figma-six-widths",
        rootNodeId: `42:${width}`,
        rootNodeName: `Acceptance ${width}`,
      },
      responsiveContract,
      pageSeed: {
        node: {
          id: "root",
          type: "frame",
          tag: "main",
          name: `Acceptance ${width}`,
          figmaNodeId: `42:${width}`,
          width,
          height,
          style: { fill: "#ffffff", cornerRadius: 0 },
          constraints: { horizontal: "MIN", vertical: "MIN" },
          layoutItem: { horizontalSizing: "fixed", verticalSizing: "fixed" },
          layout: { kind: "flex", direction: "vertical", itemSpacing: 16 },
          children: [{
            id: "title",
            type: "text",
            tag: "h1",
            name: "Title",
            width: Math.min(320, width - 32),
            height: 44,
            text: `Acceptance ${width}`,
            constraints: { horizontal: "STRETCH", vertical: "MIN" },
            layoutItem: { horizontalSizing: "fill", verticalSizing: "hug" },
            textTruncation: "ENDING",
            maxLines: 1,
            textAutoResize: "HEIGHT",
          }],
        },
      },
      report: { degradations: [] },
    }, {
      pageId: `acceptance-${width}`,
      projectKey: "six-width-project",
      exactBuild,
    });
    const initialHash = pageIr.irHash;
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      const node = responsivePageIrToPageSeedNode(pageIr);
      const next = createResponsivePageIrFromFigmaPayload({
        protocolVersion: 16,
        offerId: `offer-${width}`,
        runtimeIdentity: {
          kind: "cdb-0.9-responsive-v2",
          protocolVersion: 16,
          pageIrSchemaVersion: 2,
          exactBuild,
        },
        figma: {
          fileKey: "figma-six-widths",
          rootNodeId: `42:${width}`,
          rootNodeName: `Acceptance ${width}`,
        },
        responsiveContract,
        pageSeed: { node },
        report: { degradations: [] },
      }, {
        pageId: `acceptance-${width}`,
        projectKey: "six-width-project",
        exactBuild,
      });
      assert.deepEqual(diffResponsivePageIr(pageIr, next), [], `width ${width}, cycle ${cycle}`);
      assert.equal(next.irHash, initialHash, `width ${width}, cycle ${cycle}`);
      pageIr = next;
    }
  }
});

test("publishes schema ownership annotations and exact v2 identity constants", async () => {
  const schema = JSON.parse(await readFile(
    path.join(repoRoot, "codex-plugin/codex-design-bridge/shared/page-ir-responsive-v2.schema.json"),
    "utf8",
  ));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(schema.properties.protocolVersion.const, 16);
  assert.equal(schema.$defs.identity.properties.kind.const, PAGE_IR_RESPONSIVE_IDENTITY);
  assert.equal(schema.properties.designViewport["x-cdb-owner"], "figma");
  assert.equal(schema.properties.runtimeViewports["x-cdb-owner"], "html");
  assert.equal(schema.properties.previewScale["x-cdb-owner"], "system");
  assert.equal(schema.$defs.node.properties.sizing["x-cdb-owner"], "shared");
});

function sampleIr() {
  return {
    schemaVersion: 2,
    protocolVersion: 16,
    identity: { kind: PAGE_IR_RESPONSIVE_IDENTITY, generation: "0.9", exactBuild },
    pageId: "responsive-page",
    projectKey: "project-09",
    name: "Responsive page",
    rootId: "root",
    origin: {
      kind: "mixed",
      figmaFileKey: "figma-file",
      rootNodeId: "42:1",
      rootNodeName: "Responsive page",
      sourceFile: "index.html",
      sourceSelector: "[data-codex-id=\"root\"]",
    },
    designViewport: { width: 402, height: 874 },
    runtimeViewports: [
      { id: "mobile-402", width: 402, height: 874, devicePixelRatio: 1 },
      { id: "mobile-320", width: 320, height: 700, devicePixelRatio: 1 },
    ],
    previewScale: { mode: "fit-window", value: 0.75, breakpointId: null },
    breakpoints: [{
      id: "compact",
      minWidth: 0,
      maxWidth: 399,
      viewport: { width: 320, height: 700 },
      overrides: {
        title: {
          sizing: {
            horizontal: { mode: "fill", min: 0, max: null },
            vertical: { mode: "hug", min: null, max: null },
            aspectRatio: null,
          },
          constraints: { horizontal: "STRETCH", vertical: "MIN" },
        },
      },
    }],
    nodes: {
      root: baseNode({
        id: "root",
        type: "frame",
        tag: "main",
        name: "Root",
        parentId: null,
        order: 0,
        childIds: ["title"],
        width: 402,
        height: 874,
        sizing: fixedSizing(),
      }),
      title: baseNode({
        id: "title",
        type: "text",
        tag: "h1",
        name: "Title",
        parentId: "root",
        order: 0,
        childIds: [],
        width: 300,
        height: 40,
        sizing: {
          horizontal: { mode: "hug", min: null, max: 380 },
          vertical: { mode: "hug", min: null, max: null },
          aspectRatio: null,
        },
        textFlow: { wrap: "no-wrap", overflow: "ellipsis", autoHeight: true, fallbackFamilies: ["Arial"] },
      }),
    },
    degradations: [],
  };
}

function baseNode({ id, type, tag, name, parentId, order, childIds, width, height, sizing, textFlow = null }) {
  return {
    id,
    type,
    tag,
    name,
    parentId,
    order,
    childIds,
    sourceRef: { file: "index.html", selector: `[data-codex-id="${id}"]`, component: "" },
    semantics: {},
    interaction: {},
    figma: { nodeId: "", componentKey: "", componentSetKey: "" },
    geometry: { width, height, x: 0, y: 0, rotation: 0 },
    visibility: { visible: true, opacity: 1, clipsContent: false },
    appearance: {},
    layout: type === "frame" ? { kind: "flex", direction: "vertical" } : null,
    content: type === "text" ? { characters: "Responsive title" } : null,
    resource: null,
    adaptation: { status: "supported", reason: "" },
    sizing,
    constraints: { horizontal: "MIN", vertical: "MIN" },
    overflow: { x: "hidden", y: "hidden" },
    textFlow,
  };
}

function fixedSizing() {
  return {
    horizontal: { mode: "fixed", min: null, max: null },
    vertical: { mode: "fixed", min: null, max: null },
    aspectRatio: null,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
