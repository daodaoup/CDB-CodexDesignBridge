import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("development manifest and UI use Figma-compatible localhost URLs", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../plugin/manifest.json", import.meta.url), "utf8"),
  );
  const ui = await readFile(
    new URL("../plugin/ui.html", import.meta.url),
    "utf8",
  );
  const codexManifest = JSON.parse(
    await readFile(
      new URL(
        "../codex-plugin/codex-design-bridge/.codex-plugin/plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const formalVersion = codexManifest.version.split("+")[0];

  assert.deepEqual(manifest.networkAccess.devAllowedDomains, [
    "http://localhost:9847",
    "ws://localhost:9847",
  ]);
  assert.equal(manifest.name, "CDB");
  assert.match(ui, /发送修改给 Codex/);
  assert.match(ui, /http:\/\/localhost:9847\/api\/pair/);
  assert.match(ui, /ws:\/\/localhost:9847\/ws/);
  assert.equal(ui.match(/<button\b/g)?.length, 3);
  assert.match(ui, /用选中稿创建页面/);
  assert.match(ui, /id="reset-workspace"/);
  assert.match(ui, /Codex 项目、源码和 Figma 画布内容都会保持原样/);
  assert.doesNotMatch(ui, /<h1\b/);
  assert.doesNotMatch(ui, /在 Figma 中调整细节/);
  assert.match(ui, new RegExp(`FIGMA_PLUGIN_VERSION = "${formalVersion}"`));
  assert.match(ui, /当前唯一活动工作台/);
  assert.doesNotMatch(ui, /定位 Frame/);
  assert.doesNotMatch(ui, /导入当前/);
  assert.doesNotMatch(ui, /导入选中/);
  assert.doesNotMatch(ui, /更新全部/);
  assert.match(ui, /两边均有修改/);
  assert.match(ui, /源码和 Figma 在上次同步后都发生了修改/);
  assert.doesNotMatch(ui, /Connection token|Bridge WebSocket|<details/);
  assert.doesNotMatch(ui, /127\.0\.0\.1/);
  assert.doesNotMatch(ui, /localStorage/);
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "plugin UI script is present");
  assert.doesNotThrow(() => new vm.Script(script));
});

test("plugin UI auto-connects and reports a fast update without settings UI", async () => {
  const ui = await readFile(
    new URL("../plugin/ui.html", import.meta.url),
    "utf8",
  );
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const elements = new Map(
    [
      "capture",
      "seed-page",
      "status-dot",
      "status-text",
      "status-detail",
      "result",
      "catalog-list",
      "catalog-count",
      "reset-workspace",
      "page-count",
      "asset-count",
      "feedback-count",
      "log",
    ].map((id) => [id, new MockElement()]),
  );
  const sockets = [];
  const parentMessages = [];

  class MockWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }

    close() {}

    send(value) {
      this.lastSent = value;
    }
  }

  const window = { confirm: () => true };
  vm.runInNewContext(script, {
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      createElement() {
        return new MockElement();
      },
    },
    window,
    parent: {
      postMessage(message) {
        parentMessages.push(message);
      },
    },
    WebSocket: MockWebSocket,
    setTimeout,
    clearTimeout,
    console,
  });

  window.onmessage({
    data: {
      pluginMessage: {
        type: "plugin.settings",
        endpoint: "ws://localhost:9847/ws",
        token: "a".repeat(48),
      },
    },
  });
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /^ws:\/\/localhost:9847\/ws\?token=/);
  assert.ok(
    parentMessages.some(
      (message) => message.pluginMessage?.type === "settings.save",
    ),
  );
  sockets[0].readyState = MockWebSocket.OPEN;
  sockets[0].onopen();
  assert.equal(elements.get("status-text").textContent, "已连接 · Codex");
  assert.equal(
    JSON.parse(sockets[0].lastSent).type,
    "plugin.hello",
  );
  assert.equal(JSON.parse(sockets[0].lastSent).protocolVersion, 14);
  assert.equal(JSON.parse(sockets[0].lastSent).pluginVersion, "0.7.0");
  elements.get("capture").disabled = true;
  elements.get("capture").textContent = "Codex 正在更新…";
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "plugin.ready",
      projectName: "frontend",
      codexRunner: { runningTaskId: null, queued: 0 },
    }),
  });
  assert.equal(elements.get("capture").disabled, false);
  assert.equal(elements.get("capture").textContent, "发送设计给 Codex");
  assert.equal(elements.get("status-text").textContent, "已连接 · frontend");
  elements.get("capture").dispatch("click");
  assert.ok(
    parentMessages.some(
      (message) => message.pluginMessage?.type === "design.capture",
    ),
  );
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "plugin.ready",
      projectName: "frontend",
      localWorkspace: true,
    }),
  });
  assert.equal(
    elements.get("capture").textContent,
    "发送修改给 Codex",
  );
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "page.catalog",
      pages: [{
        id: "preview-page",
        name: "Preview",
        entry: "index.html",
        route: "/",
        state: "synced",
      }],
    }),
  });
  assert.equal(elements.get("catalog-count").textContent, "frontend · 1 个");
  assert.equal(elements.get("catalog-list").children.length, 1);
  elements.get("capture").dispatch("click");
  assert.ok(
    parentMessages.some(
      (message) => message.pluginMessage?.type === "review.capture",
    ),
  );
  window.onmessage({
    data: {
      pluginMessage: {
        type: "page.result",
        ok: true,
        pageId: "preview-page",
        nodes: 12,
      },
    },
  });
  assert.equal(
    JSON.parse(sockets[0].lastSent).type,
    "page.import.result",
  );
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "page.changes.ack",
      pageId: "preview-page",
      sourceHash: "preview-hash",
      changeSetId: "change-1",
      path: ".figma-sync/workspace-changes/change-1.json",
      fastApply: {
        appliedCount: 2,
        pendingCount: 0,
        changedFiles: ["src/App.css"],
        durationMs: 240,
      },
    }),
  });
  assert.ok(
    parentMessages.some(
      (message) =>
        message.pluginMessage?.type === "page.changes.accepted" &&
        message.pluginMessage.pageId === "preview-page",
    ),
  );
  assert.equal(elements.get("status-text").textContent, "已更新 2 处修改");
  assert.equal(elements.get("status-detail").textContent, "Codex 页面代码已经保存");
  assert.match(elements.get("result").textContent, /src\/App\.css · 0\.2 秒/);
  elements.get("reset-workspace").dispatch("click");
  assert.equal(JSON.parse(sockets[0].lastSent).type, "workspace.reset.request");
  sockets[0].onmessage({
    data: JSON.stringify({ type: "workspace.reset.result", ok: true }),
  });
  assert.ok(
    parentMessages.some(
      (message) => message.pluginMessage?.type === "workspace.reset",
    ),
  );
  window.onmessage({
    data: { pluginMessage: { type: "workspace.reset.complete" } },
  });
  assert.equal(elements.get("catalog-count").textContent, "frontend · 0 个");
  assert.equal(elements.get("catalog-list").children.length, 1);
  assert.match(
    elements.get("catalog-list").children[0].textContent,
    /当前项目没有可用页面/,
  );
  assert.equal(elements.get("status-text").textContent, "已连接 · frontend");
  assert.match(elements.get("status-detail").textContent, /Codex 项目仍保持打开/);
  assert.equal(elements.get("capture").disabled, true);
  assert.equal(elements.get("reset-workspace").disabled, true);
});

test("Figma plugin handles SVG feedback and hybrid page ChangeSets without destructive refreshes", async () => {
  const source = await readFile(new URL("../plugin/code.js", import.meta.url), "utf8");
  const messages = [];
  const callbacks = new Map();
  const zoomedNodes = [];
  const page = new MockNode("PAGE", "Review");
  page.selection = [];
  const figma = {
    root: new MockNode("DOCUMENT", "Document"),
    currentPage: page,
    fileKey: "test-file-key",
    mixed: Symbol("mixed"),
    base64Encode(bytes) {
      return Buffer.from(bytes).toString("base64");
    },
    viewport: {
      center: { x: 500, y: 400 },
      scrollAndZoomIntoView(nodes) {
        zoomedNodes.push(...nodes);
      },
    },
    ui: {
      onmessage: null,
      postMessage(message) {
        messages.push(message);
      },
    },
    clientStorage: {
      async getAsync() {
        return undefined;
      },
      async setAsync() {},
    },
    showUI() {},
    async loadAllPagesAsync() {},
    on(type, callback) {
      callbacks.set(type, callback);
    },
    createFrame() {
      const frame = new MockNode("FRAME", "Frame");
      figma.currentPage.appendChild(frame);
      return frame;
    },
    createText() {
      const text = new MockNode("TEXT", "Text");
      figma.currentPage.appendChild(text);
      return text;
    },
    createRectangle() {
      const rectangle = new MockNode("RECTANGLE", "Rectangle");
      figma.currentPage.appendChild(rectangle);
      return rectangle;
    },
    base64Decode(value) {
      return new Uint8Array(Buffer.from(value, "base64"));
    },
    createImage(bytes) {
      return { hash: `image-${bytes.length}` };
    },
    async loadFontAsync() {},
    createNodeFromSvg(fragment) {
      if (fragment.includes("__FAIL__")) {
        throw new Error("Synthetic import failure");
      }
      const frame = new MockNode("FRAME", "Imported");
      const vector = new MockNode("VECTOR", "Vector");
      vector.fills = [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1 },
          opacity: 1,
          visible: true,
        },
      ];
      vector.strokes = [];
      vector.strokeWeight = 1;
      vector.strokeCap = "NONE";
      vector.strokeJoin = "MITER";
      vector.strokeMiterLimit = 4;
      vector.dashPattern = [];
      vector.cornerRadius = 0;
      const text = new MockNode("TEXT", "Label");
      text.characters = "Review";
      text.fontName = { family: "Inter", style: "Regular" };
      text.fontSize = 16;
      text.lineHeight = { unit: "AUTO" };
      text.letterSpacing = { unit: "PIXELS", value: 0 };
      text.textAlignHorizontal = "LEFT";
      text.textAlignVertical = "TOP";
      text.textCase = "ORIGINAL";
      text.textDecoration = "NONE";
      frame.appendChild(vector);
      frame.appendChild(text);
      figma.currentPage.appendChild(frame);
      return frame;
    },
  };
  figma.root.appendChild(page);
  const legacyPageRoot = new MockNode("FRAME", "Legacy imported page");
  legacyPageRoot.setPluginData("figmaSyncRole", "page-root");
  legacyPageRoot.setPluginData("figmaSyncPageId", "legacy-page");
  legacyPageRoot.setPluginData("figmaSyncPageNodeId", "legacy-root");
  legacyPageRoot.setPluginData("figmaSyncSourceHash", "legacy-hash");
  legacyPageRoot.setPluginData(
    "figmaSyncPageSourceRef",
    JSON.stringify({ selector: '[data-codex-id="legacy-root"]' }),
  );
  const legacyStar = new MockNode("STAR", "Existing custom star");
  legacyStar.x = 80;
  legacyStar.y = 120;
  legacyStar.width = 96;
  legacyStar.height = 84;
  legacyStar.exportedSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 84"><path id="existing-star" d="M48 0L60 30L96 33L68 54L78 84L48 66L18 84L28 54L0 33L36 30Z"/></svg>';
  legacyPageRoot.appendChild(legacyStar);
  page.appendChild(legacyPageRoot);

  vm.runInNewContext(source, {
    figma,
    __html__: "<html></html>",
    setTimeout,
    clearTimeout,
    console,
  });
  await waitFor(() => typeof figma.ui.onmessage === "function");
  assert.notEqual(
    legacyPageRoot.getPluginData("figmaSyncPageBaseline"),
    "",
  );
  const migrationChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  legacyPageRoot.x += 120;
  legacyPageRoot.y += 80;
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > migrationChangeSetCount,
  );
  const migrationChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  assert.ok(
    migrationChangeSet.changes.some(
      (change) =>
        change.nodeId === "legacy-root" &&
        change.property === "svgInsert" &&
        Buffer.from(change.to.base64, "base64")
          .toString("utf8")
          .includes('id="existing-star"'),
    ),
  );
  assert.equal(
    migrationChangeSet.changes.some(
      (change) =>
        change.nodeId === "legacy-root" && ["x", "y"].includes(change.property),
    ),
    false,
  );
  legacyPageRoot.remove();

  const first = asset("hash-1", "<svg/>");
  figma.ui.onmessage({ type: "asset.upsert", asset: first });
  await waitFor(() => messages.some((message) => message.type === "asset.result"));
  let root = findAssetRoot(page);
  assert.ok(root);
  assert.equal(root.x, 450);
  assert.equal(root.y, 375);
  assert.equal(findTarget(root).getPluginData("figmaSyncElementId"), "box");

  root.x = 123;
  root.y = 234;
  findTarget(root).annotations = [{ label: "Increase contrast" }];
  const firstRoot = root;

  figma.ui.onmessage({ type: "asset.upsert", asset: asset("hash-2", "<svg/>") });
  await waitFor(
    () =>
      messages.filter(
        (message) => message.type === "asset.result" && message.ok,
      ).length === 2,
  );
  root = findAssetRoot(page);
  assert.notEqual(root, firstRoot);
  assert.equal(firstRoot.removed, true);
  assert.equal(root.x, 123);
  assert.equal(root.y, 234);
  assert.deepEqual(plain(findTarget(root).annotations), [
    { label: "Increase contrast" },
  ]);

  const stableRoot = root;
  figma.ui.onmessage({
    type: "asset.upsert",
    asset: asset("hash-3", "__FAIL__"),
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "asset.result" &&
        message.sourceHash !== "hash-2" &&
        message.ok === false,
    ),
  );
  assert.equal(findAssetRoot(page), stableRoot);
  assert.equal(stableRoot.removed, false);

  await delay(850);
  const target = findTarget(stableRoot);
  const carrier = target.children[0];
  carrier.fills = [
    {
      type: "SOLID",
      color: { r: 0, g: 0.4, b: 1 },
      opacity: 1,
      visible: true,
    },
  ];
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: carrier,
        properties: ["fills"],
        origin: "LOCAL",
      },
    ],
  });

  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "feedback.emit" && message.feedback.kind === "properties",
    ),
  );
  const feedback = messages.find(
    (message) =>
      message.type === "feedback.emit" && message.feedback.kind === "properties",
  ).feedback;
  assert.equal(feedback.assetId, "sample.svg");
  assert.equal(feedback.sourceHash, "hash-2");
  assert.equal(feedback.elementId, "box");
  assert.equal(feedback.changes[0].category, "appearance");
  assert.equal(feedback.changes[0].nodeId, carrier.id);
  assert.equal(feedback.changes[0].nodeType, "VECTOR");
  assert.deepEqual(plain(feedback.changes[0].from), {
    color: "#FFFFFF",
    opacity: 1,
  });
  assert.deepEqual(plain(feedback.changes[0].to), {
    color: "#0066FF",
    opacity: 1,
  });

  const styleFeedbackCount = messages.filter(
    (message) =>
      message.type === "feedback.emit" && message.feedback.kind === "properties",
  ).length;
  carrier.strokes = [
    {
      type: "SOLID",
      color: { r: 1, g: 0.2, b: 0.1 },
      opacity: 0.75,
      visible: true,
    },
  ];
  carrier.strokeWeight = 3;
  carrier.strokeCap = "ROUND";
  carrier.strokeJoin = "BEVEL";
  carrier.strokeMiterLimit = 7;
  carrier.dashPattern = [8, 4];
  carrier.opacity = 0.6;
  carrier.visible = false;
  carrier.x = 12;
  carrier.y = 18;
  carrier.resize(120, 60);
  carrier.rotation = 15;
  carrier.cornerRadius = 8;
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: carrier,
        properties: [
          "strokes",
          "strokeWeight",
          "strokeCap",
          "strokeJoin",
          "strokeMiterLimit",
          "dashPattern",
          "opacity",
          "visible",
          "x",
          "y",
          "width",
          "height",
          "rotation",
          "cornerRadius",
        ],
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "feedback.emit" &&
          message.feedback.kind === "properties",
      ).length > styleFeedbackCount,
  );
  const expandedStyleFeedback = messages
    .filter(
      (message) =>
        message.type === "feedback.emit" &&
        message.feedback.kind === "properties",
    )
    .at(-1).feedback;
  assert.deepEqual(
    plain(
      expandedStyleFeedback.changes
        .map((change) => change.property)
        .sort(),
    ),
    [
      "cornerRadius",
      "dashPattern",
      "height",
      "opacity",
      "rotation",
      "stroke",
      "strokeCap",
      "strokeJoin",
      "strokeMiterLimit",
      "strokeWeight",
      "visible",
      "width",
      "x",
      "y",
    ],
  );
  assert.deepEqual(
    plain(
      expandedStyleFeedback.changes.find(
        (change) => change.property === "stroke",
      ).to,
    ),
    { color: "#FF331A", opacity: 0.75 },
  );
  assert.equal(
    expandedStyleFeedback.changes.find(
      (change) => change.property === "strokeWeight",
    ).to,
    3,
  );
  assert.equal(
    expandedStyleFeedback.changes.find(
      (change) => change.property === "opacity",
    ).to,
    0.6,
  );
  assert.equal(
    expandedStyleFeedback.changes.find(
      (change) => change.property === "cornerRadius",
    ).category,
    "geometry",
  );
  assert.deepEqual(
    plain(
      expandedStyleFeedback.changes.find(
        (change) => change.property === "dashPattern",
      ).to,
    ),
    [8, 4],
  );

  const propertyFeedbackCount = messages.filter(
    (message) =>
      message.type === "feedback.emit" && message.feedback.kind === "properties",
  ).length;
  const text = target.children[1];
  text.characters = "Approved";
  text.fontName = { family: "Inter", style: "Bold" };
  text.fontSize = 20;
  text.lineHeight = { unit: "PIXELS", value: 28 };
  text.letterSpacing = { unit: "PERCENT", value: 2 };
  text.textAlignHorizontal = "CENTER";
  text.textDecoration = "UNDERLINE";
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: text,
        properties: [
          "characters",
          "fontName",
          "fontSize",
          "lineHeight",
          "letterSpacing",
          "textAlignHorizontal",
          "textDecoration",
        ],
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "feedback.emit" &&
          message.feedback.kind === "properties",
      ).length > propertyFeedbackCount,
  );
  const textFeedback = messages
    .filter(
      (message) =>
        message.type === "feedback.emit" &&
        message.feedback.kind === "properties",
    )
    .at(-1).feedback;
  assert.ok(textFeedback.changes.every((change) => change.category === "text"));
  assert.equal(
    textFeedback.changes.find((change) => change.property === "characters").to,
    "Approved",
  );
  assert.deepEqual(
    plain(
      textFeedback.changes.find((change) => change.property === "fontName").to,
    ),
    { family: "Inter", style: "Bold" },
  );
  assert.deepEqual(
    plain(
      textFeedback.changes.find((change) => change.property === "lineHeight").to,
    ),
    { unit: "PIXELS", value: 28 },
  );

  const annotationFeedbackCount = messages.filter(
    (message) =>
      message.type === "feedback.emit" &&
      message.feedback.kind === "annotations",
  ).length;
  target.annotations = [
    ...target.annotations,
    { label: "Use the approved contrast token" },
  ];
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: target,
        properties: ["annotations"],
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "feedback.emit" &&
          message.feedback.kind === "annotations",
      ).length > annotationFeedbackCount,
  );
  const annotationFeedback = messages
    .filter(
      (message) =>
        message.type === "feedback.emit" &&
        message.feedback.kind === "annotations",
    )
    .at(-1).feedback;
  assert.equal(annotationFeedback.elementId, "box");
  assert.equal(annotationFeedback.changes.length, 0);
  assert.ok(
    annotationFeedback.annotations.some(
      (annotation) =>
        annotation.label === "Use the approved contrast token" &&
        annotation.attachedNodeId === target.id,
    ),
  );

  carrier.opacity = 0.4;
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: carrier,
        properties: ["opacity"],
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({
    type: "asset.upsert",
    asset: asset("hash-4", "<svg/>"),
  });
  await waitFor(
    () =>
      messages.filter(
        (message) => message.type === "asset.result" && message.ok,
      ).length === 3,
  );
  await delay(300);
  assert.equal(target.removed, true);

  figma.ui.onmessage({
    type: "page.upsert",
    page: pageManifest("page-hash-1"),
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.result" &&
        message.pageId === "landing-page" &&
        message.ok,
    ),
  );
  let pageRoot = findImportedPageRoot(page);
  assert.ok(pageRoot);
  const currentAssetRoot = findAssetRoot(page);
  assert.ok(
    pageRoot.x >= currentAssetRoot.x + currentAssetRoot.width + 160,
  );
  assert.equal(pageRoot.y, currentAssetRoot.y);
  assert.equal(pageRoot.layoutMode, "VERTICAL");
  assert.equal(pageRoot.itemSpacing, 24);
  assert.equal(pageRoot.layoutWrap, "WRAP");
  assert.equal(pageRoot.counterAxisSpacing, 12);
  assert.equal(pageRoot.strokes.length, 1);
  const secondaryCta = findImportedPageNode(pageRoot, "secondary-cta");
  assert.equal(secondaryCta.layoutAlign, "STRETCH");
  assert.equal(secondaryCta.layoutGrow, 1);
  assert.equal(secondaryCta.layoutSizingHorizontal, "FILL");
  const heroPhoto = findImportedPageNode(pageRoot, "hero-photo");
  assert.equal(heroPhoto.type, "RECTANGLE");
  assert.equal(heroPhoto.fills[0].type, "IMAGE");
  assert.equal(heroPhoto.fills[0].scaleMode, "FILL");
  assert.deepEqual(
    Array.from(secondaryCta.fills, (paint) => paint.type),
    ["GRADIENT_LINEAR", "SOLID"],
  );
  assert.equal(secondaryCta.fills[0].gradientStops[0].color.a, 1);
  assert.equal(secondaryCta.effects[0].offset.x, 0);
  assert.equal(secondaryCta.effects[0].offset.y, 8);
  assert.equal(secondaryCta.effects[0].radius, 18);
  assert.equal(secondaryCta.effects[1].type, "BACKGROUND_BLUR");
  assert.equal(secondaryCta.effects[1].radius, 22);
  assert.equal(secondaryCta.strokeTopWeight, 1);
  assert.equal(secondaryCta.strokeRightWeight, 0);
  assert.equal(secondaryCta.strokeBottomWeight, 0);
  assert.equal(secondaryCta.strokeLeftWeight, 0);
  let titleNode = findImportedPageNode(pageRoot, "hero-title");
  assert.equal(titleNode.type, "TEXT");
  assert.equal(titleNode.characters, "Built by Codex");
  assert.equal(titleNode.fontSize, 48);

  titleNode.setPluginData("figmaSyncPageBaseline", "");
  titleNode.setPluginData("figmaSyncPageAnnotationBaseline", "");
  figma.ui.onmessage({
    type: "page.upsert",
    page: pageManifest("page-hash-1"),
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "page.result" &&
          message.pageId === "landing-page" &&
          message.ok,
      ).length === 2,
  );
  assert.notEqual(titleNode.getPluginData("figmaSyncPageBaseline"), "");
  assert.notEqual(
    titleNode.getPluginData("figmaSyncPageAnnotationBaseline"),
    "",
  );

  pageRoot.itemSpacing = 40;
  pageRoot.layoutWrap = "NO_WRAP";
  pageRoot.counterAxisSpacing = 20;
  pageRoot.primaryAxisSizingMode = "AUTO";
  pageRoot.strokes = [];
  secondaryCta.layoutGrow = 0.5;
  titleNode.fills = [
    {
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      opacity: 1,
      visible: true,
    },
  ];
  titleNode.fontSize = 56;
  titleNode.resize(620, 104);
  titleNode.opacity = 0.72;
  titleNode.fontName = { family: "Inter", style: "Semi Bold Italic" };
  titleNode.lineHeight = { unit: "PIXELS", value: 64 };
  titleNode.letterSpacing = { unit: "PERCENT", value: 2 };
  titleNode.textAlignHorizontal = "CENTER";
  titleNode.textAlignVertical = "BOTTOM";
  titleNode.textCase = "UPPER";
  titleNode.textDecoration = "UNDERLINE";
  titleNode.annotations = [{ label: "Match the production heading scale" }];
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: pageRoot,
        properties: [
          "itemSpacing",
          "layoutWrap",
          "counterAxisSpacing",
          "primaryAxisSizingMode",
          "strokes",
        ],
        origin: "LOCAL",
      },
      {
        type: "PROPERTY_CHANGE",
        node: secondaryCta,
        properties: ["layoutGrow"],
        origin: "LOCAL",
      },
      {
        type: "PROPERTY_CHANGE",
        node: titleNode,
        properties: [
          "fills",
          "width",
          "height",
          "opacity",
          "fontName",
          "fontSize",
          "lineHeight",
          "letterSpacing",
          "textAlignHorizontal",
          "textAlignVertical",
          "textCase",
          "textDecoration",
          "annotations",
        ],
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.changes.status" &&
        message.unsentChanges === true,
    ),
  );
  const protectedRoot = pageRoot;
  const protectedResultCount = messages.filter(
    (message) => message.type === "page.result",
  ).length;
  figma.ui.onmessage({
    type: "page.upsert",
    page: pageManifest("page-hash-conflict"),
  });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.result").length >
      protectedResultCount,
  );
  const protectedResult = messages
    .filter((message) => message.type === "page.result")
    .at(-1);
  assert.equal(protectedResult.ok, false);
  assert.equal(protectedResult.code, "unsent_figma_changes");
  assert.equal(findImportedPageRoot(page), protectedRoot);
  assert.equal(protectedRoot.getPluginData("figmaSyncSourceHash"), "page-hash-1");
  const initialPageChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > initialPageChangeSetCount,
  );
  const pageChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.changes.complete" && message.count === 1,
    ),
  );
  assert.equal(pageChangeSet.pageId, "landing-page");
  assert.equal(pageChangeSet.protocolVersion, 14);
  assert.ok(
    pageChangeSet.changes.some(
      (change) =>
        change.nodeId === "landing-root" &&
        change.category === "layout" &&
        change.property === "itemSpacing" &&
        change.to === 40,
    ),
  );
  for (const [nodeId, property, expected] of [
    ["landing-root", "layoutWrap", "NO_WRAP"],
    ["landing-root", "counterAxisSpacing", 20],
    ["landing-root", "primaryAxisSizingMode", "AUTO"],
    ["secondary-cta", "layoutGrow", 0.5],
  ]) {
    assert.ok(
      pageChangeSet.changes.some(
        (change) =>
          change.nodeId === nodeId &&
          change.category === "layout" &&
          change.property === property &&
          change.to === expected &&
          change.layoutContext,
      ),
      `expected ${nodeId}.${property} to be captured`,
    );
  }
  for (const [property, expected] of [
    ["width", 620],
    ["height", 104],
    ["opacity", 0.72],
    ["fontName", { family: "Inter", style: "Semi Bold Italic" }],
    ["lineHeight", { unit: "PIXELS", value: 64 }],
    ["letterSpacing", { unit: "PERCENT", value: 2 }],
    ["textAlignHorizontal", "CENTER"],
    ["textAlignVertical", "BOTTOM"],
    ["textCase", "UPPER"],
    ["textDecoration", "UNDERLINE"],
  ]) {
    assert.ok(
      pageChangeSet.changes.some(
        (change) =>
          change.nodeId === "hero-title" &&
          change.property === property &&
          JSON.stringify(change.to) === JSON.stringify(expected),
      ),
      `expected ${property} to be captured`,
    );
  }
  assert.ok(
    pageChangeSet.changes.some(
      (change) =>
        change.nodeId === "landing-root" &&
        change.category === "appearance" &&
        change.property === "stroke" &&
        change.to === null &&
        change.strokeWeight === 1,
    ),
  );
  assert.ok(
    pageChangeSet.changes.some(
      (change) =>
        change.nodeId === "hero-title" &&
        change.category === "appearance" &&
        change.property === "fill" &&
        change.to.color === "#FF0000",
    ),
  );
  assert.ok(
    pageChangeSet.changes.some(
      (change) =>
        change.nodeId === "hero-title" &&
        change.category === "text" &&
        change.property === "fontSize" &&
        change.to === 56 &&
        change.sourceRef.selector === "[data-codex-id='hero-title']",
    ),
  );
  assert.equal(pageChangeSet.annotations[0].nodeId, "hero-title");

  const emittedChangeSets = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const cleanStatusCount = messages.filter(
    (message) =>
      message.type === "page.changes.status" &&
      message.unsentChanges === false,
  ).length;
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });
  await waitFor(() =>
    messages.filter(
      (message) =>
        message.type === "page.changes.status" &&
        message.unsentChanges === false,
    ).length > cleanStatusCount,
  );
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(() =>
    messages.some((message) => message.type === "page.changes.empty"),
  );
  assert.equal(
    messages.filter((message) => message.type === "page.changes.emit").length,
    emittedChangeSets,
  );

  const vectorInsertChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const insertedStar = new MockNode("STAR", "Custom star");
  insertedStar.x = 180;
  insertedStar.y = 420;
  insertedStar.width = 160;
  insertedStar.height = 140;
  insertedStar.rotation = 12;
  insertedStar.exportedSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 140"><path id="custom-star" d="M80 0L100 50L160 55L115 90L130 140L80 110L30 140L45 90L0 55L60 50Z" fill="#FFE32C"/></svg>';
  pageRoot.appendChild(insertedStar);
  const insertedGroup = new MockNode("GROUP", "Custom vector group");
  insertedGroup.x = 420;
  insertedGroup.y = 410;
  insertedGroup.width = 220;
  insertedGroup.height = 150;
  const groupedPath = new MockNode("VECTOR", "Grouped path");
  const groupedRectangle = new MockNode("RECTANGLE", "Grouped rectangle");
  const groupedLabel = new MockNode("TEXT", "Grouped label");
  groupedLabel.characters = "Mixed SVG";
  insertedGroup.appendChild(groupedPath);
  insertedGroup.appendChild(groupedRectangle);
  insertedGroup.appendChild(groupedLabel);
  insertedGroup.exportedSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 150"><rect id="group-rect" width="90" height="70"/><path id="group-path" d="M20 120L110 20L200 120Z"/><text id="group-label" x="24" y="138">Mixed SVG</text></svg>';
  pageRoot.appendChild(insertedGroup);
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "CREATE",
        node: insertedStar,
        origin: "LOCAL",
      },
      {
        type: "CREATE",
        node: insertedGroup,
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > vectorInsertChangeSetCount,
  );
  const vectorInsertChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const vectorInserts = vectorInsertChangeSet.changes.filter(
    (change) =>
      change.nodeId === "landing-root" &&
      change.category === "vector" &&
      change.property === "svgInsert",
  );
  assert.equal(vectorInserts.length, 2);
  const vectorInsert = vectorInserts.find(
    (change) => change.nodeName === "Custom star",
  );
  assert.ok(vectorInsert);
  assert.equal(
    vectorInsert.sourceRef.selector,
    "[data-codex-id='landing-root']",
  );
  assert.match(vectorInsert.to.elementId, /^figma-svg-/);
  assert.equal(vectorInsert.to.name, "Custom star");
  assert.equal(vectorInsert.to.x, 180);
  assert.equal(vectorInsert.to.y, 420);
  assert.equal(vectorInsert.to.width, 160);
  assert.equal(vectorInsert.to.height, 140);
  assert.equal(vectorInsert.to.rotation, 12);
  assert.match(
    Buffer.from(vectorInsert.to.base64, "base64").toString("utf8"),
    /id="custom-star"/,
  );
  const groupInsert = vectorInserts.find(
    (change) => change.nodeName === "Custom vector group",
  );
  assert.ok(groupInsert);
  assert.match(
    Buffer.from(groupInsert.to.base64, "base64").toString("utf8"),
    /id="group-rect".*id="group-path".*id="group-label"/,
  );
  assert.ok(
    !vectorInsertChangeSet.changes.some(
      (change) => change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const structureChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const newSection = new MockNode("FRAME", "New section");
  pageRoot.appendChild(newSection);
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "CREATE",
        node: newSection,
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.changes.status" &&
        message.unsentChanges === true,
    ),
  );
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > structureChangeSetCount,
  );
  const structureChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  assert.ok(
    structureChangeSet.changes.some(
      (change) =>
        change.category === "structure" &&
        change.property === "nodeInsert" &&
        change.nodeName === "New section" &&
        change.to.node.type === "frame" &&
        change.to.node.id === newSection.getPluginData("figmaSyncPageNodeId"),
    ),
  );
  assert.match(
    newSection.getPluginData("figmaSyncPageNodeId"),
    /^figma-node-/,
  );
  assert.ok(
    !structureChangeSet.changes.some(
      (change) => change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const genericInsertChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const insertedButton = new MockNode("FRAME", "Checkout button");
  insertedButton.resize(220, 56);
  insertedButton.layoutMode = "HORIZONTAL";
  insertedButton.itemSpacing = 8;
  insertedButton.paddingTop = 8;
  insertedButton.paddingRight = 16;
  insertedButton.paddingBottom = 8;
  insertedButton.paddingLeft = 16;
  insertedButton.primaryAxisAlignItems = "CENTER";
  insertedButton.counterAxisAlignItems = "CENTER";
  insertedButton.fills = [
    {
      type: "SOLID",
      color: { r: 1, g: 0.9, b: 0.34 },
      opacity: 1,
      visible: true,
    },
  ];
  insertedButton.cornerRadius = 18;
  const insertedButtonLabel = new MockNode("TEXT", "Checkout label");
  insertedButtonLabel.resize(100, 24);
  insertedButtonLabel.characters = "Checkout";
  insertedButtonLabel.fontName = { family: "Inter", style: "Bold" };
  insertedButtonLabel.fontSize = 16;
  insertedButtonLabel.lineHeight = { unit: "PIXELS", value: 24 };
  insertedButtonLabel.letterSpacing = { unit: "PIXELS", value: 0 };
  insertedButtonLabel.textAlignHorizontal = "CENTER";
  insertedButtonLabel.textAlignVertical = "CENTER";
  insertedButtonLabel.textCase = "ORIGINAL";
  insertedButtonLabel.textDecoration = "NONE";
  insertedButtonLabel.fills = [
    {
      type: "SOLID",
      color: { r: 0.07, g: 0.07, b: 0.07 },
      opacity: 1,
      visible: true,
    },
  ];
  const insertedButtonImage = new MockNode("RECTANGLE", "Checkout icon");
  insertedButtonImage.resize(16, 16);
  insertedButtonImage.fills = [
    {
      type: "IMAGE",
      imageHash: "mock-image",
      scaleMode: "FILL",
      visible: true,
    },
  ];
  insertedButton.appendChild(insertedButtonLabel);
  insertedButton.appendChild(insertedButtonImage);
  pageRoot.appendChild(insertedButton);
  callbacks.get("documentchange")({
    documentChanges: [
      { type: "CREATE", node: insertedButton, origin: "LOCAL" },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > genericInsertChangeSetCount,
  );
  const genericInsertChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const genericInsert = genericInsertChangeSet.changes.find(
    (change) =>
      change.property === "nodeInsert" &&
      change.nodeName === "Checkout button",
  );
  assert.ok(genericInsert);
  assert.equal(genericInsert.to.node.tag, "button");
  assert.deepEqual(
    plain(genericInsert.to.node.children.map((child) => child.type)),
    ["text", "image"],
  );
  assert.equal(genericInsert.to.node.children[0].text, "Checkout");
  assert.equal(genericInsert.to.node.children[1].image.mimeType, "image/png");
  assert.ok(
    genericInsertChangeSet.changes.some(
      (change) =>
        change.property === "nodeReorder" &&
        change.to.children.some(
          (child) => child.nodeId === genericInsert.to.node.id,
        ),
    ),
  );
  assert.ok(
    !genericInsertChangeSet.changes.some(
      (change) => change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const reorderChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  pageRoot.insertChild(0, insertedButton);
  insertedButton.x = 300;
  insertedButton.y = 20;
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: insertedButton,
        properties: ["relativeTransform"],
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > reorderChangeSetCount,
  );
  const reorderChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const reorder = reorderChangeSet.changes.find(
    (change) => change.property === "nodeReorder",
  );
  assert.ok(reorder);
  assert.equal(
    reorder.to.children[0].nodeId,
    insertedButton.getPluginData("figmaSyncPageNodeId"),
  );
  assert.ok(
    !reorderChangeSet.changes.some(
      (change) =>
        change.property === "structure" ||
        (change.nodeId ===
          insertedButton.getPluginData("figmaSyncPageNodeId") &&
          ["x", "y"].includes(change.property)),
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const reparentChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  insertedButton.x = 647;
  insertedButton.y = 397;
  newSection.appendChild(insertedButton);
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: insertedButton,
        properties: ["parent", "relativeTransform"],
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > reparentChangeSetCount,
  );
  const reparentChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const reparent = reparentChangeSet.changes.find(
    (change) => change.property === "nodeReparent",
  );
  assert.ok(reparent);
  assert.equal(
    reparent.nodeId,
    insertedButton.getPluginData("figmaSyncPageNodeId"),
  );
  assert.equal(reparent.fromParentId, "landing-root");
  assert.equal(
    reparent.toParentId,
    newSection.getPluginData("figmaSyncPageNodeId"),
  );
  assert.equal(reparent.fromIndex, 0);
  assert.equal(reparent.toIndex, 0);
  assert.deepEqual(plain(reparent.beforeBounds), {
    x: 300,
    y: 20,
    width: 220,
    height: 56,
  });
  assert.deepEqual(plain(reparent.afterBounds), {
    x: 647,
    y: 397,
    width: 220,
    height: 56,
  });
  assert.equal(reparent.parentLayout, "NONE");
  assert.equal(reparent.positioning, "ABSOLUTE");
  assert.equal(reparent.beforeWorldTransform.length, 6);
  assert.equal(reparent.afterWorldTransform.length, 6);
  assert.ok(
    !reparentChangeSet.changes.some(
      (change) =>
        change.nodeId === reparent.nodeId &&
        ["x", "y", "nodeReorder", "structure"].includes(change.property),
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const genericDeleteChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const insertedButtonId = insertedButton.getPluginData("figmaSyncPageNodeId");
  insertedButton.remove();
  callbacks.get("documentchange")({
    documentChanges: [
      { type: "DELETE", node: insertedButton, origin: "LOCAL" },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > genericDeleteChangeSetCount,
  );
  const genericDeleteChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  assert.ok(
    genericDeleteChangeSet.changes.some(
      (change) =>
        change.property === "nodeDelete" &&
        change.nodeId === insertedButtonId,
    ),
  );
  assert.ok(
    !genericDeleteChangeSet.changes.some(
      (change) => change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const svgChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const svgNode = findImportedPageNode(pageRoot, "hero-icon");
  const editedPath = svgNode.findOne((node) => node.type === "VECTOR");
  editedPath.vectorPaths = [
    {
      windingRule: "NONZERO",
      data: "M20 90L90 20L160 90L20 60L160 40L90 120Z",
    },
  ];
  const arrowPath = new MockNode("VECTOR", "Arrow");
  arrowPath.vectorPaths = [
    {
      windingRule: "NONZERO",
      data: "M190 80L300 150L220 100Z",
    },
  ];
  svgNode.appendChild(arrowPath);
  svgNode.exportedSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><path id="star" d="M20 90L90 20L160 90L20 60L160 40L90 120Z"/><path id="arrow" d="M190 80L300 150L220 100Z"/></svg>';
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: editedPath,
        properties: ["vectorPaths"],
        origin: "LOCAL",
      },
      {
        type: "CREATE",
        node: arrowPath,
        origin: "LOCAL",
      },
    ],
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.changes.status" &&
        message.unsentChanges === true,
    ),
  );
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > svgChangeSetCount,
  );
  const svgChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const svgChange = svgChangeSet.changes.find(
    (change) =>
      change.nodeId === "hero-icon" &&
      change.category === "vector" &&
      change.property === "svg",
  );
  assert.ok(svgChange);
  assert.equal(svgChange.sourceRef.selector, "[data-codex-id='hero-icon']");
  assert.match(
    Buffer.from(svgChange.to.base64, "base64").toString("utf8"),
    /id="arrow"/,
  );
  assert.ok(
    !svgChangeSet.changes.some((change) => change.property === "structure"),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const unavailableSvgChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const pluginErrorCount = messages.filter(
    (message) => message.type === "plugin.error",
  ).length;
  titleNode.characters = "The rest still sends";
  editedPath.vectorPaths = [
    {
      windingRule: "NONZERO",
      data: "M20 20L20 20",
    },
  ];
  svgNode.exportError = new Error(
    "Failed to export node. This node may not have any visible layers.",
  );
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "PROPERTY_CHANGE",
        node: titleNode,
        properties: ["characters"],
        origin: "LOCAL",
      },
      {
        type: "PROPERTY_CHANGE",
        node: editedPath,
        properties: ["vectorPaths"],
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > unavailableSvgChangeSetCount,
  );
  const unavailableSvgChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  assert.ok(
    unavailableSvgChangeSet.changes.some(
      (change) =>
        change.nodeId === "hero-title" &&
        change.property === "characters" &&
        change.to === "The rest still sends",
    ),
  );
  const unavailableSvg = unavailableSvgChangeSet.changes.find(
    (change) =>
      change.nodeId === "hero-icon" &&
      change.property === "svgUnavailable",
  );
  assert.ok(unavailableSvg);
  assert.match(unavailableSvg.error, /may not have any visible layers/);
  assert.equal(
    messages.filter((message) => message.type === "plugin.error").length,
    pluginErrorCount,
  );
  svgNode.exportError = null;
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const stablePageRoot = pageRoot;
  svgNode.setPluginData("figmaSyncPageNodeType", "");
  figma.ui.onmessage({
    type: "page.upsert",
    page: pageManifest("page-hash-1"),
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "page.result" &&
          message.pageId === "landing-page" &&
          message.ok,
      ).length === 3,
  );
  pageRoot = findImportedPageRoot(page);
  assert.equal(pageRoot, stablePageRoot);
  assert.equal(findImportedPageNode(pageRoot, "hero-title").fontSize, 56);
  assert.equal(
    findImportedPageNode(pageRoot, "hero-icon").getPluginData(
      "figmaSyncPageNodeType",
    ),
    "svg",
  );
  assert.equal(page.selection.length, 1);
  assert.equal(page.selection[0], stablePageRoot);
  assert.equal(zoomedNodes.at(-1), stablePageRoot);

  const deletionChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const deletedSvgNode = findImportedPageNode(pageRoot, "hero-icon");
  const deletedSvgChildren = [...deletedSvgNode.children];
  for (const child of deletedSvgChildren) {
    child.remove();
  }
  callbacks.get("documentchange")({
    documentChanges: deletedSvgChildren.map((node) => ({
        type: "DELETE",
        node,
        origin: "LOCAL",
      })),
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "page.changes.status" &&
        message.unsentChanges === true,
    ),
  );
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > deletionChangeSetCount,
  );
  const deletionChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const deletion = deletionChangeSet.changes.find(
    (change) =>
      change.nodeId === "hero-icon" &&
      change.category === "structure" &&
      change.property === "nodeDelete",
  );
  assert.ok(deletion);
  assert.equal(deletion.nodeType, "SVG");
  assert.equal(
    deletion.sourceRef.selector,
    "[data-codex-id='hero-icon']",
  );
  assert.ok(
    !deletionChangeSet.changes.some(
      (change) => change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  const subtreeDeletionChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const deletedFrameNode = findImportedPageNode(
    pageRoot,
    "secondary-cta",
  );
  deletedFrameNode.remove();
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "DELETE",
        node: deletedFrameNode,
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > subtreeDeletionChangeSetCount,
  );
  const subtreeDeletionChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const subtreeDeletion = subtreeDeletionChangeSet.changes.find(
    (change) =>
      change.nodeId === "secondary-cta" &&
      change.category === "structure" &&
      change.property === "nodeDelete",
  );
  assert.ok(subtreeDeletion);
  assert.equal(subtreeDeletion.nodeType, "FRAME");
  assert.ok(
    !subtreeDeletionChangeSet.changes.some(
      (change) =>
        change.nodeId === "secondary-cta-label" ||
        change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-1",
  });

  pageRoot.x = 321;
  pageRoot.y = 432;
  figma.ui.onmessage({
    type: "page.upsert",
    page: pageManifest("page-hash-2"),
  });
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "page.result" &&
          message.pageId === "landing-page" &&
          message.ok,
      ).length === 4,
  );
  pageRoot = findImportedPageRoot(page);
  titleNode = findImportedPageNode(pageRoot, "hero-title");
  assert.equal(pageRoot, stablePageRoot);
  assert.equal(pageRoot.x, 321);
  assert.equal(pageRoot.y, 432);
  assert.deepEqual(plain(titleNode.annotations), [
    { label: "Match the production heading scale" },
  ]);

  const cloneChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const originalButton = findImportedPageNode(
    pageRoot,
    "secondary-cta",
  );
  const copiedButton = cloneMockSubtree(originalButton);
  copiedButton.name = "Secondary CTA copy";
  copiedButton.x = originalButton.x + 240;
  copiedButton.fills = [
    {
      type: "SOLID",
      color: { r: 1, g: 0.9, b: 0.34 },
      opacity: 1,
      visible: true,
    },
  ];
  const copiedLabel = copiedButton.findOne(
    (node) => node.type === "TEXT",
  );
  copiedLabel.characters = "eee";
  originalButton.parent.appendChild(copiedButton);
  callbacks.get("documentchange")({
    documentChanges: [
      {
        type: "CREATE",
        node: copiedButton,
        origin: "LOCAL",
      },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > cloneChangeSetCount,
  );
  const cloneChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const cloneChange = cloneChangeSet.changes.find(
    (change) => change.property === "nodeClone",
  );
  assert.ok(cloneChange);
  const clonedFrameId = cloneChange.to.idMap.find(
    (entry) => entry.from === "secondary-cta",
  ).to;
  const clonedLabelId = cloneChange.to.idMap.find(
    (entry) => entry.from === "secondary-cta-label",
  ).to;
  assert.ok(
    cloneChangeSet.changes.some(
      (change) =>
        change.nodeId === clonedFrameId &&
        change.property === "fill" &&
        change.to.color === "#FFE657",
    ),
  );
  assert.ok(
    cloneChangeSet.changes.some(
      (change) =>
        change.nodeId === clonedLabelId &&
        change.property === "characters" &&
        change.to === "eee",
    ),
  );
  assert.ok(
    !cloneChangeSet.changes.some(
      (change) =>
        change.property === "structure" ||
        (change.nodeId === clonedFrameId && change.property === "x"),
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-2",
  });

  const textCloneChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const originalTitle = findImportedPageNode(pageRoot, "hero-title");
  const copiedTitle = cloneMockSubtree(originalTitle);
  // Real Figma leaf nodes such as TextNode do not implement ChildrenMixin.findAll.
  copiedTitle.findAll = undefined;
  copiedTitle.name = "Hero title copy";
  copiedTitle.characters = "Copied heading";
  copiedTitle.x = originalTitle.x + 180;
  pageRoot.appendChild(copiedTitle);
  callbacks.get("documentchange")({
    documentChanges: [
      { type: "CREATE", node: copiedTitle, origin: "LOCAL" },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > textCloneChangeSetCount,
  );
  const textCloneChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const textClone = textCloneChangeSet.changes.find(
    (change) =>
      change.property === "nodeClone" && change.nodeType === "TEXT",
  );
  assert.ok(textClone);
  const copiedTitleId = textClone.to.idMap[0].to;
  assert.ok(
    textCloneChangeSet.changes.some(
      (change) =>
        change.nodeId === copiedTitleId &&
        change.property === "characters" &&
        change.to === "Copied heading",
    ),
  );
  assert.ok(
    !textCloneChangeSet.changes.some(
      (change) =>
        change.property === "structure" ||
        (change.nodeId === copiedTitleId && change.property === "x"),
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-2",
  });

  const replacementChangeSetCount = messages.filter(
    (message) => message.type === "page.changes.emit",
  ).length;
  const replacementTitle = cloneMockSubtree(originalTitle);
  replacementTitle.findAll = undefined;
  replacementTitle.x = 24;
  replacementTitle.y = 16;
  const replacementParent = findImportedPageNode(pageRoot, "secondary-cta");
  replacementParent.appendChild(replacementTitle);
  originalTitle.remove();
  callbacks.get("documentchange")({
    documentChanges: [
      { type: "CREATE", node: replacementTitle, origin: "LOCAL" },
      { type: "DELETE", node: originalTitle, origin: "LOCAL" },
    ],
  });
  figma.ui.onmessage({ type: "review.capture" });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.changes.emit")
        .length > replacementChangeSetCount,
  );
  const replacementChangeSet = messages
    .filter((message) => message.type === "page.changes.emit")
    .at(-1).changeSet;
  const atomicReplacement = replacementChangeSet.changes.find(
    (change) =>
      change.property === "nodeReparent" && change.replacement === true,
  );
  assert.ok(atomicReplacement);
  assert.equal(atomicReplacement.nodeId, "hero-title");
  assert.equal(atomicReplacement.fromParentId, "landing-root");
  assert.equal(atomicReplacement.toParentId, "secondary-cta");
  assert.equal(
    replacementTitle.getPluginData("figmaSyncPageNodeId"),
    "hero-title",
  );
  assert.ok(
    !replacementChangeSet.changes.some(
      (change) =>
        change.property === "nodeClone" ||
        change.property === "nodeDelete" ||
        change.property === "structure",
    ),
  );
  figma.ui.onmessage({
    type: "page.changes.accepted",
    pageId: "landing-page",
    sourceHash: "page-hash-2",
  });

  figma.ui.onmessage({
    type: "asset.remove",
    assetId: "sample.svg",
  });
  assert.equal(findAssetRoot(page), null);

  const userFrame = new MockNode("FRAME", "User checkout");
  userFrame.resize(960, 720);
  userFrame.fills = [
    {
      type: "SOLID",
      color: { r: 0.05, g: 0.06, b: 0.08 },
      opacity: 1,
      visible: true,
    },
  ];
  const userTitle = new MockNode("TEXT", "Checkout title");
  userTitle.resize(400, 64);
  userTitle.characters = "Checkout";
  userTitle.fontName = { family: "Inter", style: "Bold" };
  userTitle.fontSize = 48;
  userTitle.lineHeight = { unit: "PIXELS", value: 56 };
  userTitle.letterSpacing = { unit: "PIXELS", value: 0 };
  userTitle.textAlignHorizontal = "LEFT";
  userTitle.textAlignVertical = "TOP";
  userTitle.textCase = "ORIGINAL";
  userTitle.textDecoration = "NONE";
  userFrame.appendChild(userTitle);
  page.appendChild(userFrame);
  page.selection = [userFrame];
  figma.ui.onmessage({ type: "design.capture" });
  await waitFor(() =>
    messages.some((message) => message.type === "design.submit"),
  );
  const designSubmission = messages
    .filter((message) => message.type === "design.submit")
    .at(-1);
  assert.equal(designSubmission.design.figma.rootNodeId, userFrame.id);
  assert.equal(designSubmission.design.root.name, "User checkout");
  assert.equal(designSubmission.design.root.children[0].properties.characters, "Checkout");
  assert.match(designSubmission.design.screenshot.base64, /^[A-Za-z0-9+/=]+$/);
  assert.equal(
    userFrame.getPluginData("codexDesignId"),
    designSubmission.design.designId,
  );

  const freeformPage = new MockNode("PAGE", "Freeform import");
  figma.root.appendChild(freeformPage);
  figma.currentPage = freeformPage;
  const freeformManifest = pageManifest("freeform-hash");
  freeformManifest.pageId = "freeform-page";
  freeformManifest.root.layout = {
    kind: "freeform",
    direction: "none",
    gap: 0,
    counterGap: 0,
    wrap: false,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    align: "start",
    justify: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
  };
  freeformManifest.root.children = [
    {
      id: "absolute-child",
      type: "frame",
      name: "Absolute child",
      width: 200,
      height: 100,
      x: 80,
      y: 120,
      rotation: 0,
      visible: true,
      opacity: 1,
      sourceRef: {
        file: "examples/landing/index.html",
        selector: "[data-codex-id='absolute-child']",
      },
      style: { fill: "#FFFFFF" },
      layoutItem: {
        align: "start",
        grow: 0,
        shrink: 0,
        basis: "auto",
        order: 0,
        positioning: "absolute",
        horizontalSizing: "fixed",
        verticalSizing: "fixed",
      },
      layout: {
        kind: "freeform",
        direction: "none",
        gap: 0,
        counterGap: 0,
        wrap: false,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        align: "start",
        justify: "start",
        primarySizing: "fixed",
        counterSizing: "fixed",
      },
      children: [],
    },
  ];
  freeformManifest.nodeIds = ["landing-root", "absolute-child"];
  const freeformResultCount = messages.filter(
    (message) => message.type === "page.result",
  ).length;
  figma.ui.onmessage({ type: "page.upsert", page: freeformManifest });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.result").length >
      freeformResultCount,
  );
  const freeformResult = messages
    .filter((message) => message.type === "page.result")
    .at(-1);
  assert.equal(freeformResult.ok, true);
  const freeformRoot = findImportedPageRoot(freeformPage);
  const absoluteChild = findImportedPageNode(freeformRoot, "absolute-child");
  assert.equal(absoluteChild.layoutPositioning, "AUTO");
  assert.equal(absoluteChild.x, 80);
  assert.equal(absoluteChild.y, 120);

  const failedPage = new MockNode("PAGE", "Failed import");
  figma.root.appendChild(failedPage);
  figma.currentPage = failedPage;
  const failedManifest = pageManifest("failed-hash");
  failedManifest.pageId = "failed-page";
  failedManifest.root.children[2].svg = "__FAIL__";
  const failedResultCount = messages.filter(
    (message) => message.type === "page.result",
  ).length;
  figma.ui.onmessage({ type: "page.upsert", page: failedManifest });
  await waitFor(
    () =>
      messages.filter((message) => message.type === "page.result").length >
      failedResultCount,
  );
  const failedResult = messages
    .filter((message) => message.type === "page.result")
    .at(-1);
  assert.equal(failedResult.ok, false);
  assert.match(failedResult.error, /Synthetic import failure/);
  assert.equal(findImportedPageRoot(failedPage), null);

  const preservedRoot = figma.root.findOne(
    (node) => node.getPluginData("figmaSyncRole") === "page-root",
  );
  assert.ok(preservedRoot);
  figma.ui.onmessage({ type: "workspace.reset" });
  await waitFor(() =>
    messages.some((message) => message.type === "workspace.reset.complete"),
  );
  assert.equal(preservedRoot.removed, false);
  assert.equal(preservedRoot.getPluginData("figmaSyncRole"), "");
  assert.equal(preservedRoot.getPluginData("figmaSyncPageId"), "");
  assert.equal(
    figma.root.findAll(
      (node) => node.getPluginData("figmaSyncRole") === "page-root",
    ).length,
    0,
  );
});

test("Figma plugin seeds an empty Codex page from one selected frame", async () => {
  const source = await readFile(new URL("../plugin/code.js", import.meta.url), "utf8");
  const messages = [];
  const callbacks = new Map();
  const page = new MockNode("PAGE", "Figma source");
  page.selection = [];
  const figma = {
    root: new MockNode("DOCUMENT", "Document"),
    currentPage: page,
    fileKey: "figma-seed-file",
    mixed: Symbol("mixed"),
    base64Encode(bytes) {
      return Buffer.from(bytes).toString("base64");
    },
    viewport: {
      center: { x: 0, y: 0 },
      scrollAndZoomIntoView() {},
    },
    ui: {
      onmessage: null,
      postMessage(message) {
        messages.push(message);
      },
    },
    clientStorage: {
      async getAsync() {
        return undefined;
      },
      async setAsync() {},
    },
    showUI() {},
    async loadAllPagesAsync() {},
    on(type, callback) {
      callbacks.set(type, callback);
    },
    async loadFontAsync() {},
  };
  figma.root.appendChild(page);
  const frame = new MockNode("FRAME", "Landing page");
  frame.width = 390;
  frame.height = 844;
  frame.layoutMode = "VERTICAL";
  frame.itemSpacing = 16;
  frame.paddingTop = 24;
  frame.paddingRight = 24;
  frame.paddingBottom = 24;
  frame.paddingLeft = 24;
  frame.fills = [{
    type: "SOLID",
    color: { r: 0.176, g: 0.122, b: 0.949 },
    opacity: 1,
    visible: true,
  }];
  const title = new MockNode("TEXT", "Title");
  title.width = 260;
  title.height = 48;
  title.characters = "From Figma";
  title.fontName = { family: "Inter", style: "Bold" };
  title.fontSize = 36;
  title.lineHeight = { unit: "PIXELS", value: 44 };
  title.letterSpacing = { unit: "PIXELS", value: 0 };
  title.textAlignHorizontal = "LEFT";
  title.textAlignVertical = "TOP";
  title.textCase = "ORIGINAL";
  title.textDecoration = "NONE";
  title.fills = [{
    type: "SOLID",
    color: { r: 1, g: 1, b: 1 },
    opacity: 1,
    visible: true,
  }];
  frame.appendChild(title);
  page.appendChild(frame);
  page.selection = [frame];

  vm.runInNewContext(source, {
    figma,
    __html__: "<html></html>",
    setTimeout,
    clearTimeout,
    console,
  });
  await waitFor(() => typeof figma.ui.onmessage === "function");
  figma.ui.onmessage({
    type: "page.seed.capture",
    pageId: "seed-page",
    sourceHash: "seed-hash",
    requestId: "seed-request",
  });
  await waitFor(() => messages.some((message) => message.type === "page.changes.emit"));
  const emitted = messages.find((message) => message.type === "page.changes.emit");
  assert.equal(emitted.requestId, "seed-request");
  assert.equal(emitted.changeSet.pageId, "seed-page");
  assert.equal(emitted.changeSet.changes[0].property, "pageSeed");
  assert.equal(emitted.changeSet.changes[0].to.node.id, "page-root");
  assert.equal(
    emitted.changeSet.changes[0].to.node.children[0].text,
    "From Figma",
  );
  assert.equal(frame.getPluginData("figmaSyncRole"), "page-root");
  assert.equal(frame.getPluginData("figmaSyncPageNodeId"), "page-root");
  assert.equal(title.getPluginData("figmaSyncRole"), "page-node");
});

function asset(sourceHash, fragment) {
  return {
    assetId: "sample.svg",
    sourceHash,
    width: 100,
    height: 50,
    targets: [{ elementId: "box", fragment }],
  };
}

function pageManifest(sourceHash) {
  return {
    protocolVersion: 3,
    pageId: "landing-page",
    name: "Landing page",
    sourceHash,
    nodeIds: [
      "landing-root",
      "hero-title",
      "secondary-cta",
      "secondary-cta-label",
      "hero-icon",
      "hero-photo",
    ],
    root: {
      id: "landing-root",
      type: "frame",
      name: "Landing root",
      width: 1440,
      height: 900,
      x: 0,
      y: 0,
      rotation: 0,
      visible: true,
      opacity: 1,
      sourceRef: {
        file: "examples/landing/index.html",
        selector: "[data-codex-id='landing-root']",
      },
      style: {
        fill: "#101114",
        stroke: "#30322B",
        strokeWidth: 1,
        radius: 0,
      },
      layout: {
        kind: "flex",
        direction: "vertical",
        gap: 24,
        counterGap: 12,
        wrap: true,
        padding: { top: 40, right: 40, bottom: 40, left: 40 },
        align: "start",
        justify: "start",
        primarySizing: "fixed",
        counterSizing: "fixed",
      },
      children: [
        {
          id: "hero-title",
          type: "text",
          name: "Hero title",
          width: 720,
          height: 80,
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          opacity: 1,
          sourceRef: {
            file: "examples/landing/index.html",
            selector: "[data-codex-id='hero-title']",
          },
          style: { fill: "#FFFFFF" },
          text: "Built by Codex",
          textAlign: "left",
          font: {
            family: "Inter",
            style: "Bold",
            size: 48,
            lineHeight: 56,
            letterSpacing: 0,
          },
        },
        {
          id: "secondary-cta",
          type: "frame",
          name: "Secondary CTA",
          width: 220,
          height: 56,
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          opacity: 1,
          sourceRef: {
            file: "examples/landing/index.html",
            selector: "[data-codex-id='secondary-cta']",
          },
          style: {
            fill: "#101114",
            fills: [
              {
                type: "linear-gradient",
                angle: 135,
                stops: [
                  { color: "#7262FF", position: 0 },
                  { color: "#4E3FE0", position: 1 },
                ],
              },
            ],
            effects: [
              {
                type: "drop-shadow",
                color: "#20193C21",
                offsetX: 0,
                offsetY: 8,
                blur: 18,
                spread: 0,
              },
              {
                type: "background-blur",
                blur: 22,
              },
            ],
            stroke: "#30322B",
            strokeWidths: { top: 1, right: 0, bottom: 0, left: 0 },
            radius: 28,
          },
          layoutItem: {
            align: "stretch",
            grow: 1,
            shrink: 1,
            basis: "auto",
            order: 1,
            positioning: "auto",
            horizontalSizing: "fill",
            verticalSizing: "fixed",
          },
          layout: {
            kind: "flex",
            direction: "horizontal",
            gap: 0,
            counterGap: 0,
            wrap: false,
            padding: { top: 0, right: 24, bottom: 0, left: 24 },
            align: "center",
            justify: "center",
            primarySizing: "hug",
            counterSizing: "fixed",
          },
          children: [
            {
              id: "secondary-cta-label",
              type: "text",
              name: "Secondary CTA label",
              width: 160,
              height: 24,
              x: 0,
              y: 0,
              rotation: 0,
              visible: true,
              opacity: 1,
              sourceRef: {
                file: "examples/landing/index.html",
                selector: "[data-codex-id='secondary-cta-label']",
              },
              style: { fill: "#FFFFFF" },
              text: "View the protocol",
              textAlign: "center",
              font: {
                family: "Inter",
                style: "Regular",
                size: 16,
                lineHeight: 24,
                letterSpacing: 0,
              },
            },
          ],
        },
        {
          id: "hero-icon",
          type: "svg",
          name: "Hero icon",
          width: 32,
          height: 32,
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          opacity: 1,
          sourceRef: {
            file: "examples/landing/index.html",
            selector: "[data-codex-id='hero-icon']",
          },
          style: {},
          svg: '<svg viewBox="0 0 32 32"><path id="spark" d="M16 2L30 16L16 30L2 16Z" fill="#7C5CFC"/></svg>',
        },
        {
          id: "hero-photo",
          type: "image",
          name: "Hero photo",
          width: 320,
          height: 180,
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          opacity: 1,
          sourceRef: {
            file: "examples/landing/assets/hero.png",
            selector: "[data-codex-id='hero-photo']",
          },
          style: {},
          objectFit: "cover",
          image: {
            mimeType: "image/png",
            base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        },
      ],
    },
  };
}

function findAssetRoot(page) {
  return page.findOne(
    (node) => node.getPluginData("figmaSyncRole") === "asset-root",
  );
}

function findTarget(root) {
  return root.findOne(
    (node) => node.getPluginData("figmaSyncRole") === "element-target",
  );
}

function findImportedPageRoot(page) {
  return page.findOne(
    (node) => node.getPluginData("figmaSyncRole") === "page-root",
  );
}

function findImportedPageNode(root, nodeId) {
  return root.findOne(
    (node) =>
      node.getPluginData("figmaSyncRole") === "page-node" &&
      node.getPluginData("figmaSyncPageNodeId") === nodeId,
  );
}

function cloneMockSubtree(node) {
  const clone = new MockNode(node.type, node.name);
  const properties = [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "visible",
    "fills",
    "effects",
    "strokes",
    "strokeWeight",
    "strokeTopWeight",
    "strokeRightWeight",
    "strokeBottomWeight",
    "strokeLeftWeight",
    "strokeCap",
    "strokeJoin",
    "strokeMiterLimit",
    "dashPattern",
    "cornerRadius",
    "layoutMode",
    "layoutWrap",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "annotations",
    "characters",
    "fontName",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textAlignHorizontal",
    "textAlignVertical",
    "textCase",
    "textDecoration",
  ];
  for (const property of properties) {
    if (!(property in node)) {
      continue;
    }
    const value = node[property];
    clone[property] =
      value && typeof value === "object"
        ? JSON.parse(JSON.stringify(value))
        : value;
  }
  clone.pluginData = new Map(node.pluginData);
  for (const child of node.children) {
    clone.appendChild(cloneMockSubtree(child));
  }
  return clone;
}

class MockNode {
  static nextId = 1;

  constructor(type, name) {
    this.id = `${MockNode.nextId++}:0`;
    this.type = type;
    this.name = name;
    this.children = [];
    this.parent = null;
    this.removed = false;
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.rotation = 0;
    this.opacity = 1;
    this.visible = true;
    this.fills = [];
    this.effects = [];
    this.strokes = [];
    this.strokeWeight = 1;
    this.strokeTopWeight = 1;
    this.strokeRightWeight = 1;
    this.strokeBottomWeight = 1;
    this.strokeLeftWeight = 1;
    this.strokeCap = "NONE";
    this.strokeJoin = "MITER";
    this.strokeMiterLimit = 4;
    this.dashPattern = [];
    this.cornerRadius = 0;
    this.layoutMode = "NONE";
    this.layoutWrap = "NO_WRAP";
    this.itemSpacing = 0;
    this.counterAxisSpacing = 0;
    this.paddingTop = 0;
    this.paddingRight = 0;
    this.paddingBottom = 0;
    this.paddingLeft = 0;
    this.primaryAxisAlignItems = "MIN";
    this.counterAxisAlignItems = "MIN";
    this.primaryAxisSizingMode = "FIXED";
    this.counterAxisSizingMode = "FIXED";
    this.layoutAlign = "INHERIT";
    this.layoutGrow = 0;
    this.layoutPositioning = "AUTO";
    this.layoutSizingHorizontal = "FIXED";
    this.layoutSizingVertical = "FIXED";
    this.annotations = [];
    this.pluginData = new Map();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setPluginData(key, value) {
    this.pluginData.set(key, value);
  }

  getPluginData(key) {
    if (this.removed) {
      throw new Error(`The node with id "${this.id}" does not exist`);
    }
    return this.pluginData.get(key) || "";
  }

  appendChild(child) {
    detach(child);
    this.children.push(child);
    child.parent = this;
  }

  insertChild(index, child) {
    detach(child);
    this.children.splice(index, 0, child);
    child.parent = this;
  }

  remove() {
    detach(this);
    const markRemoved = (node) => {
      node.removed = true;
      for (const child of node.children) {
        markRemoved(child);
      }
    };
    markRemoved(this);
  }

  findAll(predicate) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (predicate(child)) {
          result.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  findOne(predicate) {
    return this.findAll(predicate)[0] || null;
  }

  async exportAsync(settings) {
    if (this.exportError) {
      throw this.exportError;
    }
    if (settings.format === "SVG") {
      return new Uint8Array(
        Buffer.from(
          this.exportedSvg ||
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(
              1,
              this.width,
            )} ${Math.max(1, this.height)}"></svg>`,
        ),
      );
    }
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  }
}

class MockElement {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  dispatch(type) {
    const callback = this.listeners.get(type);
    assert.ok(callback, `listener for ${type} is registered`);
    callback();
  }
}

function detach(node) {
  if (!node.parent) {
    return;
  }
  const index = node.parent.children.indexOf(node);
  if (index >= 0) {
    node.parent.children.splice(index, 1);
  }
  node.parent = null;
}

async function waitFor(predicate, timeout = 2500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for plugin state.");
    }
    await delay(10);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
