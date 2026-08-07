import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitPatchTransaction,
  hashContent,
  undoLastPatchTransaction,
} from "../codex-plugin/codex-design-bridge/mcp/patch-transaction.mjs";

test("commits a multi-file patch and safely undoes it", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-transaction-"));
  const htmlFile = path.join(projectDir, "index.html");
  const cssFile = path.join(projectDir, "styles.css");
  await writeFile(htmlFile, "<h1>Before</h1>\n", "utf8");
  await writeFile(cssFile, "h1 { color: black; }\n", "utf8");
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  const result = await commitPatchTransaction({
    projectDir,
    writes: [
      {
        file: htmlFile,
        content: "<h1>After</h1>\n",
        expectedHash: hashContent("<h1>Before</h1>\n"),
      },
      {
        file: cssFile,
        content: "h1 { color: blue; }\n",
        expectedHash: hashContent("h1 { color: black; }\n"),
      },
    ],
  });

  assert.equal(result.status, "committed");
  assert.equal(result.changedFiles.length, 2);
  assert.equal(await readFile(htmlFile, "utf8"), "<h1>After</h1>\n");
  assert.equal(await readFile(cssFile, "utf8"), "h1 { color: blue; }\n");

  const undone = await undoLastPatchTransaction(projectDir);
  assert.equal(undone.status, "committed");
  assert.equal(undone.undoneTransactionId, result.transactionId);
  assert.equal(await readFile(htmlFile, "utf8"), "<h1>Before</h1>\n");
  assert.equal(await readFile(cssFile, "utf8"), "h1 { color: black; }\n");
});

test("rejects a stale source hash without changing the file", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-conflict-"));
  const file = path.join(projectDir, "index.html");
  await writeFile(file, "user change\n", "utf8");
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  await assert.rejects(
    commitPatchTransaction({
      projectDir,
      writes: [
        {
          file,
          content: "bridge change\n",
          expectedHash: hashContent("old source\n"),
        },
      ],
    }),
    (error) => error.code === "source_conflict",
  );
  assert.equal(await readFile(file, "utf8"), "user change\n");
});

test("rolls back files when a later commit fails", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-rollback-"));
  const first = path.join(projectDir, "first.txt");
  const second = path.join(projectDir, "second.txt");
  await writeFile(first, "first before", "utf8");
  await writeFile(second, "second before", "utf8");
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  await assert.rejects(
    commitPatchTransaction({
      projectDir,
      writes: [
        { file: first, content: "first after" },
        { file: second, content: "second after" },
      ],
      faultInjector({ index }) {
        if (index === 1) {
          throw Object.assign(new Error("injected failure"), {
            code: "injected_failure",
          });
        }
      },
    }),
    (error) => error.code === "injected_failure",
  );

  assert.equal(await readFile(first, "utf8"), "first before");
  assert.equal(await readFile(second, "utf8"), "second before");
});

test("refuses undo after an unrelated edit", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-undo-conflict-"));
  const file = path.join(projectDir, "index.html");
  await writeFile(file, "before", "utf8");
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  await commitPatchTransaction({
    projectDir,
    writes: [{ file, content: "after" }],
  });
  await writeFile(file, "unrelated user edit", "utf8");

  await assert.rejects(
    undoLastPatchTransaction(projectDir),
    (error) => error.code === "undo_conflict",
  );
  assert.equal(await readFile(file, "utf8"), "unrelated user edit");
});
