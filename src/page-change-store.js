import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeHash } from "./svg.js";

export class PageChangeStore {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.syncDirectory = path.join(this.rootDirectory, ".figma-sync");
    this.pendingDirectory = path.join(this.syncDirectory, "page-changes");
    this.conflictsDirectory = path.join(
      this.syncDirectory,
      "page-change-conflicts",
    );
  }

  async ensureDirectories() {
    await Promise.all([
      mkdir(this.pendingDirectory, { recursive: true }),
      mkdir(this.conflictsDirectory, { recursive: true }),
    ]);
  }

  async record(changeSet, registryEntry) {
    validateChangeSet(changeSet, registryEntry);
    await this.ensureDirectories();

    let currentSourceHash = null;
    try {
      currentSourceHash = computeHash(
        await readFile(registryEntry.absolutePath, "utf8"),
      );
    } catch {
      currentSourceHash = null;
    }

    const isConflict =
      currentSourceHash === null || currentSourceHash !== changeSet.sourceHash;
    const changeSetId = changeSet.changeSetId || randomUUID();
    const envelope = {
      protocolVersion: 3,
      changeSetId,
      state: isConflict ? "conflict" : "pending",
      recordedAt: new Date().toISOString(),
      page: {
        pageId: changeSet.pageId,
        sourcePath: registryEntry.prepared.sourcePath,
        expectedHash: changeSet.sourceHash,
        currentHash: currentSourceHash,
      },
      changes: Array.isArray(changeSet.changes) ? changeSet.changes : [],
      annotations: Array.isArray(changeSet.annotations)
        ? changeSet.annotations
        : [],
      figma: changeSet.figma ?? {},
    };

    const directory = isConflict
      ? this.conflictsDirectory
      : this.pendingDirectory;
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const filename = `${timestamp}-${safeFilename(
      changeSet.pageId,
    )}-${changeSetId.slice(0, 8)}.json`;
    const destination = path.join(directory, filename);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
    return { envelope, path: destination, isConflict };
  }

  async list({ includeConflicts = true } = {}) {
    await this.ensureDirectories();
    return {
      pending: await readJsonFiles(this.pendingDirectory),
      conflicts: includeConflicts
        ? await readJsonFiles(this.conflictsDirectory)
        : [],
    };
  }
}

function validateChangeSet(changeSet, registryEntry) {
  if (!changeSet || typeof changeSet !== "object") {
    throw new Error("Page change set must be an object.");
  }
  if (!registryEntry) {
    throw new Error(`Unknown page "${changeSet.pageId}".`);
  }
  if (
    typeof changeSet.sourceHash !== "string" ||
    changeSet.sourceHash === ""
  ) {
    throw new Error("Page change set sourceHash is required.");
  }
  const knownNodeIds = new Set(registryEntry.prepared.nodeIds);
  for (const change of changeSet.changes || []) {
    if (!knownNodeIds.has(change.nodeId)) {
      throw new Error(
        `Unknown page node "${change.nodeId}" for page "${changeSet.pageId}".`,
      );
    }
  }
}

async function readJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const values = [];
  for (const file of files) {
    const absolutePath = path.join(directory, file.name);
    values.push({
      path: absolutePath,
      ...JSON.parse(await readFile(absolutePath, "utf8")),
    });
  }
  return values;
}

function safeFilename(value) {
  return String(value)
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80);
}
