import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceLeaseManager } from "../codex-plugin/codex-design-bridge/mcp/workspace-lease.mjs";

test("a clean workspace yields its lease to the next workspace", async (t) => {
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-lease-clean-"));
  let shutdownCount = 0;
  const first = manager(leaseRoot, {
    getStatus: () => ({ unsentChanges: false }),
    onShutdown: async () => { shutdownCount += 1; },
  });
  const second = manager(leaseRoot);
  t.after(async () => {
    await Promise.all([first.stop(), second.stop()]);
    await rm(leaseRoot, { recursive: true, force: true });
  });

  assert.equal((await first.acquire({ projectKey: "project-a" })).acquired, true);
  const acquired = await second.acquire({ projectKey: "project-b" });
  assert.equal(acquired.acquired, true);
  assert.equal(first.status().owned, false);
  assert.equal(second.status().projectKey, "project-b");
  assert.equal(shutdownCount, 1);

  const lease = JSON.parse(
    await readFile(path.join(leaseRoot, "active-workspace.json"), "utf8"),
  );
  assert.equal(lease.projectKey, "project-b");
  assert.equal("controlSecret" in lease, false);
  assert.ok(lease.controlSecretRef);
});

test("unsent Figma changes do not block takeover", async (t) => {
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-lease-unsent-"));
  let forcedShutdown = false;
  const first = manager(leaseRoot, {
    getStatus: () => ({ unsentChanges: true }),
    onShutdown: async ({ force }) => { forcedShutdown = force; },
  });
  const second = manager(leaseRoot);
  t.after(async () => {
    await Promise.all([first.stop(), second.stop()]);
    await rm(leaseRoot, { recursive: true, force: true });
  });

  await first.acquire({ projectKey: "project-a" });
  const acquired = await second.acquire({ projectKey: "project-b" });
  assert.equal(acquired.acquired, true);
  assert.equal(forcedShutdown, true);
  assert.equal(first.status().owned, false);
  assert.equal(second.status().owned, true);
});

function manager(leaseRoot, overrides = {}) {
  return new WorkspaceLeaseManager({
    leaseRoot,
    heartbeatMs: 25,
    ttlMs: 250,
    getStatus: () => ({ unsentChanges: false }),
    onShutdown: async () => {},
    ...overrides,
  });
}
