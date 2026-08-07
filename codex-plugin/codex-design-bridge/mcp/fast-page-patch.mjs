import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { prepareSvgAsset } from "../shared/svg.mjs";
import {
  commitPatchTransaction,
  hashContent,
} from "./patch-transaction.mjs";

const MARKER_START = "/* Codex Design Bridge overrides: start */";
const MARKER_END = "/* Codex Design Bridge overrides: end */";
const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".jsx",
  ".tsx",
  ".js",
  ".ts",
  ".vue",
  ".svelte",
]);
const IGNORED_DIRECTORIES = new Set([
  ".cdb-imports",
  ".codex",
  ".figma-sync",
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const CHANGESET_PROTOCOL_VERSION = 14;
const VECTOR_NODE_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "STAR",
  "VECTOR",
]);
const BORDER_NODE_TYPES = new Set([
  "COMPONENT",
  "FRAME",
  "INSTANCE",
  "RECTANGLE",
]);
const SAFE_DELETE_NODE_TYPES = new Set(["FRAME", "IMAGE", "SVG", "TEXT"]);
const VOID_MARKUP_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export async function applyFastPageChanges({
  projectDir,
  changeSet,
  manifest,
}) {
  const startedAt = Date.now();
  const root = path.resolve(projectDir);
  const changes = Array.isArray(changeSet?.changes) ? changeSet.changes : [];
  const pending = [];

  if (
    changeSet?.protocolVersion !== undefined &&
    ![13, CHANGESET_PROTOCOL_VERSION].includes(changeSet.protocolVersion)
  ) {
    return pendingResult(changes, "unsupported_change_protocol", startedAt);
  }

  if (!manifest || manifest.pageId !== changeSet?.pageId) {
    return pendingResult(changes, "missing_page_mapping", startedAt);
  }
  if (
    typeof changeSet.sourceHash !== "string" ||
    changeSet.sourceHash !== manifest.sourceHash
  ) {
    return pendingResult(changes, "stale_page_mapping", startedAt);
  }

  const files = await listProjectFiles(root);
  const sourceFiles = files.filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  const cssFiles = files.filter(
    (file) => path.extname(file).toLowerCase() === ".css",
  );
  const sourceCache = new Map();
  sourceCache.initial = new Map();
  const cssUpdates = new Map();
  const textUpdates = new Map();
  const assetUpdates = new Map();
  let appliedCount = 0;

  for (const change of changes) {
    if (
      changeSet?.protocolVersion === CHANGESET_PROTOCOL_VERSION &&
      ["nodeMove", "nodeReparent"].includes(change?.property)
    ) {
      const protocolError = validateProtocol14StructureChange(change);
      if (protocolError) {
        pending.push(
          pendingChange(
            change,
            `invalid_protocol14_structure:${protocolError}`,
            "protocol",
          ),
        );
        continue;
      }
    }
    if (change.property === "svgUnavailable") {
      pending.push(pendingChange(change, "svg_not_exportable"));
      continue;
    }
    const externalSvgFile =
      change.property === "svg"
        ? await findExternalSvgFile(root, change?.sourceRef?.file)
        : "";
    const selector = fastSelector(change);
    if (!selector && !externalSvgFile) {
      pending.push(pendingChange(change, "missing_stable_selector"));
      continue;
    }

    if (change.property === "pageSeed") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const rendered = renderInsertedPageNode(
        change?.to?.node,
        path.extname(sourceFile).toLowerCase(),
      );
      if (!rendered.ok) {
        pending.push(pendingChange(change, rendered.reason));
        continue;
      }
      const cssFile = await findCssFile({
        root,
        sourceFile,
        cssFiles,
        sourceCache,
      });
      if (rendered.rules.length > 0 && !cssFile) {
        pending.push(pendingChange(change, "stylesheet_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = replaceMappedMarkup(
        current,
        selector,
        rendered.markup,
        rendered.nodeId,
      );
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      textUpdates.set(sourceFile, updated.content);
      sourceCache.set(sourceFile, updated.content);
      if (cssFile) {
        const rules =
          cssUpdates.get(cssFile) ??
          parseManagedRules(await readCachedSource(cssFile, sourceCache));
        for (const rule of rendered.rules) {
          const declarations = rules.get(rule.selector) || new Map();
          for (const declaration of rule.declarations) {
            declarations.set(declaration.property, declaration.value);
          }
          rules.set(rule.selector, declarations);
        }
        cssUpdates.set(cssFile, rules);
      }
      for (const asset of rendered.assets) {
        const assetFile = resolveInside(
          root,
          path.join(root, "codex-design-assets", asset.fileName),
        );
        if (!assetFile) {
          pending.push(pendingChange(change, "invalid_insert_asset"));
          continue;
        }
        assetUpdates.set(assetFile, asset.bytes);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "nodeInsert") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const rendered = renderInsertedPageNode(
        change?.to?.node,
        path.extname(sourceFile).toLowerCase(),
      );
      if (!rendered.ok) {
        pending.push(pendingChange(change, rendered.reason));
        continue;
      }
      const cssFile = await findCssFile({
        root,
        sourceFile,
        cssFiles,
        sourceCache,
      });
      if (rendered.rules.length > 0 && !cssFile) {
        pending.push(pendingChange(change, "stylesheet_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = insertMappedMarkup(
        current,
        selector,
        rendered.markup,
        rendered.nodeId,
      );
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
        sourceCache.set(sourceFile, updated.content);
      }
      if (cssFile) {
        const rules =
          cssUpdates.get(cssFile) ??
          parseManagedRules(await readCachedSource(cssFile, sourceCache));
        for (const rule of rendered.rules) {
          const declarations = rules.get(rule.selector) || new Map();
          for (const declaration of rule.declarations) {
            declarations.set(declaration.property, declaration.value);
          }
          rules.set(rule.selector, declarations);
        }
        cssUpdates.set(cssFile, rules);
      }
      for (const asset of rendered.assets) {
        const assetFile = resolveInside(
          root,
          path.join(root, "codex-design-assets", asset.fileName),
        );
        if (!assetFile) {
          pending.push(pendingChange(change, "invalid_insert_asset"));
          continue;
        }
        assetUpdates.set(assetFile, asset.bytes);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "nodeClone") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = cloneMappedElement(current, selector, change.to);
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
        sourceCache.set(sourceFile, updated.content);
      }
      const cssFile = await findCssFile({
        root,
        sourceFile,
        cssFiles,
        sourceCache,
      });
      if (cssFile) {
        const rules =
          cssUpdates.get(cssFile) ??
          parseManagedRules(await readCachedSource(cssFile, sourceCache));
        if (cloneManagedRules(rules, change.to.idMap)) {
          cssUpdates.set(cssFile, rules);
        }
      }
      appliedCount += 1;
      continue;
    }

    if (["nodeMove", "nodeReparent"].includes(change.property)) {
      const targetParentSelector =
        change?.toParentSourceRef?.selector ||
        change?.to?.parentSourceRef?.selector ||
        change?.to?.sourceRef?.selector ||
        "";
      if (!fastStableSelector(targetParentSelector)) {
        pending.push(
          pendingChange(change, "missing_target_parent", "structure"),
        );
        continue;
      }
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(
          pendingChange(change, "source_element_not_found", "structure"),
        );
        continue;
      }
      const cssFile = await findCssFile({
        root,
        sourceFile,
        cssFiles,
        sourceCache,
      });
      const geometry = structuralPositionDeclarations(change);
      if (!geometry.ok) {
        pending.push(pendingChange(change, geometry.reason, "geometry"));
        continue;
      }
      if (geometry.declarations.length > 0 && !cssFile) {
        pending.push(
          pendingChange(change, "stylesheet_not_found", "dependency"),
        );
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = reparentMappedElement(
        current,
        selector,
        targetParentSelector,
        change.toIndex ?? change?.to?.index,
      );
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason, "structure"));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
        sourceCache.set(sourceFile, updated.content);
      }
      if (cssFile && geometry.declarations.length > 0) {
        const rules =
          cssUpdates.get(cssFile) ??
          parseManagedRules(await readCachedSource(cssFile, sourceCache));
        const declarations = rules.get(selector) || new Map();
        for (const declaration of geometry.declarations) {
          if (declaration.value === null) {
            declarations.delete(declaration.property);
          } else {
            declarations.set(declaration.property, declaration.value);
          }
        }
        rules.set(selector, declarations);
        cssUpdates.set(cssFile, rules);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "nodeReorder") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = reorderMappedChildren(current, selector, change.to);
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
        sourceCache.set(sourceFile, updated.content);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "nodeDelete") {
      if (!SAFE_DELETE_NODE_TYPES.has(change.nodeType)) {
        pending.push(pendingChange(change, "unsafe_delete_target"));
        continue;
      }
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = removeMappedElement(
        current,
        selector,
        change.nodeType,
      );
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "svgInsert") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = insertInlineSvg(
        current,
        selector,
        change.to,
        path.extname(sourceFile).toLowerCase(),
      );
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      if (updated.changed) {
        textUpdates.set(sourceFile, updated.content);
      }
      appliedCount += 1;
      continue;
    }

    if (change.property === "svg") {
      if (externalSvgFile) {
        const current =
          textUpdates.get(externalSvgFile) ??
          (await readCachedSource(externalSvgFile, sourceCache));
        const updated = replaceSvgDocument(current, change.to);
        if (!updated.ok) {
          pending.push(pendingChange(change, updated.reason));
          continue;
        }
        textUpdates.set(externalSvgFile, updated.content);
        appliedCount += 1;
        continue;
      }
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = replaceInlineSvg(current, selector, change.to);
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      textUpdates.set(sourceFile, updated.content);
      appliedCount += 1;
      continue;
    }

    if (change.property === "characters") {
      const sourceFile = await findSourceFile({
        root,
        files: sourceFiles,
        sourceCache,
        change,
      });
      if (!sourceFile) {
        pending.push(pendingChange(change, "source_element_not_found"));
        continue;
      }
      const current =
        textUpdates.get(sourceFile) ??
        (await readCachedSource(sourceFile, sourceCache));
      const updated = replaceText(current, selector, change.to);
      if (!updated.ok) {
        pending.push(pendingChange(change, updated.reason));
        continue;
      }
      textUpdates.set(sourceFile, updated.content);
      appliedCount += 1;
      continue;
    }

    const nextDeclarations = cssDeclarations(change);
    if (!nextDeclarations) {
      pending.push(pendingChange(change, "unsupported_property"));
      continue;
    }
    const sourceFile = await findSourceFile({
      root,
      files: sourceFiles,
      sourceCache,
      change,
    });
    const cssFile = await findCssFile({
      root,
      sourceFile,
      cssFiles,
      sourceCache,
    });
    if (!cssFile) {
      pending.push(pendingChange(change, "stylesheet_not_found"));
      continue;
    }
    const rules =
      cssUpdates.get(cssFile) ??
      parseManagedRules(await readCachedSource(cssFile, sourceCache));
    const declarations = rules.get(selector) || new Map();
    for (const declaration of nextDeclarations) {
      if (declaration.value === null) {
        declarations.delete(declaration.property);
      } else {
        declarations.set(declaration.property, declaration.value);
      }
    }
    rules.set(selector, declarations);
    cssUpdates.set(cssFile, rules);
    appliedCount += 1;
  }

  const hasPendingStructuralChange = pending.some((change) =>
    [
      "pageSeed",
      "nodeClone",
      "nodeInsert",
      "nodeMove",
      "nodeReparent",
      "nodeReorder",
    ].includes(change.property),
  );
  const hasDependentDelete = changes.some(
    (change) => change?.property === "nodeDelete",
  );
  if (hasPendingStructuralChange && hasDependentDelete) {
    return pendingResult(changes, "dependent_structure_pending", startedAt);
  }

  const finalUpdates = new Map(textUpdates);
  for (const [file, rules] of cssUpdates) {
    const current = finalUpdates.get(file) ??
      (await readCachedSource(file, sourceCache));
    finalUpdates.set(file, renderManagedRules(current, rules));
  }

  const writes = [];
  for (const [file, content] of finalUpdates) {
    const initial = sourceCache.initial.get(file);
    writes.push({
      file,
      content,
      expectedHash: initial === undefined ? undefined : hashContent(initial),
    });
  }
  for (const [file, bytes] of assetUpdates) {
    writes.push({ file, content: bytes });
  }

  let transaction;
  try {
    transaction = await commitPatchTransaction({ projectDir: root, writes });
  } catch (error) {
    const reason = [
      "source_conflict",
      "patch_verify_failed",
      "path_outside_project",
      "duplicate_patch_target",
    ].includes(error.code)
      ? error.code
      : "patch_commit_failed";
    return {
      appliedCount: 0,
      pendingCount: changes.length,
      changedFiles: [],
      durationMs: Date.now() - startedAt,
      pending: changes.map((change) => pendingChange(change, reason)),
      transactionId: error.transactionId || "",
      undoAvailable: false,
      error: {
        code: reason,
        message: error.message || "Patch transaction failed",
      },
    };
  }

  return {
    appliedCount,
    pendingCount: pending.length,
    changedFiles: transaction.changedFiles,
    durationMs: Date.now() - startedAt,
    pending,
    transactionId: transaction.transactionId,
    undoAvailable: transaction.undoAvailable,
  };
}

async function findExternalSvgFile(root, value) {
  const referenced = resolveSourceRef(root, stripQuery(value || ""));
  if (
    !referenced ||
    path.extname(referenced).toLowerCase() !== ".svg"
  ) {
    return "";
  }
  try {
    const info = await stat(referenced);
    return info.isFile() && info.size <= MAX_SOURCE_BYTES ? referenced : "";
  } catch {
    return "";
  }
}

function pendingResult(changes, reason, startedAt) {
  return {
    appliedCount: 0,
    pendingCount: changes.length,
    changedFiles: [],
    durationMs: Date.now() - startedAt,
    pending: changes.map((change) => pendingChange(change, reason)),
  };
}

function validateProtocol14StructureChange(change) {
  const requiredStrings = [
    "nodeId",
    "fromParentId",
    "toParentId",
    "parentLayout",
    "positioning",
  ];
  for (const field of requiredStrings) {
    if (typeof change?.[field] !== "string" || !change[field]) {
      return `missing_${field}`;
    }
  }
  for (const field of ["sourceRef", "fromParentSourceRef", "toParentSourceRef"]) {
    if (!fastStableSelector(change?.[field]?.selector)) {
      return `invalid_${field}`;
    }
  }
  for (const field of ["fromIndex", "toIndex"]) {
    if (!Number.isInteger(change?.[field]) || change[field] < 0) {
      return `invalid_${field}`;
    }
  }
  for (const field of ["beforeBounds", "afterBounds"]) {
    const bounds = change?.[field];
    if (
      !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width < 0 ||
      bounds.height < 0
    ) {
      return `invalid_${field}`;
    }
  }
  for (const field of ["beforeWorldTransform", "afterWorldTransform"]) {
    const transform = change?.[field];
    if (
      !Array.isArray(transform) ||
      transform.length !== 6 ||
      !transform.every(Number.isFinite)
    ) {
      return `invalid_${field}`;
    }
  }
  if (!["NONE", "HORIZONTAL", "VERTICAL", "GRID"].includes(change.parentLayout)) {
    return "invalid_parentLayout";
  }
  if (!["AUTO", "ABSOLUTE"].includes(change.positioning)) {
    return "invalid_positioning";
  }
  if (
    change.parentLayout === "GRID" &&
    (!Number.isInteger(change?.grid?.row) ||
      change.grid.row < 1 ||
      !Number.isInteger(change?.grid?.column) ||
      change.grid.column < 1)
  ) {
    return "invalid_grid";
  }
  return "";
}

function pendingChange(change, reason, stage = null) {
  return {
    nodeId: change?.nodeId || null,
    property: change?.property || null,
    stage: stage || pendingStage(change?.property),
    reason,
  };
}

function pendingStage(property) {
  if (["nodeMove", "nodeReparent", "nodeReorder", "nodeInsert", "nodeClone", "nodeDelete", "pageSeed"].includes(property)) {
    return "structure";
  }
  if (["x", "y", "width", "height"].includes(property)) {
    return "geometry";
  }
  return "style";
}

function fastSelector(change) {
  const selector = change?.sourceRef?.selector;
  return fastStableSelector(selector) ? selector : "";
}

function fastStableSelector(selector) {
  return (
    typeof selector === "string" &&
    (/^\[data-codex-id=(?:"[^"]+"|'[^']+')\]$/.test(selector) ||
      /^#[A-Za-z_][\w-]*$/.test(selector))
  );
}

function structuralPositionDeclarations(change) {
  const bounds = change?.afterBounds || change?.to?.bounds;
  const parentLayout = String(
    change?.parentLayout || change?.to?.parentLayout || "NONE",
  ).toUpperCase();
  const positioning = String(
    change?.positioning || change?.to?.positioning ||
      (parentLayout === "NONE" ? "ABSOLUTE" : "AUTO"),
  ).toUpperCase();
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y)
  ) {
    return { ok: false, reason: "missing_move_geometry" };
  }
  const clearTranslate = [
    { property: "--cdb-translate-x", value: null },
    { property: "--cdb-translate-y", value: null },
    { property: "translate", value: "none" },
  ];
  if (parentLayout === "NONE" || positioning === "ABSOLUTE") {
    return {
      ok: true,
      declarations: [
        { property: "position", value: "absolute" },
        { property: "left", value: `${formatNumber(bounds.x)}px` },
        { property: "top", value: `${formatNumber(bounds.y)}px` },
        ...clearTranslate,
      ],
    };
  }
  if (["HORIZONTAL", "VERTICAL"].includes(parentLayout)) {
    const index = change.toIndex ?? change?.to?.index;
    if (!Number.isInteger(index) || index < 0) {
      return { ok: false, reason: "invalid_target_index" };
    }
    return {
      ok: true,
      declarations: [
        { property: "position", value: null },
        { property: "left", value: null },
        { property: "top", value: null },
        { property: "order", value: String(index) },
        ...clearTranslate,
      ],
    };
  }
  if (parentLayout === "GRID") {
    const grid = change?.grid || change?.to?.grid;
    if (!grid || !Number.isInteger(grid.row) || !Number.isInteger(grid.column)) {
      return { ok: false, reason: "missing_grid_placement" };
    }
    return {
      ok: true,
      declarations: [
        { property: "grid-row", value: String(grid.row) },
        { property: "grid-column", value: String(grid.column) },
        ...clearTranslate,
      ],
    };
  }
  return { ok: false, reason: "unsupported_parent_layout" };
}

function cssDeclarations(change) {
  switch (change?.property) {
    case "fill": {
      const value = cssColor(change.to);
      return value === null
        ? null
        : [{
            property:
              change.nodeType === "TEXT"
                ? "color"
                : VECTOR_NODE_TYPES.has(change.nodeType)
                  ? "fill"
                  : "background",
            value,
          }];
    }
    case "stroke": {
      if (!BORDER_NODE_TYPES.has(change.nodeType)) return null;
      if (change.to === null) {
        return [{ property: "border", value: "0" }];
      }
      const value = cssColor(change.to);
      if (value === null) return null;
      const width =
        Number.isFinite(change.strokeWeight) && change.strokeWeight >= 0
          ? change.strokeWeight
          : 1;
      return [{
        property: "border",
        value: `${formatNumber(width)}px solid ${value}`,
      }];
    }
    case "strokeWeight":
      return BORDER_NODE_TYPES.has(change.nodeType)
        ? singleDeclaration(numericDeclaration("border-width", change.to))
        : null;
    case "fontSize":
      return singleDeclaration(numericDeclaration("font-size", change.to));
    case "width":
      return singleDeclaration(numericDeclaration("width", change.to));
    case "height":
      return singleDeclaration(numericDeclaration("height", change.to));
    case "x":
      return visualPositionDeclarations("x", change);
    case "y":
      return visualPositionDeclarations("y", change);
    case "opacity":
      return Number.isFinite(change.to) && change.to >= 0 && change.to <= 1
        ? [{ property: "opacity", value: formatNumber(change.to) }]
        : null;
    case "visible":
      return typeof change.to === "boolean"
        ? [{ property: "display", value: change.to ? null : "none" }]
        : null;
    case "padding": {
      const value = cssBox(change.to);
      return value === null ? null : [{ property: "padding", value }];
    }
    case "itemSpacing":
      return singleDeclaration(numericDeclaration("gap", change.to));
    case "counterAxisSpacing": {
      const property =
        change?.layoutContext?.layoutMode === "HORIZONTAL"
          ? "row-gap"
          : "column-gap";
      return singleDeclaration(numericDeclaration(property, change.to));
    }
    case "layoutMode":
      return cssLayoutModeDeclarations(change.to);
    case "layoutWrap":
      return cssEnumDeclaration("flex-wrap", change.to, {
        NO_WRAP: "nowrap",
        WRAP: "wrap",
      });
    case "primaryAxisAlignItems":
      return cssEnumDeclaration("justify-content", change.to, {
        MIN: "flex-start",
        CENTER: "center",
        MAX: "flex-end",
        SPACE_BETWEEN: "space-between",
      });
    case "counterAxisAlignItems":
      return cssEnumDeclaration("align-items", change.to, {
        MIN: "flex-start",
        CENTER: "center",
        MAX: "flex-end",
        BASELINE: "baseline",
      });
    case "layoutAlign":
      return cssEnumDeclaration("align-self", change.to, {
        INHERIT: "auto",
        STRETCH: "stretch",
      });
    case "layoutGrow":
      return Number.isFinite(change.to) && change.to >= 0
        ? [{ property: "flex-grow", value: formatNumber(change.to) }]
        : null;
    case "layoutPositioning":
      return cssEnumDeclaration("position", change.to, {
        AUTO: "relative",
        ABSOLUTE: "absolute",
      });
    case "layoutSizingHorizontal":
      return cssLayoutSizingDeclaration("width", change);
    case "layoutSizingVertical":
      return cssLayoutSizingDeclaration("height", change);
    case "primaryAxisSizingMode":
      return cssAxisSizingDeclaration(change, true);
    case "counterAxisSizingMode":
      return cssAxisSizingDeclaration(change, false);
    case "cornerRadius": {
      const value = cssRadius(change.to);
      return value === null ? null : [{ property: "border-radius", value }];
    }
    case "fontName":
      return cssFontDeclarations(change.to);
    case "lineHeight":
      return singleDeclaration(cssUnitDeclaration("line-height", change.to));
    case "letterSpacing":
      return singleDeclaration(cssUnitDeclaration("letter-spacing", change.to));
    case "textAlignHorizontal":
      return cssEnumDeclaration("text-align", change.to, {
        LEFT: "left",
        CENTER: "center",
        RIGHT: "right",
        JUSTIFIED: "justify",
      });
    case "textAlignVertical":
      return cssEnumDeclaration("align-content", change.to, {
        TOP: "start",
        CENTER: "center",
        BOTTOM: "end",
      });
    case "textCase":
      return cssTextCaseDeclarations(change.to);
    case "textDecoration":
      return cssEnumDeclaration("text-decoration", change.to, {
        NONE: "none",
        UNDERLINE: "underline",
        STRIKETHROUGH: "line-through",
      });
    default:
      return null;
  }
}

function cssLayoutModeDeclarations(value) {
  if (value === "HORIZONTAL") {
    return [
      { property: "display", value: "flex" },
      { property: "flex-direction", value: "row" },
    ];
  }
  if (value === "VERTICAL") {
    return [
      { property: "display", value: "flex" },
      { property: "flex-direction", value: "column" },
    ];
  }
  return value === "NONE"
    ? [
        { property: "display", value: "block" },
        { property: "flex-direction", value: null },
        { property: "flex-wrap", value: null },
      ]
    : null;
}

function cssLayoutSizingDeclaration(property, change) {
  if (change.to === "FILL") {
    return [{ property, value: "100%" }];
  }
  if (change.to === "HUG") {
    return [{ property, value: "fit-content" }];
  }
  if (change.to !== "FIXED") return null;
  const value = change?.layoutContext?.[property];
  return singleDeclaration(numericDeclaration(property, value));
}

function cssAxisSizingDeclaration(change, primary) {
  const horizontal = change?.layoutContext?.layoutMode === "HORIZONTAL";
  const property = primary === horizontal ? "width" : "height";
  if (change.to === "AUTO") {
    return [{ property, value: "fit-content" }];
  }
  if (change.to !== "FIXED") return null;
  const value = change?.layoutContext?.[property];
  return singleDeclaration(numericDeclaration(property, value));
}

function visualPositionDeclarations(axis, change) {
  if (!Number.isFinite(change.from) || !Number.isFinite(change.to)) {
    return null;
  }
  return [
    {
      property: `--cdb-translate-${axis}`,
      value: `${formatNumber(change.to - change.from)}px`,
    },
    {
      property: "translate",
      value: "var(--cdb-translate-x, 0px) var(--cdb-translate-y, 0px)",
    },
  ];
}

function singleDeclaration(declaration) {
  return declaration ? [declaration] : null;
}

function cssFontDeclarations(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.family !== "string" ||
    typeof value.style !== "string" ||
    !value.family.trim() ||
    value.family.length > 120 ||
    value.style.length > 120
  ) {
    return null;
  }
  const style = value.style.trim();
  const weight =
    /\bthin\b/i.test(style)
      ? 100
      : /\bextra\s*light\b|\bultra\s*light\b/i.test(style)
        ? 200
        : /\blight\b/i.test(style)
          ? 300
          : /\bmedium\b/i.test(style)
            ? 500
            : /\bsemi\s*bold\b|\bdemi\s*bold\b/i.test(style)
              ? 600
              : /\bextra\s*bold\b|\bultra\s*bold\b/i.test(style)
                ? 800
                : /\bblack\b|\bheavy\b/i.test(style)
                  ? 900
                  : /\bbold\b/i.test(style)
                    ? 700
                    : 400;
  return [
    {
      property: "font-family",
      value: `"${value.family.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    },
    { property: "font-weight", value: String(weight) },
    {
      property: "font-style",
      value: /\bitalic\b|\boblique\b/i.test(style) ? "italic" : "normal",
    },
  ];
}

function cssUnitDeclaration(property, value) {
  if (!value || typeof value !== "object" || typeof value.unit !== "string") {
    return null;
  }
  if (value.unit === "AUTO" && property === "line-height") {
    return { property, value: "normal" };
  }
  if (!Number.isFinite(value.value)) {
    return null;
  }
  if (value.unit === "PIXELS") {
    return { property, value: `${formatNumber(value.value)}px` };
  }
  if (value.unit === "PERCENT") {
    return { property, value: `${formatNumber(value.value)}%` };
  }
  return null;
}

function cssEnumDeclaration(property, value, mapping) {
  return typeof value === "string" && mapping[value]
    ? [{ property, value: mapping[value] }]
    : null;
}

function cssTextCaseDeclarations(value) {
  if (value === "ORIGINAL") {
    return [
      { property: "text-transform", value: "none" },
      { property: "font-variant-caps", value: "normal" },
    ];
  }
  if (value === "UPPER") {
    return [{ property: "text-transform", value: "uppercase" }];
  }
  if (value === "LOWER") {
    return [{ property: "text-transform", value: "lowercase" }];
  }
  if (value === "TITLE") {
    return [{ property: "text-transform", value: "capitalize" }];
  }
  if (value === "SMALL_CAPS" || value === "SMALL_CAPS_FORCED") {
    return [
      { property: "text-transform", value: "none" },
      {
        property: "font-variant-caps",
        value: value === "SMALL_CAPS" ? "small-caps" : "all-small-caps",
      },
    ];
  }
  return null;
}

function numericDeclaration(property, value) {
  return Number.isFinite(value) && value >= 0
    ? { property, value: `${formatNumber(value)}px` }
    : null;
}

function cssColor(value) {
  if (value === null) return "transparent";
  if (
    !value ||
    typeof value !== "object" ||
    !/^#[0-9A-F]{6}$/i.test(value.color || "")
  ) {
    return null;
  }
  const opacity =
    Number.isFinite(value.opacity) && value.opacity >= 0 && value.opacity <= 1
      ? value.opacity
      : 1;
  if (opacity === 1) return value.color.toUpperCase();
  const [red, green, blue] = [1, 3, 5].map((index) =>
    Number.parseInt(value.color.slice(index, index + 2), 16),
  );
  return `rgba(${red}, ${green}, ${blue}, ${formatNumber(opacity)})`;
}

function cssBox(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !["top", "right", "bottom", "left"].every(
      (key) => Number.isFinite(value[key]) && value[key] >= 0,
    )
  ) {
    return null;
  }
  return ["top", "right", "bottom", "left"]
    .map((key) => `${formatNumber(value[key])}px`)
    .join(" ");
}

function cssRadius(value) {
  if (Number.isFinite(value) && value >= 0) {
    return `${formatNumber(value)}px`;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !["topLeft", "topRight", "bottomRight", "bottomLeft"].every(
      (key) => Number.isFinite(value[key]) && value[key] >= 0,
    )
  ) {
    return null;
  }
  return ["topLeft", "topRight", "bottomRight", "bottomLeft"]
    .map((key) => `${formatNumber(value[key])}px`)
    .join(" ");
}

async function findSourceFile({
  root,
  files,
  sourceCache,
  change,
}) {
  const referenced = resolveSourceRef(root, change?.sourceRef?.file);
  if (
    referenced &&
    SOURCE_EXTENSIONS.has(path.extname(referenced).toLowerCase()) &&
    (await isFile(referenced))
  ) {
    return referenced;
  }
  const matcher = sourceSelectorMatcher(change?.sourceRef?.selector);
  if (!matcher) return "";
  for (const file of files) {
    const content = await readCachedSource(file, sourceCache);
    if (matcher.test(content)) return file;
  }
  return "";
}

async function findCssFile({
  root,
  sourceFile,
  cssFiles,
  sourceCache,
}) {
  if (sourceFile) {
    const source = await readCachedSource(sourceFile, sourceCache);
    for (const reference of cssReferences(source)) {
      const resolved = resolveInside(
        root,
        path.resolve(path.dirname(sourceFile), stripQuery(reference)),
      );
      if (resolved && (await isFile(resolved))) return resolved;
    }
  }
  if (cssFiles.length === 1) return cssFiles[0];
  return (
    cssFiles.find((file) =>
      /(?:^|[\\/])(?:app|global|globals|index|style|styles)\.css$/i.test(file),
    ) ||
    ""
  );
}

function cssReferences(source) {
  const references = [];
  const patterns = [
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css(?:[?#][^"']*)?)["'][^>]*>/gi,
    /(?:import\s+(?:[^"']+\s+from\s+)?|require\(\s*)["']([^"']+\.css(?:[?#][^"']*)?)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

function replaceText(source, selector, nextValue) {
  if (typeof nextValue !== "string") {
    return { ok: false, reason: "invalid_text_value" };
  }
  const attribute = selectorAttribute(selector);
  if (!attribute) return { ok: false, reason: "missing_stable_selector" };
  const opening = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\s${attribute.name}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\2[^>]*>`,
    "g",
  );
  const match = opening.exec(source);
  if (!match) return { ok: false, reason: "source_element_not_found" };
  const contentStart = match.index + match[0].length;
  const closing = new RegExp(`</${escapeRegExp(match[1])}\\s*>`, "g");
  closing.lastIndex = contentStart;
  const closeMatch = closing.exec(source);
  if (!closeMatch) return { ok: false, reason: "source_element_not_found" };
  const current = source.slice(contentStart, closeMatch.index);
  if (/<[A-Za-z!/]|[{}]/.test(current)) {
    return { ok: false, reason: "structured_text_requires_codex" };
  }
  const leading = current.match(/^\s*/)?.[0] || "";
  const trailing = current.match(/\s*$/)?.[0] || "";
  const replacement = `${leading}${escapeMarkupText(nextValue)}${trailing}`;
  return {
    ok: true,
    content:
      source.slice(0, contentStart) +
      replacement +
      source.slice(closeMatch.index),
  };
}

function removeMappedElement(source, selector, nodeType) {
  const attribute = selectorAttribute(selector);
  if (!attribute) {
    return { ok: false, reason: "missing_stable_selector" };
  }
  const openingPattern = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\s${escapeRegExp(attribute.name)}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\2[^>]*>`,
    "gi",
  );
  const opening = openingPattern.exec(source);
  if (!opening) {
    return { ok: false, reason: "source_element_not_found" };
  }
  const tagName = opening[1].toLowerCase();
  if (
    (nodeType === "SVG" && !["img", "svg"].includes(tagName)) ||
    (nodeType === "IMAGE" && tagName !== "img") ||
    (["FRAME", "TEXT"].includes(nodeType) &&
      ["body", "head", "html", "img", "script", "style", "svg"].includes(
        tagName,
      ))
  ) {
    return { ok: false, reason: "unsafe_delete_target" };
  }
  let end = opening.index + opening[0].length;
  if (
    !VOID_MARKUP_TAGS.has(tagName) &&
    !/\/>\s*$/.test(opening[0])
  ) {
    const closing = findElementClosingTag(source, tagName, end);
    if (!closing) {
      return { ok: false, reason: "source_element_not_found" };
    }
    end = closing.end;
  }
  const range = safeElementRemovalRange(source, opening.index, end);
  if (!range) {
    return { ok: false, reason: "unsafe_delete_context" };
  }
  return {
    ok: true,
    changed: true,
    content: source.slice(0, range.start) + source.slice(range.end),
  };
}

function cloneMappedElement(source, selector, payload) {
  const attribute = selectorAttribute(selector);
  const idMap = Array.isArray(payload?.idMap) ? payload.idMap : [];
  const nextNodeId =
    typeof payload?.nodeId === "string" ? payload.nodeId.trim() : "";
  if (
    !attribute ||
    idMap.length === 0 ||
    idMap.length > 200 ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(nextNodeId)
  ) {
    return { ok: false, reason: "invalid_clone_mapping" };
  }
  const mapping = new Map();
  const nextIds = new Set();
  for (const entry of idMap) {
    const from = typeof entry?.from === "string" ? entry.from.trim() : "";
    const to = typeof entry?.to === "string" ? entry.to.trim() : "";
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(from) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(to) ||
      mapping.has(from) ||
      nextIds.has(to)
    ) {
      return { ok: false, reason: "invalid_clone_mapping" };
    }
    mapping.set(from, to);
    nextIds.add(to);
  }
  if (mapping.get(attribute.value) !== nextNodeId) {
    return { ok: false, reason: "invalid_clone_mapping" };
  }
  const nextSelector = `[data-codex-id="${nextNodeId}"]`;
  if (sourceSelectorMatcher(nextSelector)?.test(source)) {
    return { ok: true, changed: false, content: source };
  }
  const openingPattern = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\s${escapeRegExp(attribute.name)}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\2[^>]*>`,
    "gi",
  );
  const opening = openingPattern.exec(source);
  if (!opening) {
    return { ok: false, reason: "source_element_not_found" };
  }
  const tagName = opening[1].toLowerCase();
  let end = opening.index + opening[0].length;
  if (
    !VOID_MARKUP_TAGS.has(tagName) &&
    !/\/>\s*$/.test(opening[0])
  ) {
    const closing = findElementClosingTag(source, tagName, end);
    if (!closing) {
      return { ok: false, reason: "source_element_not_found" };
    }
    end = closing.end;
  }
  const insertion = safeCloneInsertion(source, opening.index, end);
  if (!insertion) {
    return { ok: false, reason: "unsafe_clone_context" };
  }
  const cloned = source
    .slice(opening.index, end)
    .replace(
      /\bdata-codex-id\s*=\s*(["'])([^"']+)\1/g,
      (match, quote, value) =>
        mapping.has(value)
          ? `data-codex-id=${quote}${mapping.get(value)}${quote}`
          : match,
    );
  return {
    ok: true,
    changed: true,
    content:
      source.slice(0, end) +
      insertion.prefix +
      cloned +
      source.slice(end),
  };
}

function renderInsertedPageNode(definition, extension) {
  const state = {
    ids: new Set(),
    count: 0,
    rules: [],
    assets: [],
    extension,
  };
  try {
    const markup = renderInsertedPageNodeDefinition(definition, state);
    return {
      ok: true,
      nodeId: definition.id,
      markup,
      rules: state.rules,
      assets: state.assets,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof InsertedNodeError
          ? error.reason
          : "invalid_inserted_node",
    };
  }
}

class InsertedNodeError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function renderInsertedPageNodeDefinition(definition, state) {
  state.count += 1;
  if (
    state.count > 200 ||
    !definition ||
    typeof definition !== "object" ||
    !["frame", "image", "svg", "text"].includes(definition.type)
  ) {
    throw new InsertedNodeError("invalid_inserted_node");
  }
  const nodeId = typeof definition.id === "string" ? definition.id.trim() : "";
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(nodeId) ||
    state.ids.has(nodeId)
  ) {
    throw new InsertedNodeError("invalid_inserted_node_id");
  }
  state.ids.add(nodeId);
  const tag = validateInsertedTag(definition.type, definition.tag);
  if (!tag) {
    throw new InsertedNodeError("invalid_inserted_node_tag");
  }
  const declarations = insertedNodeDeclarations(definition);
  if (!declarations) {
    throw new InsertedNodeError("invalid_inserted_node_style");
  }
  state.rules.push({
    selector: `[data-codex-id="${nodeId}"]`,
    declarations,
  });
  const attribute = `data-codex-id="${escapeMarkupAttribute(nodeId)}"`;
  if (definition.type === "text") {
    if (typeof definition.text !== "string" || definition.text.length > 20_000) {
      throw new InsertedNodeError("invalid_inserted_text");
    }
    return `<${tag} ${attribute}>${escapeMarkupText(definition.text)}</${tag}>`;
  }
  if (definition.type === "image") {
    const image = decodeInsertedImage(definition.image);
    if (!image) {
      throw new InsertedNodeError("invalid_inserted_image");
    }
    const fileName = `${nodeId}.png`;
    state.assets.push({ fileName, bytes: image });
    const alt = escapeMarkupAttribute(definition.name || "");
    const closing = [".jsx", ".tsx", ".js", ".ts"].includes(state.extension)
      ? " />"
      : ">";
    return `<img ${attribute} src="/codex-design-assets/${fileName}" alt="${alt}"${closing}`;
  }
  if (definition.type === "svg") {
    const decoded = decodeSvgPayload(definition.svg);
    if (!decoded.ok) {
      throw new InsertedNodeError(decoded.reason);
    }
    const exported = extractSvgParts(decoded.svg);
    if (!exported) {
      throw new InsertedNodeError("invalid_svg_markup");
    }
    let opening = exported.opening;
    for (const name of ["data-codex-id", "aria-label", "style"]) {
      opening = removeMarkupAttribute(opening, name);
    }
    opening = opening.replace(
      /\s*\/?>$/,
      ` ${attribute} aria-label="${escapeMarkupAttribute(definition.name || "Figma vector")}">`,
    );
    return `${opening}${exported.inner}</svg>`;
  }
  const children = Array.isArray(definition.children) ? definition.children : [];
  if (children.length > 200) {
    throw new InsertedNodeError("invalid_inserted_node");
  }
  const typeAttribute = tag === "button" ? ' type="button"' : "";
  if (children.length === 0) {
    return `<${tag} ${attribute}${typeAttribute}></${tag}>`;
  }
  const renderedChildren = children.map((child) =>
    renderInsertedPageNodeDefinition(child, state),
  );
  const childIndent = "  ";
  return [
    `<${tag} ${attribute}${typeAttribute}>`,
    ...renderedChildren.map((child) => indentMarkup(child, childIndent, "\n")),
    `</${tag}>`,
  ].join("\n");
}

function validateInsertedTag(type, value) {
  const tag = typeof value === "string" ? value.toLowerCase() : "";
  const allowed =
    type === "text"
      ? new Set(["span", "p", "strong", "em", "label"])
      : type === "frame"
        ? new Set([
            "article",
            "aside",
            "button",
            "div",
            "footer",
            "form",
            "header",
            "main",
            "nav",
            "section",
          ])
        : type === "image"
          ? new Set(["img"])
          : new Set(["svg"]);
  return allowed.has(tag) ? tag : "";
}

function insertedNodeDeclarations(definition) {
  const width = numericDeclaration("width", definition.width);
  const height = numericDeclaration("height", definition.height);
  if (!width || !height) return null;
  const declarations = [
    width,
    height,
    { property: "box-sizing", value: "border-box" },
  ];
  const layoutItem = definition.layoutItem || null;
  if (layoutItem) {
    if (Number.isInteger(layoutItem.order)) {
      declarations.push({ property: "order", value: String(layoutItem.order) });
    }
    if (Number.isFinite(layoutItem.grow) && layoutItem.grow >= 0) {
      declarations.push({
        property: "flex-grow",
        value: formatNumber(layoutItem.grow),
      });
    }
    if (Number.isFinite(layoutItem.shrink) && layoutItem.shrink >= 0) {
      declarations.push({
        property: "flex-shrink",
        value: formatNumber(layoutItem.shrink),
      });
    }
    if (safeCssLayoutValue(layoutItem.basis)) {
      declarations.push({ property: "flex-basis", value: layoutItem.basis });
    }
    if (safeCssLayoutValue(layoutItem.gridRow)) {
      declarations.push({ property: "grid-row", value: layoutItem.gridRow });
    }
    if (safeCssLayoutValue(layoutItem.gridColumn)) {
      declarations.push({ property: "grid-column", value: layoutItem.gridColumn });
    }
    if (layoutItem.align === "stretch") {
      declarations.push({ property: "align-self", value: "stretch" });
    }
    if (layoutItem.positioning === "absolute") {
      declarations.push({ property: "position", value: "absolute" });
    }
    if (layoutItem.horizontalSizing === "fill") {
      declarations.push({ property: "width", value: "100%" });
    } else if (layoutItem.horizontalSizing === "hug") {
      declarations.push({ property: "width", value: "fit-content" });
    }
    if (layoutItem.verticalSizing === "fill") {
      declarations.push({ property: "height", value: "100%" });
    } else if (layoutItem.verticalSizing === "hug") {
      declarations.push({ property: "height", value: "fit-content" });
    }
  }
  if (
    !Number.isFinite(definition.opacity) ||
    definition.opacity < 0 ||
    definition.opacity > 1 ||
    typeof definition.visible !== "boolean" ||
    !Number.isFinite(definition.rotation)
  ) {
    return null;
  }
  if (definition.opacity !== 1) {
    declarations.push({
      property: "opacity",
      value: formatNumber(definition.opacity),
    });
  }
  if (!definition.visible) {
    declarations.push({ property: "display", value: "none" });
  }
  if (definition.rotation !== 0) {
    declarations.push({
      property: "transform",
      value: `rotate(${formatNumber(definition.rotation)}deg)`,
    });
  }
  const fill = definition?.style?.fill
    ? cssColor(definition.style.fill)
    : null;
  if (fill !== null) {
    declarations.push({
      property: definition.type === "text" ? "color" : "background-color",
      value: fill,
    });
  }
  const stroke = definition?.style?.stroke
    ? cssColor(definition.style.stroke)
    : null;
  if (stroke !== null && definition.type === "frame") {
    const strokeWeight = Number.isFinite(definition?.style?.strokeWeight)
      ? definition.style.strokeWeight
      : 1;
    declarations.push({
      property: "border",
      value: `${formatNumber(Math.max(0, strokeWeight))}px solid ${stroke}`,
    });
  }
  const radius = cssRadius(definition?.style?.cornerRadius);
  if (radius !== null && definition.type === "frame") {
    declarations.push({ property: "border-radius", value: radius });
  }
  if (definition.type === "frame") {
    const layout = definition.layout || {};
    if (layout.kind === "grid") {
      declarations.push(
        { property: "display", value: "grid" },
        { property: "grid-template-columns", value: safeCssLayoutValue(layout.grid?.columns) ? layout.grid.columns : "none" },
        { property: "grid-template-rows", value: safeCssLayoutValue(layout.grid?.rows) ? layout.grid.rows : "none" },
      );
    } else if (layout.mode === "HORIZONTAL" || layout.mode === "VERTICAL") {
      declarations.push(
        { property: "display", value: "flex" },
        {
          property: "flex-direction",
          value: layout.mode === "HORIZONTAL" ? "row" : "column",
        },
      );
      declarations.push({
        property: "flex-wrap",
        value: layout.wrap ? "wrap" : "nowrap",
      });
    } else if (layout.mode !== "NONE") {
      return null;
    }
    if (Number.isFinite(layout.itemSpacing) && layout.itemSpacing >= 0) {
      declarations.push({
        property: "gap",
        value: `${formatNumber(layout.itemSpacing)}px`,
      });
    }
    if (
      Number.isFinite(layout.counterAxisSpacing) &&
      layout.counterAxisSpacing >= 0 &&
      layout.mode !== "NONE"
    ) {
      declarations.push({
        property: layout.mode === "HORIZONTAL" ? "row-gap" : "column-gap",
        value: `${formatNumber(layout.counterAxisSpacing)}px`,
      });
    }
    const padding = cssBox(layout.padding);
    if (padding !== null) {
      declarations.push({ property: "padding", value: padding });
    }
    const justify = {
      MIN: "flex-start",
      CENTER: "center",
      MAX: "flex-end",
      SPACE_BETWEEN: "space-between",
    }[layout.primaryAxisAlignItems];
    const align = {
      MIN: "flex-start",
      CENTER: "center",
      MAX: "flex-end",
      BASELINE: "baseline",
    }[layout.counterAxisAlignItems];
    if (justify) declarations.push({ property: "justify-content", value: justify });
    if (align) declarations.push({ property: "align-items", value: align });
    const primaryProperty = layout.mode === "HORIZONTAL" ? "width" : "height";
    const counterProperty = layout.mode === "HORIZONTAL" ? "height" : "width";
    if (layout.primaryAxisSizingMode === "AUTO") {
      declarations.push({ property: primaryProperty, value: "fit-content" });
    }
    if (layout.counterAxisSizingMode === "AUTO") {
      declarations.push({ property: counterProperty, value: "fit-content" });
    }
  }
  if (definition.type === "text") {
    const font = cssFontDeclarations(definition.fontName);
    const fontSize = numericDeclaration("font-size", definition.fontSize);
    const lineHeight = cssUnitDeclaration("line-height", definition.lineHeight);
    const letterSpacing = cssUnitDeclaration(
      "letter-spacing",
      definition.letterSpacing,
    );
    if (!font || !fontSize || !lineHeight || !letterSpacing) return null;
    declarations.push(...font, fontSize, lineHeight, letterSpacing);
    for (const group of [
      cssEnumDeclaration("text-align", definition.textAlignHorizontal, {
        LEFT: "left",
        CENTER: "center",
        RIGHT: "right",
        JUSTIFIED: "justify",
      }),
      cssEnumDeclaration("align-content", definition.textAlignVertical, {
        TOP: "start",
        CENTER: "center",
        BOTTOM: "end",
      }),
      cssTextCaseDeclarations(definition.textCase),
      cssEnumDeclaration("text-decoration", definition.textDecoration, {
        NONE: "none",
        UNDERLINE: "underline",
        STRIKETHROUGH: "line-through",
      }),
    ]) {
      if (!group) return null;
      declarations.push(...group);
    }
  }
  return declarations;
}

function safeCssLayoutValue(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    /^[A-Za-z0-9().,%+\-*/\s]+$/.test(value)
  );
}

function decodeInsertedImage(payload) {
  if (
    !payload ||
    payload.mimeType !== "image/png" ||
    typeof payload.base64 !== "string"
  ) {
    return null;
  }
  const base64 = payload.base64.replace(/\s+/g, "");
  if (
    base64.length === 0 ||
    base64.length > 3 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  ) {
    return null;
  }
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 0 &&
    bytes.length <= 2 * 1024 * 1024 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    ? bytes
    : null;
}

function insertMappedMarkup(source, parentSelector, markup, nodeId) {
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(nodeId) ||
    typeof markup !== "string" ||
    !markup
  ) {
    return { ok: false, reason: "invalid_inserted_node" };
  }
  if (sourceSelectorMatcher(`[data-codex-id="${nodeId}"]`)?.test(source)) {
    return { ok: true, changed: false, content: source };
  }
  const parent = findMappedElementRange(source, parentSelector);
  if (!parent || parent.void) {
    return { ok: false, reason: "source_element_not_found" };
  }
  return insertMarkupBeforeClosing(source, parent, [markup]);
}

function replaceMappedMarkup(source, selector, markup, nodeId) {
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(nodeId) ||
    typeof markup !== "string" ||
    !markup ||
    selectorAttribute(selector)?.value !== nodeId
  ) {
    return { ok: false, reason: "invalid_inserted_node" };
  }
  const current = findMappedElementRange(source, selector);
  if (!current || current.void) {
    return { ok: false, reason: "source_element_not_found" };
  }
  let nextMarkup = markup.trim();
  const currentOpening = source.slice(current.start, current.openEnd);
  if (
    /\bdata-codex-root(?:\s|=|>)/i.test(currentOpening) &&
    !/\bdata-codex-root(?:\s|=|>)/i.test(nextMarkup)
  ) {
    nextMarkup = nextMarkup.replace(/^<([A-Za-z][\w:-]*)\b/, '<$1 data-codex-root');
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = sourceLineIndent(source, current.start);
  const replacement = indentMarkup(nextMarkup, indent, newline).replace(
    new RegExp(`^${escapeRegExp(indent)}`),
    "",
  );
  return {
    ok: true,
    changed: source.slice(current.start, current.end) !== replacement,
    content: source.slice(0, current.start) + replacement + source.slice(current.end),
  };
}

function reparentMappedElement(
  source,
  selector,
  targetParentSelector,
  targetIndex,
) {
  if (
    !fastStableSelector(selector) ||
    !fastStableSelector(targetParentSelector) ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex > 200 ||
    selector === targetParentSelector
  ) {
    return { ok: false, reason: "invalid_reparent_mapping" };
  }
  const element = findMappedElementRange(source, selector);
  const targetParent = findMappedElementRange(source, targetParentSelector);
  if (!element || !targetParent || element.void || targetParent.void) {
    return { ok: false, reason: "source_element_not_found" };
  }
  if (
    targetParent.start > element.start &&
    targetParent.end < element.end
  ) {
    return { ok: false, reason: "invalid_reparent_cycle" };
  }
  const removal = safeElementRemovalRange(source, element.start, element.end);
  const markup = source.slice(element.start, element.end).trim();
  if (!removal || !markup) {
    return { ok: false, reason: "unsafe_reparent_context" };
  }
  const stripped =
    source.slice(0, removal.start) + source.slice(removal.end);
  const nextParent = findMappedElementRange(stripped, targetParentSelector);
  if (!nextParent || nextParent.void) {
    return { ok: false, reason: "unsafe_reparent_context" };
  }
  const children = directMappedChildRanges(stripped, nextParent);
  if (!parentContainsOnlyMappedRanges(stripped, nextParent, children)) {
    return { ok: false, reason: "unsafe_reparent_context" };
  }
  if (targetIndex > children.length) {
    return { ok: false, reason: "invalid_target_index" };
  }
  if (targetIndex === children.length) {
    return insertMarkupBeforeClosing(stripped, nextParent, [markup]);
  }
  return insertMarkupBeforeElement(stripped, children[targetIndex], markup);
}

function directMappedChildRanges(source, parent) {
  const selectors = [];
  const seen = new Set();
  const pattern = /\s(data-codex-id|id)\s*=\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,127})\2/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const selector =
      match[1].toLowerCase() === "data-codex-id"
        ? `[data-codex-id="${match[3]}"]`
        : `#${match[3]}`;
    if (!seen.has(selector)) {
      seen.add(selector);
      selectors.push(selector);
    }
  }
  const inside = selectors
    .map((candidate) => findMappedElementRange(source, candidate))
    .filter(
      (range) =>
        range &&
        range.start > parent.openEnd &&
        range.end < parent.closeStart,
    );
  return inside
    .filter(
      (candidate) =>
        !inside.some(
          (other) =>
            other !== candidate &&
            other.start < candidate.start &&
            other.end > candidate.end,
        ),
    )
    .sort((left, right) => left.start - right.start);
}

function insertMarkupBeforeElement(source, target, markup) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = source.lastIndexOf("\n", target.start - 1) + 1;
  const before = source.slice(lineStart, target.start);
  if (/^[\t ]*$/.test(before)) {
    const rendered = indentMarkup(markup, before, newline);
    return {
      ok: true,
      changed: true,
      content:
        source.slice(0, lineStart) +
        rendered +
        newline +
        source.slice(lineStart),
    };
  }
  const prior = source.slice(0, target.start).trimEnd();
  if (!prior.endsWith(">")) {
    return { ok: false, reason: "unsafe_reparent_context" };
  }
  return {
    ok: true,
    changed: true,
    content: source.slice(0, target.start) + markup + source.slice(target.start),
  };
}

function reorderMappedChildren(source, parentSelector, payload) {
  const children = Array.isArray(payload?.children) ? payload.children : [];
  if (children.length === 0 || children.length > 200) {
    return { ok: false, reason: "invalid_reorder_mapping" };
  }
  const selectors = [];
  const seen = new Set();
  for (const child of children) {
    const selector = child?.sourceRef?.selector;
    if (!selectorAttribute(selector) || seen.has(selector)) {
      return { ok: false, reason: "invalid_reorder_mapping" };
    }
    seen.add(selector);
    selectors.push(selector);
  }
  const parent = findMappedElementRange(source, parentSelector);
  if (!parent || parent.void) {
    return { ok: false, reason: "source_element_not_found" };
  }
  const ranges = selectors.map((selector) =>
    findMappedElementRange(source, selector),
  );
  if (ranges.some((range) => !range || range.void)) {
    return { ok: false, reason: "source_element_not_found" };
  }
  for (let index = 0; index < ranges.length; index += 1) {
    for (let other = index + 1; other < ranges.length; other += 1) {
      if (
        ranges[index].start < ranges[other].end &&
        ranges[other].start < ranges[index].end
      ) {
        return { ok: false, reason: "unsafe_reorder_context" };
      }
    }
  }
  const allInsideParent = ranges.every(
    (range) => range.start > parent.openEnd && range.end < parent.closeStart,
  );
  const currentOrder = [...ranges]
    .sort((left, right) => left.start - right.start)
    .map((range) => range.selector);
  if (
    allInsideParent &&
    JSON.stringify(currentOrder) === JSON.stringify(selectors)
  ) {
    return parentContainsOnlyMappedRanges(source, parent, ranges)
      ? { ok: true, changed: false, content: source }
      : { ok: false, reason: "unsafe_reorder_context" };
  }
  const removals = ranges.map((range) => ({
    range,
    removal: safeElementRemovalRange(source, range.start, range.end),
    markup: source.slice(range.start, range.end).trim(),
  }));
  if (removals.some((entry) => !entry.removal || !entry.markup)) {
    return { ok: false, reason: "unsafe_reorder_context" };
  }
  removals.sort((left, right) => right.removal.start - left.removal.start);
  let stripped = source;
  for (const entry of removals) {
    stripped =
      stripped.slice(0, entry.removal.start) +
      stripped.slice(entry.removal.end);
  }
  const strippedParent = findMappedElementRange(stripped, parentSelector);
  if (!strippedParent || strippedParent.void) {
    return { ok: false, reason: "unsafe_reorder_context" };
  }
  const residual = stripped
    .slice(strippedParent.openEnd, strippedParent.closeStart)
    .replace(/<!--[^]*?-->/g, "")
    .trim();
  if (residual !== "") {
    return { ok: false, reason: "unsafe_reorder_context" };
  }
  const markupBySelector = new Map(
    ranges.map((range) => [
      range.selector,
      source.slice(range.start, range.end).trim(),
    ]),
  );
  return insertMarkupBeforeClosing(
    stripped,
    strippedParent,
    selectors.map((selector) => markupBySelector.get(selector)),
  );
}

function parentContainsOnlyMappedRanges(source, parent, ranges) {
  let inner = source.slice(parent.openEnd, parent.closeStart);
  const inside = ranges
    .filter(
      (range) => range.start > parent.openEnd && range.end < parent.closeStart,
    )
    .sort((left, right) => right.start - left.start);
  for (const range of inside) {
    const start = range.start - parent.openEnd;
    const end = range.end - parent.openEnd;
    inner = inner.slice(0, start) + inner.slice(end);
  }
  return inner.replace(/<!--[^]*?-->/g, "").trim() === "";
}

function findMappedElementRange(source, selector) {
  const attribute = selectorAttribute(selector);
  if (!attribute) return null;
  const openingPattern = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\s${escapeRegExp(attribute.name)}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\2[^>]*>`,
    "gi",
  );
  const opening = openingPattern.exec(source);
  if (!opening) return null;
  const tagName = opening[1].toLowerCase();
  const openEnd = opening.index + opening[0].length;
  if (VOID_MARKUP_TAGS.has(tagName) || /\/>\s*$/.test(opening[0])) {
    return {
      selector,
      tagName,
      start: opening.index,
      end: openEnd,
      openEnd,
      closeStart: openEnd,
      void: true,
    };
  }
  const closing = findElementClosingTag(source, tagName, openEnd);
  if (!closing) return null;
  return {
    selector,
    tagName,
    start: opening.index,
    end: closing.end,
    openEnd,
    closeStart: closing.start,
    void: false,
  };
}

function insertMarkupBeforeClosing(source, parent, markups) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const closingLineStart = source.lastIndexOf("\n", parent.closeStart - 1) + 1;
  const beforeClosing = source.slice(closingLineStart, parent.closeStart);
  const closingOnOwnLine = /^[\t ]*$/.test(beforeClosing);
  const closingIndent = closingOnOwnLine
    ? beforeClosing
    : sourceLineIndent(source, parent.start);
  const childIndent = `${closingIndent}  `;
  const rendered = markups
    .map((markup) => indentMarkup(markup, childIndent, newline))
    .join(newline);
  const insertionPoint = closingOnOwnLine
    ? closingLineStart
    : parent.closeStart;
  const insertion = closingOnOwnLine
    ? `${rendered}${newline}`
    : `${newline}${rendered}${newline}${closingIndent}`;
  return {
    ok: true,
    changed: true,
    content:
      source.slice(0, insertionPoint) +
      insertion +
      source.slice(insertionPoint),
  };
}

function safeCloneInsertion(source, start, end) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = source.indexOf("\n", end);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const beforeOnLine = source.slice(lineStart, start);
  const afterOnLine = source.slice(end, lineEnd);
  if (/^[\t ]*$/.test(beforeOnLine) && /^[\t ]*\r?$/.test(afterOnLine)) {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return { prefix: `${newline}${beforeOnLine}` };
  }
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end).trimStart();
  if (before.endsWith(">") && after.startsWith("<")) {
    return { prefix: "" };
  }
  return null;
}

function safeElementRemovalRange(source, start, end) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = source.indexOf("\n", end);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline + 1;
  const beforeOnLine = source.slice(lineStart, start);
  const afterOnLine = source.slice(end, nextNewline === -1 ? source.length : nextNewline);
  if (/^[\t ]*$/.test(beforeOnLine) && /^[\t ]*\r?$/.test(afterOnLine)) {
    return { start: lineStart, end: lineEnd };
  }
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end).trimStart();
  if (before.endsWith(">") && after.startsWith("<")) {
    return { start, end };
  }
  return null;
}

function replaceInlineSvg(source, selector, payload) {
  const decoded = decodeSvgPayload(payload);
  if (!decoded.ok) {
    return decoded;
  }
  const attribute = selectorAttribute(selector);
  if (!attribute) {
    return { ok: false, reason: "missing_stable_selector" };
  }
  const openingPattern = new RegExp(
    `<svg\\b[^>]*\\s${escapeRegExp(attribute.name)}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\1[^>]*>`,
    "gi",
  );
  const opening = openingPattern.exec(source);
  if (!opening) {
    return { ok: false, reason: "source_element_not_inline_svg" };
  }
  const closing = findSvgClosingTag(source, opening.index + opening[0].length);
  const exported = extractSvgParts(decoded.svg);
  if (!closing || !exported) {
    return { ok: false, reason: "invalid_svg_markup" };
  }
  const mergedOpening = mergeSvgViewBox(opening[0], exported.opening);
  return {
    ok: true,
    content:
      source.slice(0, opening.index) +
      mergedOpening +
      exported.inner +
      source.slice(closing.start),
  };
}

function replaceSvgDocument(source, payload) {
  const decoded = decodeSvgPayload(payload);
  if (!decoded.ok) {
    return decoded;
  }
  const opening = /<svg\b[^>]*>/i.exec(source);
  const exported = extractSvgParts(decoded.svg);
  if (!opening || !exported) {
    return { ok: false, reason: "invalid_svg_markup" };
  }
  const closing = findSvgClosingTag(source, opening.index + opening[0].length);
  if (!closing) {
    return { ok: false, reason: "invalid_svg_markup" };
  }
  const mergedOpening = mergeSvgViewBox(opening[0], exported.opening);
  return {
    ok: true,
    content:
      source.slice(0, opening.index) +
      mergedOpening +
      exported.inner +
      source.slice(closing.start),
  };
}

function insertInlineSvg(source, selector, payload, extension) {
  const decoded = decodeSvgPayload(payload);
  if (!decoded.ok) {
    return decoded;
  }
  const metadata = svgInsertMetadata(payload);
  if (!metadata) {
    return { ok: false, reason: "invalid_svg_insert_metadata" };
  }
  const insertedMatcher = sourceSelectorMatcher(
    `[data-codex-id="${metadata.elementId}"]`,
  );
  if (insertedMatcher?.test(source)) {
    return { ok: true, changed: false, content: source };
  }
  const attribute = selectorAttribute(selector);
  if (!attribute) {
    return { ok: false, reason: "missing_stable_selector" };
  }
  const openingPattern = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\s${escapeRegExp(attribute.name)}\\s*=\\s*(["'])${escapeRegExp(attribute.value)}\\2[^>]*>`,
    "gi",
  );
  const opening = openingPattern.exec(source);
  if (!opening || /\/>\s*$/.test(opening[0])) {
    return { ok: false, reason: "source_element_not_found" };
  }
  const closing = findElementClosingTag(
    source,
    opening[1],
    opening.index + opening[0].length,
  );
  const exported = extractSvgParts(decoded.svg);
  if (!closing || !exported) {
    return { ok: false, reason: "invalid_svg_markup" };
  }
  const markup = renderInsertedSvg(exported, metadata, extension);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const closingLineStart = source.lastIndexOf("\n", closing.start - 1) + 1;
  const beforeClosing = source.slice(closingLineStart, closing.start);
  const closingOnOwnLine = /^[\t ]*$/.test(beforeClosing);
  const closingIndent = closingOnOwnLine
    ? beforeClosing
    : sourceLineIndent(source, opening.index);
  const childIndent = `${closingIndent}  `;
  const rendered = indentMarkup(markup, childIndent, newline);
  const insertionPoint = closingOnOwnLine
    ? closingLineStart
    : closing.start;
  const insertion = closingOnOwnLine
    ? `${rendered}${newline}`
    : `${newline}${rendered}${newline}${closingIndent}`;
  return {
    ok: true,
    changed: true,
    content:
      source.slice(0, insertionPoint) +
      insertion +
      source.slice(insertionPoint),
  };
}

function svgInsertMetadata(payload) {
  const elementId =
    typeof payload?.elementId === "string" ? payload.elementId.trim() : "";
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(elementId) ||
    name.length > 200
  ) {
    return null;
  }
  const values = {
    x: payload.x,
    y: payload.y,
    width: payload.width,
    height: payload.height,
    rotation: payload.rotation,
  };
  if (
    !Object.values(values).every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000,
    ) ||
    values.width <= 0 ||
    values.height <= 0
  ) {
    return null;
  }
  return {
    elementId,
    name: name || "Figma vector",
    ...values,
  };
}

function renderInsertedSvg(exported, metadata, extension) {
  let opening = exported.opening;
  for (const attribute of ["data-codex-id", "aria-label", "style"]) {
    opening = removeMarkupAttribute(opening, attribute);
  }
  const style = svgPositionStyle(metadata, extension);
  opening = opening.replace(
    /\s*\/?>$/,
    ` data-codex-id="${escapeMarkupAttribute(metadata.elementId)}" aria-label="${escapeMarkupAttribute(metadata.name)}" ${style}>`,
  );
  return `${opening}${exported.inner}</svg>`;
}

function svgPositionStyle(metadata, extension) {
  const x = formatNumber(metadata.x);
  const y = formatNumber(metadata.y);
  const width = formatNumber(metadata.width);
  const height = formatNumber(metadata.height);
  const rotation = formatNumber(metadata.rotation);
  if ([".jsx", ".tsx", ".js", ".ts"].includes(extension)) {
    return `style={{ position: "absolute", left: ${x}, top: ${y}, width: ${width}, height: ${height}, transform: "rotate(${rotation}deg)", transformOrigin: "center" }}`;
  }
  return `style="position: absolute; left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px; transform: rotate(${rotation}deg); transform-origin: center;"`;
}

function findElementClosingTag(source, tagName, contentStart) {
  const tags = new RegExp(
    `<\\/?${escapeRegExp(tagName)}\\b[^>]*>`,
    "gi",
  );
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        return { start: match.index, end: match.index + match[0].length };
      }
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }
  }
  return null;
}

function removeMarkupAttribute(opening, name) {
  return opening.replace(
    new RegExp(
      `\\s${escapeRegExp(name)}\\s*=\\s*(["'])[^"']*\\1`,
      "gi",
    ),
    "",
  );
}

function sourceLineIndent(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const before = source.slice(lineStart, index);
  return /^[\t ]*$/.test(before) ? before : "";
}

function indentMarkup(markup, indent, newline) {
  return markup
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join(newline);
}

function decodeSvgPayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.mimeType !== "image/svg+xml" ||
    typeof payload.base64 !== "string"
  ) {
    return { ok: false, reason: "invalid_svg_payload" };
  }
  const base64 = payload.base64.replace(/\s+/g, "");
  if (
    base64.length === 0 ||
    base64.length > 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  ) {
    return { ok: false, reason: "invalid_svg_payload" };
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > 768 * 1024) {
    return { ok: false, reason: "invalid_svg_payload" };
  }
  const svg = bytes.toString("utf8");
  return isSafeFigmaSvg(svg)
    ? { ok: true, svg }
    : { ok: false, reason: "unsafe_svg_export" };
}

function isSafeFigmaSvg(svg) {
  try {
    prepareSvgAsset({
      svg,
      assetId: "figma-export.svg",
      sourcePath: "figma-export.svg",
      requireTargets: false,
    });
  } catch {
    return false;
  }
  return Boolean(extractSvgParts(svg));
}

function extractSvgParts(svg) {
  const opening = /<svg\b[^>]*>/i.exec(svg);
  if (!opening) {
    return null;
  }
  const closing = findSvgClosingTag(svg, opening.index + opening[0].length);
  if (!closing || svg.slice(closing.end).trim() !== "") {
    return null;
  }
  return {
    opening: opening[0],
    inner: svg.slice(opening.index + opening[0].length, closing.start),
  };
}

function findSvgClosingTag(source, contentStart) {
  const tags = /<\/?svg\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        return { start: match.index, end: match.index + match[0].length };
      }
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }
  }
  return null;
}

function mergeSvgViewBox(originalOpening, exportedOpening) {
  const viewBox = normalizeViewBox(
    markupAttribute(exportedOpening, "viewBox"),
  );
  if (!viewBox) {
    return originalOpening;
  }
  const existing = /\sviewBox\s*=\s*(["'])[^"']*\1/i;
  if (existing.test(originalOpening)) {
    return originalOpening.replace(existing, ` viewBox="${viewBox}"`);
  }
  return originalOpening.replace(/\s*\/?>$/, ` viewBox="${viewBox}">`);
}

function normalizeViewBox(value) {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(Number(part)))
  ) {
    return "";
  }
  return parts.join(" ");
}

function markupAttribute(opening, name) {
  const match = new RegExp(
    `\\s${escapeRegExp(name)}\\s*=\\s*(["'])([^"']*)\\1`,
    "i",
  ).exec(opening);
  return match?.[2] || "";
}

function sourceSelectorMatcher(selector) {
  const attribute = selectorAttribute(selector);
  if (!attribute) return null;
  const name =
    attribute.name === "id" ? "\\sid" : escapeRegExp(attribute.name);
  return new RegExp(
    `${name}\\s*=\\s*(?:"${escapeRegExp(attribute.value)}"|'${escapeRegExp(attribute.value)}')`,
  );
}

function selectorAttribute(selector) {
  if (typeof selector !== "string") return null;
  const dataId = selector.match(
    /^\[data-codex-id=(?:"([^"]+)"|'([^']+)')\]$/,
  );
  if (dataId) {
    return { name: "data-codex-id", value: dataId[1] || dataId[2] };
  }
  const htmlId = selector.match(/^#([A-Za-z_][\w-]*)$/);
  return htmlId ? { name: "id", value: htmlId[1] } : null;
}

function parseManagedRules(source) {
  const rules = new Map();
  const block = managedBlock(source);
  if (!block) return rules;
  for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector) continue;
    const declarations = new Map();
    for (const declaration of match[2].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator <= 0) continue;
      declarations.set(
        declaration.slice(0, separator).trim(),
        declaration.slice(separator + 1).trim(),
      );
    }
    rules.set(selector, declarations);
  }
  return rules;
}

function cloneManagedRules(rules, idMap) {
  let changed = false;
  for (const entry of idMap) {
    const sourceSelector = `[data-codex-id="${entry.from}"]`;
    const alternateSourceSelector = `[data-codex-id='${entry.from}']`;
    const sourceDeclarations =
      rules.get(sourceSelector) || rules.get(alternateSourceSelector);
    if (!sourceDeclarations) continue;

    const targetSelector = `[data-codex-id="${entry.to}"]`;
    const targetDeclarations = rules.get(targetSelector);
    const declarations = new Map(sourceDeclarations);
    if (targetDeclarations) {
      for (const [property, value] of targetDeclarations) {
        declarations.set(property, value);
      }
    }
    rules.set(targetSelector, declarations);
    changed = true;
  }
  return changed;
}

function renderManagedRules(source, rules) {
  const withoutBlock = removeManagedBlock(source).trimEnd();
  const rendered = [...rules.entries()]
    .map(
      ([selector, declarations]) =>
        `${selector} {\n${[...declarations.entries()]
          .map(([property, value]) => {
            const important = /\s!important$/i.test(value)
              ? value
              : `${value} !important`;
            return `  ${property}: ${important};`;
          })
          .join("\n")}\n}`,
    )
    .join("\n\n");
  return `${withoutBlock}\n\n${MARKER_START}\n${rendered}\n${MARKER_END}\n`;
}

function managedBlock(source) {
  const start = source.indexOf(MARKER_START);
  const end = source.indexOf(MARKER_END, start + MARKER_START.length);
  return start >= 0 && end >= 0
    ? source.slice(start + MARKER_START.length, end)
    : "";
}

function removeManagedBlock(source) {
  const start = source.indexOf(MARKER_START);
  const end = source.indexOf(MARKER_END, start + MARKER_START.length);
  if (start < 0 || end < 0) return source;
  return (
    source.slice(0, start) +
    source.slice(end + MARKER_END.length).replace(/^\s*/, "")
  );
}

async function listProjectFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(extension) && extension !== ".css") {
          continue;
        }
        const info = await stat(absolute);
        if (info.size <= MAX_SOURCE_BYTES) files.push(absolute);
      }
    }
  }
  await visit(root);
  return files;
}

async function readCachedSource(file, cache) {
  if (!cache.has(file)) {
    const content = await readFile(file, "utf8");
    cache.set(file, content);
    cache.initial?.set(file, content);
  }
  return cache.get(file);
}

function resolveSourceRef(root, value) {
  if (typeof value !== "string" || !value || /^[a-z]+:\/\//i.test(value)) {
    return "";
  }
  return resolveInside(root, path.resolve(root, value));
}

function resolveInside(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? value
    : relative === ""
      ? value
      : "";
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function stripQuery(value) {
  return value.split(/[?#]/, 1)[0];
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function formatNumber(value) {
  return String(Math.round(value * 1000) / 1000);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkupText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMarkupAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
