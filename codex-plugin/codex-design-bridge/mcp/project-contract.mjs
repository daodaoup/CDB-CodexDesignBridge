import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { commitPatchTransaction, hashContent } from "./patch-transaction.mjs";

const MANIFEST_VERSION = 1;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const EDITABLE_TAGS = new Set([
  "a",
  "article",
  "aside",
  "button",
  "div",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "header",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "span",
  "svg",
  "textarea",
  "ul",
]);

export async function createDesignProject({
  workspaceDir,
  description,
  projectName = "design-draft",
}) {
  const workspace = await normalizeDirectory(workspaceDir, "没有可写入设计的位置。");
  const requested = sanitizeProjectName(projectName || "design-draft");
  const targetDir = await nextAvailableDirectory(workspace, requested);
  const stagingDir = path.join(
    workspace,
    `.${path.basename(targetDir)}.cdb-create-${process.pid}-${Date.now()}`,
  );
  const title = designTitle(description);
  const manifest = createManifest({
    name: title,
    projectId: stableId(path.basename(targetDir)),
    htmlPages: [{ entry: "index.html", name: "Home", route: "/" }],
    sourceKind: "cdb-native",
  });

  await mkdir(path.join(stagingDir, "assets"), { recursive: true });
  try {
    await Promise.all([
      writeFile(
        path.join(stagingDir, "index.html"),
        designHtml(title, description),
        "utf8",
      ),
      writeFile(path.join(stagingDir, "styles.css"), designCss(), "utf8"),
      writeFile(path.join(stagingDir, "AGENTS.md"), designAgents(), "utf8"),
      mkdir(path.join(stagingDir, ".cdb"), { recursive: true }).then(() =>
        writeFile(
          path.join(stagingDir, ".cdb", "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        ),
      ),
    ]);
    await rename(stagingDir, targetDir);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return {
    projectDir: targetDir,
    descriptor: await loadProjectDescriptor(targetDir),
  };
}

export async function createFigmaSeedProject({
  workspaceDir,
  projectName = "figma-design",
}) {
  const workspace = await normalizeDirectory(workspaceDir, "没有可写入设计的位置。");
  const requested = sanitizeProjectName(projectName || "figma-design");
  const targetDir = await nextAvailableDirectory(workspace, requested);
  const stagingDir = path.join(
    workspace,
    `.${path.basename(targetDir)}.cdb-create-${process.pid}-${Date.now()}`,
  );
  const manifest = createManifest({
    name: "Figma Design",
    projectId: stableId(path.basename(targetDir)),
    htmlPages: [{ entry: "index.html", name: "Page", route: "/" }],
    sourceKind: "figma-seed",
  });

  await mkdir(path.join(stagingDir, "assets"), { recursive: true });
  try {
    await Promise.all([
      writeFile(path.join(stagingDir, "index.html"), figmaSeedHtml(), "utf8"),
      writeFile(path.join(stagingDir, "styles.css"), figmaSeedCss(), "utf8"),
      writeFile(path.join(stagingDir, "AGENTS.md"), designAgents(), "utf8"),
      mkdir(path.join(stagingDir, ".cdb"), { recursive: true }).then(() =>
        writeFile(
          path.join(stagingDir, ".cdb", "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        ),
      ),
    ]);
    await rename(stagingDir, targetDir);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return {
    projectDir: targetDir,
    descriptor: await loadProjectDescriptor(targetDir),
  };
}

export async function writeImportedManifest(projectDir, htmlPages, name) {
  const root = path.resolve(projectDir);
  const pages = htmlPages.flatMap(importedPageDescriptors);
  const manifest = createManifest({
    name: name || path.basename(root),
    projectId: stableId(path.basename(root)),
    htmlPages: pages,
    sourceKind: "imported-html",
  });
  await mkdir(path.join(root, ".cdb"), { recursive: true });
  await writeFile(
    path.join(root, ".cdb", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export function prepareImportedHtml(html) {
  return addStableIds(ensureCaptureRoot(String(html || "")));
}

export function detectImportedTabStates(html) {
  const source = String(html || "");
  const screens = new Map();
  for (const match of source.matchAll(
    /<([a-z][\w:-]*)\b[^>]*\bdata-screen\s*=\s*(["'])(.*?)\2[^>]*>/gi,
  )) {
    const target = match[3].trim();
    if (!target || screens.has(target)) continue;
    const className = htmlAttribute(match[0], "class");
    screens.set(target, {
      active: className.split(/\s+/).includes("is-active"),
      hidden: /\shidden(?:\s|=|>)/i.test(match[0]),
    });
  }

  const targets = [];
  const seen = new Set();
  for (const match of source.matchAll(
    /<([a-z][\w:-]*)\b[^>]*\bdata-target\s*=\s*(["'])(.*?)\2[^>]*>/gi,
  )) {
    const target = match[3].trim();
    if (!target || seen.has(target) || !screens.has(target)) continue;
    seen.add(target);
    targets.push({
      target,
      name: tabTriggerName(source, match) || humanizeStateName(target),
    });
  }
  if (targets.length < 2) return [];

  const defaultTarget =
    targets.find(({ target }) => screens.get(target)?.active)?.target ||
    targets.find(({ target }) => !screens.get(target)?.hidden)?.target ||
    "";
  const ordered = defaultTarget
    ? [
        ...targets.filter(({ target }) => target === defaultTarget),
        ...targets.filter(({ target }) => target !== defaultTarget),
      ]
    : targets;
  return ordered.map((state) => ({
    ...state,
    isDefault: state.target === defaultTarget,
  }));
}

export async function loadProjectDescriptor(projectDir) {
  const rootDir = await normalizeDirectory(projectDir, "当前项目目录不可用。");
  const manifestPath = path.join(rootDir, ".cdb", "manifest.json");
  let manifest;
  let manifestOrigin = "file";
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`CDB manifest 无法读取：${error.message}`);
    }
    manifestOrigin = "inferred";
    manifest = await inferManifest(rootDir);
  }
  manifest = validateManifest(manifest, rootDir);
  const projectKey = createHash("sha256")
    .update(rootDir.toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return { projectKey, rootDir, manifest, manifestOrigin };
}

export async function preflightDesignProject(projectDir) {
  const descriptor = await loadProjectDescriptor(projectDir);
  const issues = [];
  const dependencies = new Set();
  const pageStates = [];
  const sourceParts = [JSON.stringify(descriptor.manifest)];
  const hasSyncHistory = await exists(path.join(descriptor.rootDir, ".figma-sync"));

  if (descriptor.manifestOrigin === "inferred") {
    issues.push(issue({
      code: "manifest_missing",
      level: "warning",
      message: "项目缺少 .cdb/manifest.json，当前使用内存推断的静态页面清单。",
      file: ".cdb/manifest.json",
    }));
  }

  for (const page of descriptor.manifest.pages) {
    const filePath = safeProjectPath(descriptor.rootDir, page.entry);
    let html;
    try {
      html = await readFile(filePath, "utf8");
    } catch {
      issues.push(issue({
        code: "entry_missing",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: `页面入口不存在：${page.entry}`,
      }));
      continue;
    }
    sourceParts.push(page.entry, html);
    const rootCount = (html.match(/\bdata-codex-root(?:\s|=|>)/gi) || []).length;
    const ids = [...html.matchAll(/\bdata-codex-id\s*=\s*(["'])(.*?)\1/gi)]
      .map((match) => match[2].trim())
      .filter(Boolean);
    const duplicateIds = duplicates(ids);
    const editableTags = countEditableTags(html);
    const blank = isBlankPage(html);

    if (rootCount === 0) {
      issues.push(issue({
        code: "capture_root_missing",
        level: "safe_fix",
        pageId: page.id,
        file: page.entry,
        message: "页面缺少唯一捕获根。",
        fixId: `root:add:${page.id}`,
      }));
    } else if (rootCount > 1) {
      issues.push(issue({
        code: "capture_root_multiple",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: `页面存在 ${rootCount} 个捕获根，必须人工保留一个完整页面根。`,
      }));
    }

    if (duplicateIds.length > 0) {
      issues.push(issue({
        code: "mapping_id_duplicate",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: `存在重复 data-codex-id：${duplicateIds.slice(0, 5).join("、")}`,
      }));
    }

    if (ids.length < editableTags) {
      issues.push(issue({
        code: hasSyncHistory ? "mapping_id_missing_after_sync" : "mapping_id_missing",
        level: hasSyncHistory ? "blocker" : "safe_fix",
        pageId: page.id,
        file: page.entry,
        message: hasSyncHistory
          ? "页面已有同步历史，缺失稳定 ID 的节点必须由 Codex 明确修复。"
          : `预计 ${editableTags - ids.length} 个可编辑节点缺少稳定 ID。`,
        fixId: hasSyncHistory ? undefined : `ids:add:${page.id}`,
      }));
    }

    if (blank) {
      issues.push(issue({
        code: "capture_blank",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: "页面没有可捕获的可见内容。",
      }));
    }
    if (ids.length === 0 && editableTags === 0) {
      issues.push(issue({
        code: "editable_layers_empty",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: "没有检测到可编辑图层。",
      }));
    }
    if (/\b(?:createElement|appendChild|insertAdjacentHTML|innerHTML\s*=)/.test(html)) {
      issues.push(issue({
        code: "runtime_dom_detected",
        level: "warning",
        pageId: page.id,
        file: page.entry,
        message: "检测到运行时 DOM；只有初始 HTML 中的稳定节点保证可编辑映射。",
      }));
    }
    if (hasUnsafeInlineSvg(html)) {
      issues.push(issue({
        code: "unsafe_svg",
        level: "blocker",
        pageId: page.id,
        file: page.entry,
        message: "内联 SVG 包含脚本、事件处理器或外部资源。",
      }));
    }

    for (const reference of resourceReferences(html)) {
      if (/^(?:https?:)?\/\//i.test(reference)) {
        issues.push(issue({
          code: "cross_origin_resource",
          level: descriptor.manifest.assets.allowRemote ? "warning" : "blocker",
          pageId: page.id,
          file: page.entry,
          message: `远程资源不可作为稳定 CDB 资产：${reference.slice(0, 120)}`,
        }));
        continue;
      }
      if (/^(?:data:|blob:|javascript:|mailto:|#)/i.test(reference)) continue;
      const clean = reference.split(/[?#]/, 1)[0];
      if (!clean || clean.startsWith("/")) continue;
      const relative = normalizeRelativePath(
        path.posix.join(path.posix.dirname(page.entry), clean),
      );
      dependencies.add(relative);
      if (!(await exists(safeProjectPath(descriptor.rootDir, relative)))) {
        issues.push(issue({
          code: "resource_missing",
          level: "blocker",
          pageId: page.id,
          file: page.entry,
          message: `资源不存在：${relative}`,
        }));
      }
    }

    pageStates.push({
      id: page.id,
      name: page.name,
      entry: page.entry,
      route: page.route,
      path: page.route,
      captureRoot: page.captureRoot,
      ...(page.captureState ? { captureState: { ...page.captureState } } : {}),
      viewport: { ...page.viewport },
      sourceHash: hashContent(
        `${html}\u0000${JSON.stringify(page.captureState || null)}`,
      ),
      estimatedEditableLayers: Math.max(ids.length, rootCount),
    });
  }

  const sourceHash = createHash("sha256")
    .update(sourceParts.join("\u0000"))
    .digest("hex");
  const status = reportStatus(issues);
  const reportId = createHash("sha256")
    .update(`${sourceHash}\u0000${JSON.stringify(issues)}`)
    .digest("hex")
    .slice(0, 24);
  return {
    reportId,
    projectKey: descriptor.projectKey,
    sourceHash,
    status,
    pageCount: pageStates.length,
    dependencyCount: dependencies.size,
    estimatedEditableLayers: pageStates.reduce(
      (sum, page) => sum + page.estimatedEditableLayers,
      0,
    ),
    issues,
    pages: pageStates,
    descriptor,
  };
}

export async function applyDesignPreflightFixes({
  projectDir,
  reportId,
  sourceHash,
  fixIds,
}) {
  const before = await preflightDesignProject(projectDir);
  if (before.reportId !== reportId || before.sourceHash !== sourceHash) {
    throw new Error("项目已变化，请重新运行预检后再应用修复。");
  }
  const selected = new Set(Array.isArray(fixIds) ? fixIds : []);
  const allowed = new Set(
    before.issues.map((entry) => entry.fixId).filter(Boolean),
  );
  if (selected.size === 0 || [...selected].some((id) => !allowed.has(id))) {
    throw new Error("没有可应用的安全修复，或修复计划已经失效。");
  }

  const writes = new Map();
  for (const page of before.descriptor.manifest.pages) {
    const rootFix = `root:add:${page.id}`;
    const idsFix = `ids:add:${page.id}`;
    if (!selected.has(rootFix) && !selected.has(idsFix)) continue;
    const filePath = safeProjectPath(before.descriptor.rootDir, page.entry);
    const original = await readFile(filePath, "utf8");
    let next = original;
    if (selected.has(rootFix)) next = ensureCaptureRoot(next);
    if (selected.has(idsFix)) next = addStableIds(next);
    writes.set(page.entry, next);
  }

  const transaction = await commitPatchTransaction({
    projectDir: before.descriptor.rootDir,
    kind: "cdb-preflight-fix",
    writes: [...writes.entries()].map(([file, content]) => ({
      file: path.join(before.descriptor.rootDir, file),
      content,
    })),
  });
  return { transaction, report: await preflightDesignProject(projectDir) };
}

export function workspacePagesFromReport(report, previousPages = []) {
  const previous = new Map(
    (Array.isArray(previousPages) ? previousPages : []).map((page) => [page.id, page]),
  );
  return report.pages.map((page) => {
    const old = previous.get(page.id) || {};
    const sourceChanged = old.sourceHash && old.sourceHash !== page.sourceHash;
    return {
      ...page,
      acceptsFigmaSeed:
        report.descriptor?.manifest?.source?.kind === "figma-seed",
      figmaReady: Boolean(old.figmaReady),
      lastSentAt: old.lastSentAt || "",
      nodeCount: Number.isInteger(old.nodeCount) ? old.nodeCount : 0,
      syncState: !old.figmaReady
        ? "not_imported"
        : sourceChanged
          ? "source_changed"
          : old.syncState || "synced",
    };
  });
}

function createManifest({ name, projectId, htmlPages, sourceKind }) {
  return {
    schemaVersion: MANIFEST_VERSION,
    projectId,
    name,
    source: { kind: sourceKind, root: "." },
    entry: htmlPages[0]?.entry || "index.html",
    pages: htmlPages.map((page, index) => {
      const captureState = normalizeCaptureState(page.captureState);
      return {
        id: uniquePageId(page, index),
        name: String(page.name || `Page ${index + 1}`).slice(0, 80),
        entry: normalizeRelativePath(page.entry),
        route: normalizeRoute(page.route),
        captureRoot: "[data-codex-root]",
        viewport: { ...DEFAULT_VIEWPORT },
        ...(captureState ? { captureState } : {}),
      };
    }),
    assets: { roots: ["assets"], allowRemote: false },
    mapping: { attribute: "data-codex-id", requireUnique: true },
    runtime: { dom: "static", spa: false },
  };
}

function importedPageDescriptors(page) {
  const entry = normalizeRelativePath(page.path);
  const route = entry.toLowerCase() === "index.html"
    ? "/"
    : `/${entry.split("/").map(encodeURIComponent).join("/")}`;
  const states = Array.isArray(page.tabStates) ? page.tabStates : [];
  if (states.length < 2) {
    return [{ entry, name: page.name, route }];
  }
  return states.map((state, index) => ({
    entry,
    name: state.name,
    route:
      index === 0
        ? route
        : `${route}?__cdb_state=${encodeURIComponent(state.target)}`,
    ...(!state.isDefault
      ? { captureState: { kind: "tab", target: state.target } }
      : {}),
  }));
}

function htmlAttribute(openingTag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return openingTag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  )?.[2] || "";
}

function tabTriggerName(source, match) {
  const tagName = match[1].toLowerCase();
  const start = match.index + match[0].length;
  const closing = new RegExp(`</${tagName}\\s*>`, "ig");
  closing.lastIndex = start;
  const end = closing.exec(source)?.index;
  const inner = Number.isInteger(end) ? source.slice(start, end) : "";
  return decodeBasicHtml(inner.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) ||
    decodeBasicHtml(htmlAttribute(match[0], "aria-label"))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
}

function decodeBasicHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function humanizeStateName(value) {
  const words = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words
    ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 80)
    : "页面";
}

function normalizeCaptureState(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CDB manifest captureState 必须是对象。");
  }
  if (value.kind !== "tab") {
    throw new Error(`CDB manifest 不支持 captureState.kind：${value.kind || "空"}`);
  }
  const target = String(value.target || "").trim();
  if (!target || target.length > 80 || /[\u0000-\u001F]/.test(target)) {
    throw new Error("CDB manifest captureState.target 无效。");
  }
  return { kind: "tab", target };
}

async function inferManifest(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const htmlEntries = entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftRank = left.toLowerCase() === "index.html" ? 0 : 1;
      const rightRank = right.toLowerCase() === "index.html" ? 0 : 1;
      return leftRank - rightRank || left.localeCompare(right);
    });
  if (htmlEntries.length === 0) {
    throw new Error("没有找到 .cdb/manifest.json 或根目录 HTML 入口。");
  }
  const pages = [];
  for (const entry of htmlEntries) {
    const html = await readFile(path.join(rootDir, entry), "utf8");
    pages.push(
      ...importedPageDescriptors({
        path: entry,
        name: htmlTitle(html) || path.basename(entry, path.extname(entry)),
        tabStates: detectImportedTabStates(html),
      }),
    );
  }
  return createManifest({
    name: path.basename(rootDir),
    projectId: stableId(path.basename(rootDir)),
    htmlPages: pages,
    sourceKind: "selected-folder",
  });
}

function validateManifest(value, rootDir) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(".cdb/manifest.json 必须是 JSON 对象。");
  }
  if (value.schemaVersion !== MANIFEST_VERSION) {
    throw new Error(`不支持 CDB manifest schemaVersion ${value.schemaVersion ?? "空"}。`);
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error("CDB manifest 必须至少声明一个页面。");
  }
  const ids = new Set();
  const routes = new Set();
  const pages = value.pages.map((candidate, index) => {
    const id = stableId(candidate?.id || `page-${index + 1}`);
    if (ids.has(id)) throw new Error(`CDB manifest 页面 ID 重复：${id}`);
    ids.add(id);
    const entry = normalizeRelativePath(candidate?.entry || "");
    if (!/\.html?$/i.test(entry)) {
      throw new Error(`CDB manifest 页面入口必须是 HTML：${entry || "空"}`);
    }
    safeProjectPath(rootDir, entry);
    const route = normalizeRoute(candidate?.route || (entry === "index.html" ? "/" : `/${entry}`));
    if (routes.has(route)) throw new Error(`CDB manifest 页面路由重复：${route}`);
    routes.add(route);
    const captureState = normalizeCaptureState(candidate?.captureState);
    return {
      ...candidate,
      id,
      name: String(candidate?.name || `Page ${index + 1}`).trim().slice(0, 80),
      entry,
      route,
      captureRoot: String(candidate?.captureRoot || "[data-codex-root]"),
      viewport: normalizeViewport(candidate?.viewport),
      ...(captureState ? { captureState } : {}),
    };
  });
  return {
    ...value,
    projectId: stableId(value.projectId || path.basename(rootDir)),
    name: String(value.name || path.basename(rootDir)).trim().slice(0, 80),
    entry: normalizeRelativePath(value.entry || pages[0].entry),
    source: {
      kind: String(value.source?.kind || "selected-folder"),
      root: ".",
    },
    pages,
    assets: {
      roots: Array.isArray(value.assets?.roots)
        ? value.assets.roots.map(normalizeRelativePath)
        : ["assets"],
      allowRemote: value.assets?.allowRemote === true,
    },
    mapping: {
      attribute: "data-codex-id",
      requireUnique: true,
    },
    runtime: {
      dom: value.runtime?.dom === "dynamic" ? "dynamic" : "static",
      spa: value.runtime?.spa === true,
    },
  };
}

function ensureCaptureRoot(html) {
  if (/\bdata-codex-root(?:\s|=|>)/i.test(html)) return html;
  const main = html.match(/<main\b[^>]*>/i)?.[0];
  if (main) return html.replace(main, addAttributes(main, true));
  const body = html.match(/<body\b[^>]*>/i)?.[0];
  if (body) return html.replace(body, addAttributes(body, true));
  return `<main data-codex-root data-codex-id="page-root">${html}</main>`;
}

function addStableIds(html) {
  const existing = new Set(
    [...html.matchAll(/\bdata-codex-id\s*=\s*(["'])(.*?)\1/gi)].map(
      (match) => match[2],
    ),
  );
  const counts = new Map();
  return html.replace(/<([a-z][\w:-]*)(\s[^<>]*?)?>/gi, (opening, rawTag, attributes = "") => {
    const tag = rawTag.toLowerCase();
    if (!EDITABLE_TAGS.has(tag) || /\bdata-codex-id\s*=/i.test(opening)) {
      return opening;
    }
    let candidate = attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2] ||
      attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/)[0] ||
      tag;
    const nextCount = (counts.get(candidate) || 0) + 1;
    counts.set(candidate, nextCount);
    candidate = stableId(nextCount === 1 ? candidate : `${candidate}-${nextCount}`);
    while (existing.has(candidate)) {
      const suffix = (counts.get(candidate) || 1) + 1;
      counts.set(candidate, suffix);
      candidate = `${candidate}-${suffix}`;
    }
    existing.add(candidate);
    return opening.replace(/>$/, ` data-codex-id="${candidate}">`);
  });
}

function addAttributes(opening, addId) {
  const additions = ["data-codex-root"];
  if (addId && !/\bdata-codex-id\s*=/i.test(opening)) {
    additions.push('data-codex-id="page-root"');
  }
  return opening.replace(/>$/, ` ${additions.join(" ")}>`);
}

function resourceReferences(html) {
  const values = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    values.push(match[2].trim());
  }
  for (const match of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    values.push(match[2].trim());
  }
  return values.filter(Boolean);
}

function hasUnsafeInlineSvg(html) {
  const fragments = String(html || "").match(/<svg\b[\s\S]*?<\/svg\s*>/gi) || [];
  return fragments.some((fragment) =>
    /<script\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i.test(fragment),
  );
}

function countEditableTags(html) {
  let count = 0;
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (EDITABLE_TAGS.has(match[1].toLowerCase())) count += 1;
  }
  return count;
}

function isBlankPage(html) {
  const visible = html
    .replace(/<(?:script|style|template)\b[\s\S]*?<\/(?:script|style|template)>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, "")
    .trim();
  return !visible && !/<(?:img|svg|canvas|video)\b/i.test(html);
}

function reportStatus(issues) {
  if (issues.some((entry) => entry.level === "blocker")) return "blocker";
  if (issues.some((entry) => entry.level === "safe_fix")) return "safe_fix";
  if (issues.some((entry) => entry.level === "warning")) return "warning";
  return "pass";
}

function issue(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function normalizeRelativePath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`CDB manifest 路径无效：${value || "空"}`);
  }
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error(`CDB manifest 路径越界：${value}`);
  }
  return segments.join("/");
}

function safeProjectPath(root, relativePath) {
  const target = path.resolve(root, ...normalizeRelativePath(relativePath).split("/"));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`CDB manifest 路径越界：${relativePath}`);
  }
  return target;
}

function normalizeRoute(value) {
  const raw = String(value || "/").trim() || "/";
  const parsed = new URL(raw, "http://cdb.local/");
  if (parsed.origin !== "http://cdb.local") {
    throw new Error(`CDB 页面路由必须是本地路径：${value}`);
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

function normalizeViewport(value) {
  const width = Number.isInteger(value?.width) ? value.width : DEFAULT_VIEWPORT.width;
  const height = Number.isInteger(value?.height) ? value.height : DEFAULT_VIEWPORT.height;
  return {
    width: Math.min(1920, Math.max(320, width)),
    height: Math.min(1200, Math.max(480, height)),
  };
}

async function normalizeDirectory(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  const resolved = path.resolve(value.trim());
  try {
    if (!(await stat(resolved)).isDirectory()) throw new Error();
  } catch {
    throw new Error(message);
  }
  return resolved;
}

async function nextAvailableDirectory(root, requested) {
  for (let index = 1; index <= 999; index += 1) {
    const leaf = index === 1 ? requested : `${requested}-${index}`;
    const candidate = path.join(root, leaf);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("同名设计项目过多，请更换名称。");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sanitizeProjectName(value) {
  const normalized = String(value || "design-draft")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "design-draft";
}

function uniquePageId(page, index) {
  const base = stableId(page.route === "/" ? "home" : page.name || page.entry);
  return index === 0 ? base : `${base}-${index + 1}`;
}

function stableId(value) {
  return String(value || "item")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 64) || "item";
}

function htmlTitle(html) {
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "";
}

function designTitle(description) {
  const value = String(description || "新设计").trim().replace(/\s+/g, " ");
  return value.slice(0, 48) || "新设计";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function designHtml(title, description) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main data-codex-root data-codex-id="page-root" class="page-shell">
      <section data-codex-id="hero" class="hero">
        <p data-codex-id="eyebrow" class="eyebrow">CDB DESIGN</p>
        <h1 data-codex-id="title">${escapeHtml(title)}</h1>
        <p data-codex-id="description" class="description">${escapeHtml(description || "从这里开始完善你的新设计。")}</p>
        <button data-codex-id="primary-action" type="button">开始探索</button>
      </section>
    </main>
  </body>
</html>
`;
}

function designCss() {
  return `:root {
  color: #f7f7fb;
  background: #0a0a0d;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
.page-shell { min-height: 100vh; display: grid; place-items: center; padding: 48px 24px; }
.hero { width: min(720px, 100%); padding: 56px; border: 1px solid #292933; border-radius: 24px; background: #141419; }
.eyebrow { margin: 0 0 16px; color: #a78bfa; font-size: 12px; font-weight: 700; letter-spacing: 0.16em; }
h1 { margin: 0; font-size: clamp(42px, 8vw, 80px); line-height: 0.98; }
.description { max-width: 56ch; margin: 24px 0 32px; color: #b8b8c4; font-size: 18px; line-height: 1.6; }
button { min-height: 44px; padding: 0 20px; border: 0; border-radius: 12px; color: #0a0a0d; background: #d8b4fe; font: inherit; font-weight: 700; }
`;
}

function figmaSeedHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Figma Design</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main data-codex-root data-codex-id="page-root" class="figma-seed">
      <p data-codex-id="figma-seed-placeholder">在 Figma 中选择一个页面 Frame，然后发送给 Codex。</p>
    </main>
  </body>
</html>
`;
}

function figmaSeedCss() {
  return `* { box-sizing: border-box; }
html, body { margin: 0; min-width: 320px; min-height: 100%; }
body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0f0f14; }
.figma-seed { min-height: 100vh; display: grid; place-items: center; padding: 32px; color: #aaa8b8; }
.figma-seed p { max-width: 32rem; margin: 0; text-align: center; line-height: 1.6; }
`;
}

function designAgents() {
  return `# CDB project rules

- Keep exactly one \`data-codex-root\` that covers the complete target page.
- Keep every existing \`data-codex-id\` stable and unique; add semantic IDs to new editable elements.
- Keep project assets under \`assets/\` and use relative, project-local URLs.
- SVG must not contain scripts, event handlers, external resources, or embedded remote images.
- Keep important editable elements in the initial HTML. Do not replace mapped nodes with random runtime DOM.
- Do not silently rewrite dynamic business logic or remove content to make capture pass.
`;
}
