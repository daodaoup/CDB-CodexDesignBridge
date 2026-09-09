import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compactResponsivePageIr,
  createResponsivePageIrFromFigmaPayload,
} from "../shared/page-ir-responsive-v2.mjs";
import {
  CDB_BRIDGE_PROTOCOL_VERSION,
  CDB_EXACT_BUILD,
  currentRuntimeIdentity,
  validateExactRuntimeIdentity,
} from "../shared/runtime-contract.mjs";
import { normalizeVisualReference } from "./visual-verification.mjs";

export const DESIGN_OFFER_PROTOCOL_VERSION = CDB_BRIDGE_PROTOCOL_VERSION;
export const DESIGN_OFFER_ROOT_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "GROUP",
]);

const MAX_EDITABLE_NODES = 500;
const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "ignored"]);
const SUPERSEDED_STATES = new Set(["pending"]);

export class DesignOfferStore {
  constructor(filePath, { exactBuild = CDB_EXACT_BUILD } = {}) {
    if (!filePath) throw new Error("Design offer store path is required.");
    this.filePath = path.resolve(filePath);
    this.exactBuild = exactBuild;
    this.offers = new Map();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (parsed) {
      if (parsed.protocolVersion !== DESIGN_OFFER_PROTOCOL_VERSION) {
        throw codedError("store_identity_mismatch", "旧协议设计提案存储已拒绝；0.9 不读取或迁移旧恢复数据。");
      }
      try {
        validateExactRuntimeIdentity(parsed.runtimeIdentity, this.exactBuild);
      } catch {
        throw codedError("store_identity_mismatch", "设计提案存储不属于当前精确构建，已拒绝恢复。");
      }
    }
    for (const value of parsed?.offers || []) {
      if (!value?.offerId || typeof value !== "object") continue;
      this.offers.set(value.offerId, value);
    }
    this.loaded = true;
    return this;
  }

  async receive(message) {
    await this.load();
    const offer = validateDesignOffer(message, { expectedExactBuild: this.exactBuild });
    const existing = this.offers.get(offer.offerId);
    if (existing) {
      if (offerIdentity(existing) !== offerIdentity(offer)) {
        throw codedError("offer_identity_conflict", "同一 offerId 对应了不同的 Figma 节点。");
      }
      return { offer: { ...existing }, duplicate: true };
    }
    const updatedAt = new Date().toISOString();
    for (const [offerId, current] of this.offers) {
      if (
        offerId !== offer.offerId &&
        SUPERSEDED_STATES.has(current.state) &&
        offerIdentity(current) === offerIdentity(offer)
      ) {
        this.offers.set(offerId, {
          ...current,
          state: "ignored",
          error: "已由同一 Figma 页面较新的提案替换。",
          updatedAt,
        });
      }
    }
    const stored = {
      ...offer,
      state: "pending",
      receivedAt: updatedAt,
      updatedAt,
      target: null,
      result: null,
    };
    this.offers.set(stored.offerId, stored);
    await this.persist();
    return { offer: { ...stored }, duplicate: false };
  }

  async transition(offerId, state, details = {}) {
    await this.load();
    const current = this.offers.get(String(offerId || ""));
    if (!current) throw codedError("offer_not_found", "没有找到这个 Figma 设计提案。");
    if (TERMINAL_STATES.has(current.state) && current.state !== state) {
      throw codedError("offer_already_finished", "这个 Figma 设计提案已经结束。");
    }
    const next = {
      ...current,
      ...details,
      offerId: current.offerId,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.offers.set(next.offerId, next);
    await this.persist();
    return { ...next };
  }

  async receivePayload(message) {
    await this.load();
    const payload = validateDesignPayload(message, { expectedExactBuild: this.exactBuild });
    const current = this.offers.get(payload.offerId);
    if (!current) throw codedError("offer_not_found", "没有找到这个 Figma 设计提案。");
    if (current.sessionId !== payload.sessionId) {
      throw codedError("session_mismatch", "Figma 设计 payload 会话身份无效。");
    }
    if (current.rootNodeId !== payload.figma.rootNodeId) {
      throw codedError("root_identity_conflict", "Figma 页面根节点与原提案不一致。");
    }
    const createsNewProject = current.target?.action === "create_project";
    try {
      payload.pageIr = compactResponsivePageIr(createResponsivePageIrFromFigmaPayload(payload, {
        pageId: createsNewProject
          ? undefined
          : current.target?.pageId || current.linkedPageId || undefined,
        projectKey: createsNewProject ? "" : current.linkedProjectKey,
        figmaFileKey: current.figmaFileKey,
        name: current.rootName,
        exactBuild: this.exactBuild,
      }));
    } catch (error) {
      throw codedError("invalid_page_ir", `Figma 页面无法转换为 Page IR：${error.message}`);
    }
    const actualNodeCount = Object.keys(payload.pageIr.nodes).length;
    if (payload.report.nodeCount !== actualNodeCount) {
      throw codedError(
        "node_report_mismatch",
        `Figma 页面节点统计为 ${payload.report.nodeCount}，实际为 ${actualNodeCount}。`,
      );
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    if (current.payloadHash) {
      if (current.payloadHash !== digest) {
        throw codedError("payload_identity_conflict", "同一 offerId 收到了不同的完整页面数据。");
      }
      return { offer: { ...current }, duplicate: true };
    }
    const storeName = path.basename(this.filePath, path.extname(this.filePath));
    const payloadDirectory = path.join(path.dirname(this.filePath), `${storeName}-payloads`);
    const payloadPath = path.join(payloadDirectory, `${safeName(payload.offerId)}.json`);
    await atomicWriteJson(payloadPath, payload);
    const next = {
      ...current,
      state: "payload_received",
      payloadHash: digest,
      payloadPath,
      payloadSummary: {
        nodeCount: payload.report.nodeCount,
        resourceBytes: payload.report.resourceBytes,
        resourceCount: payload.report.resourceCount,
        degradationCount: payload.report.degradations.length,
        pageIrHash: payload.pageIr.irHash,
        pageId: payload.pageIr.pageId,
      },
      updatedAt: new Date().toISOString(),
    };
    this.offers.set(next.offerId, next);
    await this.persist();
    return { offer: { ...next }, duplicate: false };
  }

  async get(offerId) {
    await this.load();
    const value = this.offers.get(String(offerId || ""));
    return value ? { ...value } : null;
  }

  async list({ includeTerminal = false } = {}) {
    await this.load();
    return [...this.offers.values()]
      .filter((offer) => includeTerminal || !TERMINAL_STATES.has(offer.state))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((offer) => ({ ...offer }));
  }

  persist() {
    const snapshot = {
      protocolVersion: DESIGN_OFFER_PROTOCOL_VERSION,
      runtimeIdentity: currentRuntimeIdentity(this.exactBuild),
      offers: [...this.offers.values()],
    };
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    return this.writeQueue;
  }
}

export function validateDesignOffer(value, { expectedExactBuild = CDB_EXACT_BUILD } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("invalid_offer", "Figma 设计提案必须是对象。");
  }
  if (value.type !== "figma.design.offer") {
    throw codedError("invalid_offer_type", "Figma 设计提案类型无效。");
  }
  if (value.protocolVersion !== DESIGN_OFFER_PROTOCOL_VERSION) {
    throw codedError("version_mismatch", "Figma 设计提案需要协议 16；旧协议不兼容。");
  }
  const runtimeIdentity = requiredRuntimeIdentity(value.runtimeIdentity, expectedExactBuild);
  const offer = {
    type: value.type,
    protocolVersion: value.protocolVersion,
    runtimeIdentity,
    offerId: requiredText(value.offerId, "offerId", 128),
    sessionId: requiredText(value.sessionId, "sessionId", 128),
    figmaFileKey: requiredText(value.figmaFileKey, "figmaFileKey", 256),
    rootNodeId: requiredText(value.rootNodeId, "rootNodeId", 128),
    rootName: requiredText(value.rootName, "rootName", 256),
    rootType: requiredText(value.rootType, "rootType", 32),
    width: positiveNumber(value.width, "width", 100000),
    height: positiveNumber(value.height, "height", 100000),
    responsiveContract: normalizeResponsiveContract(value.responsiveContract, value.width, value.height),
    estimatedNodeCount: positiveInteger(value.estimatedNodeCount, "estimatedNodeCount"),
    linkedProjectKey: optionalText(value.linkedProjectKey, 256),
    linkedPageId: optionalText(value.linkedPageId, 256),
    createdAt: requiredText(value.createdAt, "createdAt", 64),
  };
  if (!DESIGN_OFFER_ROOT_TYPES.has(offer.rootType)) {
    throw codedError("unsupported_root", "请选择 Frame、Component、Instance 或 Group。");
  }
  if (offer.estimatedNodeCount > MAX_EDITABLE_NODES) {
    throw codedError("node_limit_exceeded", `可编辑图层不能超过 ${MAX_EDITABLE_NODES} 个。`);
  }
  if (!Number.isFinite(Date.parse(offer.createdAt))) {
    throw codedError("invalid_created_at", "Figma 设计提案时间无效。");
  }
  return offer;
}

export function validateDesignPayload(value, { expectedExactBuild = CDB_EXACT_BUILD } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("invalid_payload", "Figma 设计 payload 必须是对象。");
  }
  if (value.type !== "figma.design.payload" || value.protocolVersion !== DESIGN_OFFER_PROTOCOL_VERSION) {
    throw codedError("version_mismatch", "Figma 设计 payload 需要协议 16；旧协议不兼容。");
  }
  const runtimeIdentity = requiredRuntimeIdentity(value.runtimeIdentity, expectedExactBuild);
  const payload = {
    type: value.type,
    protocolVersion: value.protocolVersion,
    runtimeIdentity,
    offerId: requiredText(value.offerId, "offerId", 128),
    sessionId: requiredText(value.sessionId, "sessionId", 128),
    figma: value.figma && typeof value.figma === "object" ? { ...value.figma } : null,
    pageSeed: value.pageSeed && typeof value.pageSeed === "object" ? value.pageSeed : null,
    referenceImage: normalizeVisualReference(value.referenceImage, {
      designViewport: value.responsiveContract?.designViewport,
    }),
    report: normalizePayloadReport(value.report),
    responsiveContract: normalizeResponsiveContract(
      value.responsiveContract,
      value.pageSeed?.node?.width,
      value.pageSeed?.node?.height,
    ),
    capturedAt: requiredText(value.capturedAt, "capturedAt", 64),
  };
  if (!payload.figma || !requiredText(payload.figma.rootNodeId, "figma.rootNodeId", 128)) {
    throw codedError("invalid_payload", "Figma 设计 payload 缺少根节点身份。");
  }
  if (!payload.pageSeed?.node || typeof payload.pageSeed.node !== "object") {
    throw codedError("invalid_payload", "Figma 设计 payload 缺少 pageSeed 根节点。");
  }
  const resources = collectPayloadResources(payload.pageSeed.node);
  const resourceBytes = resources.reduce((sum, resource) => sum + resource.bytes, 0);
  if (
    payload.report.resourceBytes !== resourceBytes ||
    payload.report.resourceCount !== resources.length
  ) {
    throw codedError("resource_report_mismatch", "Figma 页面资源统计与实际 payload 不一致。");
  }
  payload.report.resources = resources;
  if (payload.report.nodeCount > MAX_EDITABLE_NODES) {
    throw codedError("node_limit_exceeded", `可编辑图层不能超过 ${MAX_EDITABLE_NODES} 个。`);
  }
  if (payload.report.resourceBytes > MAX_RESOURCE_BYTES) {
    throw codedError("resource_limit_exceeded", "Figma 页面资源总量不能超过 24 MB。");
  }
  if (!Number.isFinite(Date.parse(payload.capturedAt))) {
    throw codedError("invalid_payload", "Figma 设计 payload 采集时间无效。");
  }
  return payload;
}

function collectPayloadResources(root) {
  const resources = [];
  const visit = (node) => {
    for (const field of ["image", "svg"]) {
      const resource = node?.[field];
      if (!resource?.base64 || typeof resource.base64 !== "string") continue;
      let bytes;
      try {
        bytes = Buffer.from(resource.base64, "base64");
      } catch {
        throw codedError("invalid_resource", `Figma 节点 ${node.id || "未知"} 的资源编码无效。`);
      }
      if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/u, "") !== resource.base64.replace(/=+$/u, "")) {
        throw codedError("invalid_resource", `Figma 节点 ${node.id || "未知"} 的资源编码无效。`);
      }
      resources.push({
        nodeId: String(node.id || ""),
        kind: field,
        mimeType: String(resource.mimeType || ""),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    for (const child of node?.children || []) visit(child);
  };
  visit(root);
  return resources;
}

function normalizePayloadReport(value) {
  const report = value && typeof value === "object" ? value : {};
  return {
    nodeCount: positiveInteger(report.nodeCount, "report.nodeCount"),
    resourceBytes: nonNegativeInteger(report.resourceBytes, "report.resourceBytes"),
    resourceCount: nonNegativeInteger(report.resourceCount, "report.resourceCount"),
    degradations: Array.isArray(report.degradations)
      ? report.degradations.slice(0, 500).map((entry) => ({ ...entry }))
      : [],
  };
}

function requiredRuntimeIdentity(value, expectedExactBuild) {
  try {
    return validateExactRuntimeIdentity(value, expectedExactBuild);
  } catch (error) {
    throw codedError("runtime_identity_mismatch", `Figma 数据身份无效：${error.message}`);
  }
}

function normalizeResponsiveContract(value, expectedWidth, expectedHeight) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("responsive_contract_required", "协议 16 必须提供响应式合同，不能从单一截图猜测。");
  }
  const designViewport = value.designViewport;
  if (
    !designViewport ||
    designViewport.width !== expectedWidth ||
    designViewport.height !== expectedHeight
  ) {
    throw codedError("design_viewport_mismatch", "设计 viewport 与 Figma 根节点尺寸不一致。");
  }
  if (!Array.isArray(value.runtimeViewports) || value.runtimeViewports.length === 0) {
    throw codedError("runtime_viewports_required", "协议 16 必须声明至少一个运行 viewport。");
  }
  if (!Array.isArray(value.breakpoints)) {
    throw codedError("breakpoints_required", "协议 16 必须显式声明 breakpoint 列表，允许为空数组。");
  }
  if (!value.previewScale || typeof value.previewScale !== "object") {
    throw codedError("preview_scale_required", "协议 16 必须声明独立的预览 scale。");
  }
  return structuredClone(value);
}

function offerIdentity(value) {
  return [value.figmaFileKey, value.rootNodeId].join("\u0000");
}

function requiredText(value, field, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw codedError("invalid_offer", `Figma 设计提案 ${field} 无效。`);
  }
  return text;
}

function optionalText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLength);
}

function positiveNumber(value, field, max) {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw codedError("invalid_offer", `Figma 设计提案 ${field} 无效。`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw codedError("invalid_offer", `Figma 设计提案 ${field} 无效。`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw codedError("invalid_payload", `Figma 设计 payload ${field} 无效。`);
  }
  return value;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 128);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
