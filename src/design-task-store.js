import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PROTOCOL_VERSION = 3;
const MAX_NODES = 500;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 7 * 1024 * 1024;
const ALLOWED_ROOT_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "GROUP",
]);

export class DesignTaskStore {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.directory = path.join(
      this.rootDirectory,
      ".figma-sync",
      "design-requests",
    );
  }

  async ensureDirectories() {
    await mkdir(this.directory, { recursive: true });
  }

  async create(input) {
    const design = validateDesignSnapshot(input);
    await this.ensureDirectories();
    const taskId = `design-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const taskDirectory = path.join(this.directory, taskId);
    const assetDirectory = path.join(taskDirectory, "assets");
    await mkdir(assetDirectory, { recursive: true });

    const screenshotBuffer = decodeData(
      design.screenshot,
      "image/png",
      MAX_SCREENSHOT_BYTES,
      "Design screenshot",
    );
    const screenshotPath = path.join(taskDirectory, "reference.png");
    await writeFile(screenshotPath, screenshotBuffer);

    let totalAssetBytes = 0;
    const root = await externalizeAssets(
      design.root,
      assetDirectory,
      async (size) => {
        totalAssetBytes += size;
        if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
          throw new Error("Exported design assets exceed 7 MB.");
        }
      },
    );

    const storedDesign = {
      protocolVersion: PROTOCOL_VERSION,
      designId: design.designId,
      capturedAt: design.capturedAt,
      figma: design.figma,
      root,
      screenshot: {
        mimeType: "image/png",
        path: "reference.png",
        width: design.screenshot.width,
        height: design.screenshot.height,
      },
    };
    const designPath = path.join(taskDirectory, "design.json");
    await writeJsonAtomic(designPath, storedDesign);

    const now = new Date().toISOString();
    const status = {
      protocolVersion: PROTOCOL_VERSION,
      taskId,
      designId: design.designId,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      designPath: relativeFromRoot(this.rootDirectory, designPath),
      screenshotPath: relativeFromRoot(this.rootDirectory, screenshotPath),
    };
    await writeJsonAtomic(path.join(taskDirectory, "status.json"), status);
    return {
      ...status,
      taskDirectory,
      designAbsolutePath: designPath,
      screenshotAbsolutePath: screenshotPath,
    };
  }

  async update(taskId, patch) {
    assertTaskId(taskId);
    const taskDirectory = path.join(this.directory, taskId);
    const statusPath = path.join(taskDirectory, "status.json");
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    const next = {
      ...current,
      ...patch,
      protocolVersion: PROTOCOL_VERSION,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statusPath, next);
    return {
      ...next,
      taskDirectory,
      designAbsolutePath: path.join(taskDirectory, "design.json"),
      screenshotAbsolutePath: path.join(taskDirectory, "reference.png"),
    };
  }

  async list() {
    await this.ensureDirectories();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^design-[A-Za-z0-9-]+$/.test(entry.name)) {
        continue;
      }
      try {
        const status = JSON.parse(
          await readFile(
            path.join(this.directory, entry.name, "status.json"),
            "utf8",
          ),
        );
        tasks.push(status);
      } catch {
        // Ignore incomplete task folders; a later submission uses a new id.
      }
    }
    return tasks.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
  }

  async failInterrupted() {
    const tasks = await this.list();
    let recovered = 0;
    for (const task of tasks) {
      if (task.state !== "queued" && task.state !== "running") {
        continue;
      }
      await this.update(task.taskId, {
        state: "failed",
        completedAt: new Date().toISOString(),
        error:
          "Bridge restarted before the Codex task completed. Submit the design again.",
      });
      recovered += 1;
    }
    return recovered;
  }
}

export function validateDesignSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Design snapshot must be an object.");
  }
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Design snapshot requires protocolVersion ${PROTOCOL_VERSION}.`);
  }
  const designId = requiredString(input.designId, "designId", 160);
  const capturedAt = requiredString(input.capturedAt, "capturedAt", 80);
  if (!input.figma || typeof input.figma !== "object") {
    throw new Error("Design snapshot figma metadata is required.");
  }
  if (!input.root || typeof input.root !== "object") {
    throw new Error("Design snapshot root is required.");
  }
  if (!ALLOWED_ROOT_TYPES.has(input.root.type)) {
    throw new Error(
      "Select a Frame, Component, Instance, or Group as the design root.",
    );
  }
  if (!input.screenshot || typeof input.screenshot !== "object") {
    throw new Error("Design screenshot is required.");
  }
  requiredString(input.screenshot.base64, "screenshot.base64", 8_000_000);
  const width = positiveNumber(input.screenshot.width, "screenshot.width");
  const height = positiveNumber(input.screenshot.height, "screenshot.height");

  let nodeCount = 0;
  const stableIds = new Set();
  const validateNode = (node, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error("Every design node must be an object.");
    }
    if (depth > 60) {
      throw new Error("Design hierarchy is too deeply nested.");
    }
    nodeCount += 1;
    if (nodeCount > MAX_NODES) {
      throw new Error(`Design snapshot exceeds ${MAX_NODES} nodes.`);
    }
    const stableId = requiredString(node.stableId, "node.stableId", 180);
    if (stableIds.has(stableId)) {
      throw new Error(`Duplicate design stableId "${stableId}".`);
    }
    stableIds.add(stableId);
    requiredString(node.nodeId, "node.nodeId", 100);
    requiredString(node.name, "node.name", 300);
    requiredString(node.type, "node.type", 80);
    if (!node.properties || typeof node.properties !== "object") {
      throw new Error(`Design node "${stableId}" is missing properties.`);
    }
    if (node.asset !== undefined) {
      validateAsset(node.asset, stableId);
    }
    if (node.children !== undefined && !Array.isArray(node.children)) {
      throw new Error(`Design node "${stableId}" children must be an array.`);
    }
    for (const child of node.children || []) {
      validateNode(child, depth + 1);
    }
  };
  validateNode(input.root, 0);

  return {
    protocolVersion: PROTOCOL_VERSION,
    designId,
    capturedAt,
    figma: {
      fileKey: optionalString(input.figma.fileKey, 300),
      pageId: requiredString(input.figma.pageId, "figma.pageId", 100),
      pageName: requiredString(input.figma.pageName, "figma.pageName", 300),
      rootNodeId: requiredString(
        input.figma.rootNodeId,
        "figma.rootNodeId",
        100,
      ),
      rootNodeName: requiredString(
        input.figma.rootNodeName,
        "figma.rootNodeName",
        300,
      ),
    },
    root: input.root,
    screenshot: {
      mimeType: "image/png",
      base64: input.screenshot.base64,
      width,
      height,
    },
  };
}

async function externalizeAssets(node, assetDirectory, addSize) {
  const next = {
    ...node,
    children: [],
  };
  if (node.asset) {
    const extension = node.asset.mimeType === "image/svg+xml" ? ".svg" : ".png";
    const fileName = `${safeFileName(node.stableId)}${extension}`;
    const buffer = decodeData(
      node.asset,
      node.asset.mimeType,
      MAX_ASSET_BYTES,
      `Asset for ${node.stableId}`,
    );
    await addSize(buffer.length);
    await writeFile(path.join(assetDirectory, fileName), buffer);
    next.asset = {
      kind: node.asset.kind,
      mimeType: node.asset.mimeType,
      path: `assets/${fileName}`,
    };
  }
  for (const child of node.children || []) {
    next.children.push(
      await externalizeAssets(child, assetDirectory, addSize),
    );
  }
  return next;
}

function validateAsset(asset, stableId) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new Error(`Asset for "${stableId}" must be an object.`);
  }
  if (asset.kind !== "svg" && asset.kind !== "png") {
    throw new Error(`Asset for "${stableId}" has an unsupported kind.`);
  }
  const expectedMime =
    asset.kind === "svg" ? "image/svg+xml" : "image/png";
  if (asset.mimeType !== expectedMime) {
    throw new Error(`Asset for "${stableId}" has an invalid MIME type.`);
  }
  requiredString(asset.base64, `asset ${stableId}.base64`, 3_000_000);
}

function decodeData(value, expectedMimeType, maxBytes, label) {
  if (value.mimeType !== expectedMimeType) {
    throw new Error(`${label} must use ${expectedMimeType}.`);
  }
  let buffer;
  try {
    buffer = Buffer.from(value.base64, "base64");
  } catch {
    throw new Error(`${label} is not valid base64.`);
  }
  if (buffer.length === 0) {
    throw new Error(`${label} is empty.`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
  return buffer;
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return value;
}

function optionalString(value, maxLength) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error("Optional Figma metadata is invalid.");
  }
  return value;
}

function positiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function safeFileName(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return normalized || randomUUID().slice(0, 8);
}

function assertTaskId(taskId) {
  if (
    typeof taskId !== "string" ||
    !/^design-[A-Za-z0-9-]+$/.test(taskId)
  ) {
    throw new Error("Invalid design task id.");
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function relativeFromRoot(rootDirectory, filePath) {
  return path.relative(rootDirectory, filePath).replaceAll("\\", "/");
}
