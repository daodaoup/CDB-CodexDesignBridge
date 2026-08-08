import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_TTL_MS = 8_000;
const HANDOFF_TIMEOUT_MS = 5_000;

export class WorkspaceLeaseManager {
  constructor({
    leaseRoot,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    ttlMs = DEFAULT_TTL_MS,
    getStatus,
    onShutdown,
  }) {
    this.leaseRoot = path.resolve(leaseRoot);
    this.leasePath = path.join(this.leaseRoot, "active-workspace.json");
    this.lockPath = path.join(this.leaseRoot, "lease.lock");
    this.heartbeatMs = heartbeatMs;
    this.ttlMs = ttlMs;
    this.getStatus = typeof getStatus === "function" ? getStatus : () => ({});
    this.onShutdown = typeof onShutdown === "function" ? onShutdown : async () => {};
    this.leaseId = randomUUID();
    this.secret = randomBytes(24).toString("hex");
    this.secretPath = path.join(this.leaseRoot, `${this.leaseId}.secret`);
    this.projectKey = "";
    this.controlServer = null;
    this.controlEndpoint = "";
    this.heartbeatTimer = null;
    this.preparingHandoff = false;
  }

  async acquire({ projectKey }) {
    if (!projectKey) throw new Error("工作台 lease 缺少项目身份。");
    await this.startControlServer();
    const current = await this.readLease();
    if (current?.leaseId === this.leaseId) {
      this.projectKey = projectKey;
      await this.writeOwnedLease("active");
      this.startHeartbeat();
      return { acquired: true, lease: await this.readLease() };
    }

    if (current) {
      const health = await requestControl(
        current,
        "/health",
        { method: "GET" },
        this.leaseRoot,
      );
      if (health?.ok) {
        await requestControl(
          current,
          "/handoff/prepare",
          {
            method: "POST",
            body: { nextProjectKey: projectKey },
          },
          this.leaseRoot,
        );
        await requestControl(
          current,
          "/shutdown",
          {
            method: "POST",
            body: { force: true },
          },
          this.leaseRoot,
        );
        await this.waitForRelease(current.leaseId);
      } else if (!isExpired(current)) {
        return {
          acquired: false,
          confirmationRequired: false,
          reason: "owner_unreachable",
          owner: publicLease(current),
        };
      }
    }

    const acquired = await this.withLock(async () => {
      const latest = await this.readLease();
      if (latest && latest.leaseId !== current?.leaseId && !isExpired(latest)) {
        return false;
      }
      this.projectKey = projectKey;
      await this.writeOwnedLeaseUnsafe("active");
      return true;
    });
    if (!acquired) {
      return { acquired: false, confirmationRequired: false, reason: "lease_race" };
    }
    this.startHeartbeat();
    return { acquired: true, lease: await this.readLease() };
  }

  status() {
    return {
      owned: Boolean(this.projectKey),
      leaseId: this.projectKey ? this.leaseId : "",
      projectKey: this.projectKey,
      controlEndpoint: this.controlEndpoint,
      preparingHandoff: this.preparingHandoff,
    };
  }

  async release() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.withLock(async () => {
      const current = await this.readLease();
      if (current?.leaseId === this.leaseId) {
        await rm(this.leasePath, { force: true });
      }
    });
    await rm(this.secretPath, { force: true });
    this.projectKey = "";
    this.preparingHandoff = false;
  }

  async stop() {
    await this.release();
    if (this.controlServer) {
      const server = this.controlServer;
      this.controlServer = null;
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async startControlServer() {
    if (this.controlServer) return;
    await mkdir(this.leaseRoot, { recursive: true });
    this.controlServer = createServer((request, response) => {
      this.handleControlRequest(request, response).catch((error) => {
        sendJson(response, 500, { ok: false, error: error.message });
      });
    });
    await new Promise((resolve, reject) => {
      this.controlServer.once("error", reject);
      this.controlServer.listen(0, "127.0.0.1", resolve);
    });
    const address = this.controlServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.controlEndpoint = `http://127.0.0.1:${port}`;
  }

  async handleControlRequest(request, response) {
    if (request.headers["x-cdb-control-secret"] !== this.secret) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        leaseId: this.leaseId,
        projectKey: this.projectKey,
        preparingHandoff: this.preparingHandoff,
        ...this.getStatus(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/handoff/prepare") {
      this.preparingHandoff = true;
      const status = this.getStatus();
      await this.writeOwnedLease("handoff");
      sendJson(response, 200, {
        ok: true,
        unsentChanges: Boolean(status.unsentChanges),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/handoff/cancel") {
      this.preparingHandoff = false;
      await this.writeOwnedLease("active");
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      await this.onShutdown({ force: true, handoff: true });
      await this.release();
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.writeOwnedLease(this.preparingHandoff ? "handoff" : "active").catch(
        () => {},
      );
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async writeOwnedLease(state) {
    if (!this.projectKey) return;
    await this.withLock(async () => {
      const current = await this.readLease();
      if (current && current.leaseId !== this.leaseId && !isExpired(current)) {
        return;
      }
      await this.writeOwnedLeaseUnsafe(state);
    });
  }

  async writeOwnedLeaseUnsafe(state) {
    if (!this.projectKey) return;
    const now = Date.now();
    const existing = await this.readLease();
    const value = {
      schemaVersion: 1,
      leaseId: this.leaseId,
      ownerPid: process.pid,
      taskIdHash: this.leaseId.slice(0, 12),
      projectKey: this.projectKey,
      state,
      controlEndpoint: this.controlEndpoint,
      controlSecretRef: this.secretPath,
      acquiredAt:
        existing?.leaseId === this.leaseId
          ? existing.acquiredAt
          : new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    await mkdir(this.leaseRoot, { recursive: true });
    await writeFile(this.secretPath, this.secret, {
      encoding: "utf8",
      mode: 0o600,
    });
    const temporary = `${this.leasePath}.${process.pid}.${this.leaseId}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rm(this.leasePath, { force: true });
    await rename(temporary, this.leasePath);
  }

  async readLease() {
    try {
      const value = JSON.parse(await readFile(this.leasePath, "utf8"));
      return value?.schemaVersion === 1 ? value : null;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async waitForRelease(leaseId) {
    const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = await this.readLease();
      if (!current || current.leaseId !== leaseId || isExpired(current)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("旧 CDB 工作台没有在 5 秒内释放连接。");
  }

  async withLock(callback) {
    await mkdir(this.leaseRoot, { recursive: true });
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("CDB 工作台 lease 正忙，请重试。");
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > 5_000) {
            await rm(this.lockPath, { recursive: true, force: true });
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await callback();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }
}

function publicLease(lease) {
  return lease
    ? {
        leaseId: lease.leaseId,
        projectKey: lease.projectKey,
        state: lease.state,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
      }
    : null;
}

function isExpired(lease) {
  return !lease?.expiresAt || Date.parse(lease.expiresAt) <= Date.now();
}

async function requestControl(lease, route, { method, body } = {}, leaseRoot) {
  if (!lease?.controlEndpoint || !lease?.controlSecretRef) return null;
  const expectedSecretPath = path.join(
    path.resolve(leaseRoot),
    `${lease.leaseId}.secret`,
  );
  if (path.resolve(lease.controlSecretRef) !== expectedSecretPath) return null;
  let endpoint;
  try {
    endpoint = new URL(lease.controlEndpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    return null;
  }
  let controlSecret;
  try {
    controlSecret = await readFile(lease.controlSecretRef, "utf8");
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(new URL(route, endpoint), {
      method: method || "GET",
      headers: {
        "x-cdb-control-secret": controlSecret,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
