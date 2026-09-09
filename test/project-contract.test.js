import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyDesignPreflightFixes,
  addPageFromFigmaPayload,
  createDesignProject,
  createFigmaSeedProject,
  createProjectFromFigmaPayload,
  preflightDesignProject,
  recoverAbandonedProjectStaging,
} from "../codex-plugin/codex-design-bridge/mcp/project-contract.mjs";

test("cleans staging directories owned by a terminated generator process", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-staging-recovery-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = owner.pid;
  await new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("exit", resolve);
  });
  const abandonedProject = `.demo.cdb-create-${deadPid}-${Date.now()}`;
  const abandonedCheck = `.cdb-add-page-check-${deadPid}-ABC123`;
  const liveProject = `.live.cdb-create-${process.pid}-${Date.now()}`;
  await Promise.all([
    mkdir(path.join(workspaceDir, abandonedProject)),
    mkdir(path.join(workspaceDir, abandonedCheck)),
    mkdir(path.join(workspaceDir, liveProject)),
  ]);

  const recovered = await recoverAbandonedProjectStaging(workspaceDir);
  assert.equal(recovered.recoveredCount, 2);
  assert.deepEqual(
    new Set(recovered.removedDirectories),
    new Set([abandonedProject, abandonedCheck]),
  );
  assert.deepEqual(await readdir(workspaceDir), [liveProject]);
});

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

  const stylesheetPath = path.join(created.projectDir, "styles.css");
  const stylesheet = await readFile(stylesheetPath, "utf8");
  await writeFile(stylesheetPath, `${stylesheet}\n[data-codex-root] { opacity: 0.96; }\n`, "utf8");
  const styleChanged = await preflightDesignProject(created.projectDir);
  assert.notEqual(styleChanged.pages[0].sourceHash, report.pages[0].sourceHash);
  assert.notEqual(styleChanged.sourceHash, report.sourceHash);
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

test("atomically creates a preflighted local project from a complete Figma payload", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-figma-payload-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const created = await createProjectFromFigmaPayload({
    workspaceDir,
    projectName: "figma-home",
    pageId: "home-page",
    pageName: "首页",
    pageSeed: {
      node: {
        id: "page-root",
        type: "frame",
        tag: "main",
        name: "首页",
        width: 390,
        height: 844,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: { fill: "#FFFFFF" },
        layout: { mode: "VERTICAL", itemSpacing: 16, counterAxisSpacing: 0, padding: { top: 24, right: 24, bottom: 24, left: 24 } },
        children: [{
          id: "hero-image",
          type: "image",
          tag: "img",
          name: "Hero",
          width: 342,
          height: 180,
          opacity: 1,
          visible: true,
          rotation: 0,
          style: {},
          image: { mimeType: "image/png", base64: png },
        }],
      },
    },
  });

  assert.equal(path.basename(created.projectDir), "figma-home");
  assert.equal(created.report.status, "pass", JSON.stringify(created.report.issues));
  assert.equal(created.generated.nodeCount, 2);
  assert.equal(created.generated.resourceCount, 1);
  const manifest = JSON.parse(await readFile(path.join(created.projectDir, ".cdb", "manifest.json"), "utf8"));
  assert.equal(manifest.source.kind, "figma-payload");
  assert.equal(manifest.pages[0].id, "home-page");
  assert.deepEqual(manifest.pages[0].viewport, { width: 390, height: 844 });
  const html = await readFile(path.join(created.projectDir, "index.html"), "utf8");
  const assetName = html.match(/\.\/assets\/([a-f0-9]{32}\.png)/)?.[1];
  assert.ok(assetName);
  assert.ok(await readFile(path.join(created.projectDir, "assets", assetName)));
});

test("adds a Figma payload as a preflighted page in one existing-project transaction", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-figma-add-page-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const created = await createDesignProject({
    workspaceDir,
    description: "Existing local project",
    projectName: "existing-project",
  });
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pageSeed = {
    node: {
      id: "pricing-root",
      type: "frame",
      tag: "main",
      name: "Pricing",
      width: 1440,
      height: 900,
      opacity: 1,
      visible: true,
      rotation: 0,
      style: { fill: "#FFFFFF" },
      children: [
        {
          id: "pricing-image",
          type: "image",
          tag: "img",
          name: "Plan visual",
          width: 320,
          height: 180,
          opacity: 1,
          visible: true,
          rotation: 0,
          style: {},
          image: { mimeType: "image/png", base64: pngBytes.toString("base64") },
        },
      ],
    },
  };

  const added = await addPageFromFigmaPayload({
    projectDir: created.projectDir,
    pageId: "pricing-page",
    pageName: "Pricing",
    pageSeed,
  });

  assert.equal(added.transaction.status, "committed");
  assert.equal(added.report.status, "pass", JSON.stringify(added.report.issues));
  assert.equal(added.generated.pageId, "pricing-page");
  assert.deepEqual(
    added.transaction.changedFiles.sort(),
    [".cdb/manifest.json", "assets/4c4b6a3be1314ab86138bef4314dde02.png", "pricing.css", "pricing.html"].sort(),
  );
  const manifest = JSON.parse(
    await readFile(path.join(created.projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.pages.length, 2);
  assert.equal(manifest.pages[1].entry, "pricing.html");
  assert.deepEqual(manifest.pages[1].viewport, { width: 1440, height: 900 });
  assert.match(
    await readFile(path.join(created.projectDir, "pricing.html"), "utf8"),
    /href="\.\/pricing\.css"/,
  );

  await assert.rejects(
    addPageFromFigmaPayload({
      projectDir: created.projectDir,
      pageId: "different-id",
      pageName: "Pricing",
      pageSeed,
    }),
    (error) => error.code === "page_name_conflict",
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
