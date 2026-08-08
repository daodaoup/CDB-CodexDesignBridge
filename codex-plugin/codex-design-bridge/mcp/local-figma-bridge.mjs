import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "../vendor/ws/wrapper.mjs";
import { preparePageManifest } from "../shared/page.mjs";
import { applyFastPageChanges } from "./fast-page-patch.mjs";

const PROTOCOL_VERSION = 14;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([13, PROTOCOL_VERSION]);
const DEFAULT_PORT = 9847;
const OPERATION_TIMEOUT_MS = 20_000;
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
      runtimeVersion = "",
      projectName = "",
      projectKey = "",
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
    this.runtimeVersion = String(runtimeVersion || "");
    this.projectName = String(projectName || path.basename(this.projectDir));
    this.projectKey = String(projectKey || "");
    this.httpServer = null;
    this.webSocketServer = null;
    this.clients = new Set();
    this.pages = new Map();
    this.pageCatalog = new Map();
    this.pendingImports = new Map();
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
      maxPayload: 10 * 1024 * 1024,
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

  async pushPage(manifest) {
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
    this.pages.set(prepared.pageId, prepared);
    const resultPromise = this.waitForImport(prepared.pageId);
    this.broadcast({ type: "page.upsert", page: prepared });
    const result = await resultPromise;
    if (!result?.ok) {
      this.updateCatalogState(prepared.pageId, "failed", result?.error || "导入失败");
      throw new Error(result?.error || "Figma 没有完成页面导入。");
    }
    this.updateCatalogState(prepared.pageId, "synced");
    return {
      ...result,
      nodeCount: prepared.nodeIds.length,
    };
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
      }, OPERATION_TIMEOUT_MS);
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

  handleConnection(webSocket) {
    const client = {
      webSocket,
      ready: false,
      pluginVersion: "",
      messageQueue: Promise.resolve(),
    };
    this.clients.add(client);
    webSocket.on("message", (raw) => {
      client.messageQueue = client.messageQueue
        .then(() => this.handleMessage(client, raw))
        .catch((error) => {
          sendSocket(webSocket, {
            type: "bridge.error",
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
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(message.protocolVersion)) {
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
        message.protocolVersion === PROTOCOL_VERSION &&
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
      client.ready = true;
      client.pluginVersion = pluginVersion || `protocol-${message.protocolVersion}`;
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
        runtimeVersion: this.runtimeVersion,
        figmaPluginVersion: client.pluginVersion,
        assets: 0,
        pages: this.pageCatalog.size,
        projectName: this.projectName,
        projectKey: this.projectKey,
        localWorkspace: true,
      });
      for (const page of this.pages.values()) {
        sendSocket(client.webSocket, { type: "page.upsert", page });
      }
      sendSocket(client.webSocket, {
        type: "page.catalog",
        pages: this.catalogEntries(),
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
        for (const resolveImport of this.pendingImports.values()) {
          resolveImport({ ok: false, error: "Figma 页面关联已清空。" });
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
        this.pendingImports.delete(result.pageId);
        pending(result);
      }
      return;
    }
    if (message.type === "page.changes.record") {
      const stored = await storeChangeSet(this.projectDir, message.changeSet);
      let fastApply;
      try {
        const catalogPage = this.pageCatalog.get(message.changeSet?.pageId);
        fastApply = await applyFastPageChanges({
          projectDir: this.projectDir,
          changeSet: message.changeSet,
          manifest:
            this.pages.get(message.changeSet?.pageId) ||
            (catalogPage ? { ...catalogPage, pageId: catalogPage.id } : null),
        });
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
          projectName: this.projectName,
          projectKey: this.projectKey,
        },
        corsHeaders(request),
      );
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  waitForImport(pageId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(pageId);
        reject(new Error("Figma 页面导入超时，请确认本地插件仍然打开。"));
      }, OPERATION_TIMEOUT_MS);
      this.pendingImports.set(pageId, (value) => {
        clearTimeout(timer);
        resolve(value);
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

  readyClients() {
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
