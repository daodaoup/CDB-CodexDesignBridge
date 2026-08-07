import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyDesignPreflightFixes,
  createDesignProject,
  createFigmaSeedProject,
  preflightDesignProject,
} from "../codex-plugin/codex-design-bridge/mcp/project-contract.mjs";

test("creates a native CDB project that passes preflight", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-create-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));

  const created = await createDesignProject({
    workspaceDir,
    description: "A calm portfolio for an independent photographer",
    projectName: "photo-portfolio",
  });

  assert.equal(path.basename(created.projectDir), "photo-portfolio");
  for (const relative of [
    "index.html",
    "styles.css",
    "AGENTS.md",
    ".cdb/manifest.json",
  ]) {
    assert.ok(await readFile(path.join(created.projectDir, relative), "utf8"));
  }
  const assets = await import("node:fs/promises").then(({ stat }) =>
    stat(path.join(created.projectDir, "assets")),
  );
  assert.equal(assets.isDirectory(), true);

  const manifest = JSON.parse(
    await readFile(path.join(created.projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.pages.length, 1);
  assert.equal(manifest.pages[0].entry, "index.html");
  assert.equal(manifest.pages[0].route, "/");

  const report = await preflightDesignProject(created.projectDir);
  assert.equal(report.status, "pass", JSON.stringify(report.issues));
  assert.equal(report.pageCount, 1);
  assert.ok(report.estimatedEditableLayers > 0);
});

test("creates a preflight-ready Figma seed project", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-figma-seed-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));

  const created = await createFigmaSeedProject({
    workspaceDir,
    projectName: "from-figma",
  });
  const manifest = JSON.parse(
    await readFile(path.join(created.projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.source.kind, "figma-seed");
  const report = await preflightDesignProject(created.projectDir);
  assert.equal(report.status, "pass", JSON.stringify(report.issues));
  assert.equal(report.pages.length, 1);
  assert.match(
    await readFile(path.join(created.projectDir, "index.html"), "utf8"),
    /data-codex-root data-codex-id="page-root"/,
  );
});

test("applies only report-bound safe fixes and rejects stale plans", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-preflight-fix-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, ".cdb"));
  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>Needs IDs</title><main><h1>Hello</h1><p>World</p></main>",
    "utf8",
  );
  await writeManifest(projectDir);

  const before = await preflightDesignProject(projectDir);
  assert.equal(before.status, "safe_fix");
  const fixIds = before.issues.map((issue) => issue.fixId).filter(Boolean);
  assert.deepEqual(fixIds.sort(), ["ids:add:home", "root:add:home"]);

  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>Changed</title><main><h1>Hello</h1><p>World</p></main>",
    "utf8",
  );
  await assert.rejects(
    applyDesignPreflightFixes({
      projectDir,
      reportId: before.reportId,
      sourceHash: before.sourceHash,
      fixIds,
    }),
    /重新运行预检/,
  );

  const current = await preflightDesignProject(projectDir);
  const fixed = await applyDesignPreflightFixes({
    projectDir,
    reportId: current.reportId,
    sourceHash: current.sourceHash,
    fixIds: current.issues.map((issue) => issue.fixId).filter(Boolean),
  });
  assert.equal(fixed.report.status, "pass", JSON.stringify(fixed.report.issues));
  const html = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.equal((html.match(/data-codex-root/g) || []).length, 1);
  assert.match(html, /data-codex-id="page-root"/);
});

test("blocks duplicate IDs, missing resources, remote assets, and unsafe SVG", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-preflight-block-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, ".cdb"));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html><title>Unsafe</title>",
      '<main data-codex-root data-codex-id="root">',
      '<h1 data-codex-id="duplicate">Hello</h1>',
      '<p data-codex-id="duplicate">World</p>',
      '<img data-codex-id="missing-image" src="assets/missing.png">',
      '<img data-codex-id="remote-image" src="https://example.com/a.png">',
      '<svg data-codex-id="unsafe-svg" onload="alert(1)"></svg>',
      "</main>",
    ].join(""),
    "utf8",
  );
  await writeManifest(projectDir);

  const report = await preflightDesignProject(projectDir);
  assert.equal(report.status, "blocker");
  const codes = new Set(report.issues.map((issue) => issue.code));
  for (const code of [
    "mapping_id_duplicate",
    "resource_missing",
    "cross_origin_resource",
    "unsafe_svg",
  ]) {
    assert.equal(codes.has(code), true, `missing ${code}`);
  }
});

test("allows safe inline SVG before a normal page script", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-preflight-svg-script-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, ".cdb"));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html><title>Music</title>",
      '<main data-codex-root data-codex-id="root">',
      '<svg data-codex-id="play-icon" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></svg>',
      '<p data-codex-id="title">Player</p>',
      "</main>",
      '<script src="script.js"></script>',
    ].join(""),
    "utf8",
  );
  await writeFile(path.join(projectDir, "script.js"), "console.log('ready');", "utf8");
  await writeManifest(projectDir);

  const report = await preflightDesignProject(projectDir);
  assert.equal(report.status, "pass", JSON.stringify(report.issues));
  assert.equal(report.issues.some((issue) => issue.code === "unsafe_svg"), false);
});

test("still blocks executable content inside an SVG fragment", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-preflight-svg-unsafe-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, ".cdb"));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html><title>Unsafe SVG</title>",
      '<main data-codex-root data-codex-id="root">',
      '<svg data-codex-id="icon" viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0h1v1Z"/></svg>',
      "</main>",
    ].join(""),
    "utf8",
  );
  await writeManifest(projectDir);

  const report = await preflightDesignProject(projectDir);
  assert.equal(report.status, "blocker");
  assert.equal(report.issues.some((issue) => issue.code === "unsafe_svg"), true);
});

test("infers finite tab states for a static project without a manifest", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cdb-infer-tab-states-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html><title>Music</title>",
      '<main data-codex-root data-codex-id="app-root">',
      '  <section class="is-active" data-screen="home" data-codex-id="home-screen"><h1 data-codex-id="home-title">Home</h1></section>',
      '  <section data-screen="discover" data-codex-id="discover-screen" hidden><h1 data-codex-id="discover-title">Discover</h1></section>',
      '  <section data-screen="library" data-codex-id="library-screen" hidden><h1 data-codex-id="library-title">Library</h1></section>',
      '  <nav data-codex-id="tab-bar">',
      '    <button data-target="home" data-codex-id="home-tab">Home</button>',
      '    <button data-target="discover" data-codex-id="discover-tab">Discover</button>',
      '    <button data-target="library" data-codex-id="library-tab">Library</button>',
      "  </nav>",
      "</main>",
    ].join("\n"),
    "utf8",
  );

  const report = await preflightDesignProject(projectDir);

  assert.equal(report.status, "warning", JSON.stringify(report.issues));
  assert.equal(report.pageCount, 3);
  assert.deepEqual(
    report.pages.map((page) => page.name),
    ["Home", "Discover", "Library"],
  );
  assert.deepEqual(report.pages[1].captureState, {
    kind: "tab",
    target: "discover",
  });
});

async function writeManifest(projectDir) {
  await writeFile(
    path.join(projectDir, ".cdb", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: "test-project",
      name: "Test project",
      source: { kind: "test", root: "." },
      entry: "index.html",
      pages: [
        {
          id: "home",
          name: "Home",
          entry: "index.html",
          route: "/",
          captureRoot: "[data-codex-root]",
          viewport: { width: 1440, height: 900 },
        },
      ],
      assets: { roots: ["assets"], allowRemote: false },
      mapping: { attribute: "data-codex-id", requireUnique: true },
      runtime: { dom: "static", spa: false },
    }),
    "utf8",
  );
}
