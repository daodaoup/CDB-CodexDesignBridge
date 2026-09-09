import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("standalone runtime verifier proves daemon crash recovery", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "cdb-runtime-verifier-test-"),
  );
  const reportPath = path.join(temporaryRoot, "report.json");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = await run(process.execPath, [
    path.resolve("scripts", "verify-local-runtime.mjs"),
    "--report",
    reportPath,
  ]);

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.platform, process.platform);
  assert.notEqual(report.originalPid, report.recoveredPid);
  assert.equal(report.projectRecovered, true);
  assert.equal(report.pageRecovered, true);
  assert.equal(report.previewRecovered, true);
  assert.equal(report.leaseRecovered, true);
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
