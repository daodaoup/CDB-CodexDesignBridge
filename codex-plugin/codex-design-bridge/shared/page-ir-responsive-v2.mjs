import { createHash } from "node:crypto";
import {
  CDB_BRIDGE_PROTOCOL_VERSION,
  CDB_EXACT_BUILD,
  CDB_PAGE_IR_SCHEMA_VERSION,
} from "./runtime-contract.mjs";

export const PAGE_IR_RESPONSIVE_SCHEMA_VERSION = CDB_PAGE_IR_SCHEMA_VERSION;
export const PAGE_IR_RESPONSIVE_PROTOCOL_VERSION = CDB_BRIDGE_PROTOCOL_VERSION;
export const PAGE_IR_RESPONSIVE_IDENTITY = "cdb-page-ir-responsive-v2";
export const PAGE_IR_RESPONSIVE_MAX_NODES = 500;
export const RESPONSIVE_ACCEPTANCE_WIDTHS = Object.freeze([320, 375, 402, 430, 768, 1440]);

const NODE_TYPES = new Set(["frame", "image", "svg", "text"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export class ResponsivePageIrValidationError extends Error {
  constructor(message, path = "") {
    super(path ? `${path}: ${message}` : message);
    this.name = "ResponsivePageIrValidationError";
    this.path = path;
  }
}

export function createResponsivePageIrFromFigmaPayload(payload, options = {}) {
  const root = payload?.pageSeed?.node;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new ResponsivePageIrValidationError("Figma payload is missing pageSeed.node.");
  }
  const contract = payload.responsiveContract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new ResponsivePageIrValidationError(
      "Protocol 16 Figma payload is missing responsiveContract.",
      "responsiveContract",
    );
  }
  const figma = payload.figma && typeof payload.figma === "object" ? payload.figma : {};
  return createResponsivePageIrFromNodeTree({
    pageId: options.pageId || payload.pageId || stablePageId(payload.offerId),
    projectKey: options.projectKey || payload.projectKey || "",
    name: options.name || figma.rootNodeName || root.name || "Figma page",
    root,
    origin: {
      kind: "figma",
      figmaFileKey: String(options.figmaFileKey || figma.fileKey || payload.figmaFileKey || ""),
      rootNodeId: String(figma.rootNodeId || ""),
      rootNodeName: String(figma.rootNodeName || root.name || ""),
      sourceFile: "",
      sourceSelector: "",
    },
    responsiveContract: contract,
    degradations: payload.report?.degradations || [],
    exactBuild: options.exactBuild || payload.runtimeIdentity?.exactBuild || CDB_EXACT_BUILD,
  });
}

export function createResponsivePageIrFromNodeTree({
  pageId,
  projectKey = "",
  name,
  root,
  origin,
  responsiveContract,
  degradations = [],
  exactBuild = CDB_EXACT_BUILD,
}) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new ResponsivePageIrValidationError("root must be an object", "root");
  }
  if (!responsiveContract || typeof responsiveContract !== "object" || Array.isArray(responsiveContract)) {
    throw new ResponsivePageIrValidationError("responsiveContract is required", "responsiveContract");
  }
  const nodes = {};
  const discoveredDegradations = [];
  const visit = (source, parentId, order, path) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new ResponsivePageIrValidationError("node must be an object", path);
    }
    const id = requiredId(source.id, `${path}.id`);
    if (nodes[id]) throw new ResponsivePageIrValidationError(`duplicate node id ${id}`, path);
    if (Object.keys(nodes).length >= PAGE_IR_RESPONSIVE_MAX_NODES) {
      throw new ResponsivePageIrValidationError(`page exceeds ${PAGE_IR_RESPONSIVE_MAX_NODES} nodes`, path);
    }
    const type = String(source.type || "").toLowerCase();
    if (!NODE_TYPES.has(type)) throw new ResponsivePageIrValidationError("unsupported node type", `${path}.type`);
    const children = type === "frame" ? source.children ?? [] : [];
    if (!Array.isArray(children)) throw new ResponsivePageIrValidationError("children must be an array", `${path}.children`);
    const adaptation = responsiveAdaptation(source, type, id, {
      isRoot: parentId === null,
    });
    if (adaptation.adaptation.status === "unsupported") {
      discoveredDegradations.push({
        nodeId: id,
        reason: "unsupported_responsive_semantics",
        message: adaptation.adaptation.reason,
      });
    }
    nodes[id] = {
      id,
      type,
      tag: String(source.tag || { frame: "div", text: "span", image: "img", svg: "svg" }[type]).toLowerCase(),
      name: String(source.name || id),
      parentId,
      order,
      childIds: [],
      sourceRef: jsonClone(source.sourceRef || { selector: `[data-codex-id="${id}"]`, file: "", component: "" }),
      semantics: jsonClone(source.semantics || {}),
      interaction: jsonClone(source.interaction || {}),
      figma: jsonClone(source.figma || { nodeId: source.figmaNodeId || "", componentKey: "", componentSetKey: "" }),
      geometry: {
        width: source.width ?? source.geometry?.width,
        height: source.height ?? source.geometry?.height,
        x: source.x ?? source.geometry?.x ?? 0,
        y: source.y ?? source.geometry?.y ?? 0,
        rotation: source.rotation ?? source.geometry?.rotation ?? 0,
      },
      visibility: {
        visible: typeof source.visible === "boolean" ? source.visible : true,
        opacity: Number.isFinite(source.opacity) ? source.opacity : 1,
        clipsContent: typeof source.clipsContent === "boolean" ? source.clipsContent : false,
      },
      appearance: responsiveCanonicalAppearance(source.appearance || source.style || {}),
      layout: type === "frame" ? responsiveCanonicalLayout(source.layout) : null,
      content: type === "text" ? responsiveTextContent(source) : null,
      resource: type === "image" || type === "svg" ? responsiveResource(source, type, path) : null,
      ...adaptation,
    };
    nodes[id].childIds = children.map((child, childIndex) => visit(child, id, childIndex, `${path}.children[${childIndex}]`));
    return id;
  };
  const rootId = visit(root, null, 0, "root");
  return normalizeResponsivePageIr({
    schemaVersion: PAGE_IR_RESPONSIVE_SCHEMA_VERSION,
    protocolVersion: PAGE_IR_RESPONSIVE_PROTOCOL_VERSION,
    identity: { kind: PAGE_IR_RESPONSIVE_IDENTITY, generation: "0.9", exactBuild },
    pageId,
    projectKey,
    name: name || pageId,
    rootId,
    origin: normalizeConstructorOrigin(origin),
    designViewport: responsiveContract.designViewport,
    runtimeViewports: responsiveContract.runtimeViewports,
    previewScale: responsiveContract.previewScale,
    breakpoints: responsiveContract.breakpoints,
    nodes,
    degradations: [...degradations.map(normalizeConstructorDegradation), ...discoveredDegradations],
  }, { expectedExactBuild: exactBuild });
}

export function compactResponsivePageIr(value, options = {}) {
  const compact = normalizeResponsivePageIr(value, options);
  for (const node of Object.values(compact.nodes)) {
    if (node.resource) delete node.resource.base64;
  }
  compact.irHash = hashNormalizedResponsivePageIr(compact);
  return compact;
}

export function responsivePageIrToPageSeedNode(value, { includeResourceData = true } = {}) {
  const pageIr = normalizeResponsivePageIr(value);
  const visit = (id) => {
    const node = pageIr.nodes[id];
    const parent = node.parentId ? pageIr.nodes[node.parentId] : null;
    const result = {
      id: node.id,
      type: node.type,
      tag: node.tag,
      name: node.name,
      sourceRef: structuredClone(node.sourceRef),
      semantics: structuredClone(node.semantics),
      interaction: structuredClone(node.interaction),
      figma: structuredClone(node.figma),
      figmaNodeId: node.figma?.nodeId || "",
      width: node.geometry.width,
      height: node.geometry.height,
      x: node.geometry.x,
      y: node.geometry.y,
      rotation: node.geometry.rotation,
      visible: node.visibility.visible,
      opacity: node.visibility.opacity,
      clipsContent: node.visibility.clipsContent,
      style: structuredClone(node.appearance),
      sizing: structuredClone(node.sizing),
      constraints: structuredClone(node.constraints),
      overflow: structuredClone(node.overflow),
      responsive: node.sizing ? {
        constraints: structuredClone(node.constraints),
        minWidth: node.sizing.horizontal.min,
        maxWidth: node.sizing.horizontal.max,
        minHeight: node.sizing.vertical.min,
        maxHeight: node.sizing.vertical.max,
        aspectRatio: node.sizing.aspectRatio,
      } : null,
      layoutItem: responsiveLayoutItemToSeed(node, parent),
    };
    if (node.type === "frame") {
      result.layout = responsiveLayoutToSeed(node.layout);
      result.children = node.childIds.map(visit);
    } else if (node.type === "text") {
      result.text = node.content?.characters || "";
      const font = node.content?.font || {};
      result.fontName = { family: font.family || "Inter", style: font.style || "Regular" };
      result.fontSize = font.size || 16;
      result.lineHeight = responsiveTextUnit(font.lineHeight, 20);
      result.letterSpacing = responsiveTextUnit(font.letterSpacing, 0);
      result.textAlignHorizontal = node.content?.align?.horizontal || "LEFT";
      result.textAlignVertical = node.content?.align?.vertical || "TOP";
      result.textCase = node.content?.textCase || "ORIGINAL";
      result.textDecoration = node.content?.textDecoration || "NONE";
      result.textAutoResize = node.textFlow?.autoHeight ? "HEIGHT" : "NONE";
      result.maxLines = node.textFlow?.wrap === "no-wrap" ? 1 : null;
      result.textTruncation = node.textFlow?.overflow === "ellipsis" ? "ENDING" : "DISABLED";
    } else if (node.resource) {
      result[node.type] = {
        mimeType: node.resource.mimeType,
        base64: includeResourceData ? node.resource.base64 || "" : "",
        contentHash: node.resource.sha256,
      };
    }
    return result;
  };
  return visit(pageIr.rootId);
}

function responsiveLayoutToSeed(layout) {
  const source = layout || { kind: "none", direction: "none" };
  if (typeof source.mode === "string") return structuredClone(source);
  const direction = source.direction || "none";
  const mode = direction === "horizontal" ? "HORIZONTAL" : direction === "vertical" ? "VERTICAL" : "NONE";
  return {
    kind: source.kind || "none",
    mode,
    direction,
    wrap: Boolean(source.wrap),
    itemSpacing: Number(source.gap || 0),
    counterAxisSpacing: Number(source.counterGap ?? source.gap ?? 0),
    padding: structuredClone(source.padding || { top: 0, right: 0, bottom: 0, left: 0 }),
    primaryAxisAlignItems: ({ start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN" })[source.justify] || "MIN",
    counterAxisAlignItems: ({ start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE", stretch: "MIN" })[source.align] || "MIN",
    primaryAxisSizingMode: source.primarySizing === "hug" ? "AUTO" : "FIXED",
    counterAxisSizingMode: source.counterSizing === "hug" ? "AUTO" : "FIXED",
    grid: structuredClone(source.grid),
  };
}

function responsiveLayoutItemToSeed(node, parent) {
  if (!node.sizing) return null;
  const horizontalSizing = node.sizing.horizontal.mode;
  const verticalSizing = node.sizing.vertical.mode;
  const item = { horizontalSizing, verticalSizing };
  if (parent?.layout?.kind !== "flex") return item;
  const direction = parent.layout.direction;
  const fillsMainAxis =
    (direction === "horizontal" && horizontalSizing === "fill") ||
    (direction === "vertical" && verticalSizing === "fill");
  const fillsCounterAxis =
    (direction === "horizontal" && verticalSizing === "fill") ||
    (direction === "vertical" && horizontalSizing === "fill");
  if (fillsMainAxis) item.grow = 1;
  if (fillsCounterAxis) item.align = "stretch";
  return item;
}

function responsiveTextUnit(value, fallback) {
  if (typeof value === "number") return { unit: "PIXELS", value };
  if (!value || typeof value !== "object") return { unit: "PIXELS", value: fallback };
  return structuredClone(value);
}

export function normalizeResponsivePageIr(value, options = {}) {
  const input = object(value, "Page IR", "");
  exactKeys(input, [
    "schemaVersion", "protocolVersion", "identity", "pageId", "projectKey", "name", "rootId",
    "origin", "designViewport", "runtimeViewports", "previewScale", "breakpoints", "nodes",
    "degradations", "irHash",
  ], "");
  if (input.schemaVersion !== PAGE_IR_RESPONSIVE_SCHEMA_VERSION) {
    throw new ResponsivePageIrValidationError(
      `Unsupported Page IR schema ${String(input.schemaVersion)}; schema 2 is required.`,
      "schemaVersion",
    );
  }
  if (input.protocolVersion !== PAGE_IR_RESPONSIVE_PROTOCOL_VERSION) {
    throw new ResponsivePageIrValidationError(
      `Unsupported protocol ${String(input.protocolVersion)}; protocol 16 is required.`,
      "protocolVersion",
    );
  }
  const identity = normalizeIdentity(input.identity, options.expectedExactBuild);
  const pageId = requiredId(input.pageId, "pageId");
  const nodes = normalizeNodes(input.nodes);
  const rootId = requiredId(input.rootId, "rootId");
  validateNodeGraph(rootId, nodes);
  const designViewport = normalizeViewport(input.designViewport, "designViewport", { requireHeight: true });
  const runtimeViewports = normalizeRuntimeViewports(input.runtimeViewports);
  const breakpoints = normalizeBreakpoints(input.breakpoints, nodes);
  const previewScale = normalizePreviewScale(input.previewScale, breakpoints);

  const result = {
    schemaVersion: PAGE_IR_RESPONSIVE_SCHEMA_VERSION,
    protocolVersion: PAGE_IR_RESPONSIVE_PROTOCOL_VERSION,
    identity,
    pageId,
    projectKey: limitedString(input.projectKey, 256, "projectKey"),
    name: limitedString(input.name, 160, "name"),
    rootId,
    origin: normalizeOrigin(input.origin),
    designViewport,
    runtimeViewports,
    previewScale,
    breakpoints,
    nodes: sortObject(nodes),
    degradations: normalizeDegradations(input.degradations),
  };
  result.irHash = hashNormalizedResponsivePageIr(result);
  if (options.requireMatchingHash && input.irHash !== result.irHash) {
    throw new ResponsivePageIrValidationError("Page IR hash does not match its normalized content.", "irHash");
  }
  return result;
}

export function validateResponsivePageIr(value, options = {}) {
  if (!value || typeof value.irHash !== "string") {
    throw new ResponsivePageIrValidationError("Page IR hash is required for validation.", "irHash");
  }
  normalizeResponsivePageIr(value, { ...options, requireMatchingHash: true });
  return true;
}

export function hashResponsivePageIr(value, options = {}) {
  return normalizeResponsivePageIr(value, options).irHash;
}

export function diffResponsivePageIr(before, after, options = {}) {
  const left = normalizeResponsivePageIr(before, options);
  const right = normalizeResponsivePageIr(after, options);
  assertSameIdentity(left, right);
  const changes = [];
  diffValues(comparable(left), comparable(right), "", changes);
  return changes.map((change) => ({
    ...change,
    owner: responsivePageIrPropertyOwner(change.pointer),
  }));
}

export function mergeResponsivePageIr({ baseline, html, figma }, options = {}) {
  const normalizedBaseline = normalizeResponsivePageIr(baseline, options);
  const normalizedHtml = normalizeResponsivePageIr(html, options);
  const normalizedFigma = normalizeResponsivePageIr(figma, options);
  assertSameIdentity(normalizedBaseline, normalizedHtml);
  assertSameIdentity(normalizedBaseline, normalizedFigma);
  const htmlChanges = diffResponsivePageIr(normalizedBaseline, normalizedHtml, options)
    .filter((change) => change.owner !== "system");
  const figmaChanges = diffResponsivePageIr(normalizedBaseline, normalizedFigma, options)
    .filter((change) => change.owner !== "system");
  const htmlByPointer = new Map(htmlChanges.map((change) => [change.pointer, change]));
  const figmaByPointer = new Map(figmaChanges.map((change) => [change.pointer, change]));
  const pointers = [...new Set([...htmlByPointer.keys(), ...figmaByPointer.keys()])].sort();
  const target = comparable(normalizedBaseline);
  const conflicts = [];
  const applied = [];
  for (const pointer of pointers) {
    const htmlChange = htmlByPointer.get(pointer);
    const figmaChange = figmaByPointer.get(pointer);
    if (htmlChange && figmaChange) {
      if (sameResponsiveChange(htmlChange, figmaChange)) {
        applyResponsiveChange(target, htmlChange);
        applied.push({ pointer, source: "both", owner: htmlChange.owner });
      } else if (htmlChange.owner === "html") {
        applyResponsiveChange(target, htmlChange);
        applied.push({ pointer, source: "html", owner: "html", resolution: "owner" });
      } else if (htmlChange.owner === "figma") {
        applyResponsiveChange(target, figmaChange);
        applied.push({ pointer, source: "figma", owner: "figma", resolution: "owner" });
      } else {
        conflicts.push(responsiveConflict(pointer, htmlChange, figmaChange, "concurrent_change"));
      }
      continue;
    }
    const change = htmlChange || figmaChange;
    const source = htmlChange ? "html" : "figma";
    if (
      change.owner === "system" ||
      (change.owner === "html" && source !== "html") ||
      (change.owner === "figma" && source !== "figma")
    ) {
      conflicts.push(responsiveConflict(pointer, htmlChange, figmaChange, "ownership_violation"));
      continue;
    }
    applyResponsiveChange(target, change);
    applied.push({ pointer, source, owner: change.owner });
  }
  const merged = normalizeResponsivePageIr({
    ...normalizedBaseline,
    ...target,
    origin: {
      ...normalizedBaseline.origin,
      kind: "mixed",
      sourceFile: normalizedHtml.origin.sourceFile || normalizedBaseline.origin.sourceFile,
      sourceSelector: normalizedHtml.origin.sourceSelector || normalizedBaseline.origin.sourceSelector,
      figmaFileKey: normalizedFigma.origin.figmaFileKey || normalizedBaseline.origin.figmaFileKey,
      rootNodeId: normalizedFigma.origin.rootNodeId || normalizedBaseline.origin.rootNodeId,
      rootNodeName: normalizedFigma.origin.rootNodeName || normalizedBaseline.origin.rootNodeName,
    },
  }, options);
  return { merged, conflicts, applied, htmlChanges, figmaChanges };
}

export function resolveResponsivePageIrConflicts({ baseline, html, figma, resolution }, options = {}) {
  if (!new Set(["html", "figma"]).has(resolution)) {
    throw new ResponsivePageIrValidationError("Conflict resolution must be html or figma.");
  }
  const result = mergeResponsivePageIr({ baseline, html, figma }, options);
  if (result.conflicts.length === 0) return { ...result, resolution, resolvedConflicts: [] };
  const target = comparable(result.merged);
  const selected = resolution === "html" ? result.htmlChanges : result.figmaChanges;
  for (const conflict of result.conflicts) {
    for (const change of selected) {
      if (responsivePointersOverlap(conflict.pointer, change.pointer)) applyResponsiveChange(target, change);
    }
  }
  return {
    ...result,
    merged: normalizeResponsivePageIr({ ...result.merged, ...target }, options),
    conflicts: [],
    resolution,
    resolvedConflicts: result.conflicts.map((conflict) => ({ ...conflict, resolution })),
  };
}

export function responsivePageIrPropertyOwner(pointer) {
  const path = String(pointer || "");
  if (/^\/(?:schemaVersion|protocolVersion|identity|rootId)(?:\/|$)/u.test(path)) return "system";
  if (/^\/previewScale(?:\/|$)/u.test(path)) return "system";
  if (/^\/designViewport(?:\/|$)/u.test(path)) return "figma";
  if (/^\/runtimeViewports(?:\/|$)/u.test(path)) return "html";
  if (/^\/breakpoints\/\d+\/(?:id|minWidth|maxWidth|viewport)(?:\/|$)/u.test(path)) return "html";
  if (/^\/breakpoints(?:\/|$)/u.test(path)) return "shared";
  if (/\/nodes\/[^/]+\/sourceRef\/file$/u.test(path)) return "system";
  if (/\/nodes\/[^/]+\/(?:id|type|parentId|order|childIds)(?:\/|$)/u.test(path)) return "system";
  if (/\/nodes\/[^/]+\/resource\/(?:sha256|bytes)(?:\/|$)/u.test(path)) return "system";
  if (/\/nodes\/[^/]+\/(?:tag|sourceRef|semantics|interaction)(?:\/|$)/u.test(path)) return "html";
  if (/\/nodes\/[^/]+\/(?:name|figma)(?:\/|$)/u.test(path)) return "figma";
  if (/\/nodes\/[^/]+\/(?:geometry|visibility|appearance|layout|content|resource|adaptation|sizing|constraints|overflow|textFlow)(?:\/|$)/u.test(path)) return "shared";
  if (/^\/(?:name|degradations)(?:\/|$)/u.test(path)) return "shared";
  return "system";
}

function normalizeIdentity(value, expectedExactBuild) {
  const identity = object(value, "identity", "identity");
  exactKeys(identity, ["kind", "generation", "exactBuild"], "identity");
  if (identity.kind !== PAGE_IR_RESPONSIVE_IDENTITY) {
    throw new ResponsivePageIrValidationError("Legacy or unknown Page IR identity is rejected.", "identity.kind");
  }
  if (identity.generation !== "0.9") {
    throw new ResponsivePageIrValidationError("Only the 0.9 identity generation is accepted.", "identity.generation");
  }
  const exactBuild = limitedString(identity.exactBuild, 160, "identity.exactBuild");
  if (!/^0\.9\.0\+codex\.[0-9]{14}$/u.test(exactBuild)) {
    throw new ResponsivePageIrValidationError("Exact build must be a 0.9 cachebuster identity.", "identity.exactBuild");
  }
  if (expectedExactBuild && exactBuild !== expectedExactBuild) {
    throw new ResponsivePageIrValidationError(
      `Exact build ${exactBuild} does not match ${expectedExactBuild}.`,
      "identity.exactBuild",
    );
  }
  return { kind: PAGE_IR_RESPONSIVE_IDENTITY, generation: "0.9", exactBuild };
}

function responsiveAdaptation(source, type, nodeId, { isRoot = false } = {}) {
  const item = source.layoutItem && typeof source.layoutItem === "object" ? source.layoutItem : {};
  const rawHorizontal = source.sizing?.horizontal?.mode || item.horizontalSizing;
  const rawVertical = source.sizing?.vertical?.mode || item.verticalSizing;
  // The browser capture root has no parent and therefore no CSS layout-item
  // metadata. Its concrete design viewport is an explicit fixed-size contract,
  // so infer only the root sizing modes instead of degrading every round trip.
  const horizontalMode = normalizeSizingMode(rawHorizontal) || (isRoot ? "fixed" : null);
  const verticalMode = normalizeSizingMode(rawVertical) || (isRoot ? "fixed" : null);
  const rawConstraints = source.constraints || source.responsive?.constraints;
  const hasConstraints = rawConstraints && typeof rawConstraints === "object";
  const missing = [];
  if (!horizontalMode) missing.push("horizontal sizing");
  if (!verticalMode) missing.push("vertical sizing");
  if (!hasConstraints) missing.push("constraints");
  const supported = missing.length === 0;
  return {
    adaptation: {
      status: supported ? "supported" : "unsupported",
      reason: supported ? "" : `Node ${nodeId} is missing explicit ${missing.join(", ")}.`,
    },
    sizing: supported ? {
      horizontal: {
        mode: horizontalMode,
        min: nullableNonNegative(source.sizing?.horizontal?.min ?? source.responsive?.minWidth),
        max: nullableNonNegative(source.sizing?.horizontal?.max ?? source.responsive?.maxWidth),
      },
      vertical: {
        mode: verticalMode,
        min: nullableNonNegative(source.sizing?.vertical?.min ?? source.responsive?.minHeight),
        max: nullableNonNegative(source.sizing?.vertical?.max ?? source.responsive?.maxHeight),
      },
      aspectRatio: nullablePositive(source.sizing?.aspectRatio ?? source.aspectRatio),
    } : null,
    constraints: supported ? {
      horizontal: String(rawConstraints.horizontal || "").toUpperCase(),
      vertical: String(rawConstraints.vertical || "").toUpperCase(),
    } : null,
    overflow: supported ? {
      x: source.overflow?.x || (source.clipsContent ? "hidden" : "visible"),
      y: source.overflow?.y || (source.clipsContent ? "hidden" : "visible"),
    } : null,
    textFlow: type === "text" && supported ? responsiveTextFlow(source) : null,
  };
}

function responsiveTextContent(source) {
  const font = source.font || {};
  return jsonClone({
    characters: source.text ?? source.content?.characters ?? "",
    font: {
      family: font.family || source.fontName?.family || "Inter",
      style: font.style || source.fontName?.style || "Regular",
      size: font.size || source.fontSize || 16,
      lineHeight: responsiveCanonicalTextUnit(font.lineHeight ?? source.lineHeight, { unit: "AUTO" }),
      letterSpacing: responsiveCanonicalTextUnit(font.letterSpacing ?? source.letterSpacing, { unit: "PIXELS", value: 0 }),
    },
    align: {
      horizontal: String(source.textAlignHorizontal || source.textAlign || "LEFT").toUpperCase(),
      vertical: String(source.textAlignVertical || "TOP").toUpperCase(),
    },
    textCase: source.textCase || "ORIGINAL",
    textDecoration: source.textDecoration || "NONE",
  });
}

function responsiveCanonicalTextUnit(value, fallback) {
  if (typeof value === "number") return { unit: "PIXELS", value };
  if (!value || typeof value !== "object") return structuredClone(fallback);
  const unit = String(value.unit || "PIXELS").toUpperCase();
  return unit === "AUTO" ? { unit: "AUTO" } : { unit, value: Number(value.value ?? 0) };
}

function responsiveCanonicalLayout(value) {
  const source = value && typeof value === "object" ? value : {};
  if (typeof source.mode === "string") {
    const mode = source.mode.toUpperCase();
    const direction = mode === "HORIZONTAL" ? "horizontal" : mode === "VERTICAL" ? "vertical" : "none";
    return {
      kind: source.kind || (mode === "NONE" ? "none" : "flex"),
      direction,
      gap: Number(source.itemSpacing || 0),
      counterGap: Number(source.counterAxisSpacing ?? source.itemSpacing ?? 0),
      padding: jsonClone(source.padding || { top: 0, right: 0, bottom: 0, left: 0 }),
      align: ({ MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" })[source.counterAxisAlignItems] || "start",
      justify: ({ MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" })[source.primaryAxisAlignItems] || "start",
      wrap: Boolean(source.wrap),
      primarySizing: source.primaryAxisSizingMode === "AUTO" ? "hug" : "fixed",
      counterSizing: source.counterAxisSizingMode === "AUTO" ? "hug" : "fixed",
      ...(source.grid ? { grid: jsonClone(source.grid) } : {}),
    };
  }
  return {
    kind: source.kind || (source.direction && source.direction !== "none" ? "flex" : "none"),
    direction: source.direction || "none",
    gap: Number(source.gap ?? source.itemSpacing ?? 0),
    counterGap: Number(
      source.counterGap ?? source.counterAxisSpacing ?? source.gap ?? source.itemSpacing ?? 0,
    ),
    padding: jsonClone(source.padding || { top: 0, right: 0, bottom: 0, left: 0 }),
    align: source.align || "start",
    justify: source.justify || "start",
    wrap: Boolean(source.wrap),
    primarySizing: source.primarySizing || "fixed",
    counterSizing: source.counterSizing || "fixed",
    ...(source.grid ? { grid: jsonClone(source.grid) } : {}),
  };
}

function responsiveCanonicalAppearance(value) {
  const appearance = jsonClone(value && typeof value === "object" ? value : {});
  const normalizePaint = (paint) => {
    if (typeof paint === "string" && /^#[0-9a-f]{6}$/iu.test(paint)) return paint.toUpperCase();
    if (paint && typeof paint === "object" && typeof paint.color === "string" && /^#[0-9a-f]{6}$/iu.test(paint.color)) {
      const color = paint.color.toUpperCase();
      if (paint.opacity == null || paint.opacity === 1) return color;
      return { ...paint, color };
    }
    return paint;
  };
  if ("fill" in appearance) appearance.fill = normalizePaint(appearance.fill);
  if ("stroke" in appearance) appearance.stroke = normalizePaint(appearance.stroke);
  if (Array.isArray(appearance.fills)) appearance.fills = appearance.fills.map(normalizePaint);
  if (Array.isArray(appearance.strokes)) appearance.strokes = appearance.strokes.map(normalizePaint);
  return appearance;
}

function responsiveTextFlow(source) {
  const truncates = source.textTruncation === "ENDING" || Number.isInteger(source.maxLines);
  return {
    wrap: source.maxLines === 1 ? "no-wrap" : "wrap",
    overflow: truncates ? "ellipsis" : (source.clipsContent ? "clip" : "visible"),
    autoHeight: ["HEIGHT", "WIDTH_AND_HEIGHT"].includes(String(source.textAutoResize || "")),
    fallbackFamilies: Array.isArray(source.fallbackFamilies)
      ? source.fallbackFamilies.map(String)
      : [],
  };
}

function responsiveResource(source, type, path) {
  const raw = source.resource || source[type];
  const value = type === "svg" && typeof raw === "string"
    ? { mimeType: "image/svg+xml", base64: Buffer.from(raw, "utf8").toString("base64") }
    : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResponsivePageIrValidationError("resource is required", `${path}.${type}`);
  }
  const base64 = typeof value.base64 === "string" ? value.base64 : "";
  if (!base64) throw new ResponsivePageIrValidationError("resource base64 is required", `${path}.${type}.base64`);
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/u, "") !== base64.replace(/=+$/u, "")) {
    throw new ResponsivePageIrValidationError("resource base64 is invalid", `${path}.${type}.base64`);
  }
  return {
    kind: type,
    mimeType: String(value.mimeType || (type === "svg" ? "image/svg+xml" : "image/png")),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64,
  };
}

function normalizeConstructorOrigin(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    kind: source.kind || "mixed",
    figmaFileKey: String(source.figmaFileKey || ""),
    rootNodeId: String(source.rootNodeId || ""),
    rootNodeName: String(source.rootNodeName || ""),
    sourceFile: String(source.sourceFile || ""),
    sourceSelector: String(source.sourceSelector || ""),
  };
}

function normalizeConstructorDegradation(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    nodeId: String(source.nodeId || ""),
    reason: String(source.reason || "unsupported"),
    message: String(source.message || source.error || ""),
  };
}

function normalizeSizingMode(value) {
  const mode = String(value || "").toLowerCase();
  return ["fixed", "hug", "fill"].includes(mode) ? mode : "";
}

function nullableNonNegative(value) {
  return value == null ? null : value;
}

function nullablePositive(value) {
  return value == null ? null : value;
}

function normalizeNodes(value) {
  const input = object(value, "nodes", "nodes");
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > PAGE_IR_RESPONSIVE_MAX_NODES) {
    throw new ResponsivePageIrValidationError(`must contain 1-${PAGE_IR_RESPONSIVE_MAX_NODES} nodes`, "nodes");
  }
  const result = {};
  for (const [key, sourceValue] of entries) {
    const path = `nodes.${key}`;
    const source = object(sourceValue, "node", path);
    exactKeys(source, [
      "id", "type", "tag", "name", "parentId", "order", "childIds", "sourceRef", "semantics",
      "interaction", "figma", "geometry", "visibility", "appearance", "layout", "content", "resource",
      "adaptation", "sizing", "constraints", "overflow", "textFlow",
    ], path);
    const id = requiredId(source.id, `${path}.id`);
    if (id !== key) throw new ResponsivePageIrValidationError("node key and id differ", `${path}.id`);
    const type = limitedString(source.type, 20, `${path}.type`);
    if (!NODE_TYPES.has(type)) throw new ResponsivePageIrValidationError("unsupported node type", `${path}.type`);
    const adaptation = normalizeAdaptation(source.adaptation, `${path}.adaptation`);
    const sizing = source.sizing == null ? null : normalizeSizing(source.sizing, `${path}.sizing`);
    const constraints = source.constraints == null ? null : normalizeConstraints(source.constraints, `${path}.constraints`);
    const overflow = source.overflow == null ? null : normalizeOverflow(source.overflow, `${path}.overflow`);
    if (adaptation.status === "supported" && (!sizing || !constraints || !overflow)) {
      throw new ResponsivePageIrValidationError(
        "supported nodes require explicit sizing, constraints, and overflow",
        `${path}.adaptation`,
      );
    }
    if (adaptation.status === "unsupported" && !adaptation.reason) {
      throw new ResponsivePageIrValidationError("unsupported nodes require a reason", `${path}.adaptation.reason`);
    }
    const textFlow = source.textFlow == null ? null : normalizeTextFlow(source.textFlow, `${path}.textFlow`);
    if (type === "text" && adaptation.status === "supported" && !textFlow) {
      throw new ResponsivePageIrValidationError("supported text requires explicit textFlow", `${path}.textFlow`);
    }
    if (type !== "text" && textFlow) {
      throw new ResponsivePageIrValidationError("textFlow is only valid on text nodes", `${path}.textFlow`);
    }
    result[id] = {
      id,
      type,
      tag: normalizeTag(source.tag, `${path}.tag`),
      name: limitedString(source.name, 160, `${path}.name`),
      parentId: source.parentId == null ? null : requiredId(source.parentId, `${path}.parentId`),
      order: integer(source.order, -10_000, 10_000, `${path}.order`),
      childIds: normalizeIdArray(source.childIds, `${path}.childIds`),
      sourceRef: jsonObject(source.sourceRef, `${path}.sourceRef`),
      semantics: jsonObject(source.semantics, `${path}.semantics`),
      interaction: jsonObject(source.interaction, `${path}.interaction`),
      figma: jsonObject(source.figma, `${path}.figma`),
      geometry: normalizeGeometry(source.geometry, `${path}.geometry`),
      visibility: jsonObject(source.visibility, `${path}.visibility`),
      appearance: jsonObject(source.appearance, `${path}.appearance`),
      layout: source.layout == null ? null : jsonObject(source.layout, `${path}.layout`),
      content: source.content == null ? null : jsonObject(source.content, `${path}.content`),
      resource: source.resource == null ? null : jsonObject(source.resource, `${path}.resource`),
      adaptation,
      sizing,
      constraints,
      overflow,
      textFlow,
    };
  }
  return result;
}

function normalizeRuntimeViewports(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > RESPONSIVE_ACCEPTANCE_WIDTHS.length) {
    throw new ResponsivePageIrValidationError("must contain 1-6 explicit runtime viewports", "runtimeViewports");
  }
  const ids = new Set();
  const result = value.map((entry, index) => {
    const path = `runtimeViewports[${index}]`;
    const viewport = object(entry, "runtime viewport", path);
    exactKeys(viewport, ["id", "width", "height", "devicePixelRatio"], path);
    const id = requiredId(viewport.id, `${path}.id`);
    if (ids.has(id)) throw new ResponsivePageIrValidationError("duplicate runtime viewport id", `${path}.id`);
    ids.add(id);
    if (!RESPONSIVE_ACCEPTANCE_WIDTHS.includes(viewport.width)) {
      throw new ResponsivePageIrValidationError("width is outside the 0.9 acceptance contract", `${path}.width`);
    }
    return {
      id,
      width: viewport.width,
      height: viewport.height == null ? null : positiveNumber(viewport.height, 100_000, `${path}.height`),
      devicePixelRatio: positiveNumber(viewport.devicePixelRatio, 8, `${path}.devicePixelRatio`),
    };
  });
  return result.sort((left, right) => left.width - right.width || left.id.localeCompare(right.id));
}

function normalizeBreakpoints(value, nodes) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ResponsivePageIrValidationError("must be an array of at most 32 breakpoints", "breakpoints");
  }
  const ids = new Set();
  const result = value.map((entry, index) => {
    const path = `breakpoints[${index}]`;
    const source = object(entry, "breakpoint", path);
    exactKeys(source, ["id", "minWidth", "maxWidth", "viewport", "overrides"], path);
    const id = requiredId(source.id, `${path}.id`);
    if (ids.has(id)) throw new ResponsivePageIrValidationError("duplicate breakpoint id", `${path}.id`);
    ids.add(id);
    const minWidth = nonNegativeNumber(source.minWidth, `${path}.minWidth`);
    const maxWidth = source.maxWidth == null ? null : positiveNumber(source.maxWidth, 100_000, `${path}.maxWidth`);
    if (maxWidth != null && maxWidth < minWidth) {
      throw new ResponsivePageIrValidationError("maxWidth must be greater than or equal to minWidth", `${path}.maxWidth`);
    }
    const viewport = normalizeViewport(source.viewport, `${path}.viewport`, { requireHeight: false });
    if (!RESPONSIVE_ACCEPTANCE_WIDTHS.includes(viewport.width)) {
      throw new ResponsivePageIrValidationError("viewport width is outside the 0.9 acceptance contract", `${path}.viewport.width`);
    }
    if (viewport.width < minWidth || (maxWidth != null && viewport.width > maxWidth)) {
      throw new ResponsivePageIrValidationError("viewport width must fall inside the breakpoint range", `${path}.viewport.width`);
    }
    return { id, minWidth, maxWidth, viewport, overrides: normalizeOverrides(source.overrides, nodes, `${path}.overrides`) };
  });
  result.sort((left, right) => left.minWidth - right.minWidth || left.id.localeCompare(right.id));
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    if (previous.maxWidth == null || previous.maxWidth >= result[index].minWidth) {
      throw new ResponsivePageIrValidationError("breakpoint ranges must not overlap", "breakpoints");
    }
  }
  return result;
}

function normalizeOverrides(value, nodes, path) {
  const input = object(value, "breakpoint overrides", path);
  const result = {};
  for (const [nodeId, overrideValue] of Object.entries(input)) {
    if (!nodes[nodeId]) throw new ResponsivePageIrValidationError("override references an unknown node", `${path}.${nodeId}`);
    const override = object(overrideValue, "node override", `${path}.${nodeId}`);
    allowedKeys(override, ["sizing", "constraints", "overflow", "layout", "visibility"], `${path}.${nodeId}`);
    if (Object.keys(override).length === 0) {
      throw new ResponsivePageIrValidationError("node override must change at least one field", `${path}.${nodeId}`);
    }
    result[nodeId] = {
      ...(override.sizing === undefined ? {} : { sizing: normalizeSizing(override.sizing, `${path}.${nodeId}.sizing`) }),
      ...(override.constraints === undefined ? {} : { constraints: normalizeConstraints(override.constraints, `${path}.${nodeId}.constraints`) }),
      ...(override.overflow === undefined ? {} : { overflow: normalizeOverflow(override.overflow, `${path}.${nodeId}.overflow`) }),
      ...(override.layout === undefined ? {} : { layout: override.layout == null ? null : jsonObject(override.layout, `${path}.${nodeId}.layout`) }),
      ...(override.visibility === undefined ? {} : { visibility: jsonObject(override.visibility, `${path}.${nodeId}.visibility`) }),
    };
  }
  return sortObject(result);
}

function normalizePreviewScale(value, breakpoints) {
  const source = object(value, "previewScale", "previewScale");
  exactKeys(source, ["mode", "value", "breakpointId"], "previewScale");
  const mode = enumValue(source.mode, ["one-to-one", "fit-window", "breakpoint"], "previewScale.mode");
  const scale = positiveNumber(source.value, 16, "previewScale.value");
  const breakpointId = source.breakpointId == null ? null : requiredId(source.breakpointId, "previewScale.breakpointId");
  if (mode === "one-to-one" && scale !== 1) {
    throw new ResponsivePageIrValidationError("one-to-one preview scale must equal 1", "previewScale.value");
  }
  if (mode === "breakpoint" && !breakpoints.some((breakpoint) => breakpoint.id === breakpointId)) {
    throw new ResponsivePageIrValidationError("breakpoint preview must reference an explicit breakpoint", "previewScale.breakpointId");
  }
  if (mode !== "breakpoint" && breakpointId !== null) {
    throw new ResponsivePageIrValidationError("breakpointId is only valid in breakpoint mode", "previewScale.breakpointId");
  }
  return { mode, value: scale, breakpointId };
}

function normalizeViewport(value, path, { requireHeight }) {
  const source = object(value, "viewport", path);
  exactKeys(source, ["width", "height"], path);
  return {
    width: positiveNumber(source.width, 100_000, `${path}.width`),
    height: source.height == null && !requireHeight ? null : positiveNumber(source.height, 100_000, `${path}.height`),
  };
}

function normalizeAdaptation(value, path) {
  const source = object(value, "adaptation", path);
  exactKeys(source, ["status", "reason"], path);
  return {
    status: enumValue(source.status, ["supported", "unsupported"], `${path}.status`),
    reason: limitedString(source.reason, 500, `${path}.reason`),
  };
}

function normalizeSizing(value, path) {
  const source = object(value, "sizing", path);
  exactKeys(source, ["horizontal", "vertical", "aspectRatio"], path);
  return {
    horizontal: normalizeAxisSizing(source.horizontal, `${path}.horizontal`),
    vertical: normalizeAxisSizing(source.vertical, `${path}.vertical`),
    aspectRatio: source.aspectRatio == null ? null : positiveNumber(source.aspectRatio, 10_000, `${path}.aspectRatio`),
  };
}

function normalizeAxisSizing(value, path) {
  const source = object(value, "axis sizing", path);
  exactKeys(source, ["mode", "min", "max"], path);
  const min = source.min == null ? null : nonNegativeNumber(source.min, `${path}.min`);
  const max = source.max == null ? null : nonNegativeNumber(source.max, `${path}.max`);
  if (min != null && max != null && max < min) {
    throw new ResponsivePageIrValidationError("max must be greater than or equal to min", `${path}.max`);
  }
  return { mode: enumValue(source.mode, ["fixed", "hug", "fill"], `${path}.mode`), min, max };
}

function normalizeConstraints(value, path) {
  const source = object(value, "constraints", path);
  exactKeys(source, ["horizontal", "vertical"], path);
  return {
    horizontal: enumValue(source.horizontal, ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"], `${path}.horizontal`),
    vertical: enumValue(source.vertical, ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"], `${path}.vertical`),
  };
}

function normalizeOverflow(value, path) {
  const source = object(value, "overflow", path);
  exactKeys(source, ["x", "y"], path);
  const allowed = ["visible", "hidden", "clip", "scroll", "auto"];
  return { x: enumValue(source.x, allowed, `${path}.x`), y: enumValue(source.y, allowed, `${path}.y`) };
}

function normalizeTextFlow(value, path) {
  const source = object(value, "textFlow", path);
  exactKeys(source, ["wrap", "overflow", "autoHeight", "fallbackFamilies"], path);
  if (!Array.isArray(source.fallbackFamilies) || source.fallbackFamilies.length > 16) {
    throw new ResponsivePageIrValidationError("fallbackFamilies must be an array of at most 16 entries", `${path}.fallbackFamilies`);
  }
  return {
    wrap: enumValue(source.wrap, ["wrap", "no-wrap"], `${path}.wrap`),
    overflow: enumValue(source.overflow, ["visible", "clip", "ellipsis"], `${path}.overflow`),
    autoHeight: Boolean(source.autoHeight),
    fallbackFamilies: source.fallbackFamilies.map((family, index) => limitedString(family, 120, `${path}.fallbackFamilies[${index}]`)),
  };
}

function normalizeGeometry(value, path) {
  const source = object(value, "geometry", path);
  exactKeys(source, ["width", "height", "x", "y", "rotation"], path);
  return {
    width: positiveNumber(source.width, 100_000, `${path}.width`),
    height: positiveNumber(source.height, 100_000, `${path}.height`),
    x: finiteNumber(source.x, `${path}.x`),
    y: finiteNumber(source.y, `${path}.y`),
    rotation: finiteNumber(source.rotation, `${path}.rotation`),
  };
}

function normalizeOrigin(value) {
  const source = object(value, "origin", "origin");
  exactKeys(source, ["kind", "figmaFileKey", "rootNodeId", "rootNodeName", "sourceFile", "sourceSelector"], "origin");
  return {
    kind: enumValue(source.kind, ["html", "figma", "mixed"], "origin.kind"),
    figmaFileKey: limitedString(source.figmaFileKey, 256, "origin.figmaFileKey"),
    rootNodeId: limitedString(source.rootNodeId, 128, "origin.rootNodeId"),
    rootNodeName: limitedString(source.rootNodeName, 256, "origin.rootNodeName"),
    sourceFile: limitedString(source.sourceFile, 500, "origin.sourceFile"),
    sourceSelector: limitedString(source.sourceSelector, 500, "origin.sourceSelector"),
  };
}

function normalizeDegradations(value) {
  if (!Array.isArray(value) || value.length > PAGE_IR_RESPONSIVE_MAX_NODES) {
    throw new ResponsivePageIrValidationError("must be an array of at most 500 entries", "degradations");
  }
  return value.map((entry, index) => {
    const path = `degradations[${index}]`;
    const source = object(entry, "degradation", path);
    exactKeys(source, ["nodeId", "reason", "message"], path);
    return {
      nodeId: limitedString(source.nodeId, 128, `${path}.nodeId`),
      reason: limitedString(source.reason, 160, `${path}.reason`),
      message: limitedString(source.message, 500, `${path}.message`),
    };
  });
}

function validateNodeGraph(rootId, nodes) {
  if (!nodes[rootId]) throw new ResponsivePageIrValidationError("root node is missing", "rootId");
  if (nodes[rootId].parentId !== null) throw new ResponsivePageIrValidationError("root parentId must be null", `nodes.${rootId}.parentId`);
  const seen = new Set();
  const active = new Set();
  const visit = (id) => {
    if (active.has(id)) throw new ResponsivePageIrValidationError("node graph contains a cycle", `nodes.${id}`);
    if (seen.has(id)) throw new ResponsivePageIrValidationError("node has multiple parents", `nodes.${id}`);
    const node = nodes[id];
    if (!node) throw new ResponsivePageIrValidationError("child node is missing", `nodes.${id}`);
    active.add(id);
    seen.add(id);
    node.childIds.forEach((childId, index) => {
      if (nodes[childId]?.parentId !== id) throw new ResponsivePageIrValidationError("child parentId mismatch", `nodes.${childId}.parentId`);
      if (nodes[childId]?.order !== index) throw new ResponsivePageIrValidationError("child order mismatch", `nodes.${childId}.order`);
      visit(childId);
    });
    active.delete(id);
  };
  visit(rootId);
  if (seen.size !== Object.keys(nodes).length) throw new ResponsivePageIrValidationError("contains unreachable nodes", "nodes");
}

function assertSameIdentity(left, right) {
  if (left.pageId !== right.pageId || left.rootId !== right.rootId) {
    throw new ResponsivePageIrValidationError("Page IR page identity differs.");
  }
  if (left.identity.exactBuild !== right.identity.exactBuild) {
    throw new ResponsivePageIrValidationError("Page IR exact build identity differs.", "identity.exactBuild");
  }
}

function hashNormalizedResponsivePageIr(value) {
  const semantic = structuredClone(value);
  delete semantic.irHash;
  delete semantic.previewScale;
  for (const node of Object.values(semantic.nodes || {})) {
    if (node.resource) delete node.resource.base64;
  }
  return createHash("sha256").update(stableStringify(semantic)).digest("hex");
}

function comparable(value) {
  const result = structuredClone(value);
  delete result.irHash;
  return result;
}

function diffValues(before, after, pointer, changes) {
  if (deepEqual(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (!(key in before)) changes.push({ pointer: childPointer, before: undefined, after: structuredClone(after[key]), deleted: false });
      else if (!(key in after)) changes.push({ pointer: childPointer, before: structuredClone(before[key]), after: undefined, deleted: true });
      else diffValues(before[key], after[key], childPointer, changes);
    }
    return;
  }
  changes.push({
    pointer: pointer || "/",
    before: before === undefined ? undefined : structuredClone(before),
    after: after === undefined ? undefined : structuredClone(after),
    deleted: after === undefined,
  });
}

function applyResponsiveChange(target, change) {
  const parts = change.pointer.split("/").slice(1).map(unescapePointer);
  if (!parts.length) throw new ResponsivePageIrValidationError("Root replacement is not supported.");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      throw new ResponsivePageIrValidationError("Change pointer crosses a non-container.", change.pointer);
    }
    if (!(part in current)) current[part] = {};
    current = current[part];
  }
  const key = parts.at(-1);
  if (change.deleted) delete current[key];
  else current[key] = structuredClone(change.after);
}

function sameResponsiveChange(left, right) {
  return left.deleted === right.deleted && deepEqual(left.after, right.after);
}

function responsiveConflict(pointer, html, figma, reason) {
  return {
    pointer,
    owner: html?.owner || figma?.owner || responsivePageIrPropertyOwner(pointer),
    reason,
    html: html ? structuredClone(html) : null,
    figma: figma ? structuredClone(figma) : null,
  };
}

function responsivePointersOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function unescapePointer(value) {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function exactKeys(value, allowed, path) {
  allowedKeys(value, allowed, path);
  for (const key of allowed) {
    if (key === "irHash") continue;
    if (!(key in value)) throw new ResponsivePageIrValidationError(`missing required field ${key}`, path || key);
  }
}

function allowedKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ResponsivePageIrValidationError(`unknown field ${key}`, path || key);
  }
}

function object(value, label, path) {
  if (!isPlainObject(value)) throw new ResponsivePageIrValidationError(`${label} must be an object`, path);
  return value;
}

function jsonObject(value, path) {
  return sortJsonObject(object(value, "value", path));
}

function sortJsonObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [
    key,
    Array.isArray(child) ? child.map((entry) => isPlainObject(entry) ? sortJsonObject(entry) : entry) : isPlainObject(child) ? sortJsonObject(child) : child,
  ]));
}

function normalizeIdArray(value, path) {
  if (!Array.isArray(value) || value.length > PAGE_IR_RESPONSIVE_MAX_NODES) {
    throw new ResponsivePageIrValidationError("must be an array of node ids", path);
  }
  return value.map((id, index) => requiredId(id, `${path}[${index}]`));
}

function requiredId(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ResponsivePageIrValidationError(`must match ${ID_PATTERN}`, path);
  }
  return value;
}

function normalizeTag(value, path) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,40}$/u.test(value)) {
    throw new ResponsivePageIrValidationError("invalid semantic tag", path);
  }
  return value;
}

function limitedString(value, maximum, path) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new ResponsivePageIrValidationError(`must be a string of at most ${maximum} characters`, path);
  }
  return value;
}

function positiveNumber(value, maximum, path) {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new ResponsivePageIrValidationError(`must be greater than 0 and at most ${maximum}`, path);
  }
  return value;
}

function nonNegativeNumber(value, path) {
  if (!Number.isFinite(value) || value < 0) throw new ResponsivePageIrValidationError("must be non-negative", path);
  return value;
}

function finiteNumber(value, path) {
  if (!Number.isFinite(value)) throw new ResponsivePageIrValidationError("must be finite", path);
  return value;
}

function integer(value, minimum, maximum, path) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ResponsivePageIrValidationError("must be a bounded integer", path);
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) throw new ResponsivePageIrValidationError(`must be one of ${allowed.join(", ")}`, path);
  return value;
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(left, right) {
  return Object.is(left, right) || stableStringify(left) === stableStringify(right);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stablePageId(value) {
  const input = String(value || "figma-page");
  if (ID_PATTERN.test(input)) return input;
  return `figma-${createHash("sha256").update(input).digest("hex").slice(0, 16)}`;
}
