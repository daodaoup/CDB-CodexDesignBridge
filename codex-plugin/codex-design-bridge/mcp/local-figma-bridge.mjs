import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "../vendor/ws/wrapper.mjs";
import { preparePageManifest } from "../shared/page.mjs";
import { DESIGN_OFFER_PROTOCOL_VERSION } from "./design-offer-store.mjs";
import {
  CDB_EXACT_BUILD,
  currentRuntimeIdentity,
  validateExactRuntimeIdentity,
} from "../shared/runtime-contract.mjs";
import { applyFastPageChanges } from "./fast-page-patch.mjs";
import {
  compactResponsivePageIr as compactPageIr,
  createResponsivePageIrFromFigmaPayload as createPageIrFromFigmaPayload,
  createResponsivePageIrFromNodeTree as createPageIrFromNodeTree,
  diffResponsivePageIr as diffPageIr,
  resolveResponsivePageIrConflicts as resolvePageIrConflicts,
} from "../shared/page-ir-responsive-v2.mjs";
import { SyncBaselineStore } from "./sync-baseline-store.mjs";
import { undoLastPatchTransaction } from "./patch-transaction.mjs";

const PROTOCOL_VERSION = DESIGN_OFFER_PROTOCOL_VERSION;
const DEFAULT_PORT = 9847;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const TRUSTED_FIGMA_ORIGINS = new Set([
  "https://www.figma.com",
  "https://figma.com",
  "null",
]);

export class LocalFigmaBridge {
  constructor(
    projectDir,
    {
      host = "127.0.0.1",
      port = DEFAULT_PORT,
      onFastApply = null,
      onImportPages = null,
      onResetWorkspace = null,
      offerStore = null,
      baselineStore = null,
      onCaptureHtmlPage = null,
      onSyncCommitted = null,
      onFastRollback = null,
      onDesignPayload = null,
      onOffersChanged = null,
      runtimeVersion = "",
      projectName = "",
      projectKey = "",
      operationTimeoutMs = Number(
        process.env.CODEX_DESIGN_BRIDGE_FIGMA_OPERATION_TIMEOUT_MS ||
          DEFAULT_OPERATION_TIMEOUT_MS,
      ),
    } = {},
  ) {
    this.projectDir = path.resolve(projectDir);
    this.host = host;
    this.port = port;
    this.onFastApply =
      typeof onFastApply === "function" ? onFastApply : null;
    this.onImportPages =
      typeof onImportPages === "function" ? onImportPages : null;
    this.onResetWorkspace =
      typeof onResetWorkspace === "function" ? onResetWorkspace : null;
    this.offerStore = offerStore;
    this.baselineStore = baselineStore || new SyncBaselineStore(this.projectDir);
    this.onCaptureHtmlPage = typeof onCaptureHtmlPage === "function" ? onCaptureHtmlPage : null;
    this.onSyncCommitted = typeof onSyncCommitted === "function" ? onSyncCommitted : null;
    this.onFastRollback = typeof onFastRollback === "function" ? onFastRollback : null;
    this.onDesignPayload = typeof onDesignPayload === "function" ? onDesignPayload : null;
    this.onOffersChanged =
      typeof onOffersChanged === "function" ? onOffersChanged : null;
    this.runtimeVersion = String(runtimeVersion || "");
    this.projectName = String(projectName || path.basename(this.projectDir));
    this.projectKey = String(projectKey || "");
    this.operationTimeoutMs = Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0
      ? operationTimeoutMs
      : DEFAULT_OPERATION_TIMEOUT_MS;
    this.httpServer = null;
    this.webSocketServer = null;
    this.clients = new Set();
    this.pages = new Map();
    this.pageCatalog = new Map();
    this.pendingImports = new Map();
    this.pendingImportUndo = null;
    this.pendingChangeCapture = null;
    this.token = "";
    this.unsentChanges = false;
    this.lastConnectedAt = "";
    this.lastError = "";
  }

  async start() {
    this.token = randomBytes(24).toString("hex");
    this.httpServer = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        sendJson(response, 500, {
          error: "bridge_error",
          message: error.message,
        });
      });
    });
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      // Binary resources are base64 encoded in protocol 16, so the WebSocket
      // envelope needs headroom above the validated 24 MB decoded limit.
      maxPayload: 34 * 1024 * 1024,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );
      if (
        !isTrustedFigmaOrigin(request.headers.origin) ||
        url.pathname !== "/ws" ||
        url.searchParams.get("token") !== this.token
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (webSocket) =>
      this.handleConnection(webSocket),
    );

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, resolve);
    });
    const address = this.httpServer.address();
    if (typeof address === "object" && address) {
      this.port = address.port;
    }
    return this.status();
  }

  async stop() {
    if (this.pendingImportUndo) {
      const pending = this.pendingImportUndo;
      this.pendingImportUndo = null;
      pending.resolve({
        ok: false,
        code: "figma_disconnected",
        error: "Figma 连接已关闭，撤销请求没有完成。",
      });
    }
    for (const client of this.clients) {
      client.webSocket.terminate();
    }
    this.clients.clear();
    if (this.webSocketServer) {
      await new Promise((resolve) => this.webSocketServer.close(resolve));
      this.webSocketServer = null;
    }
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }
  }

  async endSession() {
    this.broadcast({ type: "session.ended" });
    await new Promise((resolve) => setImmediate(resolve));
    await this.stop();
  }

  status() {
    const figmaPluginVersions = [
      ...new Set(
        this.readyClients()
          .map((client) => client.pluginVersion)
          .filter(Boolean),
      ),
    ];
    return {
      connected: this.readyClients().length > 0,
      pluginClients: this.readyClients().length,
      unsentChanges: this.unsentChanges,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      runtimeVersion: this.runtimeVersion,
      projectName: this.projectName,
      projectKey: this.projectKey,
      figmaPluginVersions,
      wsUrl: `ws://localhost:${this.port}/ws`,
      port: this.port,
      pageStates: this.catalogEntries(),
      designOffers: [],
    };
  }

  setWorkspaceIdentity({ projectName = "", projectKey = "" } = {}) {
    this.projectName = String(projectName || path.basename(this.projectDir));
    this.projectKey = String(projectKey || "");
  }

  setPageCatalog(pages) {
    const previous = this.pageCatalog;
    this.pageCatalog = new Map(
      (Array.isArray(pages) ? pages : []).map((page) => {
        const old = previous.get(page.id) || {};
        const imported = this.pages.get(page.id);
        const sourceChanged =
          imported?.sourceHash && imported.sourceHash !== page.sourceHash;
        return [
          page.id,
          {
            id: page.id,
            name: page.name,
            entry: page.entry || "",
            route: page.route || page.path || "/",
            sourceHash: page.sourceHash || "",
            acceptsFigmaSeed: Boolean(page.acceptsFigmaSeed),
            state: !imported
              ? page.syncState || old.state || "not_imported"
              : sourceChanged
                ? "source_changed"
                : old.state === "figma_changed" || old.state === "conflict"
                  ? old.state
                  : page.syncState || "synced",
            error: page.syncState === "failed" ? old.error || "最近更新失败" : "",
          },
        ];
      }),
    );
    this.broadcastCatalog();
  }

  async pushPage(manifest, { conflictResolution = null } = {}) {
    const clients = this.readyClients();
    if (clients.length === 0) {
      throw new Error(
        "请先在 Figma 中打开本地 CDB 插件，然后再试一次。",
      );
    }
    const prepared = preparePageManifest({
      json: JSON.stringify(manifest),
      sourcePath: manifest.source?.file || "current-preview",
    });
    if (conflictResolution?.direction === "html") {
      prepared.conflictResolution = {
        direction: "html",
        transactionId: String(conflictResolution.transactionId || ""),
        undoSnapshot:
          conflictResolution.undoSnapshot &&
          typeof conflictResolution.undoSnapshot === "object"
            ? structuredClone(conflictResolution.undoSnapshot)
            : null,
      };
    }
    const previousPage = this.pages.get(prepared.pageId);
    this.pages.set(prepared.pageId, prepared);
    const resultPromise = this.waitForImport(prepared.pageId, {
      expectedTransactionId: prepared.conflictResolution?.transactionId || "",
      expectedSourceHash: prepared.sourceHash,
    });
    sendSocket(clients.at(-1).webSocket, { type: "page.upsert", page: prepared });
    const result = await resultPromise;
    if (!result?.ok) {
      if (conflictResolution?.direction === "html") {
        restoreMapValue(this.pages, prepared.pageId, previousPage);
      }
      this.updateCatalogState(prepared.pageId, "failed", result?.error || "导入失败");
      throw new Error(result?.error || "Figma 没有完成页面导入。");
    }
    if (
      conflictResolution?.direction === "html" &&
      result.transactionId !== prepared.conflictResolution.transactionId
    ) {
      restoreMapValue(this.pages, prepared.pageId, previousPage);
      this.updateCatalogState(prepared.pageId, "conflict");
      throw codedError(
        "figma_conflict_transaction_mismatch",
        "Figma 插件没有确认接受 HTML 的撤销事务，请重载当前开发插件后重试。",
      );
    }
    const importedPageIr = attachFigmaNodeMappings(prepared.pageIr, result.nodeMappings);
    const importBaseline = await this.baselineStore.commit({
      pageIr: importedPageIr,
      sourceHash: prepared.sourceHash,
      figma: {
        fileKey: result.fileKey,
        pageId: result.figmaPageId,
        rootNodeId: result.nodeId,
        rootNodeName: prepared.name,
      },
      transactionId: result.transactionId || `page-import:${prepared.pageId}:${prepared.sourceHash}`,
    });
    this.updateCatalogState(prepared.pageId, "synced");
    return {
      ...result,
      nodeCount: prepared.nodeIds.length,
      sourceHash: prepared.sourceHash,
      pageIrHash: importBaseline.pageIrHash,
    };
  }

  focusNode({ pageId, figmaNodeId }) {
    const client = this.readyClients().at(-1);
    if (!client) {
      throw codedError("figma_not_connected", "请先在 Figma 中打开本地 CDB 插件，然后再试一次。");
    }
    const page = this.pageCatalog.get(String(pageId || ""));
    if (!page) {
      throw codedError("figma_page_not_found", "当前项目中没有这个页面。");
    }
    const nodeId = String(figmaNodeId || "").trim();
    if (!/^\d+:\d+$/.test(nodeId)) {
      throw codedError("figma_node_id_invalid", "视觉差异没有可定位的 Figma 节点。");
    }
    sendSocket(client.webSocket, {
      type: "page.node.locate",
      pageId: page.id,
      figmaNodeId: nodeId,
    });
    return { pageId: page.id, figmaNodeId: nodeId };
  }

  async undoHtmlConflictResolution({ pageId, transactionId }) {
    const client = this.readyClients().at(-1);
    if (!client) {
      throw codedError("figma_not_connected", "撤销接受 HTML 需要 Figma 插件保持连接。");
    }
    if (this.pendingImportUndo) {
      throw codedError("figma_undo_busy", "Figma 冲突撤销正在进行，请稍候。");
    }
    const requestId = `page-undo-${Date.now()}-${randomBytes(6).toString("hex")}`;
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImportUndo = null;
        reject(codedError("figma_undo_timeout", "Figma 冲突撤销超时，请确认插件仍然打开。"));
      }, this.operationTimeoutMs);
      this.pendingImportUndo = {
        requestId,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      };
    });
    sendSocket(client.webSocket, {
      type: "page.import.undo",
      requestId,
      pageId: String(pageId || ""),
      transactionId: String(transactionId || ""),
    });
    const result = await resultPromise;
    if (!result?.ok) {
      throw codedError(result?.code || "figma_undo_failed", result?.error || "Figma 未能撤销接受 HTML。");
    }
    this.unsentChanges = true;
    this.pages.delete(pageId);
    this.updateCatalogState(pageId, "conflict");
    return result;
  }

  async captureChanges() {
    if (this.readyClients().length === 0) {
      throw new Error(
        "请先在 Figma 中打开本地 CDB 插件，然后再试一次。",
      );
    }
    if (this.pendingChangeCapture) {
      throw new Error("Figma 修改正在读取中，请稍候。");
    }
    const requestId = `changes-${Date.now()}`;
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChangeCapture = null;
        reject(new Error("读取 Figma 修改超时，请确认本地插件仍然打开。"));
      }, this.operationTimeoutMs);
      this.pendingChangeCapture = {
        requestId,
        results: [],
        expectedCount: null,
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingChangeCapture = null;
          resolve(value);
        },
      };
    });
    this.broadcast({ type: "page.changes.request", requestId });
    return resultPromise;
  }

  async acceptDesignOffer(offerId, target) {
    if (!this.offerStore) throw codedError("offer_inbox_unavailable", "设计提案收件箱不可用。");
    const offer = await this.offerStore.get(offerId);
    if (!offer) throw codedError("offer_not_found", "没有找到这个 Figma 设计提案。");
    const client = this.allReadyClients().find(
      (candidate) => candidate.protocolVersion === PROTOCOL_VERSION && candidate.sessionId === offer.sessionId,
    );
    if (!client) throw codedError("figma_disconnected", "请重新打开 Figma CDB 插件后再接收这个提案。");
    const accepted = await this.offerStore.transition(offerId, "accepted", { target });
    sendSocket(client.webSocket, {
      type: "figma.design.accept",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: offer.sessionId,
      offerId,
      rootNodeId: offer.rootNodeId,
      estimatedNodeCount: offer.estimatedNodeCount,
      target,
    });
    await this.notifyOffersChanged();
    return accepted;
  }

  handleConnection(webSocket) {
    const client = {
      webSocket,
      ready: false,
      pluginVersion: "",
      protocolVersion: 0,
      sessionId: "",
      projectKey: "",
      messageQueue: Promise.resolve(),
    };
    this.clients.add(client);
    webSocket.on("message", (raw) => {
      client.messageQueue = client.messageQueue
        .then(() => this.handleMessage(client, raw))
        .catch((error) => {
          console.error(`[CDB Figma Bridge] ${error?.stack || error}`);
          sendSocket(webSocket, {
            type: "bridge.error",
            code: error?.code || "bridge_error",
            error: error.message,
          });
        });
    });
    webSocket.on("close", () => this.clients.delete(client));
    webSocket.on("error", () => this.clients.delete(client));
  }

  async handleMessage(client, raw) {
    const message = JSON.parse(String(raw));
    if (message.type === "plugin.hello") {
      const shouldReplayPages = !client.ready;
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.lastError = "version_mismatch";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "version_mismatch",
          error: "Figma 插件版本与当前设计工作台不匹配，请更新后重新打开插件。",
        });
        return;
      }
      const pluginVersion = String(message.pluginVersion || "");
      const expectedVersion = formalVersion(this.runtimeVersion);
      if (
        expectedVersion &&
        pluginVersion !== expectedVersion
      ) {
        this.lastError = "version_mismatch";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "version_mismatch",
          error: `Figma 插件版本 ${pluginVersion || "未知"} 与当前 CDB ${expectedVersion} 不匹配，请更新后重新打开插件。`,
        });
        return;
      }
      try {
        validateExactRuntimeIdentity(message.runtimeIdentity, this.runtimeVersion || CDB_EXACT_BUILD);
      } catch {
        this.lastError = "runtime_identity_mismatch";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "runtime_identity_mismatch",
          error: "Figma 插件不属于当前精确 0.9 构建；旧缓存不会被兼容或恢复。",
        });
        return;
      }
      client.ready = true;
      client.protocolVersion = message.protocolVersion;
      client.sessionId = String(message.sessionId || "");
      if (!client.sessionId) {
        client.ready = false;
        this.lastError = "session_required";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "session_required",
          error: "协议 16 的 Figma 插件必须提供会话身份。",
        });
        return;
      }
      client.pluginVersion = pluginVersion;
      client.projectKey = String(message.projectKey || "");
      for (const other of [...this.clients].filter((candidate) => candidate.ready)) {
        if (
          other !== client &&
          ((client.sessionId && other.sessionId === client.sessionId) ||
            (client.projectKey && other.projectKey === client.projectKey))
        ) {
          sendSocket(other.webSocket, {
            type: "session.replaced",
            reason: "newer_connection",
          });
          other.webSocket.close(1000, "newer_connection");
        }
      }
      this.unsentChanges = Boolean(message.unsentChanges);
      for (const pageId of message.changedPageIds || []) {
        const current = this.pageCatalog.get(pageId);
        this.updateCatalogState(
          pageId,
          current?.state === "source_changed" ? "conflict" : "figma_changed",
        );
      }
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = "";
      sendSocket(client.webSocket, {
        type: "plugin.ready",
        protocolVersion: PROTOCOL_VERSION,
        runtimeIdentity: currentRuntimeIdentity(this.runtimeVersion || CDB_EXACT_BUILD),
        runtimeVersion: this.runtimeVersion,
        figmaPluginVersion: client.pluginVersion,
        assets: 0,
        pages: this.pageCatalog.size,
        projectName: this.projectName,
        projectKey: this.projectKey,
        localWorkspace: true,
      });
      if (this.offerStore) {
        const offers = (await this.offerStore.list({ includeTerminal: true }))
          .filter((offer) => offer.sessionId === client.sessionId)
          .slice(0, 20);
        sendSocket(client.webSocket, {
          type: "figma.design.inbox",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: client.sessionId,
          offers,
        });
      }
      if (shouldReplayPages) {
        for (const page of this.pages.values()) {
          sendSocket(client.webSocket, { type: "page.upsert", page });
        }
      }
      sendSocket(client.webSocket, {
        type: "page.catalog",
        pages: this.catalogEntries(),
      });
      return;
    }
    if (message.type === "figma.design.offer") {
      this.requireProtocol16Session(client, message);
      if (!this.offerStore) {
        throw codedError("offer_inbox_unavailable", "当前 CDB 工作台没有启用设计提案收件箱。");
      }
      try {
        const received = await this.offerStore.receive(message);
        sendSocket(client.webSocket, {
          type: "figma.design.offer.ack",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: client.sessionId,
          offerId: received.offer.offerId,
          state: received.offer.state,
          duplicate: received.duplicate,
          projectName: this.projectName,
          projectKey: this.projectKey,
        });
        await this.notifyOffersChanged();
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "figma.design.offer.ack",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: client.sessionId,
          offerId: String(message.offerId || ""),
          state: "rejected",
          code: error.code || "invalid_offer",
          error: error.message,
        });
      }
      return;
    }
    if (message.type === "figma.design.cancel") {
      this.requireProtocol16Session(client, message);
      if (!this.offerStore) throw codedError("offer_inbox_unavailable", "设计提案收件箱不可用。");
      const offer = await this.offerStore.get(message.offerId);
      if (!offer || offer.sessionId !== client.sessionId) {
        throw codedError("offer_not_found", "没有找到当前会话的设计提案。");
      }
      const cancelled = await this.offerStore.transition(message.offerId, "cancelled", {
        error: "",
      });
      sendSocket(client.webSocket, {
        type: "figma.design.result",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: client.sessionId,
        offerId: cancelled.offerId,
        state: cancelled.state,
      });
      await this.notifyOffersChanged();
      return;
    }
    if (message.type === "figma.design.progress") {
      this.requireProtocol16Session(client, message);
      const offer = await this.offerStore?.get(message.offerId);
      if (!offer || offer.sessionId !== client.sessionId) {
        throw codedError("offer_not_found", "没有找到当前会话的设计提案。");
      }
      await this.offerStore.transition(message.offerId, "collecting", {
        progress: {
          phase: String(message.phase || "collecting"),
          completed: Number(message.completed || 0),
          total: Number(message.total || 0),
          message: String(message.message || ""),
        },
      });
      await this.notifyOffersChanged();
      return;
    }
    if (message.type === "figma.design.payload") {
      this.requireProtocol16Session(client, message);
      try {
        const received = await this.offerStore.receivePayload(message);
        let offer = received.offer;
        if (this.onDesignPayload && offer.state !== "completed") {
          const result = await this.onDesignPayload(offer);
          offer = await this.offerStore.transition(message.offerId, "completed", {
            result,
            error: "",
          });
        }
        sendSocket(client.webSocket, {
          type: "figma.design.result",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: client.sessionId,
          offerId: message.offerId,
          state: offer.state,
          duplicate: received.duplicate,
          result: offer.result || offer.payloadSummary,
        });
        await this.notifyOffersChanged();
      } catch (error) {
        await this.offerStore.transition(message.offerId, "failed", {
          error: error.message,
        }).catch(() => {});
        sendSocket(client.webSocket, {
          type: "figma.design.result",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: client.sessionId,
          offerId: String(message.offerId || ""),
          state: "failed",
          code: error.code || "invalid_payload",
          error: error.message,
        });
        await this.notifyOffersChanged();
      }
      return;
    }
    if (message.type === "figma.design.result.query") {
      this.requireProtocol16Session(client, message);
      const offer = await this.offerStore?.get(message.offerId);
      if (!offer || offer.sessionId !== client.sessionId) {
        throw codedError("offer_not_found", "没有找到当前会话的设计提案。");
      }
      sendSocket(client.webSocket, {
        type: "figma.design.result",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: client.sessionId,
        offerId: offer.offerId,
        state: offer.state,
        result: offer.result || null,
      });
      return;
    }
    if (message.type === "page.changes.status") {
      this.unsentChanges = Boolean(message.unsentChanges);
      for (const pageId of message.changedPageIds || []) {
        const current = this.pageCatalog.get(pageId);
        this.updateCatalogState(
          pageId,
          current?.state === "source_changed" ? "conflict" : "figma_changed",
        );
      }
      return;
    }
    if (message.type === "workspace.reset.request") {
      if (!this.onResetWorkspace) {
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: false,
          error: "当前工作台不支持从 Figma 重置。",
        });
        return;
      }
      try {
        await this.onResetWorkspace();
        for (const pendingImport of this.pendingImports.values()) {
          pendingImport.resolve({ ok: false, error: "Figma 页面关联已清空。" });
        }
        this.pendingImports.clear();
        this.pendingChangeCapture?.resolve({
          empty: true,
          changeCount: 0,
          snapshotPath: "",
          relativePath: "",
        });
        this.pendingChangeCapture = null;
        this.pages.clear();
        this.pageCatalog.clear();
        this.unsentChanges = false;
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: true,
        });
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "page.import.request") {
      const requested = [...new Set(message.pageIds || [])].filter((pageId) =>
        this.pageCatalog.has(pageId),
      );
      if (!this.onImportPages || requested.length === 0) {
        sendSocket(client.webSocket, {
          type: "page.import.request.result",
          ok: false,
          error: "没有可导入的 CDB 页面。",
        });
        return;
      }
      Promise.resolve(this.onImportPages(requested))
        .then(() => {
          sendSocket(client.webSocket, {
            type: "page.import.request.result",
            ok: true,
            pageIds: requested,
          });
        })
        .catch((error) => {
          for (const pageId of requested) {
            this.updateCatalogState(pageId, "failed", error.message);
          }
          sendSocket(client.webSocket, {
            type: "page.import.request.result",
            ok: false,
            error: error.message,
          });
        });
      return;
    }
    if (message.type === "page.import.result") {
      const result = message.result || {};
      const pending = this.pendingImports.get(result.pageId);
      if (pending) {
        if (
          pending.expectedSourceHash &&
          result.sourceHash &&
          result.sourceHash !== pending.expectedSourceHash
        ) {
          return;
        }
        this.pendingImports.delete(result.pageId);
        pending.resolve(result);
      }
      return;
    }
    if (message.type === "page.import.undo.result") {
      const pending = this.pendingImportUndo;
      if (!pending || pending.requestId !== message.requestId) return;
      this.pendingImportUndo = null;
      pending.resolve(message);
      return;
    }
    if (message.type === "page.changes.record") {
      const stored = await storeChangeSet(this.projectDir, message.changeSet);
      let fastApply;
      let syncContext = null;
      try {
        syncContext = await this.prepareThreeWaySync(message.changeSet, {
          changeSetPath: stored.relativePath,
        });
        if (syncContext?.merge.conflicts.length > 0) {
          fastApply = syncConflictResult(
            message.changeSet?.changes || [],
            syncContext.merge.conflicts,
            syncContext.conflictRecord?.filePath || "",
          );
        } else {
          const catalogPage = this.pageCatalog.get(message.changeSet?.pageId);
          fastApply = await applyFastPageChanges({
            projectDir: this.projectDir,
            changeSet: message.changeSet,
            manifest:
              this.pages.get(message.changeSet?.pageId) ||
              (catalogPage ? { ...catalogPage, pageId: catalogPage.id } : null),
          });
        }
      } catch (error) {
        const changes = Array.isArray(message.changeSet?.changes)
          ? message.changeSet.changes
          : [];
        fastApply = {
          appliedCount: 0,
          pendingCount: changes.length,
          changedFiles: [],
          durationMs: 0,
          pending: changes.map((change) => ({
            nodeId: change?.nodeId || null,
            property: change?.property || null,
            reason: "fast_apply_failed",
          })),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.updateCatalogState(
        message.changeSet?.pageId,
        fastApply.pendingCount > 0 ? "conflict" : "synced",
      );
      const captured = {
        empty: false,
        changeCount:
          (message.changeSet?.changes?.length || 0) +
          (message.changeSet?.annotations?.length || 0),
        snapshotPath: stored.absolutePath,
        relativePath: stored.relativePath,
        figma: message.changeSet?.figma || null,
        changeSet: message.changeSet || null,
        fastApply,
      };
      let synchronized = null;
      if (this.onFastApply) {
        try {
          synchronized = await this.onFastApply({
            ...captured,
            pageId: message.changeSet?.pageId || null,
          });
        } catch {
          // The change snapshot and source patch are already durable.
        }
      }
      if (synchronized?.fastApply) {
        fastApply = synchronized.fastApply;
        captured.fastApply = fastApply;
      }
      if (fastApply.pendingCount === 0) {
        const seedChange = (message.changeSet?.changes || []).find(
          (change) => change?.property === "pageSeed" && change?.to?.node,
        );
        if (seedChange) {
          try {
            const pageId = message.changeSet?.pageId;
            const pageIr = createPageIrFromNodeTree({
              pageId,
              projectKey: this.projectKey,
              name: seedChange.to.node.name || this.pageCatalog.get(pageId)?.name || pageId,
              root: seedChange.to.node,
              origin: {
                kind: "figma",
                figmaFileKey: message.changeSet?.figma?.fileKey || "",
                rootNodeId: message.changeSet?.figma?.rootNodeId || "",
                rootNodeName: seedChange.to.node.name || "",
              },
              degradations: seedChange.to.report?.degradations || [],
              responsiveContract: message.changeSet?.responsiveContract,
            });
            const nextSourceHash = synchronized?.sourceHash || message.changeSet?.sourceHash || "";
            const committed = await this.baselineStore.commit({
              pageIr,
              sourceHash: isSha256(nextSourceHash) ? nextSourceHash : "",
              figma: message.changeSet?.figma,
              transactionId: fastApply.transactionId || message.changeSet?.changeSetId || "",
            });
            synchronized = { ...(synchronized || {}), sourceHash: nextSourceHash, fastApply };
            if (this.onSyncCommitted) {
              await this.onSyncCommitted({
                pageId,
                sourceHash: committed.sourceHash,
                pageIrHash: committed.pageIrHash,
                transactionId: fastApply.transactionId || message.changeSet?.changeSetId || "",
              });
            }
          } catch (error) {
            fastApply = baselineFailure(fastApply, seedChange, error);
            captured.fastApply = fastApply;
          }
        }
      }
      if (fastApply.pendingCount === 0 && syncContext) {
        try {
          const postHtml = await this.captureHtmlPageIr(message.changeSet?.pageId);
          const mismatches = diffPageIr(syncContext.merge.merged, postHtml.pageIr)
            .filter((change) => !["figma", "system"].includes(change.owner));
          if (mismatches.length > 0) {
            throw Object.assign(new Error(`目标端回读仍有 ${mismatches.length} 个 Page IR 差异。`), {
              code: "page_ir_readback_mismatch",
              mismatches,
            });
          }
          await this.baselineStore.commit({
            pageIr: syncContext.merge.merged,
            sourceHash: postHtml.sourceHash,
            figma: message.changeSet?.figma,
            transactionId: fastApply.transactionId || message.changeSet?.changeSetId || "",
          });
          synchronized = { ...(synchronized || {}), sourceHash: postHtml.sourceHash, fastApply };
          if (this.onSyncCommitted) {
            await this.onSyncCommitted({
              pageId: message.changeSet?.pageId,
              sourceHash: postHtml.sourceHash,
              pageIrHash: syncContext.merge.merged.irHash,
              transactionId: fastApply.transactionId || "",
            });
          }
        } catch (error) {
          fastApply = baselineFailure(fastApply, null, error);
          captured.fastApply = fastApply;
        }
      }
      this.updateCatalogState(
        message.changeSet?.pageId,
        fastApply.pendingCount > 0 ? "conflict" : "synced",
      );
      sendSocket(client.webSocket, {
        type: "page.changes.ack",
        requestId: message.requestId || null,
        changeSetId: message.changeSet?.changeSetId || null,
        pageId: message.changeSet?.pageId || null,
        sourceHash:
          synchronized?.sourceHash || message.changeSet?.sourceHash || null,
        state:
          fastApply.pendingCount === 0
            ? "applied"
            : fastApply.appliedCount > 0
              ? "partial"
              : "pending",
        path: stored.relativePath,
        changeCount: captured.changeCount,
        fastApply,
      });
      this.recordCapturedChange(message.requestId, captured);
      this.unsentChanges = false;
      return;
    }
    if (message.type === "page.changes.complete") {
      this.completeChangeCapture(message.requestId, message.count);
      this.unsentChanges = false;
      return;
    }
    if (message.type === "page.changes.empty") {
      this.pendingChangeCapture?.resolve({
        empty: true,
        changeCount: 0,
        snapshotPath: "",
        relativePath: "",
      });
      this.unsentChanges = false;
      return;
    }
    if (message.type === "ping") {
      sendSocket(client.webSocket, { type: "pong" });
    }
  }

  async handleHttp(request, response) {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (request.method === "OPTIONS") {
      if (!isTrustedFigmaOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        ...this.status(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/pair") {
      if (!isTrustedFigmaOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      sendJson(
        response,
        200,
        {
          ok: true,
          token: this.token,
          wsUrl: `ws://localhost:${this.port}/ws`,
          protocolVersion: PROTOCOL_VERSION,
          runtimeIdentity: currentRuntimeIdentity(this.runtimeVersion || CDB_EXACT_BUILD),
          projectName: this.projectName,
          projectKey: this.projectKey,
        },
        corsHeaders(request),
      );
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  waitForImport(pageId, {
    expectedTransactionId = "",
    expectedSourceHash = "",
  } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(pageId);
        reject(new Error("Figma 页面导入超时，请确认本地插件仍然打开。"));
      }, this.operationTimeoutMs);
      this.pendingImports.set(pageId, {
        expectedTransactionId,
        expectedSourceHash,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  recordCapturedChange(requestId, captured) {
    const pending = this.pendingChangeCapture;
    if (!pending || pending.requestId !== requestId) return;
    pending.results.push(captured);
    this.finishChangeCaptureIfReady();
  }

  completeChangeCapture(requestId, count) {
    const pending = this.pendingChangeCapture;
    if (!pending || pending.requestId !== requestId) return;
    pending.expectedCount = Number.isInteger(count) ? Math.max(0, count) : 0;
    this.finishChangeCaptureIfReady();
  }

  finishChangeCaptureIfReady() {
    const pending = this.pendingChangeCapture;
    if (
      !pending ||
      pending.expectedCount === null ||
      pending.results.length < pending.expectedCount
    ) {
      return;
    }
    if (pending.results.length === 0) {
      pending.resolve({
        empty: true,
        changeCount: 0,
        snapshotPath: "",
        snapshotPaths: [],
        relativePath: "",
      });
      return;
    }
    const fastApplies = pending.results
      .map((result) => result.fastApply)
      .filter(Boolean);
    const changedFiles = [
      ...new Set(fastApplies.flatMap((result) => result.changedFiles || [])),
    ];
    pending.resolve({
      empty: false,
      changeCount: pending.results.reduce(
        (sum, result) => sum + (result.changeCount || 0),
        0,
      ),
      snapshotPath: pending.results.at(-1).snapshotPath,
      snapshotPaths: pending.results.map((result) => result.snapshotPath),
      relativePath: pending.results.at(-1).relativePath,
      figma: pending.results.at(-1).figma || null,
      pages: pending.results.length,
      fastApply: {
        appliedCount: fastApplies.reduce(
          (sum, result) => sum + (result.appliedCount || 0),
          0,
        ),
        pendingCount: fastApplies.reduce(
          (sum, result) => sum + (result.pendingCount || 0),
          0,
        ),
        changedFiles,
        durationMs: fastApplies.reduce(
          (sum, result) => sum + (result.durationMs || 0),
          0,
        ),
        pending: fastApplies.flatMap((result) => result.pending || []),
        transactionId:
          fastApplies.map((result) => result.transactionId).filter(Boolean).at(-1) || "",
        undoAvailable: fastApplies.some((result) => result.undoAvailable),
      },
    });
  }

  async captureHtmlPageIr(pageId) {
    if (!this.onCaptureHtmlPage) {
      throw codedError("html_snapshot_unavailable", "当前工作台无法采集 HTML Page IR。 ");
    }
    const manifest = await this.onCaptureHtmlPage(pageId);
    if (manifest?.pageIr && manifest?.sourceHash) return manifest;
    const prepared = preparePageManifest({
      json: JSON.stringify(manifest),
      sourcePath: manifest?.source?.file || "current-preview",
    });
    return {
      ...prepared,
      pageIr: manifest?.pageIr || prepared.pageIr,
    };
  }

  async prepareThreeWaySync(changeSet, { changeSetPath = "" } = {}) {
    if (!changeSet?.pageSnapshot || !this.onCaptureHtmlPage) return null;
    const baseline = await this.baselineStore.get(changeSet.pageId);
    if (!baseline) return null;
    const html = await this.captureHtmlPageIr(changeSet.pageId);
    const htmlPageIr = carryFigmaOwnedBaselineFields(html.pageIr, baseline.pageIr);
    const snapshot = structuredClone(changeSet.pageSnapshot);
    carryBaselineResources(snapshot.pageSeed?.node, baseline.pageIr, changeSet.changes);
    carryHtmlOwnedBaselineFields(snapshot.pageSeed?.node, baseline.pageIr);
    const figmaResponsiveContract = {
      ...snapshot.responsiveContract,
      runtimeViewports: structuredClone(baseline.pageIr.runtimeViewports),
      breakpoints: structuredClone(baseline.pageIr.breakpoints),
      previewScale: structuredClone(baseline.pageIr.previewScale),
    };
    const capturedFigmaPageIr = createPageIrFromFigmaPayload({
      protocolVersion: PROTOCOL_VERSION,
      runtimeIdentity: currentRuntimeIdentity(this.runtimeVersion),
      pageSeed: snapshot.pageSeed,
      report: snapshot.report,
      figma: changeSet.figma,
      responsiveContract: figmaResponsiveContract,
    }, {
      pageId: changeSet.pageId,
      projectKey: this.projectKey,
      figmaFileKey: changeSet.figma?.fileKey || baseline.figma.fileKey,
      name: baseline.pageIr.name,
    });
    const figmaPageIr = carryMissingFigmaNodeIdentity(
      capturedFigmaPageIr,
      baseline.pageIr,
      changeSet.figma?.rootNodeId,
    );
    const merge = await this.baselineStore.merge({
      pageId: changeSet.pageId,
      htmlPageIr,
      figmaPageIr,
    });
    let conflictRecord = null;
    if (merge.conflicts.length > 0) {
      conflictRecord = await this.baselineStore.recordConflicts({
        changeSetId: changeSet.changeSetId,
        changeSetPath,
        pageId: changeSet.pageId,
        baseline,
        htmlPageIr,
        figmaPageIr,
        conflicts: merge.conflicts,
      });
    }
    return {
      baseline,
      html: { ...html, pageIr: htmlPageIr },
      figmaPageIr,
      merge,
      conflictRecord,
    };
  }

  async resolveThreeWaySync(changeSet, resolution) {
    if (resolution !== "figma") {
      throw codedError("unsupported_resolution", "Bridge 源码事务只接受 Figma 方向的显式解决。");
    }
    const context = await this.prepareThreeWaySync(changeSet);
    if (!context || context.merge.conflicts.length === 0) {
      throw codedError("conflict_not_found", "当前页面没有可解决的 Page IR 冲突。");
    }
    const resolved = resolvePageIrConflicts({
      baseline: context.baseline.pageIr,
      html: context.html.pageIr,
      figma: context.figmaPageIr,
      resolution,
    });
    const catalogPage = this.pageCatalog.get(changeSet.pageId);
    const mappedPage =
      this.pages.get(changeSet.pageId) ||
      (catalogPage ? { ...catalogPage, pageId: catalogPage.id } : null);
    let fastApply = await applyFastPageChanges({
      projectDir: this.projectDir,
      changeSet,
      manifest: mappedPage
        ? { ...mappedPage, sourceHash: changeSet.sourceHash }
        : null,
    });
    if (this.onFastApply) {
      const synchronized = await this.onFastApply({
        pageId: changeSet.pageId,
        changeSet,
        changeCount: changeSet.changes?.length || 0,
        fastApply,
        snapshotPath: "",
      });
      if (synchronized?.fastApply) fastApply = synchronized.fastApply;
    }
    if (fastApply.pendingCount > 0) {
      const reasons = [...new Set(
        (fastApply.pending || []).map((item) => item?.reason).filter(Boolean),
      )];
      throw Object.assign(new Error(
        `接受 Figma 后仍有未能安全写入的修改${
          reasons.length > 0 ? `：${reasons.join("、")}` : ""
        }。`,
      ), {
        code: "conflict_resolution_pending",
        fastApply,
      });
    }
    const postHtml = await this.captureHtmlPageIr(changeSet.pageId);
    const mismatches = diffPageIr(resolved.merged, postHtml.pageIr)
      .filter((change) => !["figma", "system"].includes(change.owner));
    if (mismatches.length > 0) {
      throw Object.assign(new Error(`接受 Figma 后回读仍有 ${mismatches.length} 个 Page IR 差异。`), {
        code: "page_ir_readback_mismatch",
        mismatches,
      });
    }
    const baseline = await this.baselineStore.commit({
      pageIr: resolved.merged,
      sourceHash: postHtml.sourceHash,
      figma: changeSet.figma,
      transactionId: fastApply.transactionId || changeSet.changeSetId,
    });
    if (this.onSyncCommitted) {
      await this.onSyncCommitted({
        pageId: changeSet.pageId,
        sourceHash: postHtml.sourceHash,
        pageIrHash: baseline.pageIrHash,
        transactionId: fastApply.transactionId || "",
      });
    }
    this.updateCatalogState(changeSet.pageId, "synced");
    return { resolution, resolved, fastApply, baseline };
  }

  async applyDesignPayloadToLinkedPage({ offer, payload, pageId }) {
    const targetPageId = String(pageId || offer?.linkedPageId || "");
    const catalogPage = this.pageCatalog.get(targetPageId);
    if (!targetPageId || !catalogPage) {
      throw codedError("linked_page_not_found", "Figma 提案关联的本地页面不存在。");
    }
    const baseline = await this.baselineStore.get(targetPageId);
    if (!baseline) {
      throw codedError("baseline_not_found", "关联页面还没有共同同步基线，不能执行完整快照更新。");
    }
    if (
      baseline.figma.fileKey !== offer.figmaFileKey ||
      baseline.figma.rootNodeId !== offer.rootNodeId
    ) {
      throw codedError("figma_root_identity_conflict", "Figma 提案根节点与关联页面基线不一致。");
    }
    const html = await this.captureHtmlPageIr(targetPageId);
    const htmlChanges = diffPageIr(baseline.pageIr, html.pageIr)
      .filter((change) => !["figma", "system"].includes(change.owner));
    if (htmlChanges.length > 0) {
      const first = htmlChanges[0];
      throw Object.assign(
        codedError(
          "linked_page_source_changed",
          `本地 HTML 已在共同基线后发生变化（${first.pointer} · ${first.owner}），请先同步或解决冲突。`,
        ),
        { changes: htmlChanges },
      );
    }
    const changeSet = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeIdentity: payload.runtimeIdentity,
      changeSetId: `offer:${offer.offerId}`,
      pageId: targetPageId,
      sourceHash: catalogPage.sourceHash,
      figma: {
        fileKey: offer.figmaFileKey,
        pageId: payload.figma?.pageId || "",
        rootNodeId: offer.rootNodeId,
        rootNodeName: offer.rootName,
      },
      pageSnapshot: {
        pageSeed: payload.pageSeed,
        report: payload.report,
        responsiveContract: payload.responsiveContract,
        referenceImage: payload.referenceImage,
      },
      responsiveContract: payload.responsiveContract,
      changes: [{
        nodeId: baseline.pageIr.rootId,
        nodeType: "FRAME",
        category: "structure",
        property: "pageSeed",
        sourceRef: {
          file: catalogPage.entry || "",
          selector: baseline.pageIr.nodes[baseline.pageIr.rootId]?.sourceRef?.selector || "[data-codex-root]",
        },
        to: {
          node: payload.pageSeed.node,
          report: payload.report,
        },
      }],
      annotations: [],
    };
    const context = await this.prepareThreeWaySync(changeSet);
    if (!context) {
      throw codedError("page_snapshot_unavailable", "无法为关联页面建立三方快照。");
    }
    if (context.merge.conflicts.length > 0) {
      const first = context.merge.conflicts[0];
      throw Object.assign(
        codedError(
          "page_sync_conflict",
          `关联页面存在 ${context.merge.conflicts.length} 个 Page IR 冲突（${first.pointer} · ${first.reason}）。`,
        ),
        {
          conflicts: context.merge.conflicts,
          conflictPath: context.conflictRecord?.filePath || "",
        },
      );
    }
    let fastApply = await applyFastPageChanges({
      projectDir: this.projectDir,
      changeSet,
      manifest: { ...catalogPage, pageId: targetPageId },
    });
    let synchronized = null;
    if (this.onFastApply) {
      synchronized = await this.onFastApply({
        pageId: targetPageId,
        changeSet,
        changeCount: 1,
        fastApply,
        snapshotPath: offer.payloadPath || "",
      });
      if (synchronized?.fastApply) fastApply = synchronized.fastApply;
    }
    if (fastApply.pendingCount > 0) {
      const reason = fastApply.pending?.[0]?.reason || fastApply.error || "unknown";
      throw Object.assign(codedError("linked_page_update_pending", `完整 Figma 快照未能安全写入关联页面（${reason}）。`), {
        fastApply,
      });
    }
    let postHtml;
    try {
      postHtml = await this.captureHtmlPageIr(targetPageId);
    } catch (error) {
      const readbackError = Object.assign(
        codedError(
          "page_ir_readback_failed",
          `关联页面写后回读失败：${error instanceof Error ? error.message : String(error)}`,
        ),
        { cause: error, fastApply },
      );
      throw await this.rollbackLinkedPageWrite(
        readbackError,
        fastApply,
        targetPageId,
      );
    }
    const mismatches = diffPageIr(context.figmaPageIr, postHtml.pageIr)
      .filter((change) => !["figma", "system"].includes(change.owner));
    if (mismatches.length > 0) {
      const first = mismatches[0];
      const mismatchError = Object.assign(
        codedError(
          "page_ir_readback_mismatch",
          `关联页面回读仍有 ${mismatches.length} 个 Page IR 差异（${first.pointer} · ${first.owner}）。`,
        ),
        { mismatches, fastApply },
      );
      throw await this.rollbackLinkedPageWrite(
        mismatchError,
        fastApply,
        targetPageId,
      );
    }
    const nextSourceHash = synchronized?.sourceHash || postHtml.sourceHash;
    const committed = await this.baselineStore.commit({
      pageIr: context.figmaPageIr,
      sourceHash: nextSourceHash,
      figma: changeSet.figma,
      transactionId: fastApply.transactionId || changeSet.changeSetId,
    });
    this.updateCatalogState(targetPageId, "synced");
    if (this.onSyncCommitted) {
      await this.onSyncCommitted({
        pageId: targetPageId,
        sourceHash: nextSourceHash,
        pageIrHash: committed.pageIrHash,
        transactionId: fastApply.transactionId || "",
      });
    }
    return {
      action: "update_page",
      projectDir: this.projectDir,
      projectKey: this.projectKey,
      pageId: targetPageId,
      sourceHash: nextSourceHash,
      pageIrHash: committed.pageIrHash,
      rootNodeId: changeSet.figma.rootNodeId,
      rootNodeName: changeSet.figma.rootNodeName,
      nodeMappings: committed.nodeMappings,
      transactionId: fastApply.transactionId || "",
      changedFiles: fastApply.changedFiles || [],
      preflightStatus: "pass",
    };
  }

  async rollbackLinkedPageWrite(error, fastApply, pageId) {
    if (!fastApply.transactionId) return error;
    try {
      const rollback = await undoLastPatchTransaction(this.projectDir, {
        expectedTransactionId: fastApply.transactionId,
      });
      error.rollback = rollback;
      if (this.onFastRollback) {
        await this.onFastRollback({
          pageId,
          rollback,
          reason: error.code,
        });
      }
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
      error.message += ` 自动回滚失败：${rollbackError.message}`;
    }
    return error;
  }

  readyClients() {
    const ready = this.allReadyClients();
    const matching = ready.filter(
      (client) => client.projectKey && client.projectKey === this.projectKey,
    );
    const candidates = matching.length > 0 ? matching : ready;
    return candidates.length > 0 ? [candidates.at(-1)] : [];
  }

  allReadyClients() {
    return [...this.clients].filter((client) => client.ready);
  }

  broadcast(message) {
    for (const client of this.readyClients()) {
      sendSocket(client.webSocket, message);
    }
  }

  catalogEntries() {
    return [...this.pageCatalog.values()].map((page) => ({ ...page }));
  }

  updateCatalogState(pageId, state, error = "") {
    if (!pageId || !this.pageCatalog.has(pageId)) return;
    this.pageCatalog.set(pageId, {
      ...this.pageCatalog.get(pageId),
      state,
      error,
    });
    this.broadcastCatalog();
  }

  broadcastCatalog() {
    this.broadcast({ type: "page.catalog", pages: this.catalogEntries() });
  }

  requireProtocol16Session(client, message) {
    if (
      client.protocolVersion !== PROTOCOL_VERSION ||
      message.protocolVersion !== PROTOCOL_VERSION
    ) {
      throw codedError("version_mismatch", "这个操作需要 CDB 协议 16；旧协议不兼容。");
    }
    try {
      validateExactRuntimeIdentity(message.runtimeIdentity, this.runtimeVersion || CDB_EXACT_BUILD);
    } catch {
      throw codedError("runtime_identity_mismatch", "这个操作不属于当前精确 0.9 构建。");
    }
    if (!client.sessionId || message.sessionId !== client.sessionId) {
      throw codedError("session_mismatch", "Figma 设计提案会话身份无效，请重新连接。");
    }
  }

  async notifyOffersChanged() {
    const offers = this.offerStore ? await this.offerStore.list() : [];
    if (this.onOffersChanged) await this.onOffersChanged(offers);
    for (const client of this.readyClients()) {
      if (client.protocolVersion !== PROTOCOL_VERSION) continue;
      sendSocket(client.webSocket, {
        type: "figma.design.inbox",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: client.sessionId,
        offers,
      });
    }
  }
}

async function storeChangeSet(projectDir, changeSet) {
  if (!changeSet || typeof changeSet !== "object") {
    throw new Error("Figma 修改数据无效。");
  }
  const directory = path.join(
    projectDir,
    ".figma-sync",
    "workspace-changes",
  );
  await mkdir(directory, { recursive: true });
  const fileName = `${Date.now()}-${safeName(changeSet.pageId || "page")}.json`;
  const absolutePath = path.join(directory, fileName);
  const temporary = `${absolutePath}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        protocolVersion: PROTOCOL_VERSION,
        capturedAt: new Date().toISOString(),
        ...changeSet,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rename(temporary, absolutePath);
  return {
    absolutePath,
    relativePath: path
      .relative(projectDir, absolutePath)
      .replaceAll("\\", "/"),
  };
}

function safeName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formalVersion(version) {
  return String(version || "").split("+")[0];
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
    vary: "Origin, Access-Control-Request-Private-Network",
  };
}

function isTrustedFigmaOrigin(origin) {
  return typeof origin === "string" && TRUSTED_FIGMA_ORIGINS.has(origin);
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendSocket(webSocket, value) {
  if (webSocket.readyState === 1) {
    webSocket.send(JSON.stringify(value));
  }
}

function restoreMapValue(map, key, value) {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function baselineFailure(fastApply, change, error) {
  return {
    ...fastApply,
    pendingCount: fastApply.pendingCount + 1,
    pending: [
      ...(fastApply.pending || []),
      {
        nodeId: change?.nodeId || change?.to?.node?.id || null,
        property: change?.property || "pageIr",
        reason: error?.code || "baseline_persist_failed",
      },
    ],
    error: `页面已写入，但共同同步基线保存失败：${error instanceof Error ? error.message : String(error)}`,
  };
}

function carryBaselineResources(root, baselinePageIr, changes = []) {
  const changedResourceIds = new Set(
    (Array.isArray(changes) ? changes : [])
      .filter((change) => ["svg", "image", "pageSeed"].includes(change?.property))
      .map((change) => change?.nodeId)
      .filter(Boolean),
  );
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const baselineResource = baselinePageIr.nodes?.[node.id]?.resource;
    const currentResource = node.resource || node[node.type];
    const currentHasData =
      currentResource &&
      typeof currentResource === "object" &&
      typeof currentResource.base64 === "string" &&
      currentResource.base64.length > 0;
    const baselineHasData =
      baselineResource &&
      typeof baselineResource.base64 === "string" &&
      baselineResource.base64.length > 0;
    if (
      baselineHasData &&
      !currentHasData &&
      !changedResourceIds.has(node.id) &&
      ["image", "svg"].includes(node.type)
    ) {
      node.resource = structuredClone(baselineResource);
      delete node.image;
      delete node.svg;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
}

function carryHtmlOwnedBaselineFields(root, baselinePageIr) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const baselineNode = baselinePageIr.nodes?.[node.id];
    if (baselineNode) {
      const figmaConstraints = structuredClone(
        node.constraints || null,
      );
      node.tag = baselineNode.tag;
      node.sourceRef = structuredClone(baselineNode.sourceRef);
      node.semantics = structuredClone(baselineNode.semantics);
      node.interaction = structuredClone(baselineNode.interaction);
      node.sizing = structuredClone(baselineNode.sizing);
      node.constraints = figmaConstraints;
      node.overflow = structuredClone(baselineNode.overflow);
      node.textFlow = structuredClone(baselineNode.textFlow);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
}

function carryFigmaOwnedBaselineFields(htmlPageIr, baselinePageIr) {
  return compactPageIr({
    ...htmlPageIr,
    origin: {
      ...htmlPageIr.origin,
      figmaFileKey: baselinePageIr.origin?.figmaFileKey || "",
      rootNodeId: baselinePageIr.origin?.rootNodeId || "",
      rootNodeName: baselinePageIr.origin?.rootNodeName || "",
    },
    nodes: Object.fromEntries(
      Object.entries(htmlPageIr.nodes || {}).map(([id, node]) => [
        id,
        {
          ...node,
          name: baselinePageIr.nodes?.[id]?.name || node.name,
          figma: baselinePageIr.nodes?.[id]?.figma || node.figma,
        },
      ]),
    ),
  });
}

function carryMissingFigmaNodeIdentity(pageIr, baselinePageIr, rootNodeId = "") {
  return compactPageIr({
    ...pageIr,
    nodes: Object.fromEntries(
      Object.entries(pageIr.nodes || {}).map(([id, node]) => {
        const baselineFigma = baselinePageIr.nodes?.[id]?.figma || {};
        const figma = node.figma || {};
        return [
          id,
          {
            ...node,
            figma: {
              nodeId:
                figma.nodeId
                || baselineFigma.nodeId
                || (id === pageIr.rootId ? rootNodeId : ""),
              componentKey: figma.componentKey || baselineFigma.componentKey || "",
              componentSetKey:
                figma.componentSetKey || baselineFigma.componentSetKey || "",
            },
          },
        ];
      }),
    ),
  });
}

function syncConflictResult(changes, conflicts, conflictPath) {
  const source = Array.isArray(changes) && changes.length > 0 ? changes : [{}];
  return {
    appliedCount: 0,
    pendingCount: source.length,
    changedFiles: [],
    durationMs: 0,
    transactionId: "",
    undoAvailable: false,
    conflicts,
    conflictPath,
    pending: source.map((change) => ({
      nodeId: change?.nodeId || null,
      property: change?.property || "pageIr",
      reason: "page_ir_conflict",
      conflictCount: conflicts.length,
    })),
    error: `HTML 与 Figma 同时修改了 ${conflicts.length} 个不可自动合并的 Page IR 字段。`,
  };
}

function attachFigmaNodeMappings(pageIr, mappings) {
  const value = structuredClone(pageIr);
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const node = value.nodes?.[mapping?.pageNodeId];
    if (!node || typeof mapping?.figmaNodeId !== "string") continue;
    node.figma = {
      ...(node.figma || {}),
      nodeId: mapping.figmaNodeId.slice(0, 128),
    };
  }
  return value;
}
