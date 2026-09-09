import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workspaceRoot = path.resolve(".");
const pluginRoot = path.join(
  workspaceRoot,
  "codex-plugin",
  "codex-design-bridge",
);
const installerPath = path.join(
  workspaceRoot,
  "scripts",
  "install-codex-design-bridge.ps1",
);
const silentInstallerPath = path.join(
  workspaceRoot,
  "Install Codex Design Bridge.vbs",
);
const windowsWorkspaceLauncherPath = path.join(
  workspaceRoot,
  "Open CDB Workspace.cmd",
);
const macInstallerPath = path.join(
  workspaceRoot,
  "scripts",
  "install-codex-design-bridge-macos.sh",
);

test(
  "Windows installer validates the release without changing plugin state",
  { skip: process.platform !== "win32" },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "design-bridge-installer-"));
    const reportPath = path.join(tempDir, "report.json");
    t.after(() => rm(tempDir, { recursive: true, force: true }));

    const result = runInstaller([
      "-CheckOnly",
      "-SourcePath",
      pluginRoot,
      "-ReportPath",
      reportPath,
    ]);

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    );
    const report = JSON.parse(
      (await readFile(reportPath, "utf8")).replace(/^\uFEFF/, ""),
    );
    assert.equal(report.plugin, "codex-design-bridge");
    assert.equal(report.version, manifestVersion());
    assert.equal(report.checkOnly, true);
    assert.equal(report.status, "package-valid");
    assert.equal(report.coreFileCount, 27);
    assert.equal(Object.keys(report.hashes).length, 27);
    assert.match(report.hashes["mcp/local-workspace-server.mjs"], /^[A-F0-9]{64}$/);
    assert.match(report.hashes["mcp/browser-capture.mjs"], /^[A-F0-9]{64}$/);
    assert.match(report.hashes[".codex-plugin/plugin.json"], /^[A-F0-9]{64}$/);
    const installerSource = readFileSync(installerPath, "utf8");
    assert.match(installerSource, /Close these processes automatically and continue/);
    assert.match(installerSource, /Stop-Process -Id \$process\.Id -Force/);
    assert.match(installerSource, /\[switch\]\$WaitForExit/);
    assert.match(installerSource, /Timed out waiting for Codex\/ChatGPT to exit/);
    assert.match(installerSource, /OpenAI\\Codex\\bin/);
    const silentInstallerSource = readFileSync(silentInstallerPath, "utf8");
    assert.match(silentInstallerSource, /-WaitForExit/);
    assert.match(silentInstallerSource, /shell\.Run\(command, 0, True\)/);
    assert.doesNotMatch(silentInstallerSource, /Stop-Process|taskkill/i);
  },
);

test("Windows entrypoints bootstrap the current local runtime", () => {
  const installerSource = readFileSync(installerPath, "utf8");
  assert.match(installerSource, /codex-design-bridge-local/);
  assert.match(installerSource, /function Write-LocalMarketplace/);
  assert.match(installerSource, /plugin", "marketplace", "add"/);
  assert.match(installerSource, /function Resolve-NodeCommandPath/);
  assert.match(installerSource, /Set-McpRuntime -PluginPath \$stagingPath/);
  assert.match(installerSource, /mcpNodePath = \$mcpNodePath/);
  assert.match(installerSource, /LocalApplicationData/);

  const silentInstallerSource = readFileSync(silentInstallerPath, "utf8");
  assert.match(silentInstallerSource, /CDB 0\.9 beta/);
  assert.doesNotMatch(silentInstallerSource, /CDB 0\.7/);

  const workspaceLauncher = readFileSync(windowsWorkspaceLauncherPath, "utf8");
  assert.match(workspaceLauncher, /codex-primary-runtime\\dependencies\\node/);
  assert.match(workspaceLauncher, /scripts\\open-local-workspace\.mjs/);
  assert.match(workspaceLauncher, /where node\.exe/);
});

test(
  "macOS installer validates the release without changing plugin state",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "design-bridge-mac-check-"));
    const reportPath = path.join(tempDir, "report.json");
    t.after(() => rm(tempDir, { recursive: true, force: true }));

    const result = runMacInstaller(
      ["--check-only", "--source", pluginRoot, "--report", reportPath],
      tempDir,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.plugin, "codex-design-bridge");
    assert.equal(report.version, manifestVersion());
    assert.equal(report.checkOnly, true);
    assert.equal(report.status, "package-valid");
    assert.equal(report.coreFileCount, 27);
    assert.equal(Object.keys(report.hashes).length, 27);
    assert.match(report.hashes["mcp/local-workspace-server.mjs"], /^[a-f0-9]{64}$/);
    assert.match(report.hashes["mcp/browser-capture.mjs"], /^[a-f0-9]{64}$/);
    assert.match(report.hashes[".codex-plugin/plugin.json"], /^[a-f0-9]{64}$/);
  },
);

test(
  "macOS installer rejects an incomplete source package",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "design-bridge-mac-invalid-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));

    const result = runMacInstaller(
      ["--check-only", "--source", tempDir, "--report", path.join(tempDir, "report.json")],
      tempDir,
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Codex Design Bridge source was not found/);
  },
);

test(
  "macOS installer backs up, installs, and verifies the runtime cache",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixture = await createMacInstallerFixture("success");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));

    const result = runMacInstaller(
      [
        "--source", pluginRoot,
        "--destination-root", fixture.destinationRoot,
        "--codex-command", fixture.codexCommand,
        "--report", fixture.reportPath,
        "--skip-process-check",
        "--clean-install",
      ],
      fixture.home,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const installedManifest = JSON.parse(
      await readFile(path.join(fixture.destinationRoot, "codex-design-bridge", ".codex-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(installedManifest.version, manifestVersion());
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(fixture.destinationRoot));
    assert.ok(!entries.some((entry) => entry.startsWith("codex-design-bridge.backup-")));
    assert.equal(
      spawnSync("test", ["-d", path.join(fixture.legacyCacheRoot, "0.7.0+codex.legacy")]).status,
      0,
      "runtime caches remain available to tasks that already loaded them",
    );
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8"));
    assert.equal(report.status, "installed");
    assert.equal(report.previousVersion, "0.4.3+codex.old");
    assert.equal(report.hashesVerified, true);
    assert.equal(report.pluginListConfirmed, true);
    assert.equal(report.installedPath, fixture.cachePath);
    assert.equal(spawnSync(report.mcpNodePath, ["--version"]).status, 0);
    const installedMcpConfig = JSON.parse(
      await readFile(path.join(fixture.destinationRoot, "codex-design-bridge", ".mcp.json"), "utf8"),
    );
    assert.equal(installedMcpConfig.mcpServers.design_workspace.command, report.mcpNodePath);
    assert.deepEqual(installedMcpConfig.mcpServers.design_workspace.args, ["./mcp/gateway.mjs"]);
    const cachedMcpConfig = JSON.parse(
      await readFile(path.join(fixture.cachePath, ".mcp.json"), "utf8"),
    );
    assert.equal(cachedMcpConfig.mcpServers.design_workspace.command, report.mcpNodePath);
  },
);

test(
  "macOS installer restores the previous source and registration after failure",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixture = await createMacInstallerFixture("fail-add");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));

    const result = runMacInstaller(
      [
        "--source", pluginRoot,
        "--destination-root", fixture.destinationRoot,
        "--codex-command", fixture.codexCommand,
        "--report", fixture.reportPath,
        "--skip-process-check",
      ],
      fixture.home,
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Restoring the previous version/);
    const restoredManifest = JSON.parse(
      await readFile(path.join(fixture.destinationRoot, "codex-design-bridge", ".codex-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(restoredManifest.version, "0.4.3+codex.old");
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.deepEqual(state.installed, [
      { pluginId: "codex-design-bridge@personal", version: "0.4.3+codex.old" },
    ]);
  },
);

test(
  "macOS installer bootstraps a dedicated marketplace on first install",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixture = await createMacInstallerFixture("first-install");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await rm(path.join(fixture.home, ".agents"), { recursive: true, force: true });
    await rm(fixture.destinationRoot, { recursive: true, force: true });

    const result = runMacInstaller(
      [
        "--source", pluginRoot,
        "--codex-command", fixture.codexCommand,
        "--skip-process-check",
      ],
      fixture.home,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const localRoot = path.join(fixture.home, "Library", "Application Support", "Codex Design Bridge");
    const marketplace = JSON.parse(
      await readFile(path.join(localRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    assert.equal(marketplace.name, "codex-design-bridge-local");
    assert.equal(marketplace.plugins[0].source.path, "./plugins/codex-design-bridge");
    const installedManifest = JSON.parse(
      await readFile(path.join(localRoot, "plugins", "codex-design-bridge", ".codex-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(installedManifest.version, manifestVersion());
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.deepEqual(state.installed, [
      { pluginId: "codex-design-bridge@codex-design-bridge-local", version: manifestVersion() },
    ]);
  },
);

test(
  "Windows installer rejects an incomplete source package",
  { skip: process.platform !== "win32" },
  async (t) => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "design-bridge-installer-invalid-"),
    );
    const reportPath = path.join(tempDir, "report.json");
    t.after(() => rm(tempDir, { recursive: true, force: true }));

    const result = runInstaller([
      "-CheckOnly",
      "-SourcePath",
      tempDir,
      "-ReportPath",
      reportPath,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Codex Design Bridge source was not found/,
    );
  },
);

test(
  "Windows installer bootstraps a dedicated marketplace and runtime cache",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "design-bridge-win-install-"));
    const profile = path.join(root, "profile");
    const localAppData = path.join(root, "local-app-data");
    const statePath = path.join(root, "plugin-state.json");
    const fakeCodex = path.join(root, "fake-codex.cmd");
    const reportPath = path.join(root, "install-report.json");
    t.after(() => rm(root, { recursive: true, force: true }));

    await mkdir(profile, { recursive: true });
    await mkdir(localAppData, { recursive: true });
    await writeFile(
      fakeCodex,
      `@echo off\r\n"${process.execPath}" "${path.resolve("scripts", "test-fixtures", "fake-codex-plugin-cli.mjs")}" %*\r\n`,
      "utf8",
    );

    const result = runInstaller(
      [
        "-SourcePath", pluginRoot,
        "-CodexCommand", fakeCodex,
        "-ReportPath", reportPath,
        "-SkipProcessCheck",
      ],
      {
        ...process.env,
        USERPROFILE: profile,
        HOME: profile,
        LOCALAPPDATA: localAppData,
        CDB_FAKE_CODEX_STATE: statePath,
        CODEX_DESIGN_BRIDGE_LOCAL_MARKETPLACE_ROOT: path.join(
          localAppData,
          "Codex Design Bridge",
        ),
        PATH: `${path.dirname(process.execPath)};${process.env.PATH || ""}`,
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(
      (await readFile(reportPath, "utf8")).replace(/^\uFEFF/, ""),
    );
    assert.equal(report.status, "installed");
    assert.equal(report.marketplace, "codex-design-bridge-local");
    assert.equal(report.hashesVerified, true);
    assert.equal(report.pluginListConfirmed, true);
    assert.equal(report.mcpNodePath, process.execPath);
    assert.equal(
      report.targetPath,
      path.join(localAppData, "Codex Design Bridge", "plugins", "codex-design-bridge"),
    );
    const cachedMcp = JSON.parse(
      (await readFile(path.join(report.installedPath, ".mcp.json"), "utf8"))
        .replace(/^\uFEFF/, ""),
    );
    assert.equal(cachedMcp.mcpServers.design_workspace.command, process.execPath);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.installed, [
      {
        pluginId: "codex-design-bridge@codex-design-bridge-local",
        version: manifestVersion(),
      },
    ]);
    assert.equal(state.marketplaces[0].name, "codex-design-bridge-local");
  },
);

function runInstaller(argumentsList, environment = process.env) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installerPath,
      ...argumentsList,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      env: environment,
    },
  );
}

function runMacInstaller(argumentsList, home) {
  return spawnSync("/bin/bash", [macInstallerPath, ...argumentsList], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}`,
    },
  });
}

async function createMacInstallerFixture(mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "design-bridge-mac-install-"));
  const home = path.join(root, "home");
  const destinationRoot = path.join(home, "plugins");
  const target = path.join(destinationRoot, "codex-design-bridge");
  const marketplaceDirectory = path.join(home, ".agents", "plugins");
  const statePath = path.join(root, "plugin-state.json");
  const codexCommand = path.join(root, "fake-codex.mjs");
  const reportPath = path.join(destinationRoot, ".codex-design-bridge-install-report.json");
  const cachePath = path.join(
    home,
    ".codex",
    "plugins",
    "cache",
    "personal",
    "codex-design-bridge",
    manifestVersion(),
  );
  const legacyCacheRoot = path.join(
    home,
    ".codex",
    "plugins",
    "cache",
    "personal",
    "codex-design-bridge",
  );

  await mkdir(marketplaceDirectory, { recursive: true });
  await writeFile(
    path.join(marketplaceDirectory, "marketplace.json"),
    JSON.stringify({
      name: "personal",
      plugins: [{ name: "codex-design-bridge" }],
    }),
  );
  await mkdir(destinationRoot, { recursive: true });
  await mkdir(path.join(home, "tmp"), { recursive: true });
  await mkdir(path.join(legacyCacheRoot, "0.7.0+codex.legacy"), { recursive: true });
  await cp(pluginRoot, target, { recursive: true });
  const oldManifestPath = path.join(target, ".codex-plugin", "plugin.json");
  const oldManifest = JSON.parse(await readFile(oldManifestPath, "utf8"));
  oldManifest.version = "0.4.3+codex.old";
  await writeFile(oldManifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`);
  await writeFile(
    statePath,
    JSON.stringify({ installed: [{ pluginId: "codex-design-bridge@personal", version: oldManifest.version }] }),
  );
  await writeFile(
    codexCommand,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const statePath = ${JSON.stringify(statePath)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (args[0] !== "plugin") process.exit(2);
if (args[1] === "list") {
  process.stdout.write(JSON.stringify(state));
} else if (args[1] === "remove") {
  state.installed = [];
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write("{}");
} else if (args[1] === "add") {
  const selector = args[2];
  const marketplace = selector.split("@")[1];
  const source = marketplace === "codex-design-bridge-local"
    ? path.join(process.env.HOME, "Library", "Application Support", "Codex Design Bridge", "plugins", "codex-design-bridge")
    : path.join(process.env.HOME, "plugins", "codex-design-bridge");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, ".codex-plugin", "plugin.json"), "utf8"));
  if (mode === "fail-add" && manifest.version !== "0.4.3+codex.old") process.exit(9);
  const cache = path.join(process.env.HOME, ".codex", "plugins", "cache", marketplace, "codex-design-bridge", manifest.version);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.cpSync(source, cache, { recursive: true });
  state.installed = [{ pluginId: selector, version: manifest.version }];
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write("{}");
} else if (args[1] === "marketplace" && args[2] === "add") {
  process.stdout.write("{}");
} else if (args[1] === "marketplace" && args[2] === "remove") {
  process.stdout.write("{}");
} else if (args[1] === "marketplace" && args[2] === "list") {
  process.stdout.write(JSON.stringify({ marketplaces: [] }));
} else process.exit(3);
`,
  );
  await chmod(codexCommand, 0o755);
  return { root, home, destinationRoot, codexCommand, reportPath, cachePath, legacyCacheRoot, statePath };
}

function manifestVersion() {
  return JSON.parse(
    readFileSync(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  ).version;
}
