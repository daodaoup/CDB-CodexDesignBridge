const ROLE_KEY = "figmaSyncRole";
const ASSET_ID_KEY = "figmaSyncAssetId";
const ELEMENT_ID_KEY = "figmaSyncElementId";
const SOURCE_HASH_KEY = "figmaSyncSourceHash";
const PAGE_ID_KEY = "figmaSyncPageId";
const PAGE_NODE_ID_KEY = "figmaSyncPageNodeId";
const PAGE_NODE_TYPE_KEY = "figmaSyncPageNodeType";
const PAGE_SOURCE_REF_KEY = "figmaSyncPageSourceRef";
const PAGE_LAYOUT_META_KEY = "figmaSyncPageLayout";
const PAGE_LAYOUT_ITEM_KEY = "figmaSyncPageLayoutItem";
const PAGE_BASELINE_KEY = "figmaSyncPageBaseline";
const PAGE_SVG_BASELINE_KEY = "figmaSyncPageSvgBaseline";
const PAGE_ANNOTATION_BASELINE_KEY = "figmaSyncPageAnnotationBaseline";
const PAGE_STRUCTURE_BASELINE_KEY = "figmaSyncPageStructureBaseline";
const PAGE_VECTOR_INSERT_VERSION_KEY = "figmaSyncPageVectorInsertVersion";
const DESIGN_ID_KEY = "codexDesignId";
const DESIGN_NODE_ID_KEY = "codexDesignNodeId";
const ROLE_ROOT = "asset-root";
const ROLE_TARGET = "element-target";
const ROLE_PAGE_ROOT = "page-root";
const ROLE_PAGE_NODE = "page-node";
const DESIGN_ROOT_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "GROUP",
]);
const SVG_EXPORT_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "POLYGON",
  "STAR",
  "LINE",
]);
const INSERTABLE_PAGE_VECTOR_TYPES = new Set([
  ...SVG_EXPORT_TYPES,
  "RECTANGLE",
]);
const VECTOR_INSERT_VERSION = "5";
const SAFE_PAGE_DELETE_TYPES = new Set(["frame", "image", "svg", "text"]);
const CLONEABLE_PAGE_TYPES = new Set(["frame", "image", "svg", "text"]);
const INSERTABLE_PAGE_FRAME_TYPES = new Set([
  "COMPONENT",
  "FRAME",
  "GROUP",
  "INSTANCE",
]);
const MAX_INSERTED_PAGE_NODES = 200;
const MAX_INSERTED_IMAGE_BYTES = 2 * 1024 * 1024;
const PAGE_CHANGE_PROTOCOL_VERSION = 14;
const EDITABLE_PROPERTIES = new Set([
  "fills",
  "strokes",
  "strokeWeight",
  "strokeCap",
  "strokeJoin",
  "strokeMiterLimit",
  "dashPattern",
  "opacity",
  "visible",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "relativeTransform",
  "x",
  "y",
  "width",
  "height",
  "rotation",
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
  "characters",
  "fontName",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textAlignHorizontal",
  "textAlignVertical",
  "textCase",
  "textDecoration",
  "vectorNetwork",
  "vectorPaths",
]);
const APPEARANCE_PROPERTIES = new Set([
  "fill",
  "stroke",
  "strokeWeight",
  "strokeCap",
  "strokeJoin",
  "strokeMiterLimit",
  "dashPattern",
  "opacity",
  "visible",
]);
const GEOMETRY_PROPERTIES = new Set([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "cornerRadius",
]);
const LAYOUT_PROPERTIES = new Set([
  "layoutMode",
  "itemSpacing",
  "padding",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "layoutWrap",
  "counterAxisSpacing",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
]);

let suppressChangesUntil = 0;
const snapshots = new Map();
const pendingFlushes = new Map();
let pageStatusTimer = null;
let lastReportedUnsentChanges = null;
const trackedPageFigmaNodeIds = new Set();

figma.showUI(__html__, {
  width: 380,
  height: 520,
  themeColors: true,
});

void initialize();

async function initialize() {
  await figma.loadAllPagesAsync();
  indexCurrentPage();
  for (const root of findPageRoots()) {
    ensurePageBaselines(root);
  }

  figma.on("documentchange", (event) => {
    if (Date.now() < suppressChangesUntil) {
      return;
    }

    for (const change of event.documentChanges) {
      if (!change.node) {
        continue;
      }
      const changedProperties = new Set(change.properties || []);
      const propertiesChanged = Array.from(changedProperties).some((property) =>
        EDITABLE_PROPERTIES.has(property),
      );
      const annotationsChanged = changedProperties.has("annotations");
      const pageNode =
        !change.node.removed && findPageNodeAncestor(change.node);
      const affectsPage =
        trackedPageFigmaNodeIds.has(change.node.id) ||
        Boolean(pageNode);
      const affectsTrackedSvg = pageNode && isTrackedSvgNode(pageNode);
      if (
        affectsPage &&
        (change.type !== "PROPERTY_CHANGE" ||
          propertiesChanged ||
          annotationsChanged ||
          affectsTrackedSvg)
      ) {
        schedulePageStatus();
      }
      if (change.type !== "PROPERTY_CHANGE" || change.node.removed) {
        continue;
      }
      const target = findTargetAncestor(change.node);
      if (!target) {
        continue;
      }
      if (propertiesChanged || annotationsChanged) {
        scheduleFeedback(target, {
          propertiesChanged,
          annotationsChanged,
          origin: change.origin,
          changedNodeId: change.node.id,
          changedNodes: propertiesChanged ? [describeNode(change.node)] : [],
        });
      }
    }
  });

  figma.on("currentpagechange", () => {
    indexCurrentPage();
    reportPageStatus(true);
  });

  figma.ui.onmessage = (message) => {
    void handleUiMessage(message);
  };

  const settings = await loadConnectionSettings();
  figma.ui.postMessage({
    type: "plugin.settings",
    ...settings,
  });
  figma.ui.postMessage({
    type: "plugin.ready",
    pageName: figma.currentPage.name,
    importedAssets: findAssetRoots().length,
    importedPages: findPageRoots().length,
    importedAssetIds: findAssetRoots().map((root) =>
      root.getPluginData(ASSET_ID_KEY),
    ),
    importedPageIds: findPageRoots().map((root) =>
      root.getPluginData(PAGE_ID_KEY),
    ),
    unsentChanges: hasUnsentPageChanges(),
    changedPageIds: unsentPageIds(),
  });
}

async function handleUiMessage(message) {
  try {
    if (message.type === "asset.upsert") {
      await upsertAsset(message.asset);
      return;
    }
    if (message.type === "asset.remove") {
      const root = findAssetRoot(message.assetId);
      if (root) {
        root.remove();
      }
      figma.ui.postMessage({
        type: "notice",
        level: "info",
        message: `${message.assetId} was removed locally and cleared from Figma.`,
      });
      return;
    }
    if (message.type === "page.upsert") {
      await upsertPage(message.page);
      return;
    }
    if (message.type === "page.remove") {
      figma.ui.postMessage({
        type: "notice",
        level: "warning",
        message: `${message.pageId} was removed locally. Existing Figma layers were kept.`,
      });
      return;
    }
    if (message.type === "page.locate") {
      const root = findPageRoot(message.pageId);
      if (!root) {
        throw new Error("这个 CDB 页面还没有导入 Figma。");
      }
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);
      return;
    }
    if (message.type === "workspace.reset") {
      resetWorkspaceAssociations();
      return;
    }
    if (message.type === "page.seed.capture") {
      await captureSelectedPageSeed(message);
      return;
    }
    if (message.type === "design.capture") {
      await captureSelectedDesign();
      return;
    }
    if (
      message.type === "review.capture" ||
      message.type === "feedback.capture"
    ) {
      captureCurrentFeedback();
      await capturePageChanges(message.requestId || null);
      return;
    }
    if (message.type === "page.changes.accepted") {
      acceptPageChanges(message);
      return;
    }
    if (message.type === "settings.save") {
      await saveConnectionSettings(message);
      return;
    }
    if (message.type === "viewport.focus") {
      const root = findAssetRoot(message.assetId);
      if (root) {
        figma.currentPage.selection = [root];
        figma.viewport.scrollAndZoomIntoView([root]);
      }
      return;
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "plugin.error",
      requestId: message.requestId || null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resetWorkspaceAssociations() {
  suppressChangesUntil = Date.now() + 800;
  clearTimeout(pageStatusTimer);
  pageStatusTimer = null;
  for (const pending of pendingFlushes.values()) {
    clearTimeout(pending.timer);
  }
  pendingFlushes.clear();
  snapshots.clear();
  trackedPageFigmaNodeIds.clear();

  const pageKeys = [
    PAGE_ID_KEY,
    PAGE_NODE_ID_KEY,
    PAGE_NODE_TYPE_KEY,
    PAGE_SOURCE_REF_KEY,
    PAGE_LAYOUT_META_KEY,
    PAGE_LAYOUT_ITEM_KEY,
    PAGE_BASELINE_KEY,
    PAGE_SVG_BASELINE_KEY,
    PAGE_ANNOTATION_BASELINE_KEY,
    PAGE_STRUCTURE_BASELINE_KEY,
    PAGE_VECTOR_INSERT_VERSION_KEY,
  ];
  const roots = figma.root.findAll(
    (node) => node.getPluginData?.(ROLE_KEY) === ROLE_PAGE_ROOT,
  );
  for (const root of roots) {
    for (const node of [root, ...root.findAll(() => true)]) {
      const role = node.getPluginData?.(ROLE_KEY);
      if (role === ROLE_PAGE_ROOT || role === ROLE_PAGE_NODE) {
        node.setPluginData(ROLE_KEY, "");
        node.setPluginData(SOURCE_HASH_KEY, "");
        for (const key of pageKeys) node.setPluginData(key, "");
      }
    }
  }
  lastReportedUnsentChanges = false;
  figma.currentPage.selection = [];
  figma.ui.postMessage({
    type: "workspace.reset.complete",
    preservedFrames: roots.length,
  });
}

async function loadConnectionSettings() {
  try {
    const [endpoint, token] = await Promise.all([
      figma.clientStorage.getAsync("figmaSyncEndpoint"),
      figma.clientStorage.getAsync("figmaSyncToken"),
    ]);
    return {
      endpoint: typeof endpoint === "string" ? endpoint : "",
      token: typeof token === "string" ? token : "",
    };
  } catch {
    return { endpoint: "", token: "" };
  }
}

async function saveConnectionSettings(message) {
  const endpoint = typeof message.endpoint === "string" ? message.endpoint : "";
  const token = typeof message.token === "string" ? message.token : "";
  await Promise.all([
    figma.clientStorage.setAsync("figmaSyncEndpoint", endpoint),
    figma.clientStorage.setAsync("figmaSyncToken", token),
  ]);
}

async function upsertAsset(asset) {
  validateAsset(asset);
  const existing = findAssetRoot(asset.assetId);
  const preserved = existing ? capturePreservedState(existing) : null;
  const parent = existing?.parent || figma.currentPage;
  const insertIndex = existing && "children" in parent ? parent.children.indexOf(existing) : -1;
  let replacement = null;

  suppressChangesUntil = Date.now() + 800;

  try {
    replacement = figma.createFrame();
    replacement.name = `SVG · ${asset.assetId}`;
    replacement.resize(asset.width, asset.height);
    replacement.fills = [];
    replacement.clipsContent = false;
    replacement.setPluginData(ROLE_KEY, ROLE_ROOT);
    replacement.setPluginData(ASSET_ID_KEY, asset.assetId);
    replacement.setPluginData(SOURCE_HASH_KEY, asset.sourceHash);

    for (const target of asset.targets) {
      const imported = figma.createNodeFromSvg(target.fragment);
      imported.name = target.elementId;
      imported.x = 0;
      imported.y = 0;
      imported.setPluginData(ROLE_KEY, ROLE_TARGET);
      imported.setPluginData(ASSET_ID_KEY, asset.assetId);
      imported.setPluginData(ELEMENT_ID_KEY, target.elementId);
      imported.setPluginData(SOURCE_HASH_KEY, asset.sourceHash);
      const annotations = preserved?.annotationsByElement.get(target.elementId);
      if (annotations && "annotations" in imported) {
        imported.annotations = annotations;
      }
      replacement.appendChild(imported);
    }

    if (existing) {
      replacement.x = existing.x;
      replacement.y = existing.y;
      replacement.rotation = existing.rotation;
      replacement.opacity = existing.opacity;
      if (insertIndex >= 0 && "insertChild" in parent) {
        parent.insertChild(insertIndex, replacement);
      }
    } else {
      placeNewBridgeRoot(replacement);
    }

    const selectedElementIds = preserved?.selectedElementIds || [];
    if (existing) {
      existing.remove();
    }

    refreshSnapshotsForRoot(replacement);
    const restoredSelection = selectedElementIds
      .map((elementId) => findTarget(replacement, elementId))
      .filter(Boolean);
    figma.currentPage.selection =
      restoredSelection.length > 0 ? restoredSelection : [replacement];
    if (!existing) {
      figma.viewport.scrollAndZoomIntoView([replacement]);
    }

    figma.ui.postMessage({
      type: "asset.result",
      ok: true,
      assetId: asset.assetId,
      sourceHash: asset.sourceHash,
      elements: asset.targets.length,
      nodeId: replacement.id,
    });
  } catch (error) {
    if (replacement && !replacement.removed) {
      replacement.remove();
    }
    if (existing && !existing.removed) {
      figma.currentPage.selection = [existing];
    }
    figma.ui.postMessage({
      type: "asset.result",
      ok: false,
      assetId: asset.assetId,
      error: error instanceof Error ? error.message : String(error),
      rolledBack: Boolean(existing),
    });
  }
}

async function upsertPage(page) {
  validatePage(page);
  const existing = findPageRoot(page.pageId);
  if (
    existing &&
    existing.getPluginData(SOURCE_HASH_KEY) === page.sourceHash
  ) {
    refreshPageNodeTypes(existing, page.root);
    ensurePageBaselines(existing);
    refreshTrackedPageNodeIds();
    figma.currentPage.selection = [existing];
    figma.viewport.scrollAndZoomIntoView([existing]);
    figma.ui.postMessage({
      type: "page.result",
      ok: true,
      pageId: page.pageId,
      sourceHash: page.sourceHash,
      nodes: page.nodeIds.length,
      nodeId: existing.id,
      fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
      figmaPageId: figma.currentPage.id,
      reused: true,
    });
    reportPageStatus(true);
    return;
  }

  if (existing && pageHasUnsentChanges(existing)) {
    figma.currentPage.selection = [existing];
    figma.ui.postMessage({
      type: "page.result",
      ok: false,
      code: "unsent_figma_changes",
      pageId: page.pageId,
      sourceHash: page.sourceHash,
      error: "Figma 中有尚未发送的修改，已保留当前图层。请先发送修改或解决冲突。",
      rolledBack: true,
    });
    reportPageStatus(true);
    return;
  }

  const preserved = existing ? capturePagePreservedState(existing) : null;
  const parent = existing?.parent || figma.currentPage;
  const insertIndex =
    existing && "children" in parent ? parent.children.indexOf(existing) : -1;
  let replacement = null;

  suppressChangesUntil = Date.now() + 1000;
  if (existing) {
    try {
      await reconcilePageNode({
        node: existing,
        definition: page.root,
        page,
        isRoot: true,
        annotationsByNode: preserved?.annotationsByNode,
      });
      existing.name = `Page · ${page.name}`;
      storePageBaselines(existing);
      refreshTrackedPageNodeIds();
      const restoredSelection = (preserved?.selectedNodeIds || [])
        .map((nodeId) => findTrackedPageNode(existing, nodeId))
        .filter(Boolean);
      figma.currentPage.selection =
        restoredSelection.length > 0 ? restoredSelection : [existing];
      figma.ui.postMessage({
        type: "page.result",
        ok: true,
        pageId: page.pageId,
        sourceHash: page.sourceHash,
        nodes: page.nodeIds.length,
        nodeId: existing.id,
        fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
        figmaPageId: figma.currentPage.id,
        reused: true,
        incremental: true,
      });
      reportPageStatus(true);
      schedulePageStatus(1050);
      return;
    } catch {
      // Fall back to the existing all-or-nothing replacement path.
    }
  }
  try {
    replacement = await createPageNode({
      definition: page.root,
      page,
      parent: null,
      isRoot: true,
      annotationsByNode: preserved?.annotationsByNode,
      onCreate(node) {
        replacement = node;
      },
    });
    replacement.name = `Page · ${page.name}`;

    if (existing) {
      replacement.x = existing.x;
      replacement.y = existing.y;
      if (insertIndex >= 0 && "insertChild" in parent) {
        parent.insertChild(insertIndex, replacement);
      }
    } else {
      placeNewBridgeRoot(replacement);
    }

    const selectedNodeIds = preserved?.selectedNodeIds || [];
    if (existing) {
      existing.remove();
    }

    storePageBaselines(replacement);
    refreshTrackedPageNodeIds();
    const restoredSelection = selectedNodeIds
      .map((nodeId) => findTrackedPageNode(replacement, nodeId))
      .filter(Boolean);
    figma.currentPage.selection =
      restoredSelection.length > 0 ? restoredSelection : [replacement];
    if (!existing) {
      figma.viewport.scrollAndZoomIntoView([replacement]);
    }

    figma.ui.postMessage({
      type: "page.result",
      ok: true,
      pageId: page.pageId,
      sourceHash: page.sourceHash,
      nodes: page.nodeIds.length,
      nodeId: replacement.id,
      fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
      figmaPageId: figma.currentPage.id,
      reused: false,
    });
    reportPageStatus(true);
    schedulePageStatus(1050);
  } catch (error) {
    if (replacement && !replacement.removed) {
      replacement.remove();
    }
    if (existing && !existing.removed) {
      figma.currentPage.selection = [existing];
    }
    figma.ui.postMessage({
      type: "page.result",
      ok: false,
      pageId: page.pageId,
      error: error instanceof Error ? error.message : String(error),
      rolledBack: Boolean(existing),
    });
  }
}

async function reconcilePageNode({
  node,
  definition,
  page,
  isRoot,
  annotationsByNode,
}) {
  const expectedType = definition.type;
  const currentType = node.getPluginData(PAGE_NODE_TYPE_KEY);
  if (currentType && currentType !== expectedType) {
    throw new Error(`Page node type changed for ${definition.id}.`);
  }
  node.name = definition.name;
  node.resize(definition.width, definition.height);
  node.visible = definition.visible;
  node.opacity = definition.opacity;
  node.rotation = definition.rotation;
  setPageNodeData(node, page, definition, isRoot);

  if (definition.type === "frame") {
    if (!("children" in node)) {
      throw new Error(`Page frame ${definition.id} is not editable.`);
    }
    node.clipsContent =
      typeof definition.clipsContent === "boolean"
        ? definition.clipsContent
        : true;
    applyFrameLayout(node, definition.layout);
    applyNodeStyle(node, definition.style, { clearFill: true });
    const existingById = new Map(
      node.children
        .filter((child) => child.getPluginData(ROLE_KEY) === ROLE_PAGE_NODE)
        .map((child) => [child.getPluginData(PAGE_NODE_ID_KEY), child]),
    );
    const retained = new Set();
    for (let index = 0; index < definition.children.length; index += 1) {
      const childDefinition = definition.children[index];
      let child = existingById.get(childDefinition.id) || null;
      const canReuse =
        child &&
        child.getPluginData(PAGE_NODE_TYPE_KEY) === childDefinition.type &&
        !["image", "svg"].includes(childDefinition.type);
      if (!canReuse) {
        const created = await createPageNode({
          definition: childDefinition,
          page,
          parent: null,
          isRoot: false,
          annotationsByNode,
        });
        node.insertChild(index, created);
        if (child && !child.removed) child.remove();
        child = created;
      } else {
        await reconcilePageNode({
          node: child,
          definition: childDefinition,
          page,
          isRoot: false,
          annotationsByNode,
        });
        node.insertChild(index, child);
      }
      retained.add(child);
      if (node.layoutMode === "NONE") {
        child.x = childDefinition.x;
        child.y = childDefinition.y;
      }
      applyLayoutItem(child, childDefinition.layoutItem);
    }
    for (const child of [...node.children]) {
      if (
        child.getPluginData(ROLE_KEY) === ROLE_PAGE_NODE &&
        !retained.has(child)
      ) {
        child.remove();
      }
    }
  } else if (definition.type === "text") {
    if (node.type !== "TEXT") {
      throw new Error(`Page text ${definition.id} is not editable.`);
    }
    const fontName = await loadPageFont(definition.font);
    node.fontName = fontName;
    node.characters = definition.text;
    node.fontSize = definition.font.size;
    node.lineHeight = { unit: "PIXELS", value: definition.font.lineHeight };
    node.letterSpacing = {
      unit: "PIXELS",
      value: definition.font.letterSpacing,
    };
    node.textAlignHorizontal = definition.textAlign.toUpperCase();
    node.textAutoResize = "NONE";
    node.resize(definition.width, definition.height);
    applyNodeStyle(node, definition.style);
  } else {
    throw new Error(`Page vector ${definition.id} requires replacement.`);
  }
  applyLayoutItem(node, definition.layoutItem);
}

function refreshPageNodeTypes(root, definition) {
  const node = findTrackedPageNode(root, definition.id);
  if (node) {
    node.setPluginData(PAGE_NODE_TYPE_KEY, definition.type);
  }
  for (const child of definition.children || []) {
    refreshPageNodeTypes(root, child);
  }
}

async function createPageNode({
  definition,
  page,
  parent,
  isRoot,
  annotationsByNode,
  onCreate,
}) {
  let node;
  if (definition.type === "frame") {
    node = figma.createFrame();
  } else if (definition.type === "text") {
    node = figma.createText();
  } else if (definition.type === "image") {
    node = figma.createRectangle();
  } else {
    node = figma.createNodeFromSvg(definition.svg);
  }

  onCreate?.(node);

  if (parent) {
    parent.appendChild(node);
  }
  node.name = definition.name;
  node.resize(definition.width, definition.height);
  node.visible = definition.visible;
  node.opacity = definition.opacity;
  node.rotation = definition.rotation;
  setPageNodeData(node, page, definition, isRoot);

  if (definition.type === "frame") {
    node.clipsContent =
      typeof definition.clipsContent === "boolean"
        ? definition.clipsContent
        : true;
    applyFrameLayout(node, definition.layout);
    applyNodeStyle(node, definition.style, { clearFill: true });
    for (const childDefinition of definition.children) {
      const child = await createPageNode({
        definition: childDefinition,
        page,
        parent: node,
        isRoot: false,
        annotationsByNode,
      });
      if (node.layoutMode === "NONE") {
        child.x = childDefinition.x;
        child.y = childDefinition.y;
      } else if (
        definition.layout.align === "stretch" &&
        "layoutAlign" in child
      ) {
        child.layoutAlign = "STRETCH";
      }
    }
  } else if (definition.type === "text") {
    const fontName = await loadPageFont(definition.font);
    node.fontName = fontName;
    node.characters = definition.text;
    node.fontSize = definition.font.size;
    node.lineHeight = {
      unit: "PIXELS",
      value: definition.font.lineHeight,
    };
    node.letterSpacing = {
      unit: "PIXELS",
      value: definition.font.letterSpacing,
    };
    node.textAlignHorizontal = definition.textAlign.toUpperCase();
    node.textAutoResize = "NONE";
    node.resize(definition.width, definition.height);
    applyNodeStyle(node, definition.style);
  } else if (definition.type === "image") {
    applyPageImage(node, definition);
    node.resize(definition.width, definition.height);
  } else {
    node.resize(definition.width, definition.height);
  }

  applyLayoutItem(node, definition.layoutItem);

  const annotations = annotationsByNode?.get(definition.id);
  if (annotations && "annotations" in node) {
    node.annotations = annotations;
  }
  return node;
}

async function loadPageFont(font) {
  const requested = { family: font.family, style: font.style };
  try {
    await figma.loadFontAsync(requested);
    return requested;
  } catch {
    const fallback = { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(fallback);
    return fallback;
  }
}

function applyFrameLayout(frame, layout) {
  frame.layoutMode =
    layout.direction === "horizontal"
      ? "HORIZONTAL"
      : layout.direction === "vertical"
        ? "VERTICAL"
        : "NONE";
  frame.itemSpacing = layout.gap;
  if ("layoutWrap" in frame) {
    frame.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
  }
  if ("counterAxisSpacing" in frame) {
    frame.counterAxisSpacing = layout.counterGap || 0;
  }
  frame.paddingTop = layout.padding.top;
  frame.paddingRight = layout.padding.right;
  frame.paddingBottom = layout.padding.bottom;
  frame.paddingLeft = layout.padding.left;
  if (frame.layoutMode !== "NONE") {
    frame.primaryAxisSizingMode =
      layout.primarySizing === "hug" ? "AUTO" : "FIXED";
    frame.counterAxisSizingMode =
      layout.counterSizing === "hug" ? "AUTO" : "FIXED";
    frame.primaryAxisAlignItems =
      {
        start: "MIN",
        center: "CENTER",
        end: "MAX",
        "space-between": "SPACE_BETWEEN",
      }[layout.justify] || "MIN";
    frame.counterAxisAlignItems =
      {
        start: "MIN",
        center: "CENTER",
        end: "MAX",
        stretch: "MIN",
        baseline: "BASELINE",
      }[layout.align] || "MIN";
  }
}

function applyLayoutItem(node, layoutItem) {
  if (!layoutItem) return;
  const parent = node.parent;
  const hasAutoLayoutParent =
    parent &&
    "layoutMode" in parent &&
    parent.layoutMode !== "NONE";
  if (!hasAutoLayoutParent) return;
  if ("layoutAlign" in node) {
    node.layoutAlign = layoutItem.align === "stretch" ? "STRETCH" : "INHERIT";
  }
  if ("layoutGrow" in node) {
    node.layoutGrow = Number.isFinite(layoutItem.grow) ? layoutItem.grow : 0;
  }
  if ("layoutPositioning" in node) {
    node.layoutPositioning =
      layoutItem.positioning === "absolute" ? "ABSOLUTE" : "AUTO";
  }
  if ("layoutSizingHorizontal" in node) {
    node.layoutSizingHorizontal = layoutItem.horizontalSizing.toUpperCase();
  }
  if ("layoutSizingVertical" in node) {
    node.layoutSizingVertical = layoutItem.verticalSizing.toUpperCase();
  }
}

function applyPageImage(node, definition) {
  if (
    typeof figma.base64Decode !== "function" ||
    typeof figma.createImage !== "function" ||
    !definition?.image?.base64
  ) {
    throw new Error(`Page image ${definition.id} cannot be decoded.`);
  }
  const image = figma.createImage(figma.base64Decode(definition.image.base64));
  node.fills = [{
    type: "IMAGE",
    imageHash: image.hash,
    scaleMode:
      definition.objectFit === "contain"
        ? "FIT"
        : definition.objectFit === "none"
          ? "TILE"
          : "FILL",
    visible: true,
    opacity: 1,
  }];
}

function applyNodeStyle(node, style, { clearFill = false } = {}) {
  if ("fills" in node) {
    const fills = [
      ...(style.fills || []).map(gradientPaint),
      ...(style.fill ? [paintFromHex(style.fill)] : []),
    ];
    if (fills.length > 0) {
      node.fills = fills;
    } else if (clearFill) {
      node.fills = [];
    }
  }
  if ("strokes" in node) {
    node.strokes = style.stroke ? [paintFromHex(style.stroke)] : [];
  }
  if (
    style.strokeWidths &&
    "strokeTopWeight" in node &&
    "strokeRightWeight" in node &&
    "strokeBottomWeight" in node &&
    "strokeLeftWeight" in node
  ) {
    node.strokeTopWeight = style.strokeWidths.top;
    node.strokeRightWeight = style.strokeWidths.right;
    node.strokeBottomWeight = style.strokeWidths.bottom;
    node.strokeLeftWeight = style.strokeWidths.left;
  } else if ("strokeWeight" in node && typeof style.strokeWidth === "number") {
    node.strokeWeight = style.strokeWidth;
  }
  if ("cornerRadius" in node && typeof style.radius === "number") {
    node.cornerRadius = style.radius;
  }
  if ("effects" in node) {
    node.effects = (style.effects || []).map((effect) =>
      effect.type === "background-blur"
        ? {
            type: "BACKGROUND_BLUR",
            radius: effect.blur,
            visible: true,
          }
        : {
            type: "DROP_SHADOW",
            color: rgbaFromHex(effect.color),
            offset: { x: effect.offsetX, y: effect.offsetY },
            radius: effect.blur,
            spread: effect.spread,
            visible: true,
            blendMode: "NORMAL",
          },
    );
  }
}

function gradientPaint(fill) {
  const angle = ((fill.angle ?? 180) * Math.PI) / 180;
  const direction = { x: Math.sin(angle), y: -Math.cos(angle) };
  const perpendicular = { x: -direction.y, y: direction.x };
  const transform =
    fill.type === "radial-gradient"
      ? [
          [1, 0, fill.center.x - 0.5],
          [0, 1, fill.center.y - 0.5],
        ]
      : [
          [
            direction.x,
            direction.y,
            (1 - direction.x - direction.y) / 2,
          ],
          [
            perpendicular.x,
            perpendicular.y,
            (1 - perpendicular.x - perpendicular.y) / 2,
          ],
        ];
  return {
    type: fill.type === "radial-gradient" ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR",
    gradientTransform: transform,
    gradientStops: fill.stops.map((stop) => ({
      position: stop.position,
      color: rgbaFromHex(stop.color),
    })),
    visible: true,
    opacity: 1,
    blendMode: "NORMAL",
  };
}

function rgbaFromHex(value) {
  const paint = paintFromHex(value);
  return { ...paint.color, a: paint.opacity };
}

function paintFromHex(value) {
  const hex = value.slice(1);
  return {
    type: "SOLID",
    color: {
      r: Number.parseInt(hex.slice(0, 2), 16) / 255,
      g: Number.parseInt(hex.slice(2, 4), 16) / 255,
      b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    },
    opacity:
      hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    visible: true,
  };
}

function setPageNodeData(node, page, definition, isRoot) {
  node.setPluginData(ROLE_KEY, isRoot ? ROLE_PAGE_ROOT : ROLE_PAGE_NODE);
  node.setPluginData(PAGE_ID_KEY, page.pageId);
  node.setPluginData(PAGE_NODE_ID_KEY, definition.id);
  node.setPluginData(PAGE_NODE_TYPE_KEY, definition.type);
  node.setPluginData(SOURCE_HASH_KEY, page.sourceHash);
  node.setPluginData(
    PAGE_SOURCE_REF_KEY,
    definition.sourceRef ? JSON.stringify(definition.sourceRef) : "",
  );
  node.setPluginData(
    PAGE_LAYOUT_META_KEY,
    JSON.stringify(definition.type === "frame" ? definition.layout || null : null),
  );
  node.setPluginData(
    PAGE_LAYOUT_ITEM_KEY,
    JSON.stringify(definition.layoutItem || null),
  );
}

function storePageBaselines(root) {
  for (const node of findTrackedPageNodes(root)) {
    node.setPluginData(
      PAGE_BASELINE_KEY,
      JSON.stringify(snapshotNodeProperties(node)),
    );
    if (isTrackedSvgNode(node)) {
      node.setPluginData(
        PAGE_SVG_BASELINE_KEY,
        JSON.stringify(snapshotSvgSubtree(node)),
      );
    }
    node.setPluginData(
      PAGE_ANNOTATION_BASELINE_KEY,
      JSON.stringify(collectDirectFigmaAnnotations(node)),
    );
  }
  root.setPluginData(
    PAGE_STRUCTURE_BASELINE_KEY,
    JSON.stringify(snapshotPageStructure(root)),
  );
  root.setPluginData(PAGE_VECTOR_INSERT_VERSION_KEY, VECTOR_INSERT_VERSION);
}

function ensurePageBaselines(root) {
  for (const node of findTrackedPageNodes(root)) {
    const baseline = readPageBaseline(node);
    if (
      !node.getPluginData(PAGE_BASELINE_KEY) ||
      !("layoutKind" in baseline)
    ) {
      node.setPluginData(
        PAGE_BASELINE_KEY,
        JSON.stringify(snapshotNodeProperties(node)),
      );
    }
    if (
      isTrackedSvgNode(node) &&
      !node.getPluginData(PAGE_SVG_BASELINE_KEY)
    ) {
      node.setPluginData(
        PAGE_SVG_BASELINE_KEY,
        JSON.stringify(snapshotSvgSubtree(node)),
      );
    }
    if (!node.getPluginData(PAGE_ANNOTATION_BASELINE_KEY)) {
      node.setPluginData(
        PAGE_ANNOTATION_BASELINE_KEY,
        JSON.stringify(collectDirectFigmaAnnotations(node)),
      );
    }
  }
  if (!root.getPluginData(PAGE_STRUCTURE_BASELINE_KEY)) {
    root.setPluginData(
      PAGE_STRUCTURE_BASELINE_KEY,
      JSON.stringify(snapshotPageStructure(root)),
    );
  }
  if (
    root.getPluginData(PAGE_VECTOR_INSERT_VERSION_KEY) !==
    VECTOR_INSERT_VERSION
  ) {
    root.setPluginData(
      PAGE_STRUCTURE_BASELINE_KEY,
      JSON.stringify(snapshotPageStructureWithoutUnmappedVectors(root)),
    );
    root.setPluginData(
      PAGE_VECTOR_INSERT_VERSION_KEY,
      VECTOR_INSERT_VERSION,
    );
  }
}

function schedulePageStatus(delay = 240) {
  clearTimeout(pageStatusTimer);
  pageStatusTimer = setTimeout(() => {
    pageStatusTimer = null;
    reportPageStatus();
  }, delay);
}

function reportPageStatus(force = false) {
  const changedPageIds = unsentPageIds();
  const unsentChanges = changedPageIds.length > 0;
  if (!force && unsentChanges === lastReportedUnsentChanges) {
    return;
  }
  lastReportedUnsentChanges = unsentChanges;
  figma.ui.postMessage({
    type: "page.changes.status",
    unsentChanges,
    changedPageIds,
  });
}

function hasUnsentPageChanges() {
  return unsentPageIds().length > 0;
}

function unsentPageIds() {
  return findPageRoots()
    .filter(pageHasUnsentChanges)
    .map((root) => root.getPluginData(PAGE_ID_KEY))
    .filter(Boolean);
}

function pageHasUnsentChanges(root) {
  if (
    pageStructureFingerprint(readPageStructureBaseline(root)) !==
    pageStructureFingerprint(snapshotPageStructure(root))
  ) {
    return true;
  }
  for (const node of findTrackedPageNodes(root)) {
    const baseline = readPageBaseline(node);
    const current = snapshotNodeProperties(node);
    if (node.getPluginData(ROLE_KEY) === ROLE_PAGE_ROOT) {
      delete baseline.x;
      delete baseline.y;
      delete current.x;
      delete current.y;
    }
    if (
      JSON.stringify(baseline) !== JSON.stringify(current) ||
      (isTrackedSvgNode(node) &&
        JSON.stringify(readPageSvgBaseline(node)) !==
          JSON.stringify(snapshotSvgSubtree(node))) ||
      JSON.stringify(readPageAnnotationBaseline(node)) !==
        JSON.stringify(collectDirectFigmaAnnotations(node))
    ) {
      return true;
    }
  }
  return false;
}

function snapshotPageStructure(root) {
  const structure = [];
  const visit = (node) => {
    const pageNodeId = node.getPluginData(PAGE_NODE_ID_KEY);
    const pageNodeType = node.getPluginData(PAGE_NODE_TYPE_KEY);
    const parent = node === root ? null : node.parent;
    const parentLayoutMeta = parent
      ? readJsonPluginData(parent, PAGE_LAYOUT_META_KEY)
      : null;
    const parentLayout =
      parentLayoutMeta?.kind === "grid"
        ? "GRID"
        : parent && "layoutMode" in parent && typeof parent.layoutMode === "string"
          ? parent.layoutMode
          : "NONE";
    structure.push({
      id: node.id,
      parentId: parent?.id || null,
      parentPageNodeId: parent?.getPluginData?.(PAGE_NODE_ID_KEY) || null,
      index:
        parent && "children" in parent
          ? parent.children.indexOf(node)
          : 0,
      type: node.type,
      name: node.name,
      pageNodeId,
      pageNodeType,
      sourceRef: readJsonPluginData(node, PAGE_SOURCE_REF_KEY),
      layoutMeta: readJsonPluginData(node, PAGE_LAYOUT_META_KEY),
      layoutItem: readJsonPluginData(node, PAGE_LAYOUT_ITEM_KEY),
      bounds: snapshotNodeBounds(node),
      worldTransform: snapshotWorldTransform(node),
      parentLayout,
      positioning:
        parentLayout === "NONE"
          ? "ABSOLUTE"
          : "layoutPositioning" in node &&
        typeof node.layoutPositioning === "string"
          ? node.layoutPositioning
          : "AUTO",
      constraints: snapshotConstraints(node),
    });
    if (node !== root && isTrackedSvgNode(node)) {
      return;
    }
    if ("children" in node) {
      for (const child of node.children) {
        if (!child.removed) {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return structure;
}

function snapshotNodeBounds(node) {
  return {
    x: "x" in node && Number.isFinite(node.x) ? round(node.x) : 0,
    y: "y" in node && Number.isFinite(node.y) ? round(node.y) : 0,
    width: "width" in node && Number.isFinite(node.width) ? round(node.width) : 0,
    height:
      "height" in node && Number.isFinite(node.height) ? round(node.height) : 0,
  };
}

function snapshotWorldTransform(node) {
  const transform = "absoluteTransform" in node ? node.absoluteTransform : null;
  if (
    Array.isArray(transform) &&
    transform.length === 2 &&
    transform.every((row) => Array.isArray(row) && row.length === 3)
  ) {
    return [
      round(transform[0][0]),
      round(transform[1][0]),
      round(transform[0][1]),
      round(transform[1][1]),
      round(transform[0][2]),
      round(transform[1][2]),
    ];
  }
  let x = 0;
  let y = 0;
  let current = node;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if ("x" in current && Number.isFinite(current.x)) x += current.x;
    if ("y" in current && Number.isFinite(current.y)) y += current.y;
    current = current.parent;
  }
  return [1, 0, 0, 1, round(x), round(y)];
}

function snapshotConstraints(node) {
  if (!("constraints" in node) || !node.constraints) return null;
  const horizontal = node.constraints.horizontal;
  const vertical = node.constraints.vertical;
  return typeof horizontal === "string" && typeof vertical === "string"
    ? { horizontal, vertical }
    : null;
}

function snapshotPageStructureWithoutUnmappedVectors(root) {
  const insertedNodeIds = new Set();
  const structure = snapshotPageStructure(root);
  const entriesByPageNodeId = new Map();
  for (const entry of structure) {
    if (!entry.pageNodeId) continue;
    const matches = entriesByPageNodeId.get(entry.pageNodeId) || [];
    matches.push(entry);
    entriesByPageNodeId.set(entry.pageNodeId, matches);
  }
  for (const matches of entriesByPageNodeId.values()) {
    if (matches.length < 2) continue;
    const original = [...matches].sort((left, right) =>
      compareFigmaNodeIds(left.id, right.id),
    )[0];
    for (const entry of matches) {
      if (entry.id === original.id) continue;
      const node = findPageDescendantById(root, entry.id);
      if (!node) continue;
      for (const nodeId of pageSubtreeNodeIds(node)) {
        insertedNodeIds.add(nodeId);
      }
    }
  }
  for (const entry of structure) {
    if (entry.pageNodeId || insertedNodeIds.has(entry.id)) continue;
    const node = findPageDescendantById(root, entry.id);
    if (
      node &&
      (isInsertablePageVector(node) || insertedPageNodeType(node))
    ) {
      for (const nodeId of pageSubtreeNodeIds(node)) {
        insertedNodeIds.add(nodeId);
      }
    }
  }
  return structure.filter(
    (entry) => !insertedNodeIds.has(entry.id),
  );
}

function compareFigmaNodeIds(left, right) {
  const leftParts = String(left).split(":").map(Number);
  const rightParts = String(right).split(":").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return String(left).localeCompare(String(right));
}

function readPageStructureBaseline(root) {
  try {
    const parsed = JSON.parse(
      root.getPluginData(PAGE_STRUCTURE_BASELINE_KEY) || "[]",
    );
    return Array.isArray(parsed)
      ? collapseTrackedSvgDescendants(root, parsed)
      : [];
  } catch {
    return [];
  }
}

function collapseTrackedSvgDescendants(root, structure) {
  const svgNodeIds = new Set(
    findTrackedPageNodes(root)
      .filter(isTrackedSvgNode)
      .map((node) => node.id),
  );
  if (svgNodeIds.size === 0) {
    return structure;
  }
  const nodesById = new Map(structure.map((node) => [node.id, node]));
  return structure.filter((node) => {
    let parentId = node.parentId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (svgNodeIds.has(parentId)) {
        return false;
      }
      visited.add(parentId);
      parentId = nodesById.get(parentId)?.parentId || null;
    }
    return true;
  });
}

function acceptPageChanges(message) {
  if (
    typeof message.pageId !== "string" ||
    typeof message.sourceHash !== "string"
  ) {
    return;
  }
  const root = findPageRoot(message.pageId);
  if (
    !root ||
    root.getPluginData(SOURCE_HASH_KEY) !== message.sourceHash
  ) {
    return;
  }
  storePageBaselines(root);
  reportPageStatus(true);
}

function capturePagePreservedState(root) {
  const annotationsByNode = new Map();
  for (const node of findTrackedPageNodes(root)) {
    annotationsByNode.set(
      node.getPluginData(PAGE_NODE_ID_KEY),
      collectDirectFigmaAnnotations(node),
    );
  }
  const selectedNodeIds = figma.currentPage.selection
    .map((node) => findPageNodeAncestor(node))
    .filter(Boolean)
    .filter((node) => isDescendantOf(node, root))
    .map((node) => node.getPluginData(PAGE_NODE_ID_KEY));
  return { annotationsByNode, selectedNodeIds };
}

function capturePreservedState(root) {
  const annotationsByElement = new Map();
  for (const target of findTargets(root)) {
    annotationsByElement.set(
      target.getPluginData(ELEMENT_ID_KEY),
      collectFigmaAnnotations(target),
    );
  }

  const selectedElementIds = figma.currentPage.selection
    .map((node) => findTargetAncestor(node))
    .filter(Boolean)
    .filter((target) => isDescendantOf(target, root))
    .map((target) => target.getPluginData(ELEMENT_ID_KEY));

  return { annotationsByElement, selectedElementIds };
}

function scheduleFeedback(target, context) {
  const key = targetKey(target);
  const previous = pendingFlushes.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    previous.context.propertiesChanged ||= context.propertiesChanged;
    previous.context.annotationsChanged ||= context.annotationsChanged;
    previous.context.origin = context.origin;
    previous.context.changedNodeId = context.changedNodeId;
    for (const changedNode of context.changedNodes || []) {
      const index = previous.context.changedNodes.findIndex(
        (candidate) => candidate.id === changedNode.id,
      );
      if (index >= 0) {
        previous.context.changedNodes[index] = changedNode;
      } else {
        previous.context.changedNodes.push(changedNode);
      }
    }
    previous.timer = setTimeout(
      () => flushFeedback(key, target, previous.context),
      220,
    );
    return;
  }

  const entry = {
    context: {
      ...context,
      changedNodes: [...(context.changedNodes || [])],
    },
    timer: setTimeout(() => flushFeedback(key, target, context), 220),
  };
  pendingFlushes.set(key, entry);
}

function flushFeedback(key, target, context) {
  pendingFlushes.delete(key);
  if (target.removed) {
    snapshots.delete(key);
    return;
  }

  const previous = snapshots.get(key) || {
    nodes: {},
    annotations: [],
  };
  const current = snapshotTarget(target);
  snapshots.set(key, current);

  if (context.propertiesChanged) {
    const changes = [];
    for (const changedNode of context.changedNodes || []) {
      const before = previous.nodes[changedNode.id];
      const after = current.nodes[changedNode.id];
      if (!before || !after) {
        continue;
      }
      for (const change of diffObject(before.properties, after.properties)) {
        changes.push({
          category: propertyCategory(change.property),
          ...change,
          nodeId: after.id,
          nodeName: after.name,
          nodeType: after.type,
        });
      }
    }
    if (changes.length > 0) {
      emitFeedback(target, "properties", {
        changes,
        annotations: [],
        context,
      });
    }
  }

  if (context.annotationsChanged) {
    if (JSON.stringify(previous.annotations) !== JSON.stringify(current.annotations)) {
      emitFeedback(target, "annotations", {
        changes: [],
        annotations: current.annotations,
        context,
      });
    }
  }
}

function captureCurrentFeedback() {
  let count = 0;
  for (const root of findAssetRoots()) {
    for (const target of findTargets(root)) {
      const current = snapshotTarget(target);
      snapshots.set(targetKey(target), current);
      if (current.annotations.length > 0) {
        emitFeedback(target, "annotations", {
          changes: [],
          annotations: current.annotations,
          context: {
            origin: "LOCAL",
            changedNodeId: target.id,
            manual: true,
          },
        });
        count += 1;
      }
    }
  }
  figma.ui.postMessage({
    type: "notice",
    level: "info",
    message: count > 0 ? `Sent annotations for ${count} element(s).` : "No annotations found.",
  });
}

async function capturePageChanges(captureRequestId = null) {
  let sent = 0;
  for (const root of findPageRoots()) {
    const previousStructure = readPageStructureBaseline(root);
    const clonedSubtrees = prepareInsertedPageClones(
      root,
      previousStructure,
    );
    const insertedPageNodes = await prepareInsertedPageNodes(
      root,
      previousStructure,
      clonedSubtrees.nodeIds,
    );
    const changes = [
      ...clonedSubtrees.changes,
      ...insertedPageNodes.changes,
    ];
    const pageMoves = capturePageMoves(
      previousStructure,
      snapshotPageStructure(root),
    );
    changes.push(...pageMoves.changes);
    const atomicMoveNodeIds = new Set([
      ...pageMoves.currentNodeIds,
      ...clonedSubtrees.moveNodeIds,
    ]);
    const layoutOrderChanges = capturePageReorders(
      previousStructure,
      snapshotPageStructure(root),
      atomicMoveNodeIds,
    );
    const annotations = [];
    for (const node of findTrackedPageNodes(root)) {
      const nodeId = node.getPluginData(PAGE_NODE_ID_KEY);
      const baseline = readPageBaseline(node);
      const current = snapshotNodeProperties(node);
      const sourceRef = readJsonPluginData(node, PAGE_SOURCE_REF_KEY);
      for (const change of diffObject(baseline, current)) {
        if (
          ((node.getPluginData(ROLE_KEY) === ROLE_PAGE_ROOT) ||
            clonedSubtrees.nodeIds.has(node.id) ||
            atomicMoveNodeIds.has(node.id) ||
            layoutOrderChanges.currentNodeIds.has(node.id)) &&
          ["x", "y"].includes(change.property)
        ) {
          continue;
        }
        const pageChange = {
          nodeId,
          nodeName: node.name,
          nodeType: node.type,
          sourceRef,
          category: propertyCategory(change.property),
          ...change,
        };
        if (change.property === "stroke") {
          pageChange.strokeWeight = current.strokeWeight;
        }
        if (LAYOUT_PROPERTIES.has(change.property)) {
          pageChange.layoutContext = {
            layoutMode: current.layoutMode,
            width: current.width,
            height: current.height,
          };
        }
        changes.push(pageChange);
      }
      if (
        isTrackedSvgNode(node) &&
        JSON.stringify(readPageSvgBaseline(node)) !==
          JSON.stringify(snapshotSvgSubtree(node))
      ) {
        const previousSvg = readPageSvgBaseline(node);
        const currentSvg = snapshotSvgSubtree(node);
        if (
          previousSvg.length > 0 &&
          currentSvg.length === 0 &&
          hasStablePageSelector(sourceRef)
        ) {
          changes.push({
            nodeId,
            nodeName: node.name,
            nodeType: "SVG",
            sourceRef,
            category: "structure",
            property: "nodeDelete",
            from: previousSvg,
            to: null,
          });
          continue;
        }
        try {
          changes.push({
            nodeId,
            nodeName: node.name,
            nodeType: "SVG",
            sourceRef,
            category: "vector",
            property: "svg",
            from: null,
            to: await exportTrackedPageSvg(node),
          });
        } catch (error) {
          changes.push({
            nodeId,
            nodeName: node.name,
            nodeType: "SVG",
            sourceRef,
            category: "vector",
            property: "svgUnavailable",
            from: previousSvg,
            to: currentSvg,
            error:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
      const previousAnnotations = readPageAnnotationBaseline(node);
      const currentAnnotations = collectDirectFigmaAnnotations(node);
      if (
        JSON.stringify(previousAnnotations) !==
        JSON.stringify(currentAnnotations)
      ) {
        for (const annotation of currentAnnotations) {
          annotations.push({
            ...annotation,
            nodeId,
            nodeName: node.name,
            nodeType: node.type,
            sourceRef,
          });
        }
      }
    }

    const insertedVectors = await captureInsertedPageVectors(
      root,
      previousStructure,
      new Set([
        ...clonedSubtrees.nodeIds,
        ...insertedPageNodes.nodeIds,
      ]),
    );
    changes.push(...insertedVectors.changes);
    const currentStructure = snapshotPageStructure(root);
    const deletedLeaves = captureDeletedPageSubtrees(
      previousStructure,
      currentStructure,
      clonedSubtrees.replacedPreviousNodeIds,
    );
    changes.push(...deletedLeaves.changes);
    const reorderedChildren = capturePageReorders(
      previousStructure,
      currentStructure,
      atomicMoveNodeIds,
    );
    changes.push(...reorderedChildren.changes);
    const remainingPreviousStructure = previousStructure.filter(
      (entry) =>
        !deletedLeaves.nodeIds.has(entry.id) &&
        !reorderedChildren.previousNodeIds.has(entry.id) &&
        !pageMoves.previousNodeIds.has(entry.id) &&
        !clonedSubtrees.replacedPreviousNodeIds.has(entry.id),
    );
    const remainingStructure = currentStructure.filter(
      (entry) =>
        !insertedVectors.nodeIds.has(entry.id) &&
        !clonedSubtrees.nodeIds.has(entry.id) &&
        !insertedPageNodes.nodeIds.has(entry.id) &&
        !reorderedChildren.currentNodeIds.has(entry.id) &&
        !pageMoves.currentNodeIds.has(entry.id),
    );
    if (
      pageStructureFingerprint(remainingPreviousStructure) !==
      pageStructureFingerprint(remainingStructure)
    ) {
      changes.push({
        nodeId: root.getPluginData(PAGE_NODE_ID_KEY),
        nodeName: root.name,
        nodeType: root.type,
        sourceRef: readJsonPluginData(root, PAGE_SOURCE_REF_KEY),
        category: "structure",
        property: "structure",
        from: remainingPreviousStructure,
        to: remainingStructure,
      });
    }

    if (changes.length === 0 && annotations.length === 0) {
      continue;
    }
    const changeSetId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    figma.ui.postMessage({
      type: "page.changes.emit",
      requestId: captureRequestId || changeSetId,
      changeSet: {
        protocolVersion: PAGE_CHANGE_PROTOCOL_VERSION,
        changeSetId,
        pageId: root.getPluginData(PAGE_ID_KEY),
        sourceHash: root.getPluginData(SOURCE_HASH_KEY),
        changes,
        annotations,
        figma: {
          pageName: figma.currentPage.name,
          rootNodeId: root.id,
          rootNodeName: root.name,
        },
      },
    });
    sent += 1;
  }
  figma.ui.postMessage({
    type: "page.changes.complete",
    requestId: captureRequestId,
    count: sent,
  });
  figma.ui.postMessage({
    type: "notice",
    level: "info",
    message:
      sent > 0
        ? `Submitted ${sent} page change set(s).`
        : "No page changes or annotations found.",
  });
  if (sent === 0) {
    figma.ui.postMessage({
      type: "page.changes.empty",
      requestId:
        captureRequestId ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
  }
  reportPageStatus(true);
}

async function captureSelectedPageSeed(message) {
  const pageId = typeof message.pageId === "string" ? message.pageId.trim() : "";
  const sourceHash =
    typeof message.sourceHash === "string" ? message.sourceHash.trim() : "";
  const requestId =
    typeof message.requestId === "string" && message.requestId
      ? message.requestId
      : `figma-seed-${Date.now()}`;
  if (!pageId || !sourceHash) {
    throw new Error("当前 CDB 页面缺少可用映射。");
  }
  if (findPageRoot(pageId)) {
    throw new Error("当前页面已经从 Figma 建立过映射。");
  }
  const selection = figma.currentPage.selection.filter((node) => !node.removed);
  if (selection.length !== 1) {
    throw new Error("请只选择一个完整的页面 Frame。");
  }
  const root = selection[0];
  if (!INSERTABLE_PAGE_FRAME_TYPES.has(root.type)) {
    throw new Error("请选择 Frame、Component、Instance 或 Group 作为完整页面。");
  }

  const serialized = await serializeInsertedPageNode(root);
  const sourceRef = { selector: '[data-codex-id="page-root"]' };
  const definition = {
    ...serialized.definition,
    id: "page-root",
    type: "frame",
    tag: "main",
    sourceRef,
  };
  setPageNodeData(
    root,
    { pageId, sourceHash },
    definition,
    true,
  );
  for (const mapping of serialized.mappings.slice(1)) {
    setInsertedPageNodeData(
      root,
      mapping.node,
      mapping.nodeId,
      mapping.pageNodeType,
    );
  }
  ensurePageBaselines(root);
  indexCurrentPage();

  const changeSetId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  figma.ui.postMessage({
    type: "page.changes.emit",
    requestId,
    changeSet: {
      protocolVersion: PAGE_CHANGE_PROTOCOL_VERSION,
      changeSetId,
      pageId,
      sourceHash,
      changes: [{
        nodeId: "page-root",
        nodeName: root.name,
        nodeType: root.type,
        sourceRef,
        category: "structure",
        property: "pageSeed",
        from: null,
        to: { node: definition },
      }],
      annotations: [],
      figma: {
        pageName: figma.currentPage.name,
        rootNodeId: root.id,
        rootNodeName: root.name,
      },
    },
  });
  figma.ui.postMessage({
    type: "page.changes.complete",
    requestId,
    count: 1,
  });
  reportPageStatus(true);
}

function pageStructureFingerprint(structure) {
  return JSON.stringify(
    structure.map(
      ({
        name: _name,
        index: _index,
        bounds: _bounds,
        worldTransform: _worldTransform,
        parentLayout: _parentLayout,
        positioning: _positioning,
        constraints: _constraints,
        layoutMeta: _layoutMeta,
        layoutItem: _layoutItem,
        ...entry
      }) => entry,
    ),
  );
}

function prepareInsertedPageClones(root, previousStructure) {
  const previousFigmaNodeIds = new Set(
    previousStructure.map((entry) => entry.id),
  );
  const previousPageNodeIds = new Set(
    previousStructure
      .map((entry) => entry.pageNodeId)
      .filter(Boolean),
  );
  const currentStructure = snapshotPageStructure(root);
  const currentFigmaNodeIds = new Set(
    currentStructure.map((entry) => entry.id),
  );
  const previousByPageNodeId = new Map(
    previousStructure
      .filter((entry) => entry.pageNodeId)
      .map((entry) => [entry.pageNodeId, entry]),
  );
  const previousById = new Map(
    previousStructure.map((entry) => [entry.id, entry]),
  );
  const currentById = new Map(
    currentStructure.map((entry) => [entry.id, entry]),
  );
  const previousChildren = pageChildrenByParent(previousStructure);
  const changes = [];
  const nodeIds = new Set();
  const moveNodeIds = new Set();
  const replacedPreviousNodeIds = new Set();
  for (const entry of currentStructure) {
    if (
      previousFigmaNodeIds.has(entry.id) ||
      !previousFigmaNodeIds.has(entry.parentId) ||
      !CLONEABLE_PAGE_TYPES.has(entry.pageNodeType) ||
      !previousPageNodeIds.has(entry.pageNodeId) ||
      !hasStablePageSelector(entry.sourceRef)
    ) {
      continue;
    }
    const node = findPageDescendantById(root, entry.id);
    if (!node) {
      continue;
    }
    const original = previousByPageNodeId.get(entry.pageNodeId);
    const replacesDeletedOriginal =
      original && !currentFigmaNodeIds.has(original.id);
    const idMap = [];
    const descendants =
      typeof node.findAll === "function"
        ? node.findAll(
            (descendant) =>
              descendant.getPluginData(ROLE_KEY) === ROLE_PAGE_NODE,
          )
        : [];
    for (const candidate of [node, ...descendants]) {
      const previousNodeId = candidate.getPluginData(PAGE_NODE_ID_KEY);
      if (!previousNodeId) {
        continue;
      }
      const nextNodeId = replacesDeletedOriginal
        ? previousNodeId
        : `figma-clone-${normalizeNodeId(candidate.id)}`;
      const previousSourceRef = readJsonPluginData(
        candidate,
        PAGE_SOURCE_REF_KEY,
      );
      if (!replacesDeletedOriginal) {
        candidate.setPluginData(PAGE_NODE_ID_KEY, nextNodeId);
        candidate.setPluginData(
          PAGE_SOURCE_REF_KEY,
          JSON.stringify({
            ...previousSourceRef,
            selector: `[data-codex-id="${nextNodeId}"]`,
          }),
        );
      }
      idMap.push({ from: previousNodeId, to: nextNodeId });
    }
    for (const nodeId of pageSubtreeNodeIds(node)) {
      nodeIds.add(nodeId);
    }
    const parent = node.parent;
    const rootMapping = idMap[0];
    if (!rootMapping || !parent) {
      continue;
    }
    if (replacesDeletedOriginal) {
      const previousParent = previousById.get(original.parentId);
      const currentParent = currentById.get(entry.parentId);
      if (
        !previousParent?.pageNodeId ||
        !currentParent?.pageNodeId ||
        !hasStablePageSelector(previousParent.sourceRef) ||
        !hasStablePageSelector(currentParent.sourceRef)
      ) {
        continue;
      }
      changes.push({
        nodeId: original.pageNodeId,
        nodeName: node.name,
        nodeType: entry.type,
        sourceRef: original.sourceRef,
        category: "structure",
        property: "nodeReparent",
        replacement: true,
        fromParentId: previousParent.pageNodeId,
        toParentId: currentParent.pageNodeId,
        fromParentSourceRef: previousParent.sourceRef,
        toParentSourceRef: currentParent.sourceRef,
        fromIndex: original.index,
        toIndex: entry.index,
        beforeBounds: original.bounds,
        afterBounds: entry.bounds,
        beforeWorldTransform: original.worldTransform,
        afterWorldTransform: entry.worldTransform,
        parentLayout: entry.parentLayout,
        positioning: entry.positioning,
        constraints: entry.constraints,
        grid: gridPlacement(entry, currentParent),
        layerOrder: entry.index,
        from: original,
        to: entry,
      });
      for (const nodeId of pageSubtreeNodeIds(node)) {
        moveNodeIds.add(nodeId);
      }
      addPageStructureSubtreeIds(
        original.id,
        previousChildren,
        replacedPreviousNodeIds,
      );
      continue;
    }
    changes.push({
      nodeId: parent.getPluginData(PAGE_NODE_ID_KEY),
      nodeName: node.name,
      nodeType: entry.pageNodeType.toUpperCase(),
      sourceRef: entry.sourceRef,
      category: "structure",
      property: "nodeClone",
      from: {
        nodeId: entry.pageNodeId,
        sourceRef: entry.sourceRef,
      },
      to: {
        nodeId: rootMapping.to,
        parentSourceRef: readJsonPluginData(parent, PAGE_SOURCE_REF_KEY),
        idMap,
      },
    });
  }
  return {
    changes,
    nodeIds,
    moveNodeIds,
    replacedPreviousNodeIds,
  };
}

async function prepareInsertedPageNodes(
  root,
  previousStructure,
  excludedNodeIds,
) {
  const previousFigmaNodeIds = new Set(
    previousStructure.map((entry) => entry.id),
  );
  const currentStructure = snapshotPageStructure(root);
  const changes = [];
  const nodeIds = new Set();
  for (const entry of currentStructure) {
    if (
      previousFigmaNodeIds.has(entry.id) ||
      excludedNodeIds.has(entry.id) ||
      nodeIds.has(entry.id) ||
      !previousFigmaNodeIds.has(entry.parentId) ||
      entry.pageNodeId
    ) {
      continue;
    }
    const node = findPageDescendantById(root, entry.id);
    if (
      !node ||
      (isInsertablePageVector(node) && !hasVisibleImageFill(node))
    ) {
      continue;
    }
    const parent = node.parent;
    const parentSourceRef = parent
      ? readJsonPluginData(parent, PAGE_SOURCE_REF_KEY)
      : null;
    if (!parent || !hasStablePageSelector(parentSourceRef)) {
      continue;
    }
    try {
      const serialized = await serializeInsertedPageNode(node);
      for (const mapping of serialized.mappings) {
        setInsertedPageNodeData(
          root,
          mapping.node,
          mapping.nodeId,
          mapping.pageNodeType,
        );
      }
      for (const nodeId of pageSubtreeNodeIds(node)) {
        nodeIds.add(nodeId);
      }
      changes.push({
        nodeId: parent.getPluginData(PAGE_NODE_ID_KEY),
        nodeName: node.name,
        nodeType: node.type,
        sourceRef: parentSourceRef,
        category: "structure",
        property: "nodeInsert",
        from: null,
        to: {
          parentSourceRef,
          node: serialized.definition,
        },
      });
    } catch {
      // Keep unsupported nodes or failed exports in the fallback structure diff.
    }
  }
  return { changes, nodeIds };
}

async function serializeInsertedPageNode(rootNode) {
  const state = { count: 0, mappings: [] };
  const visit = async (node) => {
    state.count += 1;
    if (state.count > MAX_INSERTED_PAGE_NODES) {
      throw new Error("The inserted subtree exceeds 200 nodes.");
    }
    const pageNodeType = insertedPageNodeType(node);
    if (!pageNodeType) {
      throw new Error(`Unsupported inserted node type: ${node.type}`);
    }
    const nodeId = `figma-node-${normalizeNodeId(node.id)}`;
    const sourceRef = {
      selector: `[data-codex-id="${nodeId}"]`,
    };
    state.mappings.push({ node, nodeId, pageNodeType });
    const properties = snapshotNodeProperties(node);
    const definition = {
      id: nodeId,
      type: pageNodeType,
      tag: insertedMarkupTag(node, pageNodeType),
      name: node.name || nodeId,
      sourceRef,
      width: positivePageDimension(node.width),
      height: positivePageDimension(node.height),
      opacity:
        Number.isFinite(node.opacity) && node.opacity >= 0 && node.opacity <= 1
          ? round(node.opacity)
          : 1,
      visible: typeof node.visible === "boolean" ? node.visible : true,
      rotation: Number.isFinite(node.rotation) ? round(node.rotation) : 0,
      style: {
        fill: properties.fill,
        stroke: properties.stroke,
        strokeWeight: properties.strokeWeight,
        cornerRadius: properties.cornerRadius,
      },
      layoutItem: {
        align: properties.layoutAlign === "STRETCH" ? "stretch" : "auto",
        grow: Number.isFinite(properties.layoutGrow) ? properties.layoutGrow : 0,
        shrink: 1,
        basis: "auto",
        order:
          node.parent && "children" in node.parent
            ? node.parent.children.indexOf(node)
            : 0,
        positioning:
          properties.layoutPositioning === "ABSOLUTE" ? "absolute" : "auto",
        horizontalSizing: String(
          properties.layoutSizingHorizontal || "FIXED",
        ).toLowerCase(),
        verticalSizing: String(
          properties.layoutSizingVertical || "FIXED",
        ).toLowerCase(),
      },
    };
    if (pageNodeType === "text") {
      return {
        ...definition,
        text: typeof node.characters === "string" ? node.characters : "",
        fontName: properties.fontName,
        fontSize: properties.fontSize,
        lineHeight: properties.lineHeight,
        letterSpacing: properties.letterSpacing,
        textAlignHorizontal: properties.textAlignHorizontal,
        textAlignVertical: properties.textAlignVertical,
        textCase: properties.textCase,
        textDecoration: properties.textDecoration,
      };
    }
    if (pageNodeType === "svg") {
      const bytes = await node.exportAsync({
        format: "SVG",
        svgIdAttribute: true,
      });
      if (bytes.length === 0 || bytes.length > 768 * 1024) {
        throw new Error("The inserted SVG exceeds the 768 KB sync limit.");
      }
      return {
        ...definition,
        svg: {
          mimeType: "image/svg+xml",
          base64: encodeBase64(bytes),
        },
      };
    }
    if (pageNodeType === "image") {
      const bytes = await node.exportAsync({ format: "PNG" });
      if (bytes.length === 0 || bytes.length > MAX_INSERTED_IMAGE_BYTES) {
        throw new Error("The inserted image exceeds the 2 MB sync limit.");
      }
      return {
        ...definition,
        image: {
          mimeType: "image/png",
          base64: encodeBase64(bytes),
        },
      };
    }
    const children = [];
    if ("children" in node) {
      for (const child of node.children) {
        if (!child.removed) {
          children.push(await visit(child));
        }
      }
    }
    return {
      ...definition,
      layout: {
        kind: properties.layoutMode === "NONE" ? "none" : "flex",
        mode: properties.layoutMode,
        direction:
          properties.layoutMode === "HORIZONTAL"
            ? "horizontal"
            : properties.layoutMode === "VERTICAL"
              ? "vertical"
              : "none",
        wrap: properties.layoutWrap === "WRAP",
        itemSpacing: properties.itemSpacing,
        counterAxisSpacing: properties.counterAxisSpacing,
        padding: properties.padding,
        primaryAxisAlignItems: properties.primaryAxisAlignItems,
        counterAxisAlignItems: properties.counterAxisAlignItems,
        primaryAxisSizingMode: properties.primaryAxisSizingMode,
        counterAxisSizingMode: properties.counterAxisSizingMode,
      },
      children,
    };
  };
  return {
    definition: await visit(rootNode),
    mappings: state.mappings,
  };
}

function insertedPageNodeType(node) {
  if (node.type === "TEXT") {
    return "text";
  }
  if (hasVisibleImageFill(node)) {
    return "image";
  }
  const vectorTree = isInsertablePageVectorTree(node);
  if (vectorTree.supported && vectorTree.hasVector) {
    return "svg";
  }
  return INSERTABLE_PAGE_FRAME_TYPES.has(node.type) ? "frame" : "";
}

function hasVisibleImageFill(node) {
  return (
    "fills" in node &&
    Array.isArray(node.fills) &&
    node.fills.some(
      (paint) => paint?.type === "IMAGE" && paint.visible !== false,
    )
  );
}

function insertedMarkupTag(node, pageNodeType) {
  if (pageNodeType === "text") return "span";
  if (pageNodeType === "image") return "img";
  if (pageNodeType === "svg") return "svg";
  const name = String(node.name || "").trim().toLowerCase();
  if (/(^|[\s_-])(button|btn|cta)([\s_-]|$)/.test(name)) return "button";
  for (const tag of [
    "main",
    "nav",
    "header",
    "footer",
    "section",
    "article",
    "aside",
    "form",
  ]) {
    if (name === tag || name.startsWith(`${tag}-`) || name.startsWith(`${tag} `)) {
      return tag;
    }
  }
  return "div";
}

function positivePageDimension(value) {
  return Number.isFinite(value) && value > 0 ? round(value) : 1;
}

function setInsertedPageNodeData(root, node, nodeId, pageNodeType) {
  node.setPluginData(ROLE_KEY, ROLE_PAGE_NODE);
  node.setPluginData(PAGE_ID_KEY, root.getPluginData(PAGE_ID_KEY));
  node.setPluginData(PAGE_NODE_ID_KEY, nodeId);
  node.setPluginData(PAGE_NODE_TYPE_KEY, pageNodeType);
  node.setPluginData(SOURCE_HASH_KEY, root.getPluginData(SOURCE_HASH_KEY));
  node.setPluginData(
    PAGE_SOURCE_REF_KEY,
    JSON.stringify({ selector: `[data-codex-id="${nodeId}"]` }),
  );
}

function captureDeletedPageSubtrees(
  previousStructure,
  currentStructure,
  excludedNodeIds = new Set(),
) {
  const currentNodeIds = new Set(
    currentStructure.map((entry) => entry.id),
  );
  const childrenByParentId = new Map();
  for (const entry of previousStructure) {
    if (!entry.parentId) {
      continue;
    }
    const children = childrenByParentId.get(entry.parentId) || [];
    children.push(entry.id);
    childrenByParentId.set(entry.parentId, children);
  }
  const changes = [];
  const nodeIds = new Set();
  for (const entry of previousStructure) {
    if (
      excludedNodeIds.has(entry.id) ||
      currentNodeIds.has(entry.id) ||
      !entry.parentId ||
      !currentNodeIds.has(entry.parentId) ||
      !SAFE_PAGE_DELETE_TYPES.has(entry.pageNodeType) ||
      typeof entry.pageNodeId !== "string" ||
      entry.pageNodeId === "" ||
      !hasStablePageSelector(entry.sourceRef)
    ) {
      continue;
    }
    changes.push({
      nodeId: entry.pageNodeId,
      nodeName: entry.name,
      nodeType: entry.pageNodeType.toUpperCase(),
      sourceRef: entry.sourceRef,
      category: "structure",
      property: "nodeDelete",
      from: entry,
      to: null,
    });
    const stack = [entry.id];
    while (stack.length > 0) {
      const nodeId = stack.pop();
      if (nodeIds.has(nodeId)) {
        continue;
      }
      nodeIds.add(nodeId);
      stack.push(...(childrenByParentId.get(nodeId) || []));
    }
  }
  return { changes, nodeIds };
}

function capturePageMoves(previousStructure, currentStructure) {
  const previousById = new Map(
    previousStructure.map((entry) => [entry.id, entry]),
  );
  const currentById = new Map(
    currentStructure.map((entry) => [entry.id, entry]),
  );
  const previousChildren = pageChildrenByParent(previousStructure);
  const currentChildren = pageChildrenByParent(currentStructure);
  const changes = [];
  const previousNodeIds = new Set();
  const currentNodeIds = new Set();
  for (const current of currentStructure) {
    const previous = previousById.get(current.id);
    if (
      !previous ||
      previous.parentId === current.parentId ||
      !previous.parentId ||
      !current.parentId ||
      !current.pageNodeId ||
      !hasStablePageSelector(previous.sourceRef) ||
      !hasStablePageSelector(current.sourceRef)
    ) {
      continue;
    }
    const previousParent = previousById.get(previous.parentId);
    const currentParent = currentById.get(current.parentId);
    if (
      !previousParent?.pageNodeId ||
      !currentParent?.pageNodeId ||
      !hasStablePageSelector(previousParent.sourceRef) ||
      !hasStablePageSelector(currentParent.sourceRef)
    ) {
      continue;
    }
    changes.push({
      nodeId: current.pageNodeId,
      nodeName: current.name,
      nodeType: current.type,
      sourceRef: current.sourceRef,
      category: "structure",
      property: "nodeReparent",
      fromParentId: previousParent.pageNodeId,
      toParentId: currentParent.pageNodeId,
      fromParentSourceRef: previousParent.sourceRef,
      toParentSourceRef: currentParent.sourceRef,
      fromIndex: previous.index,
      toIndex: current.index,
      beforeBounds: previous.bounds,
      afterBounds: current.bounds,
      beforeWorldTransform: previous.worldTransform,
      afterWorldTransform: current.worldTransform,
      parentLayout: current.parentLayout,
      positioning: current.positioning,
      constraints: current.constraints,
      grid: gridPlacement(current, currentParent),
      layerOrder: current.index,
      from: previous,
      to: current,
    });
    addPageStructureSubtreeIds(
      previous.id,
      previousChildren,
      previousNodeIds,
    );
    addPageStructureSubtreeIds(
      current.id,
      currentChildren,
      currentNodeIds,
    );
  }
  return { changes, previousNodeIds, currentNodeIds };
}

function gridPlacement(entry, parent) {
  if (parent?.layoutMeta?.kind !== "grid") return null;
  const columns = gridTrackCount(parent.layoutMeta?.grid?.columns);
  const index = Number.isInteger(entry.index) ? entry.index : 0;
  return {
    row: Math.floor(index / columns) + 1,
    column: (index % columns) + 1,
  };
}

function gridTrackCount(value) {
  const source = String(value || "").trim();
  if (!source || source === "none") return 1;
  const repeat = source.match(/^repeat\(\s*(\d+)\s*,/i);
  if (repeat) return Math.max(1, Number.parseInt(repeat[1], 10));
  let depth = 0;
  let count = 0;
  let inToken = false;
  for (const character of source) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (inToken) count += 1;
      inToken = false;
    } else {
      inToken = true;
    }
  }
  return Math.max(1, count + (inToken ? 1 : 0));
}

function capturePageReorders(
  previousStructure,
  currentStructure,
  excludedNodeIds = new Set(),
) {
  const previousById = new Map(
    previousStructure.map((entry) => [entry.id, entry]),
  );
  const currentById = new Map(
    currentStructure.map((entry) => [entry.id, entry]),
  );
  const previousChildren = pageChildrenByParent(previousStructure);
  const currentChildren = pageChildrenByParent(currentStructure);
  const parentEntries = currentStructure
    .filter(
      (entry) =>
        previousById.has(entry.id) &&
        hasStablePageSelector(entry.sourceRef),
    )
    .sort(
      (left, right) =>
        pageStructureDepth(right, currentById) -
        pageStructureDepth(left, currentById),
    );
  const changes = [];
  const previousNodeIds = new Set();
  const currentNodeIds = new Set();
  for (const parent of parentEntries) {
    const before = (previousChildren.get(parent.id) || []).filter(
      (entry) => !excludedNodeIds.has(entry.id),
    );
    const after = (currentChildren.get(parent.id) || []).filter(
      (entry) => !excludedNodeIds.has(entry.id),
    );
    if (
      after.length === 0 ||
      after.some(
        (entry) =>
          !entry.pageNodeId || !hasStablePageSelector(entry.sourceRef),
      )
    ) {
      continue;
    }
    const beforeOrder = before.map(pageStructureChildIdentity);
    const afterOrder = after.map(pageStructureChildIdentity);
    if (JSON.stringify(beforeOrder) === JSON.stringify(afterOrder)) {
      continue;
    }
    const beforeFigmaNodeIds = new Set(before.map((entry) => entry.id));
    const sameChildren =
      before.length === after.length &&
      after.every((entry) => beforeFigmaNodeIds.has(entry.id));
    const hasIncomingChild = after.some(
      (entry) => !beforeFigmaNodeIds.has(entry.id),
    );
    if (!sameChildren && !hasIncomingChild) {
      continue;
    }
    changes.push({
      nodeId: parent.pageNodeId,
      nodeName: parent.name,
      nodeType: parent.type,
      sourceRef: parent.sourceRef,
      category: "structure",
      property: "nodeReorder",
      from: beforeOrder,
      to: {
        parentSourceRef: parent.sourceRef,
        children: after.map((entry) => ({
          nodeId: entry.pageNodeId,
          sourceRef: entry.sourceRef,
        })),
      },
    });
    for (const entry of before) {
      addPageStructureSubtreeIds(
        entry.id,
        previousChildren,
        previousNodeIds,
      );
    }
    for (const entry of after) {
      addPageStructureSubtreeIds(
        entry.id,
        currentChildren,
        currentNodeIds,
      );
      const previous = previousById.get(entry.id);
      if (previous) {
        addPageStructureSubtreeIds(
          previous.id,
          previousChildren,
          previousNodeIds,
        );
      }
    }
  }
  return { changes, previousNodeIds, currentNodeIds };
}

function pageChildrenByParent(structure) {
  const result = new Map();
  for (const entry of structure) {
    if (!entry.parentId) continue;
    const children = result.get(entry.parentId) || [];
    children.push(entry);
    result.set(entry.parentId, children);
  }
  return result;
}

function pageStructureChildIdentity(entry) {
  return `${entry.pageNodeId || ""}:${entry.id}`;
}

function addPageStructureSubtreeIds(nodeId, childrenByParent, target) {
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (target.has(current)) continue;
    target.add(current);
    for (const child of childrenByParent.get(current) || []) {
      stack.push(child.id);
    }
  }
}

function pageStructureDepth(entry, entriesById) {
  let depth = 0;
  let parentId = entry.parentId;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = entriesById.get(parentId)?.parentId || null;
  }
  return depth;
}

function hasStablePageSelector(sourceRef) {
  const selector = sourceRef?.selector;
  return (
    typeof selector === "string" &&
    (/^\[data-codex-id=(?:"[^"]+"|'[^']+')\]$/.test(selector) ||
      /^#[A-Za-z_][\w-]*$/.test(selector))
  );
}

async function captureInsertedPageVectors(
  root,
  previousStructure,
  excludedNodeIds,
) {
  const previousNodeIds = new Set(
    previousStructure.map((entry) => entry.id),
  );
  const currentStructure = snapshotPageStructure(root);
  const changes = [];
  const nodeIds = new Set();
  for (const entry of currentStructure) {
    if (
      previousNodeIds.has(entry.id) ||
      excludedNodeIds.has(entry.id) ||
      nodeIds.has(entry.id)
    ) {
      continue;
    }
    const node = findPageDescendantById(root, entry.id);
    if (!node || !isInsertablePageVector(node)) {
      continue;
    }
    try {
      const parent = node.parent;
      const exported = await exportInsertedPageVector(node);
      setInsertedPageNodeData(
        root,
        node,
        exported.elementId,
        "svg",
      );
      changes.push({
        nodeId: parent.getPluginData(PAGE_NODE_ID_KEY),
        nodeName: node.name,
        nodeType: "SVG",
        sourceRef: readJsonPluginData(parent, PAGE_SOURCE_REF_KEY),
        category: "vector",
        property: "svgInsert",
        from: null,
        to: exported,
      });
      for (const nodeId of pageSubtreeNodeIds(node)) {
        nodeIds.add(nodeId);
      }
    } catch {
      // Keep unsupported or oversized vector additions in the structure diff.
    }
  }
  return { changes, nodeIds };
}

async function exportInsertedPageVector(node) {
  const bytes = await node.exportAsync({
    format: "SVG",
    svgIdAttribute: true,
  });
  if (bytes.length === 0 || bytes.length > 768 * 1024) {
    throw new Error("The inserted SVG exceeds the 768 KB sync limit.");
  }
  return {
    mimeType: "image/svg+xml",
    base64: encodeBase64(bytes),
    elementId: `figma-svg-${normalizeNodeId(node.id)}`,
    name: node.name || "Figma vector",
    x: "x" in node && typeof node.x === "number" ? round(node.x) : 0,
    y: "y" in node && typeof node.y === "number" ? round(node.y) : 0,
    width:
      "width" in node && typeof node.width === "number"
        ? round(node.width)
        : 1,
    height:
      "height" in node && typeof node.height === "number"
        ? round(node.height)
        : 1,
    rotation:
      "rotation" in node && typeof node.rotation === "number"
        ? round(node.rotation)
        : 0,
  };
}

async function exportTrackedPageSvg(node) {
  const bytes = await node.exportAsync({
    format: "SVG",
    svgIdAttribute: true,
  });
  if (bytes.length === 0 || bytes.length > 768 * 1024) {
    throw new Error("The edited SVG exceeds the 768 KB sync limit.");
  }
  return {
    mimeType: "image/svg+xml",
    base64: encodeBase64(bytes),
  };
}

function snapshotSvgSubtree(root) {
  const nodes = [];
  const visit = (node) => {
    nodes.push({
      id: node.id,
      parentId: node === root ? null : node.parent?.id || null,
      type: node.type,
      name: node.name,
      fingerprint: svgNodeFingerprint(node),
    });
    if ("children" in node) {
      for (const child of node.children) {
        if (!child.removed) {
          visit(child);
        }
      }
    }
  };
  if ("children" in root) {
    for (const child of root.children) {
      if (!child.removed) {
        visit(child);
      }
    }
  } else {
    visit(root);
  }
  return nodes;
}

function svgNodeFingerprint(node) {
  return shortHash(
    JSON.stringify({
      properties: snapshotDesignProperties(node),
      vectorPaths:
        "vectorPaths" in node && Array.isArray(node.vectorPaths)
          ? jsonSafe(node.vectorPaths)
          : null,
      vectorNetwork:
        "vectorNetwork" in node && node.vectorNetwork
          ? jsonSafe(node.vectorNetwork)
          : null,
      arcData:
        "arcData" in node && node.arcData ? jsonSafe(node.arcData) : null,
      pointCount:
        "pointCount" in node && typeof node.pointCount === "number"
          ? node.pointCount
          : null,
      innerRadius:
        "innerRadius" in node && typeof node.innerRadius === "number"
          ? round(node.innerRadius)
          : null,
      booleanOperation:
        "booleanOperation" in node &&
        typeof node.booleanOperation === "string"
          ? node.booleanOperation
          : null,
      relativeTransform:
        "relativeTransform" in node && node.relativeTransform
          ? jsonSafe(node.relativeTransform)
          : null,
    }),
  );
}

function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isTrackedSvgNode(node) {
  return node.getPluginData(PAGE_NODE_TYPE_KEY) === "svg";
}

function isInsertablePageVector(node) {
  const tree = isInsertablePageVectorTree(node);
  if (
    !tree.supported ||
    !tree.hasVector ||
    !node.parent ||
    node.getPluginData(PAGE_NODE_ID_KEY)
  ) {
    return false;
  }
  const role = node.parent.getPluginData?.(ROLE_KEY);
  if (role !== ROLE_PAGE_NODE && role !== ROLE_PAGE_ROOT) {
    return false;
  }
  const sourceRef = readJsonPluginData(node.parent, PAGE_SOURCE_REF_KEY);
  return typeof sourceRef?.selector === "string" && sourceRef.selector !== "";
}

function isInsertablePageVectorTree(node) {
  if (INSERTABLE_PAGE_VECTOR_TYPES.has(node.type)) {
    return { supported: true, hasVector: true };
  }
  if (node.type === "TEXT") {
    return { supported: true, hasVector: false };
  }
  if (node.type !== "GROUP" || !("children" in node)) {
    return { supported: false, hasVector: false };
  }
  const children = node.children.filter((child) => !child.removed);
  if (children.length === 0) {
    return { supported: false, hasVector: false };
  }
  const results = children.map((child) => isInsertablePageVectorTree(child));
  return {
    supported: results.every((result) => result.supported),
    hasVector: results.some((result) => result.hasVector),
  };
}

function pageSubtreeNodeIds(node) {
  return [
    node.id,
    ...(typeof node.findAll === "function"
      ? node.findAll((descendant) => !descendant.removed).map(
          (descendant) => descendant.id,
        )
      : []),
  ];
}

function findPageDescendantById(root, nodeId) {
  if (root.id === nodeId) {
    return root;
  }
  return root.findOne((node) => node.id === nodeId) || null;
}

async function captureSelectedDesign() {
  const selection = figma.currentPage.selection.filter(
    (node) => node && !node.removed,
  );
  if (selection.length !== 1) {
    throw new Error("Select exactly one Frame, Component, Instance, or Group.");
  }
  const root = selection[0];
  if (!DESIGN_ROOT_TYPES.has(root.type)) {
    throw new Error("The selected design root must be a Frame, Component, Instance, or Group.");
  }
  const context = { nodes: 0, assetBytes: 0 };
  const designId = getOrAssignPluginId(
    root,
    DESIGN_ID_KEY,
    `design-${normalizeNodeId(root.id)}`,
  );
  const serializedRoot = await serializeDesignNode(root, context);
  const screenshot = await exportDesignScreenshot(root);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  figma.ui.postMessage({
    type: "design.submit",
    requestId,
    design: {
      protocolVersion: 3,
      designId,
      capturedAt: new Date().toISOString(),
      figma: {
        fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        rootNodeId: root.id,
        rootNodeName: root.name,
      },
      root: serializedRoot,
      screenshot,
    },
  });
}

async function serializeDesignNode(node, context) {
  context.nodes += 1;
  if (context.nodes > 500) {
    throw new Error("The selected design exceeds 500 nodes.");
  }
  const stableId =
    node.getPluginData(PAGE_NODE_ID_KEY) ||
    getOrAssignPluginId(
      node,
      DESIGN_NODE_ID_KEY,
      `figma-${normalizeNodeId(node.id)}`,
    );
  const record = {
    stableId,
    nodeId: node.id,
    name: node.name || node.type,
    type: node.type,
    properties: snapshotDesignProperties(node),
    annotations: collectDirectAnnotations(node),
    sourceRef: readJsonPluginData(node, PAGE_SOURCE_REF_KEY),
    children: [],
  };

  const asset = await exportDesignNodeAsset(node, context);
  if (asset) {
    record.asset = asset;
  }
  if ("children" in node && !SVG_EXPORT_TYPES.has(node.type)) {
    for (const child of node.children) {
      if (!child.removed) {
        record.children.push(await serializeDesignNode(child, context));
      }
    }
  }
  return record;
}

function snapshotDesignProperties(node) {
  const properties = {
    ...snapshotNodeProperties(node),
    fills: "fills" in node ? snapshotPaints(node.fills) : [],
    strokes: "strokes" in node ? snapshotPaints(node.strokes) : [],
    effects:
      "effects" in node && Array.isArray(node.effects)
        ? jsonSafe(node.effects)
        : [],
    clipsContent:
      "clipsContent" in node && typeof node.clipsContent === "boolean"
        ? node.clipsContent
        : null,
    layoutAlign:
      "layoutAlign" in node && typeof node.layoutAlign === "string"
        ? node.layoutAlign
        : null,
    layoutGrow:
      "layoutGrow" in node && typeof node.layoutGrow === "number"
        ? round(node.layoutGrow)
        : null,
    layoutPositioning:
      "layoutPositioning" in node &&
      typeof node.layoutPositioning === "string"
        ? node.layoutPositioning
        : null,
    constraints:
      "constraints" in node && node.constraints
        ? jsonSafe(node.constraints)
        : null,
  };
  if (node.type === "INSTANCE" && node.componentProperties) {
    properties.componentProperties = jsonSafe(node.componentProperties);
  }
  return properties;
}

async function exportDesignScreenshot(root) {
  const width = Math.max(1, Math.min(1200, Math.round(root.width)));
  let bytes = await root.exportAsync({
    format: "PNG",
    constraint: { type: "WIDTH", value: width },
  });
  let exportedWidth = width;
  if (bytes.length > 3 * 1024 * 1024 && width > 600) {
    exportedWidth = 600;
    bytes = await root.exportAsync({
      format: "PNG",
      constraint: { type: "WIDTH", value: exportedWidth },
    });
  }
  if (bytes.length > 3 * 1024 * 1024) {
    throw new Error("The design reference image exceeds 3 MB.");
  }
  const scale = exportedWidth / Math.max(1, root.width);
  return {
    mimeType: "image/png",
    base64: encodeBase64(bytes),
    width: exportedWidth,
    height: Math.max(1, Math.round(root.height * scale)),
  };
}

async function exportDesignNodeAsset(node, context) {
  let kind = null;
  let mimeType = null;
  let settings = null;
  if (SVG_EXPORT_TYPES.has(node.type)) {
    kind = "svg";
    mimeType = "image/svg+xml";
    settings = { format: "SVG", svgIdAttribute: true };
  } else if (
    "fills" in node &&
    Array.isArray(node.fills) &&
    node.fills.some(
      (paint) => paint.type === "IMAGE" && paint.visible !== false,
    ) &&
    (!("children" in node) || node.children.length === 0)
  ) {
    kind = "png";
    mimeType = "image/png";
    settings = { format: "PNG" };
  }
  if (!settings) {
    return null;
  }

  const bytes = await node.exportAsync(settings);
  if (
    bytes.length === 0 ||
    bytes.length > 768 * 1024 ||
    context.assetBytes + bytes.length > 1536 * 1024
  ) {
    return null;
  }
  context.assetBytes += bytes.length;
  return {
    kind,
    mimeType,
    base64: encodeBase64(bytes),
  };
}

function snapshotPaints(paints) {
  if (!Array.isArray(paints)) {
    return [];
  }
  return paints.map((paint) => {
    if (paint.type === "SOLID") {
      return {
        type: "SOLID",
        color: rgbToHex(paint.color),
        opacity:
          typeof paint.opacity === "number" ? round(paint.opacity) : 1,
        visible: paint.visible !== false,
      };
    }
    if (paint.type === "IMAGE") {
      return {
        type: "IMAGE",
        imageHash: paint.imageHash || null,
        scaleMode: paint.scaleMode || null,
        opacity:
          typeof paint.opacity === "number" ? round(paint.opacity) : 1,
        visible: paint.visible !== false,
      };
    }
    return jsonSafe(paint);
  });
}

function getOrAssignPluginId(node, key, fallback) {
  const existing = node.getPluginData(key);
  if (existing) {
    return existing;
  }
  node.setPluginData(key, fallback);
  return fallback;
}

function normalizeNodeId(nodeId) {
  return String(nodeId).replace(/[^A-Za-z0-9_-]+/g, "-");
}

function encodeBase64(bytes) {
  if (typeof figma.base64Encode === "function") {
    return figma.base64Encode(bytes);
  }
  let binary = "";
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function emitFeedback(target, kind, { changes, annotations, context }) {
  const root = findAssetRootAncestor(target);
  if (!root) {
    return;
  }
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  figma.ui.postMessage({
    type: "feedback.emit",
    requestId,
    feedback: {
      feedbackId: requestId,
      assetId: root.getPluginData(ASSET_ID_KEY),
      sourceHash: root.getPluginData(SOURCE_HASH_KEY),
      elementId: target.getPluginData(ELEMENT_ID_KEY),
      kind,
      changes,
      annotations,
      figma: {
        pageName: figma.currentPage.name,
        nodeId: target.id,
        nodeName: target.name,
        changedNodeId: context.changedNodeId,
        changedNodes: context.changedNodes || [],
        origin: context.origin,
        manual: Boolean(context.manual),
      },
    },
  });
}

function snapshotTarget(target) {
  const nodes = {};
  const visit = (node) => {
    nodes[node.id] = {
      ...describeNode(node),
      properties: snapshotNodeProperties(node),
    };
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(target);
  return {
    nodes,
    annotations: collectAnnotations(target),
  };
}

function snapshotNodeProperties(node) {
  const fill = "fills" in node ? firstSolidPaint(node.fills) : null;
  const stroke = "strokes" in node ? firstSolidPaint(node.strokes) : null;
  const properties = {
    fill,
    stroke,
    strokeWeight:
      "strokeWeight" in node && typeof node.strokeWeight === "number"
        ? round(node.strokeWeight)
        : null,
    strokeCap:
      "strokeCap" in node && typeof node.strokeCap === "string"
        ? node.strokeCap
        : null,
    strokeJoin:
      "strokeJoin" in node && typeof node.strokeJoin === "string"
        ? node.strokeJoin
        : null,
    strokeMiterLimit:
      "strokeMiterLimit" in node && typeof node.strokeMiterLimit === "number"
        ? round(node.strokeMiterLimit)
        : null,
    dashPattern:
      "dashPattern" in node && Array.isArray(node.dashPattern)
        ? node.dashPattern.map(round)
        : null,
    opacity: "opacity" in node ? round(node.opacity) : null,
    visible: "visible" in node && typeof node.visible === "boolean" ? node.visible : null,
    x: "x" in node && typeof node.x === "number" ? round(node.x) : null,
    y: "y" in node && typeof node.y === "number" ? round(node.y) : null,
    width: "width" in node && typeof node.width === "number" ? round(node.width) : null,
    height:
      "height" in node && typeof node.height === "number" ? round(node.height) : null,
    rotation:
      "rotation" in node && typeof node.rotation === "number"
        ? round(node.rotation)
        : null,
    cornerRadius: snapshotCornerRadius(node),
    layoutMode:
      "layoutMode" in node && typeof node.layoutMode === "string"
        ? node.layoutMode
        : null,
    layoutKind:
      readJsonPluginData(node, PAGE_LAYOUT_META_KEY)?.kind ||
      ("layoutMode" in node && node.layoutMode !== "NONE" ? "flex" : "none"),
    layoutWrap:
      "layoutWrap" in node && typeof node.layoutWrap === "string"
        ? node.layoutWrap
        : null,
    itemSpacing:
      "itemSpacing" in node && typeof node.itemSpacing === "number"
        ? round(node.itemSpacing)
        : null,
    counterAxisSpacing:
      "counterAxisSpacing" in node &&
      typeof node.counterAxisSpacing === "number"
        ? round(node.counterAxisSpacing)
        : null,
    padding: snapshotPadding(node),
    primaryAxisAlignItems:
      "primaryAxisAlignItems" in node &&
      typeof node.primaryAxisAlignItems === "string"
        ? node.primaryAxisAlignItems
        : null,
    counterAxisAlignItems:
      "counterAxisAlignItems" in node &&
      typeof node.counterAxisAlignItems === "string"
        ? node.counterAxisAlignItems
        : null,
    primaryAxisSizingMode:
      "primaryAxisSizingMode" in node &&
      typeof node.primaryAxisSizingMode === "string"
        ? node.primaryAxisSizingMode
        : null,
    counterAxisSizingMode:
      "counterAxisSizingMode" in node &&
      typeof node.counterAxisSizingMode === "string"
        ? node.counterAxisSizingMode
        : null,
    layoutAlign:
      "layoutAlign" in node && typeof node.layoutAlign === "string"
        ? node.layoutAlign
        : null,
    layoutGrow:
      "layoutGrow" in node && typeof node.layoutGrow === "number"
        ? round(node.layoutGrow)
        : null,
    layoutPositioning:
      "layoutPositioning" in node &&
      typeof node.layoutPositioning === "string"
        ? node.layoutPositioning
        : null,
    layoutSizingHorizontal:
      "layoutSizingHorizontal" in node &&
      typeof node.layoutSizingHorizontal === "string"
        ? node.layoutSizingHorizontal
        : null,
    layoutSizingVertical:
      "layoutSizingVertical" in node &&
      typeof node.layoutSizingVertical === "string"
        ? node.layoutSizingVertical
        : null,
  };

  if (node.type === "TEXT") {
    properties.characters =
      typeof node.characters === "string" ? node.characters : null;
    properties.fontName = snapshotFontName(node.fontName);
    properties.fontSize =
      typeof node.fontSize === "number" ? round(node.fontSize) : null;
    properties.lineHeight = snapshotUnitValue(node.lineHeight);
    properties.letterSpacing = snapshotUnitValue(node.letterSpacing);
    properties.textAlignHorizontal =
      typeof node.textAlignHorizontal === "string"
        ? node.textAlignHorizontal
        : null;
    properties.textAlignVertical =
      typeof node.textAlignVertical === "string" ? node.textAlignVertical : null;
    properties.textCase =
      typeof node.textCase === "string" ? node.textCase : null;
    properties.textDecoration =
      typeof node.textDecoration === "string" ? node.textDecoration : null;
  }

  return properties;
}

function snapshotCornerRadius(node) {
  if (!("cornerRadius" in node)) {
    return null;
  }
  if (typeof node.cornerRadius === "number") {
    return round(node.cornerRadius);
  }
  const radii = {
    topLeft: node.topLeftRadius,
    topRight: node.topRightRadius,
    bottomRight: node.bottomRightRadius,
    bottomLeft: node.bottomLeftRadius,
  };
  return Object.values(radii).every((value) => typeof value === "number")
    ? Object.fromEntries(
        Object.entries(radii).map(([key, value]) => [key, round(value)]),
      )
    : null;
}

function snapshotPadding(node) {
  const values = [
    node.paddingTop,
    node.paddingRight,
    node.paddingBottom,
    node.paddingLeft,
  ];
  if (
    !("paddingTop" in node) ||
    !values.every((value) => typeof value === "number")
  ) {
    return null;
  }
  return {
    top: round(node.paddingTop),
    right: round(node.paddingRight),
    bottom: round(node.paddingBottom),
    left: round(node.paddingLeft),
  };
}

function snapshotFontName(fontName) {
  return fontName &&
    typeof fontName === "object" &&
    typeof fontName.family === "string" &&
    typeof fontName.style === "string"
    ? { family: fontName.family, style: fontName.style }
    : null;
}

function snapshotUnitValue(value) {
  if (!value || typeof value !== "object" || typeof value.unit !== "string") {
    return null;
  }
  return {
    unit: value.unit,
    ...(typeof value.value === "number" ? { value: round(value.value) } : {}),
  };
}

function firstSolidPaint(paints) {
  if (!Array.isArray(paints)) {
    return null;
  }
  const paint = paints.find((candidate) => candidate.type === "SOLID" && candidate.visible !== false);
  if (!paint) {
    return null;
  }
  const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
  return {
    color: rgbToHex(paint.color),
    opacity: round(opacity),
  };
}

function rgbToHex(color) {
  const channel = (value) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function collectAnnotations(target) {
  const values = [];
  const visit = (node) => {
    if ("annotations" in node && Array.isArray(node.annotations)) {
      for (const annotation of node.annotations) {
        values.push({
          label: annotation.label || null,
          labelMarkdown: annotation.labelMarkdown || null,
          categoryId: annotation.categoryId || null,
          properties: annotation.properties
            ? annotation.properties.map((property) => ({ ...property }))
            : [],
          attachedNodeId: node.id,
          attachedNodeName: node.name,
        });
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(target);
  return values;
}

function collectFigmaAnnotations(target) {
  const values = [];
  const seen = new Set();
  const visit = (node) => {
    if ("annotations" in node && Array.isArray(node.annotations)) {
      for (const annotation of node.annotations) {
        const normalized = {
          ...(annotation.label ? { label: annotation.label } : {}),
          ...(annotation.labelMarkdown
            ? { labelMarkdown: annotation.labelMarkdown }
            : {}),
          ...(annotation.categoryId ? { categoryId: annotation.categoryId } : {}),
          ...(annotation.properties
            ? { properties: annotation.properties.map((property) => ({ ...property })) }
            : {}),
        };
        const key = JSON.stringify(normalized);
        if (!seen.has(key)) {
          seen.add(key);
          values.push(normalized);
        }
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(target);
  return values;
}

function collectDirectAnnotations(node) {
  if (!("annotations" in node) || !Array.isArray(node.annotations)) {
    return [];
  }
  return node.annotations.map((annotation) => ({
    label: annotation.label || null,
    labelMarkdown: annotation.labelMarkdown || null,
    categoryId: annotation.categoryId || null,
    properties: annotation.properties
      ? annotation.properties.map((property) => ({ ...property }))
      : [],
    attachedNodeId: node.id,
  }));
}

function collectDirectFigmaAnnotations(node) {
  if (!("annotations" in node) || !Array.isArray(node.annotations)) {
    return [];
  }
  return node.annotations.map((annotation) => ({
    ...(annotation.label ? { label: annotation.label } : {}),
    ...(annotation.labelMarkdown
      ? { labelMarkdown: annotation.labelMarkdown }
      : {}),
    ...(annotation.categoryId ? { categoryId: annotation.categoryId } : {}),
    ...(annotation.properties
      ? { properties: annotation.properties.map((property) => ({ ...property })) }
      : {}),
  }));
}

function readPageBaseline(node) {
  const value = readJsonPluginData(node, PAGE_BASELINE_KEY);
  return value && typeof value === "object"
    ? value
    : snapshotNodeProperties(node);
}

function readPageSvgBaseline(node) {
  const value = readJsonPluginData(node, PAGE_SVG_BASELINE_KEY);
  return Array.isArray(value) ? value : snapshotSvgSubtree(node);
}

function readPageAnnotationBaseline(node) {
  const value = readJsonPluginData(node, PAGE_ANNOTATION_BASELINE_KEY);
  return Array.isArray(value) ? value : [];
}

function readJsonPluginData(node, key) {
  try {
    const value = node.getPluginData(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function diffObject(before, after) {
  const changes = [];
  for (const property of Object.keys(after)) {
    if (JSON.stringify(before[property]) !== JSON.stringify(after[property])) {
      changes.push({
        property,
        from: before[property] ?? null,
        to: after[property] ?? null,
      });
    }
  }
  return changes;
}

function propertyCategory(property) {
  if (APPEARANCE_PROPERTIES.has(property)) {
    return "appearance";
  }
  if (GEOMETRY_PROPERTIES.has(property)) {
    return "geometry";
  }
  if (LAYOUT_PROPERTIES.has(property)) {
    return "layout";
  }
  return "text";
}

function describeNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
  };
}

function indexCurrentPage() {
  snapshots.clear();
  for (const root of findAssetRoots()) {
    refreshSnapshotsForRoot(root);
  }
  refreshTrackedPageNodeIds();
}

function refreshTrackedPageNodeIds() {
  trackedPageFigmaNodeIds.clear();
  for (const root of findPageRoots()) {
    for (const node of [root, ...root.findAll(() => true)]) {
      trackedPageFigmaNodeIds.add(node.id);
    }
  }
}

function refreshSnapshotsForRoot(root) {
  for (const target of findTargets(root)) {
    snapshots.set(targetKey(target), snapshotTarget(target));
  }
}

function findPageRoots() {
  return figma.currentPage.findAll(
    (node) => node.getPluginData(ROLE_KEY) === ROLE_PAGE_ROOT,
  );
}

function findPageRoot(pageId) {
  return (
    figma.currentPage.findOne(
      (node) =>
        node.getPluginData(ROLE_KEY) === ROLE_PAGE_ROOT &&
        node.getPluginData(PAGE_ID_KEY) === pageId,
    ) || null
  );
}

function findTrackedPageNodes(root) {
  return [
    root,
    ...root.findAll(
      (node) => node.getPluginData(ROLE_KEY) === ROLE_PAGE_NODE,
    ),
  ];
}

function findTrackedPageNode(root, nodeId) {
  if (root.getPluginData(PAGE_NODE_ID_KEY) === nodeId) {
    return root;
  }
  return (
    root.findOne(
      (node) =>
        node.getPluginData(ROLE_KEY) === ROLE_PAGE_NODE &&
        node.getPluginData(PAGE_NODE_ID_KEY) === nodeId,
    ) || null
  );
}

function findPageNodeAncestor(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    const role = current.getPluginData?.(ROLE_KEY);
    if (role === ROLE_PAGE_NODE || role === ROLE_PAGE_ROOT) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findAssetRoots() {
  return figma.currentPage.findAll(
    (node) => node.getPluginData(ROLE_KEY) === ROLE_ROOT,
  );
}

function findAssetRoot(assetId) {
  return (
    figma.currentPage.findOne(
      (node) =>
        node.getPluginData(ROLE_KEY) === ROLE_ROOT &&
        node.getPluginData(ASSET_ID_KEY) === assetId,
    ) || null
  );
}

function placeNewBridgeRoot(node) {
  const existingRoots = [...findPageRoots(), ...findAssetRoots()].filter(
    (root) =>
      root !== node &&
      !root.removed &&
      root.parent === figma.currentPage,
  );
  if (existingRoots.length === 0) {
    node.x = figma.viewport.center.x - node.width / 2;
    node.y = figma.viewport.center.y - node.height / 2;
    return;
  }

  const gap = 160;
  node.x =
    Math.max(...existingRoots.map((root) => root.x + root.width)) + gap;
  node.y = Math.min(...existingRoots.map((root) => root.y));
}

function findTargets(root) {
  return root.findAll((node) => node.getPluginData(ROLE_KEY) === ROLE_TARGET);
}

function findTarget(root, elementId) {
  return (
    root.findOne(
      (node) =>
        node.getPluginData(ROLE_KEY) === ROLE_TARGET &&
        node.getPluginData(ELEMENT_ID_KEY) === elementId,
    ) || null
  );
}

function findTargetAncestor(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.getPluginData?.(ROLE_KEY) === ROLE_TARGET) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findAssetRootAncestor(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.getPluginData?.(ROLE_KEY) === ROLE_ROOT) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isDescendantOf(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function targetKey(target) {
  return `${target.getPluginData(ASSET_ID_KEY)}::${target.getPluginData(ELEMENT_ID_KEY)}`;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function validateAsset(asset) {
  if (!asset || typeof asset !== "object") {
    throw new Error("Asset payload is missing.");
  }
  if (!asset.assetId || !asset.sourceHash) {
    throw new Error("Asset id and source hash are required.");
  }
  if (!(asset.width > 0) || !(asset.height > 0)) {
    throw new Error("Asset dimensions must be positive.");
  }
  if (!Array.isArray(asset.targets) || asset.targets.length === 0) {
    throw new Error("Asset has no prepared sync targets.");
  }
  const ids = new Set();
  for (const target of asset.targets) {
    if (!target.elementId || !target.fragment) {
      throw new Error("Every target needs elementId and SVG fragment.");
    }
    if (ids.has(target.elementId)) {
      throw new Error(`Duplicate target "${target.elementId}".`);
    }
    ids.add(target.elementId);
  }
}

function validatePage(page) {
  if (!page || typeof page !== "object") {
    throw new Error("Page payload is missing.");
  }
  if (!page.pageId || !page.sourceHash || !page.root) {
    throw new Error("Page id, source hash, and root are required.");
  }
  if (page.root.type !== "frame") {
    throw new Error("Page root must be a frame.");
  }
  if (!Array.isArray(page.nodeIds) || page.nodeIds.length === 0) {
    throw new Error("Page has no stable node ids.");
  }
  const ids = new Set();
  const visit = (node) => {
    if (!node.id || !["frame", "image", "text", "svg"].includes(node.type)) {
      throw new Error("Every page node needs a stable id and supported type.");
    }
    if (!(node.width > 0) || !(node.height > 0)) {
      throw new Error(`Page node "${node.id}" needs positive dimensions.`);
    }
    if (ids.has(node.id)) {
      throw new Error(`Duplicate page node "${node.id}".`);
    }
    ids.add(node.id);
    for (const child of node.children || []) {
      visit(child);
    }
  };
  visit(page.root);
  if (
    ids.size !== page.nodeIds.length ||
    page.nodeIds.some((id) => !ids.has(id))
  ) {
    throw new Error("Page node id index does not match the page tree.");
  }
}
