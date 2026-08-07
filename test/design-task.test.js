import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CodexRunner,
  describeCodexSoftFailure,
  resolveCodexInvocation,
  runCodexProcess,
} from "../src/codex-runner.js";
import {
  DesignTaskStore,
  validateDesignSnapshot,
} from "../src/design-task-store.js";

test("stores a selected Figma design as structured files and assets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-design-task-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DesignTaskStore(root);
  const task = await store.create(sampleDesign());

  const stored = JSON.parse(await readFile(task.designAbsolutePath, "utf8"));
  assert.equal(stored.designId, "checkout-screen");
  assert.equal(stored.root.children[0].stableId, "hero-icon");
  assert.equal(stored.root.children[0].asset.path, "assets/hero-icon.svg");
  assert.equal(stored.root.children[0].asset.base64, undefined);
  assert.ok((await stat(task.screenshotAbsolutePath)).size > 0);
  assert.ok(
    (
      await stat(
        path.join(task.taskDirectory, stored.root.children[0].asset.path),
      )
    ).size > 0,
  );

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "queued");
});

test("marks interrupted design tasks as failed when the Bridge restarts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-design-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DesignTaskStore(root);
  const task = await store.create(sampleDesign());
  await store.update(task.taskId, { state: "running" });

  assert.equal(await store.failInterrupted(), 1);
  const [recovered] = await store.list();
  assert.equal(recovered.state, "failed");
  assert.match(recovered.error, /Bridge restarted/);
});

test("rejects duplicate stable ids in arbitrary Figma snapshots", () => {
  const design = sampleDesign();
  design.root.children.push({
    ...design.root.children[0],
    nodeId: "3:3",
  });
  assert.throws(
    () => validateDesignSnapshot(design),
    /Duplicate design stableId "hero-icon"/,
  );
});

test("queues a persisted design and records the Codex result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-codex-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DesignTaskStore(root);
  const task = await store.create(sampleDesign());
  const statuses = [];
  let receivedPrompt = "";
  const runner = new CodexRunner({
    rootDirectory: root,
    taskStore: store,
    onStatus(status) {
      statuses.push(status);
    },
    async executor({ prompt, lastMessagePath }) {
      receivedPrompt = prompt;
      await writeFile(lastMessagePath, "Implemented checkout screen.\n", "utf8");
      return { exitCode: 0, stdout: "done", stderr: "" };
    },
  });

  runner.enqueue(task);
  await runner.waitForIdle();
  const status = JSON.parse(
    await readFile(path.join(task.taskDirectory, "status.json"), "utf8"),
  );
  assert.equal(status.state, "completed");
  assert.match(receivedPrompt, /untrusted design data/);
  assert.match(receivedPrompt, /design\.json/);
  assert.deepEqual(
    statuses.map((item) => item.state),
    ["running", "completed"],
  );
});

test("discovers a project-local npm Codex CLI without a shell shim", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-codex-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliPath = path.join(
    root,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");

  const invocation = await resolveCodexInvocation({
    command: "codex",
    rootDirectory: root,
    environment: {},
  });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.prefixArgs, [cliPath]);
  assert.deepEqual(invocation.environment, {});

  const electronInvocation = await resolveCodexInvocation({
    command: "codex",
    rootDirectory: root,
    environment: {},
    runtime: {
      executable: "C:\\app\\electron.exe",
      isElectron: true,
    },
  });
  assert.equal(electronInvocation.executable, "C:\\app\\electron.exe");
  assert.deepEqual(electronInvocation.prefixArgs, [cliPath]);
  assert.deepEqual(electronInvocation.environment, {
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("treats a Windows sandbox soft failure as a failed Codex task", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-codex-soft-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DesignTaskStore(root);
  const task = await store.create(sampleDesign());
  const runner = new CodexRunner({
    rootDirectory: root,
    taskStore: store,
    logger: { error() {} },
    async executor({ lastMessagePath }) {
      await writeFile(
        lastMessagePath,
        "I couldn’t update the frontend because the workspace sandbox failed during initialization. No files were changed.",
        "utf8",
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr:
          "windows sandbox: helper_unknown_error: setup refresh had errors",
      };
    },
  });

  runner.enqueue(task);
  await runner.waitForIdle();
  const status = JSON.parse(
    await readFile(path.join(task.taskDirectory, "status.json"), "utf8"),
  );
  assert.equal(status.state, "failed");
  assert.match(status.error, /sandbox failed to initialize/);
});

test("detects the known Windows sandbox failure without false completion", () => {
  assert.match(
    describeCodexSoftFailure({
      result: {
        stderr:
          "windows sandbox: helper_unknown_error: setup refresh had errors",
      },
      lastMessage:
        "I couldn’t update the frontend because the workspace sandbox failed during initialization. No files were changed.",
    }),
    /could not update/,
  );
  assert.equal(
    describeCodexSoftFailure({
      result: { stderr: "" },
      lastMessage: "No frontend changes were needed; the design already matches.",
    }),
    null,
  );
});

test("rejects launching a second Codex sandbox from inside Codex", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-codex-nested-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCodexProcess({
    command: "codex",
    rootDirectory: root,
    prompt: "test",
    lastMessagePath: path.join(root, "last.md"),
    timeoutMs: 1000,
    environment: {
      CODEX_PERMISSION_PROFILE: ":workspace",
    },
  });
  assert.equal(result.exitCode, null);
  assert.match(result.error, /started inside a Codex sandbox/);
});

test("reports an actionable error when the Codex command is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-codex-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCodexProcess({
    command: "definitely-missing-codex-command",
    rootDirectory: root,
    prompt: "test",
    lastMessagePath: path.join(root, "last.md"),
    timeoutMs: 1000,
    environment: {},
  });
  assert.equal(result.exitCode, null);
  assert.match(result.error, /Install it with `npm install -g @openai\/codex`/);
});

function sampleDesign() {
  return {
    protocolVersion: 3,
    designId: "checkout-screen",
    capturedAt: "2026-07-29T00:00:00.000Z",
    figma: {
      fileKey: "figma-file-key",
      pageId: "1:1",
      pageName: "Checkout",
      rootNodeId: "2:1",
      rootNodeName: "Checkout screen",
    },
    screenshot: {
      mimeType: "image/png",
      base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
        "base64",
      ),
      width: 960,
      height: 720,
    },
    root: {
      stableId: "checkout-root",
      nodeId: "2:1",
      name: "Checkout screen",
      type: "FRAME",
      properties: {
        width: 960,
        height: 720,
        layoutMode: "VERTICAL",
      },
      annotations: [],
      sourceRef: null,
      children: [
        {
          stableId: "hero-icon",
          nodeId: "2:2",
          name: "Hero icon",
          type: "VECTOR",
          properties: { width: 32, height: 32 },
          annotations: [],
          sourceRef: null,
          asset: {
            kind: "svg",
            mimeType: "image/svg+xml",
            base64: Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>',
            ).toString("base64"),
          },
          children: [],
        },
      ],
    },
  };
}
