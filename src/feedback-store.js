import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeHash } from "./svg.js";

export class FeedbackStore {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.syncDirectory = path.join(this.rootDirectory, ".figma-sync");
    this.inboxDirectory = path.join(this.syncDirectory, "inbox");
    this.conflictsDirectory = path.join(this.syncDirectory, "conflicts");
  }

  async ensureDirectories() {
    await Promise.all([
      mkdir(this.inboxDirectory, { recursive: true }),
      mkdir(this.conflictsDirectory, { recursive: true }),
    ]);
  }

  async record(feedback, registryEntry) {
    validateFeedback(feedback, registryEntry);
    await this.ensureDirectories();

    let currentSourceHash = null;
    try {
      currentSourceHash = computeHash(await readFile(registryEntry.absolutePath, "utf8"));
    } catch {
      currentSourceHash = null;
    }

    const isConflict =
      currentSourceHash === null || currentSourceHash !== feedback.sourceHash;
    const feedbackId = feedback.feedbackId || randomUUID();
    const envelope = {
      protocolVersion: 2,
      feedbackId,
      state: isConflict ? "conflict" : "pending",
      recordedAt: new Date().toISOString(),
      source: {
        assetId: feedback.assetId,
        sourcePath: registryEntry.prepared.sourcePath,
        expectedHash: feedback.sourceHash,
        currentHash: currentSourceHash,
      },
      elementId: feedback.elementId,
      kind: feedback.kind,
      changes: Array.isArray(feedback.changes) ? feedback.changes : [],
      annotations: Array.isArray(feedback.annotations) ? feedback.annotations : [],
      figma: feedback.figma ?? {},
    };

    const directory = isConflict ? this.conflictsDirectory : this.inboxDirectory;
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const filename = `${timestamp}-${safeFilename(feedback.assetId)}-${safeFilename(
      feedback.elementId,
    )}-${feedbackId.slice(0, 8)}.json`;
    const destination = path.join(directory, filename);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await rename(temporary, destination);

    return { envelope, path: destination, isConflict };
  }

  async list({ includeConflicts = true } = {}) {
    await this.ensureDirectories();
    const pending = await readJsonFiles(this.inboxDirectory);
    const conflicts = includeConflicts ? await readJsonFiles(this.conflictsDirectory) : [];
    return { pending, conflicts };
  }
}

function validateFeedback(feedback, registryEntry) {
  if (!feedback || typeof feedback !== "object") {
    throw new Error("Feedback payload must be an object.");
  }
  if (!registryEntry) {
    throw new Error(`Unknown asset "${feedback.assetId}".`);
  }
  if (!registryEntry.prepared.elementIds.includes(feedback.elementId)) {
    throw new Error(
      `Unknown element "${feedback.elementId}" for asset "${feedback.assetId}".`,
    );
  }
  if (!["style", "properties", "annotations"].includes(feedback.kind)) {
    throw new Error(`Unsupported feedback kind "${feedback.kind}".`);
  }
  if (typeof feedback.sourceHash !== "string" || feedback.sourceHash === "") {
    throw new Error("Feedback sourceHash is required.");
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
    const value = JSON.parse(await readFile(absolutePath, "utf8"));
    values.push({ path: absolutePath, ...value });
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
