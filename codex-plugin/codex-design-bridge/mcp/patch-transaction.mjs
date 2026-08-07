import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const TRANSACTION_VERSION = 1;
const DEFAULT_LIMIT = 20;

export function hashContent(value) {
  return createHash("sha256").update(toBuffer(value)).digest("hex");
}

export async function commitPatchTransaction({
  projectDir,
  writes,
  kind = "figma-change",
  parentTransactionId = "",
  undoable = true,
  limit = DEFAULT_LIMIT,
  faultInjector = null,
}) {
  const root = path.resolve(projectDir);
  const operations = normalizeWrites(root, writes);
  if (operations.length === 0) {
    return {
      transactionId: "",
      changedFiles: [],
      undoAvailable: false,
      status: "noop",
    };
  }

  const transactionId = `${Date.now()}-${randomUUID()}`;
  const transactionRoot = path.join(
    root,
    ".figma-sync",
    "transactions",
    transactionId,
  );
  const backupRoot = path.join(transactionRoot, "backups");
  await mkdir(backupRoot, { recursive: true });

  const entries = [];
  const staged = [];
  const committed = [];
  let journal = {
    version: TRANSACTION_VERSION,
    transactionId,
    kind,
    parentTransactionId,
    undoable: Boolean(undoable),
    status: "planning",
    createdAt: new Date().toISOString(),
    completedAt: "",
    files: [],
  };

  try {
    for (const [index, operation] of operations.entries()) {
      const before = await readFileState(operation.file);
      if (
        operation.expectedHash !== undefined &&
        operation.expectedHash !== before.hash
      ) {
        throw transactionError(
          "source_conflict",
          `Source changed before patch: ${relativePath(root, operation.file)}`,
        );
      }

      const afterHash = operation.delete
        ? null
        : hashContent(operation.content);
      if (
        (!operation.delete && before.hash === afterHash) ||
        (operation.delete && !before.exists)
      ) {
        continue;
      }

      const backupName = `${String(index).padStart(4, "0")}.bin`;
      const backupPath = path.join(backupRoot, backupName);
      if (before.exists) await writeFile(backupPath, before.bytes);

      const stagePath = operation.delete
        ? ""
        : path.join(
            path.dirname(operation.file),
            `.${path.basename(operation.file)}.cdb-${transactionId}.tmp`,
          );
      if (stagePath) {
        await mkdir(path.dirname(operation.file), { recursive: true });
        await writeFile(stagePath, operation.content);
        staged.push(stagePath);
      }

      entries.push({
        absolutePath: operation.file,
        path: relativePath(root, operation.file),
        existedBefore: before.exists,
        beforeHash: before.hash,
        afterHash,
        backup: before.exists ? `backups/${backupName}` : "",
        delete: operation.delete,
        stagePath,
      });
    }

    if (entries.length === 0) {
      await rm(transactionRoot, { recursive: true, force: true });
      return {
        transactionId: "",
        changedFiles: [],
        undoAvailable: false,
        status: "noop",
      };
    }

    journal = {
      ...journal,
      status: "staged",
      files: entries.map(publicEntry),
    };
    await writeJournal(transactionRoot, journal);

    for (const [index, entry] of entries.entries()) {
      if (typeof faultInjector === "function") {
        await faultInjector({ phase: "before-commit", index, entry: publicEntry(entry) });
      }
      const current = await readFileState(entry.absolutePath);
      if (current.hash !== entry.beforeHash) {
        throw transactionError(
          "source_conflict",
          `Source changed during patch: ${entry.path}`,
        );
      }
      if (entry.delete) {
        await rm(entry.absolutePath, { force: true });
      } else {
        await rename(entry.stagePath, entry.absolutePath);
        removeFromArray(staged, entry.stagePath);
      }
      // From this point onward the target may have changed. Record it before
      // verification so every post-rename failure is covered by rollback.
      committed.push(entry);
      const verified = await readFileState(entry.absolutePath);
      if (verified.hash !== entry.afterHash) {
        throw transactionError(
          "patch_verify_failed",
          `Patch verification failed: ${entry.path}`,
        );
      }
    }

    journal = {
      ...journal,
      status: "committed",
      completedAt: new Date().toISOString(),
    };
    await writeJournal(transactionRoot, journal);
    await pruneTransactions(root, limit);
    return {
      transactionId,
      changedFiles: entries.map((entry) => entry.path),
      undoAvailable: Boolean(undoable),
      status: "committed",
    };
  } catch (error) {
    const rollbackErrors = await rollbackEntries(committed, transactionRoot);
    await Promise.all(
      staged.map((file) => rm(file, { force: true }).catch(() => undefined)),
    );
    journal = {
      ...journal,
      status: rollbackErrors.length > 0 ? "rollback_failed" : "rolled_back",
      completedAt: new Date().toISOString(),
      error: {
        code: error.code || "patch_commit_failed",
        message: error.message || "Patch transaction failed",
      },
      rollbackErrors,
    };
    await writeJournal(transactionRoot, journal).catch(() => undefined);
    error.code ||= "patch_commit_failed";
    error.transactionId = transactionId;
    error.rollbackErrors = rollbackErrors;
    throw error;
  }
}

export async function undoLastPatchTransaction(projectDir) {
  const root = path.resolve(projectDir);
  const transaction = await latestUndoableTransaction(root);
  if (!transaction) {
    return {
      transactionId: "",
      undoneTransactionId: "",
      changedFiles: [],
      undoAvailable: false,
      status: "nothing_to_undo",
    };
  }

  const writes = [];
  for (const entry of transaction.journal.files) {
    const absolutePath = resolveInside(root, path.resolve(root, entry.path));
    if (!absolutePath) {
      throw transactionError("invalid_transaction_path", entry.path);
    }
    const current = await readFileState(absolutePath);
    if (current.hash !== entry.afterHash) {
      throw transactionError(
        "undo_conflict",
        `Source changed after the last Design Bridge patch: ${entry.path}`,
      );
    }
    writes.push({
      file: absolutePath,
      expectedHash: entry.afterHash,
      delete: !entry.existedBefore,
      content: entry.existedBefore
        ? await readFile(path.join(transaction.root, entry.backup))
        : null,
    });
  }

  const result = await commitPatchTransaction({
    projectDir: root,
    writes,
    kind: "undo",
    parentTransactionId: transaction.journal.transactionId,
    undoable: false,
  });
  const updated = {
    ...transaction.journal,
    status: "undone",
    undoneAt: new Date().toISOString(),
    undoTransactionId: result.transactionId,
  };
  await writeJournal(transaction.root, updated);
  return {
    ...result,
    undoneTransactionId: transaction.journal.transactionId,
    undoAvailable: false,
  };
}

function normalizeWrites(root, writes) {
  const seen = new Set();
  const normalized = [];
  for (const write of Array.isArray(writes) ? writes : []) {
    const file = resolveInside(root, path.resolve(write?.file || ""));
    if (!file) {
      throw transactionError("path_outside_project", String(write?.file || ""));
    }
    const key = file.toLowerCase();
    if (seen.has(key)) {
      throw transactionError("duplicate_patch_target", relativePath(root, file));
    }
    seen.add(key);
    const deleting = write.delete === true;
    normalized.push({
      file,
      content: deleting ? null : toBuffer(write.content),
      delete: deleting,
      expectedHash:
        write.expectedHash === undefined ? undefined : write.expectedHash,
    });
  }
  return normalized;
}

async function rollbackEntries(entries, transactionRoot) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (!entry.existedBefore) {
        await rm(entry.absolutePath, { force: true });
        continue;
      }
      const backup = await readFile(path.join(transactionRoot, entry.backup));
      await writeAtomically(entry.absolutePath, backup);
    } catch (error) {
      errors.push({ path: entry.path, message: error.message });
    }
  }
  return errors;
}

async function writeAtomically(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.cdb-restore-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function latestUndoableTransaction(root) {
  const directory = path.join(root, ".figma-sync", "transactions");
  let names;
  try {
    names = (await readdir(directory)).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const transactionRoot = path.join(directory, name);
    try {
      const journal = JSON.parse(
        await readFile(path.join(transactionRoot, "transaction.json"), "utf8"),
      );
      if (journal.status === "committed" && journal.undoable !== false) {
        return { root: transactionRoot, journal };
      }
    } catch {
      // Ignore incomplete or corrupt historical records.
    }
  }
  return null;
}

async function pruneTransactions(root, limit) {
  const directory = path.join(root, ".figma-sync", "transactions");
  const names = (await readdir(directory)).sort().reverse();
  await Promise.all(
    names
      .slice(Math.max(1, Number(limit) || DEFAULT_LIMIT))
      .map((name) =>
        rm(path.join(directory, name), { recursive: true, force: true }),
      ),
  );
}

async function writeJournal(transactionRoot, journal) {
  await mkdir(transactionRoot, { recursive: true });
  const target = path.join(transactionRoot, "transaction.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readFileState(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      throw transactionError("patch_target_not_file", file);
    }
    const bytes = await readFile(file);
    return { exists: true, bytes, hash: hashContent(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, bytes: Buffer.alloc(0), hash: null };
    }
    throw error;
  }
}

function publicEntry(entry) {
  return {
    path: entry.path,
    existedBefore: entry.existedBefore,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    backup: entry.backup,
    delete: entry.delete,
  };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ""), "utf8");
}

function resolveInside(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? value
    : relative === ""
      ? value
      : "";
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function removeFromArray(values, value) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function transactionError(code, message) {
  return Object.assign(new Error(message), { code });
}
