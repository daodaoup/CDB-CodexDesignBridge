import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAGE_IR_RESPONSIVE_SCHEMA_VERSION as PAGE_IR_SCHEMA_VERSION,
  compactResponsivePageIr,
  hashResponsivePageIr,
  mergeResponsivePageIr,
  normalizeResponsivePageIr,
} from "../shared/page-ir-responsive-v2.mjs";
import {
  CDB_EXACT_BUILD,
  currentRuntimeIdentity,
  validateExactRuntimeIdentity,
} from "../shared/runtime-contract.mjs";

export const SYNC_BASELINE_VERSION = 2;

const exactOptions = { expectedExactBuild: CDB_EXACT_BUILD };
const compactPageIr = (value) => compactResponsivePageIr(value, exactOptions);
const hashPageIr = (value) => hashResponsivePageIr(value, exactOptions);
const normalizePageIr = (value) => normalizeResponsivePageIr(value, exactOptions);
const mergePageIr = (value) => mergeResponsivePageIr(value, exactOptions);

export class SyncBaselineStore {
  constructor(projectDir, { directory = ".cdb/sync-baselines" } = {}) {
    if (!projectDir) throw codedError("invalid_project", "同步基线需要本地项目目录。");
    this.projectDir = path.resolve(projectDir);
    this.directory = path.resolve(this.projectDir, directory);
    this.writeQueue = Promise.resolve();
  }

  async get(pageId) {
    const normalizedPageId = safePageId(pageId);
    const filePath = this.pathFor(normalizedPageId);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw codedError("baseline_corrupt", `页面 ${normalizedPageId} 的同步基线不是有效 JSON。`);
      }
      throw error;
    }
    return validateRecord(parsed, normalizedPageId, filePath);
  }

  async commit({
    pageIr,
    sourceHash = "",
    figma = {},
    transactionId = "",
  }) {
    const compact = compactPageIr(pageIr);
    const normalizedSourceHash = optionalHash(sourceHash, "sourceHash");
    const normalizedFigma = normalizeFigmaIdentity(figma);
    const normalizedTransactionId = optionalText(transactionId, 160);

    let committed;
    this.writeQueue = this.writeQueue.then(async () => {
      const now = new Date().toISOString();
      const filePath = this.pathFor(compact.pageId);
      const existing = await readExistingRecord(filePath, compact.pageId);
      committed = {
        baselineVersion: SYNC_BASELINE_VERSION,
        runtimeIdentity: currentRuntimeIdentity(),
        pageIrSchemaVersion: PAGE_IR_SCHEMA_VERSION,
        pageId: compact.pageId,
        projectKey: compact.projectKey,
        sourceHash: normalizedSourceHash,
        pageIrHash: compact.irHash,
        figma: normalizedFigma,
        nodeMappings: pageIrNodeMappings(compact),
        transactionId: normalizedTransactionId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        pageIr: compact,
      };
      await atomicWriteJson(filePath, committed);
    });
    await this.writeQueue;
    return structuredClone(committed);
  }

  async merge({
    pageId,
    htmlPageIr,
    figmaPageIr,
    commit = false,
    sourceHash = "",
    figma = {},
    transactionId = "",
  }) {
    const baseline = await this.get(pageId);
    if (!baseline) {
      throw codedError("baseline_not_found", `页面 ${pageId} 还没有成功同步基线。`);
    }
    const result = mergePageIr({
      baseline: baseline.pageIr,
      html: htmlPageIr,
      figma: figmaPageIr,
    });
    if (commit && result.conflicts.length === 0) {
      result.baseline = await this.commit({
        pageIr: result.merged,
        sourceHash,
        figma,
        transactionId,
      });
    } else {
      result.baseline = baseline;
    }
    return result;
  }

  async recordConflicts({
    changeSetId,
    changeSetPath = "",
    pageId,
    baseline,
    htmlPageIr,
    figmaPageIr,
    conflicts,
  }) {
    const safeChangeSetId = safeFileToken(changeSetId || randomUUID());
    const normalizedPageId = safePageId(pageId);
    const record = {
      conflictVersion: 1,
      changeSetId: optionalText(changeSetId, 160),
      changeSetPath: optionalText(changeSetPath, 1000),
      pageId: normalizedPageId,
      baselineHash: baseline?.pageIrHash || baseline?.pageIr?.irHash || "",
      htmlPageIrHash: normalizePageIr(htmlPageIr).irHash,
      figmaPageIrHash: normalizePageIr(figmaPageIr).irHash,
      conflicts: Array.isArray(conflicts) ? structuredClone(conflicts) : [],
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(this.projectDir, ".cdb", "sync-conflicts", `${safeChangeSetId}.json`);
    await atomicWriteJson(filePath, record);
    return { ...record, filePath };
  }

  async markConflictResolved(
    filePath,
    { resolution, transactionId = "", rollbackBaseline = null },
  ) {
    const root = path.join(this.projectDir, ".cdb", "sync-conflicts");
    const target = path.resolve(filePath || "");
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw codedError("invalid_conflict_path", "同步冲突记录路径无效。");
    }
    const record = JSON.parse(await readFile(target, "utf8"));
    const resolved = {
      ...record,
      status: "resolved",
      resolution: resolution === "figma" ? "figma" : "html",
      transactionId: optionalText(transactionId, 160),
      ...(rollbackBaseline
        ? { rollbackBaseline: compactRollbackBaseline(rollbackBaseline) }
        : {}),
      resolvedAt: new Date().toISOString(),
    };
    await atomicWriteJson(target, resolved);
    return resolved;
  }

  async reopenConflict(
    filePath,
    { undoTransactionId = "", expectedResolution = "" } = {},
  ) {
    const root = path.join(this.projectDir, ".cdb", "sync-conflicts");
    const target = path.resolve(filePath || "");
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw codedError("invalid_conflict_path", "同步冲突记录路径无效。");
    }
    const record = JSON.parse(await readFile(target, "utf8"));
    if (
      record.status !== "resolved" ||
      !["html", "figma"].includes(record.resolution) ||
      (expectedResolution && record.resolution !== expectedResolution)
    ) {
      throw codedError("conflict_not_undoable", "已解决冲突的方向或状态与撤销请求不匹配。");
    }
    const reopened = {
      ...record,
      status: "open",
      reopenedAt: new Date().toISOString(),
      undoTransactionId: optionalText(undoTransactionId, 160),
    };
    delete reopened.resolvedAt;
    await atomicWriteJson(target, reopened);
    return reopened;
  }

  async markConflictCopied(filePath, { copyPageId, transactionId = "" }) {
    const root = path.join(this.projectDir, ".cdb", "sync-conflicts");
    const target = path.resolve(filePath || "");
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw codedError("invalid_conflict_path", "同步冲突记录路径无效。");
    }
    const record = JSON.parse(await readFile(target, "utf8"));
    const copy = {
      pageId: safePageId(copyPageId),
      transactionId: optionalText(transactionId, 160),
      copiedAt: new Date().toISOString(),
    };
    const updated = {
      ...record,
      copies: [...(Array.isArray(record.copies) ? record.copies : []), copy],
      updatedAt: copy.copiedAt,
    };
    await atomicWriteJson(target, updated);
    return updated;
  }

  pathFor(pageId) {
    return path.join(this.directory, `${safePageId(pageId)}.json`);
  }
}

function validateRecord(value, expectedPageId, filePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("baseline_corrupt", `页面 ${expectedPageId} 的同步基线格式无效。`);
  }
  if (
    value.baselineVersion !== SYNC_BASELINE_VERSION ||
    !isCurrentRuntimeIdentity(value.runtimeIdentity) ||
    value.pageIrSchemaVersion !== PAGE_IR_SCHEMA_VERSION ||
    value.pageId !== expectedPageId
  ) {
    throw codedError("baseline_version_mismatch", `页面 ${expectedPageId} 的同步基线版本或身份不匹配。`);
  }
  let normalized;
  try {
    normalized = normalizePageIr(value.pageIr);
  } catch (error) {
    throw codedError("baseline_corrupt", `页面 ${expectedPageId} 的 Page IR 无效：${error.message}`);
  }
  const actualHash = hashPageIr(normalized);
  if (value.pageIrHash !== actualHash || value.pageIr?.irHash !== actualHash) {
    throw codedError("baseline_hash_mismatch", `页面 ${expectedPageId} 的同步基线哈希校验失败。`);
  }
  return {
    baselineVersion: SYNC_BASELINE_VERSION,
    runtimeIdentity: currentRuntimeIdentity(),
    pageIrSchemaVersion: PAGE_IR_SCHEMA_VERSION,
    pageId: expectedPageId,
    projectKey: optionalText(value.projectKey, 256),
    sourceHash: optionalHash(value.sourceHash, "sourceHash"),
    pageIrHash: actualHash,
    figma: normalizeFigmaIdentity(value.figma),
    nodeMappings: pageIrNodeMappings(normalized),
    transactionId: optionalText(value.transactionId, 160),
    createdAt: validTimestamp(value.createdAt, "createdAt"),
    updatedAt: validTimestamp(value.updatedAt, "updatedAt"),
    filePath,
    pageIr: normalized,
  };
}

async function readExistingRecord(filePath, pageId) {
  try {
    return validateRecord(JSON.parse(await readFile(filePath, "utf8")), pageId, filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // A current-build commit is a fresh baseline, never a migration. If an
    // older exact build owns this path, replace it atomically instead of
    // letting stale project metadata block the new import.
    if (error?.code === "baseline_version_mismatch") return null;
    throw error;
  }
}

function normalizeFigmaIdentity(value) {
  const figma = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    fileKey: optionalText(figma.fileKey || figma.figmaFileKey, 256),
    pageId: optionalText(figma.pageId, 128),
    rootNodeId: optionalText(figma.rootNodeId || figma.nodeId, 128),
    rootNodeName: optionalText(figma.rootNodeName || figma.nodeName, 256),
  };
}

function isCurrentRuntimeIdentity(value) {
  try {
    validateExactRuntimeIdentity(value, CDB_EXACT_BUILD);
    return true;
  } catch {
    return false;
  }
}

function pageIrNodeMappings(pageIr) {
  return Object.values(pageIr.nodes || {}).map((node) => ({
    pageNodeId: node.id,
    figmaNodeId: node.figma?.nodeId || "",
    nodeType: node.type,
    sourceRef: structuredClone(node.sourceRef),
  }));
}

function compactRollbackBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("invalid_baseline", "冲突撤销基线无效。");
  }
  const pageIr = compactPageIr(value.pageIr);
  return {
    pageIr,
    sourceHash: optionalHash(value.sourceHash, "sourceHash"),
    figma: normalizeFigmaIdentity(value.figma),
    transactionId: optionalText(value.transactionId, 160),
  };
}

function safePageId(value) {
  const pageId = typeof value === "string" ? value : "";
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(pageId)) {
    throw codedError("invalid_page_id", "同步基线页面 ID 无效。");
  }
  return pageId;
}

function safeFileToken(value) {
  const token = String(value || "").replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 160);
  if (!token || token === "." || token === "..") return randomUUID();
  return token;
}

function optionalHash(value, field) {
  const text = optionalText(value, 64);
  if (text && !/^[a-f0-9]{64}$/u.test(text)) {
    throw codedError("invalid_baseline", `同步基线 ${field} 必须是 SHA-256。`);
  }
  return text;
}

function optionalText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function validTimestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw codedError("baseline_corrupt", `同步基线 ${field} 无效。`);
  }
  return value;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
