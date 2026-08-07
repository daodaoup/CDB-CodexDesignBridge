import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
  watch,
} from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CodexRunner } from "./codex-runner.js";
import { DesignTaskStore } from "./design-task-store.js";
import { FeedbackStore } from "./feedback-store.js";
import { PageChangeStore } from "./page-change-store.js";
import { preparePageManifest } from "./page.js";
import { prepareSvgAsset } from "./svg.js";

const DEFAULT_PORT = 9847;
const PROTOCOL_VERSION = 11;

export class BridgeServer {
  constructor({
    rootDirectory = process.cwd(),
    assetsDirectory = "assets",
    pagesDirectory = "pages",
    host = "127.0.0.1",
    port = DEFAULT_PORT,
    token,
    watchFiles = true,
    logger = console,
    codexCommand,
    codexExecutor,
    onDesignTask = () => {},
    onClientChange = () => {},
    onPageImportResult = () => {},
  } = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.assetsDirectory = path.resolve(this.rootDirectory, assetsDirectory);
    this.pagesDirectory = path.resolve(this.rootDirectory, pagesDirectory);
    this.host = host;
    this.port = Number(port);
    this.token = token;
    this.watchFiles = watchFiles;
    this.logger = logger;
    this.onDesignTask = onDesignTask;
    this.onClientChange = onClientChange;
    this.onPageImportResult = onPageImportResult;
    this.feedbackStore = new FeedbackStore(this.rootDirectory);
    this.pageChangeStore = new PageChangeStore(this.rootDirectory);
    this.designTaskStore = new DesignTaskStore(this.rootDirectory);
    this.codexRunner = new CodexRunner({
      rootDirectory: this.rootDirectory,
      taskStore: this.designTaskStore,
      command: codexCommand,
      executor: codexExecutor,
      logger,
      onStatus: (status) => this.publishDesignTask(status),
    });
    this.registry = new Map();
    this.tombstones = new Map();
    this.pageRegistry = new Map();
    this.pageTombstones = new Map();
    this.clients = new Set();
    this.debounceTimers = new Map();
    this.httpServer = null;
    this.webSocketServer = null;
    this.fileWatcher = null;
    this.pageWatcher = null;
    this.connectionPath = path.join(this.rootDirectory, ".figma-sync", "connection.json");
  }

  async start() {
    if (!this.token) {
      this.token = await loadOrCreateToken(this.rootDirectory);
    }
    await mkdir(this.assetsDirectory, { recursive: true });
    await mkdir(this.pagesDirectory, { recursive: true });
    await this.feedbackStore.ensureDirectories();
    await this.pageChangeStore.ensureDirectories();
    await this.designTaskStore.ensureDirectories();
    await this.designTaskStore.failInterrupted();
    await this.scanAssets();
    await this.scanPages();

    this.httpServer = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        this.logger.error(error);
        sendJson(response, 500, { error: "internal_error", message: error.message });
      });
    });
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname !== "/ws" || url.searchParams.get("token") !== this.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (webSocket) => this.handleConnection(webSocket));

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, resolve);
    });

    const address = this.httpServer.address();
    this.port = typeof address === "object" && address ? address.port : this.port;
    await this.writeConnectionFile();

    if (this.watchFiles) {
      await this.startWatcher();
      await this.startPageWatcher();
    }

    return this.getConnectionInfo();
  }

  async stop() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.codexRunner.stop();
    if (this.fileWatcher) {
      await this.fileWatcher.return();
      this.fileWatcher = null;
    }
    if (this.pageWatcher) {
      await this.pageWatcher.return();
      this.pageWatcher = null;
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
    try {
      const current = JSON.parse(await readFile(this.connectionPath, "utf8"));
      if (current.pid === process.pid) {
        await unlink(this.connectionPath);
      }
    } catch {
      // A stale or already removed connection file is harmless.
    }
  }

  getConnectionInfo() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      host: this.host,
      port: this.port,
      token: this.token,
      wsUrl: `ws://${this.host}:${this.port}/ws`,
      rootDirectory: this.rootDirectory,
      assetsDirectory: this.assetsDirectory,
      pagesDirectory: this.pagesDirectory,
      designRequestsDirectory: this.designTaskStore.directory,
      codexCommand: this.codexRunner.command,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  getPluginClientCount() {
    return Array.from(this.clients).filter((client) => client.ready).length;
  }

  async scanAssets() {
    const files = await collectSvgFiles(this.assetsDirectory);
    for (const file of files) {
      try {
        await this.prepareAndPublish(file, { broadcast: false });
      } catch (error) {
        this.logger.warn(`Skipped ${file}: ${error.message}`);
      }
    }
  }

  async scanPages() {
    const files = await collectPageFiles(this.pagesDirectory);
    for (const file of files) {
      try {
        await this.preparePageAndPublish(file, { broadcast: false });
      } catch (error) {
        this.logger.warn(`Skipped ${file}: ${error.message}`);
      }
    }
  }

  async prepareAndPublish(filePath, { broadcast = true } = {}) {
    const absolutePath = path.resolve(filePath);
    assertInside(this.assetsDirectory, absolutePath);
    if (path.extname(absolutePath).toLowerCase() !== ".svg") {
      throw new Error("Only .svg files can be pushed.");
    }
    const svg = await readFile(absolutePath, "utf8");
    const assetId = path.relative(this.assetsDirectory, absolutePath).replaceAll("\\", "/");
    const sourcePath = path.relative(this.rootDirectory, absolutePath).replaceAll("\\", "/");
    const prepared = prepareSvgAsset({ svg, assetId, sourcePath });
    const entry = { absolutePath, prepared };
    this.registry.set(assetId, entry);
    this.tombstones.delete(assetId);
    if (broadcast) {
      this.broadcast({ type: "asset.upsert", asset: prepared });
    }
    return prepared;
  }

  async preparePageAndPublish(filePath, { broadcast = true } = {}) {
    const absolutePath = path.resolve(filePath);
    assertInside(this.pagesDirectory, absolutePath);
    if (!absolutePath.toLowerCase().endsWith(".figma-page.json")) {
      throw new Error("Only .figma-page.json files can be pushed as pages.");
    }
    const json = await readFile(absolutePath, "utf8");
    const sourcePath = path
      .relative(this.rootDirectory, absolutePath)
      .replaceAll("\\", "/");
    const prepared = preparePageManifest({ json, sourcePath });
    const entry = { absolutePath, prepared };
    this.pageRegistry.set(prepared.pageId, entry);
    this.pageTombstones.delete(prepared.pageId);
    if (broadcast) {
      this.broadcast({ type: "page.upsert", page: prepared });
    }
    return prepared;
  }

  async startWatcher() {
    this.fileWatcher = watch(this.assetsDirectory, { recursive: true });
    const watcher = this.fileWatcher;
    void (async () => {
      try {
        for await (const event of watcher) {
          if (!event.filename || path.extname(event.filename).toLowerCase() !== ".svg") {
            continue;
          }
          const absolutePath = path.resolve(this.assetsDirectory, event.filename);
          this.scheduleFileRefresh(absolutePath);
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          this.logger.error(`File watcher stopped: ${error.message}`);
        }
      }
    })();
  }

  async startPageWatcher() {
    this.pageWatcher = watch(this.pagesDirectory, { recursive: true });
    const watcher = this.pageWatcher;
    void (async () => {
      try {
        for await (const event of watcher) {
          if (
            !event.filename ||
            !event.filename.toLowerCase().endsWith(".figma-page.json")
          ) {
            continue;
          }
          const absolutePath = path.resolve(this.pagesDirectory, event.filename);
          this.schedulePageRefresh(absolutePath);
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          this.logger.error(`Page watcher stopped: ${error.message}`);
        }
      }
    })();
  }

  scheduleFileRefresh(absolutePath) {
    const existing = this.debounceTimers.get(absolutePath);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      absolutePath,
      setTimeout(async () => {
        this.debounceTimers.delete(absolutePath);
        try {
          await access(absolutePath);
          await this.prepareAndPublish(absolutePath);
          this.logger.log(`Synced ${path.relative(this.rootDirectory, absolutePath)}`);
        } catch (error) {
          const assetId = path
            .relative(this.assetsDirectory, absolutePath)
            .replaceAll("\\", "/");
          if (error?.code === "ENOENT") {
            const previous = this.registry.get(assetId);
            if (previous) {
              this.tombstones.set(assetId, previous);
            }
            this.registry.delete(assetId);
            this.broadcast({ type: "asset.remove", assetId });
            return;
          }
          this.logger.error(`Rejected ${assetId}: ${error.message}`);
          this.broadcast({
            type: "asset.error",
            assetId,
            error: error.message,
            details: error.details ?? [],
          });
        }
      }, 150),
    );
  }

  schedulePageRefresh(absolutePath) {
    const existing = this.debounceTimers.get(absolutePath);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      absolutePath,
      setTimeout(async () => {
        this.debounceTimers.delete(absolutePath);
        try {
          await access(absolutePath);
          const page = await this.preparePageAndPublish(absolutePath);
          this.logger.log(`Synced ${page.sourcePath}`);
        } catch (error) {
          const previous = Array.from(this.pageRegistry.values()).find(
            (entry) => entry.absolutePath === absolutePath,
          );
          if (error?.code === "ENOENT") {
            if (previous) {
              this.pageTombstones.set(previous.prepared.pageId, previous);
              this.pageRegistry.delete(previous.prepared.pageId);
              this.broadcast({
                type: "page.remove",
                pageId: previous.prepared.pageId,
              });
            }
            return;
          }
          const pageId = previous?.prepared.pageId || path.basename(absolutePath);
          this.logger.error(`Rejected ${pageId}: ${error.message}`);
          this.broadcast({
            type: "page.error",
            pageId,
            error: error.message,
            details: error.details ?? [],
          });
        }
      }, 150),
    );
  }

  handleConnection(webSocket) {
    const client = { webSocket, ready: false, id: randomUUID() };
    this.clients.add(client);
    sendWebSocket(webSocket, {
      type: "bridge.hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: client.id,
      assets: this.registry.size,
      pages: this.pageRegistry.size,
    });

    webSocket.on("message", (buffer) => {
      this.handleWebSocketMessage(client, buffer.toString()).catch((error) => {
        sendWebSocket(webSocket, {
          type: "bridge.error",
          requestId: null,
          error: error.message,
        });
      });
    });
    webSocket.on("close", () => {
      this.clients.delete(client);
      this.onClientChange(this.getPluginClientCount());
    });
    webSocket.on("error", (error) => this.logger.warn(`WebSocket error: ${error.message}`));
  }

  async handleWebSocketMessage(client, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      throw new Error("WebSocket messages must be valid JSON.");
    }

    if (message.type === "plugin.hello") {
      client.ready = true;
      this.onClientChange(this.getPluginClientCount());
      sendWebSocket(client.webSocket, {
        type: "plugin.ready",
        protocolVersion: PROTOCOL_VERSION,
        assets: this.registry.size,
        pages: this.pageRegistry.size,
        projectName: path.basename(this.rootDirectory),
        codexRunner: this.codexRunner.getStatus(),
      });
      for (const entry of this.registry.values()) {
        sendWebSocket(client.webSocket, { type: "asset.upsert", asset: entry.prepared });
      }
      for (const entry of this.pageRegistry.values()) {
        sendWebSocket(client.webSocket, {
          type: "page.upsert",
          page: entry.prepared,
        });
      }
      const importedAssetIds = Array.isArray(message.importedAssetIds)
        ? message.importedAssetIds.filter(
            (assetId) => typeof assetId === "string",
          )
        : [];
      for (const assetId of importedAssetIds) {
        if (!this.registry.has(assetId)) {
          sendWebSocket(client.webSocket, { type: "asset.remove", assetId });
        }
      }
      return;
    }

    if (message.type === "page.import.result") {
      this.onPageImportResult(message.result ?? null);
      return;
    }

    if (message.type === "feedback.record") {
      const feedback = message.feedback;
      const entry =
        this.registry.get(feedback?.assetId) ||
        this.tombstones.get(feedback?.assetId);
      const result = await this.feedbackStore.record(feedback, entry);
      sendWebSocket(client.webSocket, {
        type: "feedback.ack",
        requestId: message.requestId ?? null,
        feedbackId: result.envelope.feedbackId,
        state: result.envelope.state,
        path: path.relative(this.rootDirectory, result.path).replaceAll("\\", "/"),
      });
      return;
    }

    if (message.type === "page.changes.record") {
      const changeSet = message.changeSet;
      const entry =
        this.pageRegistry.get(changeSet?.pageId) ||
        this.pageTombstones.get(changeSet?.pageId);
      const result = await this.pageChangeStore.record(changeSet, entry);
      sendWebSocket(client.webSocket, {
        type: "page.changes.ack",
        requestId: message.requestId ?? null,
        changeSetId: result.envelope.changeSetId,
        state: result.envelope.state,
        path: path
          .relative(this.rootDirectory, result.path)
          .replaceAll("\\", "/"),
      });
      return;
    }

    if (message.type === "design.generate") {
      const task = await this.designTaskStore.create(message.design);
      const publicTask = publicDesignTask(task);
      sendWebSocket(client.webSocket, {
        type: "design.task",
        requestId: message.requestId ?? null,
        task: publicTask,
      });
      this.onDesignTask(publicTask);
      this.codexRunner.enqueue(task);
      return;
    }

    if (message.type === "plugin.error") {
      this.logger.error(`Figma plugin: ${message.error || "Unknown error"}`);
      return;
    }

    if (message.type === "ping") {
      sendWebSocket(client.webSocket, { type: "pong", at: new Date().toISOString() });
      return;
    }

    throw new Error(`Unsupported message type "${message.type}".`);
  }

  broadcast(message) {
    for (const client of this.clients) {
      if (client.ready) {
        sendWebSocket(client.webSocket, message);
      }
    }
  }

  publishDesignTask(task) {
    this.broadcast({ type: "design.task", task });
    this.onDesignTask(task);
  }

  async handleHttp(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        assets: this.registry.size,
        pages: this.pageRegistry.size,
        pluginClients: Array.from(this.clients).filter((client) => client.ready).length,
        codexRunner: this.codexRunner.getStatus(),
        pid: process.pid,
      });
      return;
    }

    if (!isAuthorized(request, url, this.token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/push") {
      const body = await readJsonBody(request);
      if (typeof body.path !== "string" || body.path === "") {
        sendJson(response, 400, { error: "path_required" });
        return;
      }
      const absolutePath = path.isAbsolute(body.path)
        ? path.resolve(body.path)
        : path.resolve(this.rootDirectory, body.path);
      try {
        const asset = await this.prepareAndPublish(absolutePath);
        sendJson(response, 200, {
          ok: true,
          assetId: asset.assetId,
          sourceHash: asset.sourceHash,
          elementIds: asset.elementIds,
        });
      } catch (error) {
        sendJson(response, 400, {
          error: "invalid_asset",
          message: error.message,
          details: error.details ?? [],
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/push-page") {
      const body = await readJsonBody(request);
      if (typeof body.path !== "string" || body.path === "") {
        sendJson(response, 400, { error: "path_required" });
        return;
      }
      const absolutePath = path.isAbsolute(body.path)
        ? path.resolve(body.path)
        : path.resolve(this.rootDirectory, body.path);
      try {
        const page = await this.preparePageAndPublish(absolutePath);
        sendJson(response, 200, {
          ok: true,
          pageId: page.pageId,
          sourceHash: page.sourceHash,
          nodeIds: page.nodeIds,
        });
      } catch (error) {
        sendJson(response, 400, {
          error: "invalid_page",
          message: error.message,
          details: error.details ?? [],
        });
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  }

  async writeConnectionFile() {
    const syncDirectory = path.dirname(this.connectionPath);
    await mkdir(syncDirectory, { recursive: true });
    this.startedAt = new Date().toISOString();
    const temporary = `${this.connectionPath}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(this.getConnectionInfo(), null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, this.connectionPath);
  }
}

export async function loadOrCreateToken(rootDirectory) {
  const syncDirectory = path.resolve(rootDirectory, ".figma-sync");
  const tokenPath = path.join(syncDirectory, "token");
  await mkdir(syncDirectory, { recursive: true });
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // Generate the token below.
  }
  const token = randomBytes(24).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

async function collectSvgFiles(directory) {
  const result = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".svg") {
        result.push(absolutePath);
      }
    }
  };
  try {
    await visit(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return result.sort();
}

async function collectPageFiles(directory) {
  const result = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".figma-page.json")
      ) {
        result.push(absolutePath);
      }
    }
  };
  try {
    await visit(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return result.sort();
}

function assertInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Path must stay inside ${parent}.`);
}

function isAuthorized(request, url, token) {
  return (
    request.headers.authorization === `Bearer ${token}` ||
    url.searchParams.get("token") === token
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendWebSocket(webSocket, value) {
  if (webSocket.readyState === webSocket.OPEN) {
    webSocket.send(JSON.stringify(value));
  }
}

function publicDesignTask(task) {
  return {
    protocolVersion: task.protocolVersion,
    taskId: task.taskId,
    designId: task.designId,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error || null,
    designPath: task.designPath,
  };
}
