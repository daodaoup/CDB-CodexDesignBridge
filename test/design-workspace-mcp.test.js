import test from "node:test";
import assert from "node:assert/strict";
import { solidVisualReference } from "./helpers/visual-reference.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "../codex-plugin/codex-design-bridge/vendor/ws/wrapper.mjs";
import { commitPatchTransaction } from "../codex-plugin/codex-design-bridge/mcp/patch-transaction.mjs";

const pluginRoot = process.env.DESIGN_WORKSPACE_PLUGIN_ROOT
  ? path.resolve(process.env.DESIGN_WORKSPACE_PLUGIN_ROOT)
  : path.resolve("codex-plugin", "codex-design-bridge");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");

test("publishes one CDB launcher entry with direct project actions", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  const skill = await readFile(
    path.join(pluginRoot, "skills", "start-design", "SKILL.md"),
    "utf8",
  );
  const interfaceYaml = await readFile(
    path.join(
      pluginRoot,
      "skills",
      "start-design",
      "agents",
      "openai.yaml",
    ),
    "utf8",
  );

  assert.equal(manifest.interface.defaultPrompt, "打开 CDB");
  assert.equal(manifest.interface.displayName, "CDB");
  assert.equal(manifest.interface.composerIcon, "./assets/icon.png");
  assert.equal(manifest.interface.logo, "./assets/icon.png");
  assert.equal(manifest.interface.logoDark, "./assets/icon.png");
  const icon = await readFile(path.join(pluginRoot, "assets", "icon.png"));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(skill, /name: start-design/);
  assert.match(skill, /Bare invocation/);
  assert.match(skill, /open_cdb/);
  assert.match(skill, /create_design_project/);
  assert.match(skill, /create_figma_seed_project/);
  assert.match(skill, /open_design_workspace/);
  assert.match(interfaceYaml, /display_name: "CDB"/);
  assert.match(interfaceYaml, /\$start-design/);
});

test("publishes the design workspace as an MCP Apps resource", async (t) => {
  const client = startClient();
  t.after(() => client.close());

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "codex-design-workspace");
  assert.equal(initialized.serverInfo.version, manifestVersion());
  assert.equal(initialized.capabilities.tools.listChanged, false);

  const listed = await client.request("tools/list");
  assert.ok(listed.tools.some((tool) => tool.name === "open_cdb"));
  assert.ok(listed.tools.some((tool) => tool.name === "get_cdb_health"));
  const openTool = listed.tools.find(
    (tool) => tool.name === "open_design_workspace",
  );
  assert.ok(openTool);
  assert.equal(
    openTool._meta["ui.resourceUri"],
    "ui://codex-design-bridge/workspace-v2.html",
  );
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "send_preview_to_local_figma",
    ),
  );
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "capture_local_figma_changes",
    ),
  );
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "get_design_preview_image",
    ),
  );
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "get_design_verification_images",
    ),
  );
  assert.ok(listed.tools.some((tool) => tool.name === "focus_figma_design_node"));
  assert.ok(listed.tools.some((tool) => tool.name === "get_design_source_location"));
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "open_design_preview_in_browser",
    ),
  );
  const importTool = listed.tools.find(
    (tool) => tool.name === "import_html_project",
  );
  assert.ok(importTool);
  assert.equal(importTool.inputSchema.properties.files.maxItems, 500);
  const managePageTool = listed.tools.find(
    (tool) => tool.name === "manage_design_workspace_page",
  );
  assert.ok(managePageTool);
  assert.deepEqual(
    managePageTool.inputSchema.properties.action.enum,
    ["select", "remove"],
  );
  assert.ok(listed.tools.some((tool) => tool.name === "open_design_launcher"));
  assert.ok(listed.tools.some((tool) => tool.name === "resolve_design_source"));
  assert.ok(listed.tools.some((tool) => tool.name === "create_design_project"));
  assert.ok(listed.tools.some((tool) => tool.name === "create_figma_seed_project"));
  assert.ok(listed.tools.some((tool) => tool.name === "preflight_design_project"));
  assert.ok(listed.tools.some((tool) => tool.name === "apply_design_preflight_fixes"));
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "report_design_workspace_mounted",
    ),
  );
  assert.ok(
    listed.tools.some(
      (tool) => tool.name === "undo_last_design_patch",
    ),
  );

  const resource = await client.request("resources/read", {
    uri: "ui://codex-design-bridge/workspace-v2.html",
  });
  assert.equal(
    resource.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.match(resource.contents[0].text, /Design workspace/);
  assert.match(resource.contents[0].text, /`CDB \$\{runtimeVersion\}`/);
  assert.match(resource.contents[0].text, /id="workspaceLabel"/);
  assert.match(resource.contents[0].text, /id="versionLabel"/);
  assert.match(resource.contents[0].text, /color-scheme: dark;/);
  assert.match(resource.contents[0].text, /--bg: #0a0a0a;/);
  assert.match(resource.contents[0].text, /--surface: #111111;/);
  assert.match(resource.contents[0].text, /--accent-2: #d946ef;/);
  assert.match(resource.contents[0].text, /background-image: radial-gradient\(/);
  assert.doesNotMatch(resource.contents[0].text, /prefers-color-scheme: dark/);
  assert.match(resource.contents[0].text, /\.app\s*\{[\s\S]*?padding: 0;/);
  assert.match(
    resource.contents[0].text,
    /html,\s*body\s*\{\s*width: 100%;\s*height: 100%;\s*overflow: hidden;\s*background: transparent;/,
  );
  assert.match(resource.contents[0].text, /\.app\s*\{[\s\S]*?overflow: hidden;[\s\S]*?border-radius: 8px;/);
  assert.match(resource.contents[0].text, /\.shell\s*\{[\s\S]*?border-radius: 8px;/);
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, false);
  assert.equal(resource.contents[0]._meta["openai/widgetPrefersBorder"], false);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.redirectDomains, [
    "http://127.0.0.1:*",
    "http://localhost:*",
  ]);
  assert.match(resource.contents[0].text, /id="openHtmlButton"/);
  assert.match(resource.contents[0].text, /open_design_preview_in_browser/);
  assert.doesNotMatch(resource.contents[0].text, /id="closeButton"/);
  assert.match(resource.contents[0].text, /id="endButton"/);
  assert.match(resource.contents[0].text, /aria-label="关闭工作台"/);
  assert.match(resource.contents[0].text, /id="endDialog"/);
  assert.match(resource.contents[0].text, /end_design_session/);
  assert.match(resource.contents[0].text, /Figma 中还有尚未发送给 Codex 的修改/);
  assert.doesNotMatch(resource.contents[0].text, /workspace-collapsed/);
  assert.match(resource.contents[0].text, /id="pageList"/);
  assert.doesNotMatch(resource.contents[0].text, /id="addPageButton"/);
  assert.match(resource.contents[0].text, /id="importProjectButton" hidden/);
  assert.match(resource.contents[0].text, /导入 HTML 项目/);
  assert.match(resource.contents[0].text, /webkitdirectory/);
  assert.match(resource.contents[0].text, /import_html_project/);
  assert.match(resource.contents[0].text, /collectDroppedFiles/);
  assert.match(resource.contents[0].text, /id="sendAllButton"/);
  assert.match(resource.contents[0].text, /id="primaryButtonLabel">当前页面/);
  assert.match(resource.contents[0].text, /全部发送到 Figma/);
  assert.match(resource.contents[0].text, /id="receiveButton"/);
  assert.match(resource.contents[0].text, /重试处理/);
  assert.match(resource.contents[0].text, /handoffPendingFigmaChanges/);
  assert.match(resource.contents[0].text, /sendFollowUpMessage/);
  assert.match(
    resource.contents[0].text,
    /void handoffPendingFigmaChanges\(\);/,
  );
  assert.match(resource.contents[0].text, /CDB Figma→Codex 自动处理/);
  assert.match(resource.contents[0].text, /不要调用 open_design_launcher/);
  assert.match(resource.contents[0].text, /处理完成/);
  assert.match(resource.contents[0].text, /send_preview_to_local_figma/);
  assert.match(resource.contents[0].text, /manage_design_workspace_page/);
  assert.match(resource.contents[0].text, /get_design_preview_image/);
  assert.match(resource.contents[0].text, /get_design_verification_images/);
  assert.match(resource.contents[0].text, /focus_figma_design_node/);
  assert.match(resource.contents[0].text, /get_design_source_location/);
  assert.match(resource.contents[0].text, /id="verificationDialog"/);
  assert.match(resource.contents[0].text, /id="sourceLocationDialog"/);
  assert.match(resource.contents[0].text, /id="verificationReviewCanvas"/);
  assert.match(resource.contents[0].text, /id="verificationNodeHighlight"/);
  assert.match(resource.contents[0].text, /report_design_workspace_mounted/);
  assert.match(resource.contents[0].text, /undo_last_design_patch/);
  assert.match(
    resource.contents[0].text,
    /id="undoButton"[^>]*>撤销上次修改<\/button>/,
  );
  assert.doesNotMatch(
    resource.contents[0].text,
    /class="button icon-only" id="undoButton"/,
  );
  assert.match(resource.contents[0].text, /class="preview-frame"/);
  assert.match(resource.contents[0].text, /id="previewFallback"/);
  assert.match(resource.contents[0].text, /--preview-source-width/);
  assert.match(resource.contents[0].text, /--preview-source-height/);
  assert.match(resource.contents[0].text, /id="zoomControl"/);
  assert.match(resource.contents[0].text, /id="zoomOutButton"/);
  assert.match(resource.contents[0].text, /id="zoomInButton"/);
  assert.match(
    resource.contents[0].text,
    /\.canvas-zoom\s*\{[^}]*top:\s*18px;[^}]*right:\s*18px;[^}]*bottom:\s*auto;/s,
  );
  assert.match(
    resource.contents[0].text,
    /#resultSummary\s*\{[^}]*font-size:\s*11px;[^}]*font-weight:\s*400;/s,
  );
  assert.match(resource.contents[0].text, /id="previewModeSelect"/);
  assert.match(resource.contents[0].text, /验收 320/);
  assert.match(resource.contents[0].text, /验收 1440/);
  assert.match(resource.contents[0].text, /id="verificationCard"/);
  assert.match(resource.contents[0].text, /已通过真实渲染验收/);
  assert.match(resource.contents[0].text, /let previewZoom = 100;/);
  assert.match(resource.contents[0].text, /PREVIEW_MAX_ZOOM = 300/);
  assert.match(resource.contents[0].text, /PREVIEW_MIN_ZOOM = 50/);
  assert.match(resource.contents[0].text, /--preview-scale/);
  assert.match(resource.contents[0].text, /id="previewStage"/);
  assert.match(
    resource.contents[0].text,
    /transform: translate3d\(-50%, -50%, 0\)[\s\S]*?--preview-pan-x[\s\S]*?--preview-pan-y[\s\S]*?scale\(var\(--preview-scale, 0\.5\)\)/,
  );
  assert.match(resource.contents[0].text, /pointerdown", startPreviewPan/);
  assert.match(resource.contents[0].text, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(resource.contents[0].text, /按住拖拽视图/);
  assert.match(
    resource.contents[0].text,
    /previewZoom <= 100 && previewMode !== "one-to-one"\) resetPreviewPan\(\)/,
  );
  assert.match(resource.contents[0].text, /Math\.abs\(scaledWidth - stageWidth\)/);
  assert.match(resource.contents[0].text, /activePage\?\.viewport/);
  assert.match(resource.contents[0].text, /availableWidth \/ width/);
  assert.doesNotMatch(resource.contents[0].text, /data-device=/);
  assert.doesNotMatch(resource.contents[0].text, /aspect-ratio: 820 \/ 1024/);
  assert.doesNotMatch(resource.contents[0].text, /aspect-ratio: 390 \/ 844/);
  assert.match(resource.contents[0].text, /allow-same-origin allow-scripts/);
  assert.match(resource.contents[0].text, /function loadPreview\(\)/);
  assert.match(resource.contents[0].text, /function activePreviewUrl\(\)/);
  assert.match(resource.contents[0].text, /new URL\(pagePath, `\$\{base\.origin\}\/`\)/);
  assert.match(
    resource.contents[0].text,
    /function canUseLivePreview\(\)[\s\S]*?return false;/,
  );
  assert.match(resource.contents[0].text, /mode: requestedMode/);
  assert.match(resource.contents[0].text, /\? "inline" : "fullscreen"/);
  assert.match(resource.contents[0].text, /id="removePageButton"/);
  assert.match(resource.contents[0].text, /id="removePageDialog"/);
  assert.match(resource.contents[0].text, /HTML、CSS、图片和 Figma 画布都会保留/);
  assert.doesNotMatch(resource.contents[0].text, /className = "page-path"/);
  assert.match(resource.contents[0].text, /id="launcherView"/);
  assert.match(resource.contents[0].text, /id="launcherFigma"/);
  assert.match(resource.contents[0].text, /id="launcherDescription"/);
  assert.match(resource.contents[0].text, /apply_design_preflight_fixes/);
  assert.match(resource.contents[0].text, /window\.parent\.postMessage/);
  assert.match(
    resource.contents[0].text,
    /ui\/notifications\/tool-result/,
  );
  assert.match(resource.contents[0].text, /pluginVersion/);
  assert.match(resource.contents[0].text, /runtimeVersion/);
  assert.match(resource.contents[0].text, /sourceVersion/);
  assert.match(resource.contents[0].text, /versionStatus/);
  assert.match(resource.contents[0].text, /function ensurePolling/);
  const scripts = [
    ...resource.contents[0].text.matchAll(
      /<script>([\s\S]*?)<\/script>/g,
    ),
  ];
  assert.ok(scripts.length > 0);
  assert.doesNotThrow(() => new Function(scripts.at(-1)[1]));
  assert.match(resource.contents[0].text, /<iframe/);
  assert.doesNotMatch(resource.contents[0].text, /openExternal/);
  assert.doesNotMatch(resource.contents[0].text, /window\.open\(/);
});

test("opens the active localhost preview route through the browser helper", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-browser-open-"),
  );
  const capturePath = path.join(projectDir, "opened-url.txt");
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><title>Browser open</title><main data-codex-root data-codex-id="home-root"><h1 data-codex-id="home-title">Ready</h1></main>',
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "design.html"),
    '<!doctype html><title>Design route</title><main data-codex-root data-codex-id="design-root"><h1 data-codex-id="design-title">Design</h1></main>',
    "utf8",
  );
  await writeCdbManifest(projectDir, [
    { id: "home", name: "Home", entry: "index.html", route: "/" },
    { id: "design", name: "Design", entry: "design.html", route: "/design.html" },
  ]);
  const client = startClient({
    CODEX_DESIGN_BRIDGE_BROWSER_OPEN_CAPTURE_PATH: capturePath,
  });
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const openedWorkspace = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  const designPage = openedWorkspace.structuredContent.workspace.pages.find(
    (page) => page.id === "design",
  );
  await client.request("tools/call", {
    name: "manage_design_workspace_page",
    arguments: {
      projectDir,
      action: "select",
      pageId: designPage.id,
    },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_preview_in_browser",
    arguments: { projectDir, pageId: designPage.id },
  });
  const openedUrl = new URL(await readFile(capturePath, "utf8"));
  assert.equal(openedUrl.hostname, "127.0.0.1");
  assert.equal(openedUrl.pathname, "/design.html");
  assert.equal(openedUrl.searchParams.get("__cdb_viewport"), "1440x900");
  const browserPreviewHtml = await (await fetch(openedUrl)).text();
  assert.match(browserPreviewHtml, /data-cdb-browser-preview/);
  assert.match(browserPreviewHtml, /width: 1440px; height: 900px/);
  assert.match(opened.structuredContent.workspace.message, /默认浏览器/);
});

test("opens an unbound launcher and creates a ready native design without questions", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-launcher-"));
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-launcher-lease-"));
  const client = startClient({ CODEX_DESIGN_BRIDGE_LEASE_ROOT: leaseRoot });
  t.after(async () => {
    await client.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(leaseRoot, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });

  const launched = await client.request("tools/call", {
    name: "open_design_launcher",
    arguments: { workspaceDir },
  });
  const launcher = launched.structuredContent.workspace;
  assert.equal(launcher.mode, "launcher");
  assert.equal(launcher.projectDir, "");
  assert.equal(launcher.previewUrl, "");
  assert.equal(launcher.sessionActive, false);
  assert.equal(launcher.lease.owned, false);
  await assert.rejects(
    readFile(path.join(leaseRoot, "active-workspace.json")),
    /ENOENT/,
  );

  const created = await client.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir,
      projectName: "direct-design",
      description: "A focused launch page for a small typography studio",
    },
  });
  const workspace = created.structuredContent.workspace;
  assert.equal(workspace.mode, "workspace");
  assert.equal(workspace.phase, "ready", JSON.stringify(workspace));
  assert.equal(path.basename(workspace.projectDir), "direct-design");
  assert.match(workspace.projectName, /typography stu/i);
  assert.equal(workspace.preflightReport.status, "pass");
  assert.equal(workspace.lease.owned, true);
  for (const relative of [
    "index.html",
    "styles.css",
    "AGENTS.md",
    ".cdb/manifest.json",
  ]) {
    assert.ok(await readFile(path.join(workspace.projectDir, relative), "utf8"));
  }

  const resumed = await client.request("tools/call", {
    name: "open_cdb",
    arguments: { action: "auto", workspaceDir },
  });
  assert.equal(resumed.structuredContent.workspace.mode, "workspace");
  assert.equal(resumed.structuredContent.workspace.projectDir, workspace.projectDir);

  const seeded = await client.request("tools/call", {
    name: "create_figma_seed_project",
    arguments: { workspaceDir, projectName: "figma-first" },
  });
  const seedWorkspace = seeded.structuredContent.workspace;
  assert.equal(seedWorkspace.mode, "workspace");
  assert.equal(seedWorkspace.phase, "ready", JSON.stringify(seedWorkspace));
  assert.equal(path.basename(seedWorkspace.projectDir), "figma-first");
  assert.equal(seedWorkspace.pages[0].acceptsFigmaSeed, true);
  const seedManifest = JSON.parse(
    await readFile(
      path.join(seedWorkspace.projectDir, ".cdb", "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(seedManifest.source.kind, "figma-seed");
});

test("creates a local project from a protocol 16 offer and returns stable Figma mappings", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-create-project-"));
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-create-lease-"));
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
    CODEX_DESIGN_BRIDGE_LEASE_ROOT: leaseRoot,
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await client.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(leaseRoot, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const launched = await client.request("tools/call", {
    name: "open_design_launcher",
    arguments: { workspaceDir },
  });
  const launcherId = launched.structuredContent.workspace.launcherId;
  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sessionId = "session-create-project-1234";
  const readyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId,
    projectKey: "",
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await readyPromise;

  const offerId = "offer-create-project-1234";
  const offerAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figmaFileKey: "figma-file-create-project",
    rootNodeId: "84:1",
    rootName: "New Site",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: "old-project-key",
    linkedPageId: "old-page-id",
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await offerAckPromise).state, "pending");

  const acceptMessage = waitForSocketMessage(socket, "figma.design.accept");
  await client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: { offerId, action: "create_project", launcherId, workspaceDir },
  });
  assert.equal((await acceptMessage).target.action, "create_project");

  const resultPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figma: {
      fileKey: "figma-file-create-project",
      pageId: "7:1",
      pageName: "Designs",
      rootNodeId: "84:1",
      rootNodeName: "New Site",
    },
    pageSeed: {
      node: {
        id: "new-site-root",
        type: "frame",
        tag: "main",
        name: "New Site",
        width: 1440,
        height: 900,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: { fill: "#ffffff" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const result = await resultPromise;
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.result.action, "create_project");
  assert.equal(result.result.pageId, offerId);
  assert.notEqual(result.result.pageId, "old-page-id");
  assert.equal(result.result.entry, "index.html");
  assert.equal(result.result.route, "/");
  assert.equal(result.result.rootNodeId, "84:1");
  assert.equal(result.result.verification.status, "passed");
  assert.equal(result.result.verification.visual.status, "passed");
  assert.equal(result.result.nodeMappings.length, 1);
  assert.equal(result.result.nodeMappings[0].figmaNodeId, "84:1");
  assert.equal(result.result.nodeMappings[0].sourceRef.file, "index.html");

  const projectDir = result.result.projectDir;
  const baseline = JSON.parse(
    await readFile(
      path.join(projectDir, ".cdb", "sync-baselines", `${result.result.pageId}.json`),
      "utf8",
    ),
  );
  assert.equal(baseline.sourceHash, result.result.sourceHash);
  assert.equal(baseline.figma.rootNodeId, "84:1");
  assert.equal(baseline.nodeMappings[0].sourceRef.file, "index.html");
  assert.ok(await readFile(path.join(projectDir, "index.html"), "utf8"));
  assert.ok(await readFile(path.join(projectDir, "styles.css"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const synchronized = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  const synchronizedWorkspace = synchronized.structuredContent.workspace;
  const synchronizedPage = synchronizedWorkspace.pages.find(
    (candidate) => candidate.id === result.result.pageId,
  );
  assert.equal(synchronizedWorkspace.figmaReady, true);
  assert.equal(synchronizedPage.figmaReady, true);
  assert.equal(synchronizedPage.syncState, "synced");
  assert.equal(synchronizedPage.sourceHash, baseline.sourceHash);

  const transitioned = await client.request("tools/call", {
    name: "get_figma_design_offers",
    arguments: { launcherId },
  });
  const transitionedWorkspace = transitioned.structuredContent.workspace;
  assert.equal(transitionedWorkspace.mode, "workspace");
  assert.equal(transitionedWorkspace.projectDir, projectDir);
  assert.equal(transitionedWorkspace.activePageId, result.result.pageId);
  assert.equal(transitionedWorkspace.sessionActive, true);

  await client.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir },
  });
  socket.close();

  const relaunched = await client.request("tools/call", {
    name: "open_design_launcher",
    arguments: { workspaceDir },
  });
  const updateLauncherId = relaunched.structuredContent.workspace.launcherId;
  const updatePairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${updatePairing.wsUrl}?token=${updatePairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const updateSessionId = "session-launcher-update-1234";
  const updateReadyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId: updateSessionId,
    projectKey: "",
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await updateReadyPromise;

  const updateOfferId = "offer-launcher-update-1234";
  const updateAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: updateOfferId,
    sessionId: updateSessionId,
    figmaFileKey: "figma-file-create-project",
    rootNodeId: "84:1",
    rootName: "New Site",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: result.result.projectKey,
    linkedPageId: result.result.pageId,
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await updateAckPromise).state, "pending");

  const updateAcceptPromise = waitForSocketMessage(socket, "figma.design.accept");
  await client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: {
      offerId: updateOfferId,
      action: "update_page",
      launcherId: updateLauncherId,
      projectDir,
      pageId: result.result.pageId,
    },
  });
  assert.equal((await updateAcceptPromise).target.action, "update_page");

  const updateResultPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: updateOfferId,
    sessionId: updateSessionId,
    figma: {
      fileKey: "figma-file-create-project",
      pageId: "7:1",
      pageName: "Designs",
      rootNodeId: "84:1",
      rootNodeName: "New Site",
    },
    pageSeed: {
      node: {
        id: "new-site-root",
        type: "frame",
        tag: "main",
        name: "New Site",
        width: 1440,
        height: 900,
        opacity: 0.96,
        visible: true,
        rotation: 0,
        style: { fill: "#ffffff" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const updateResult = await updateResultPromise;
  assert.equal(updateResult.state, "completed", JSON.stringify(updateResult));
  assert.equal(updateResult.result.action, "update_page");
  assert.equal(updateResult.result.pageId, result.result.pageId);
  assert.equal(updateResult.result.rootNodeId, "84:1");
  assert.equal(updateResult.result.nodeMappings.length, 1);
  assert.equal(updateResult.result.nodeMappings[0].figmaNodeId, "84:1");
  assert.match(
    await readFile(path.join(projectDir, "styles.css"), "utf8"),
    /opacity:\s*0\.96/,
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  const updated = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  const updatedWorkspace = updated.structuredContent.workspace;
  const updatedPage = updatedWorkspace.pages.find(
    (candidate) => candidate.id === result.result.pageId,
  );
  assert.equal(updatedWorkspace.phase, "in_figma");
  assert.equal(updatedPage.syncState, "synced");
  assert.notEqual(updatedPage.sourceHash, baseline.sourceHash);
  assert.equal(updatedWorkspace.pendingChangeCount, 0);
});

test("accepts a protocol 16 offer into an existing local project as a new page", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-add-page-"));
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-add-page-lease-"));
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
    CODEX_DESIGN_BRIDGE_LEASE_ROOT: leaseRoot,
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await client.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(leaseRoot, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const created = await client.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir,
      projectName: "existing-project",
      description: "Existing local project",
    },
  });
  const projectDir = created.structuredContent.workspace.projectDir;
  const projectKey = created.structuredContent.workspace.preflightReport.projectKey;
  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sessionId = "session-add-page-1234";
  const readyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId,
    projectKey,
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await readyPromise;

  const offerId = "offer-add-page-1234";
  const offerAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figmaFileKey: "figma-file-add-page",
    rootNodeId: "42:10",
    rootName: "Pricing",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await offerAckPromise).state, "pending");

  const acceptMessage = waitForSocketMessage(socket, "figma.design.accept");
  await client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: { offerId, action: "add_page", projectDir },
  });
  assert.equal((await acceptMessage).target.action, "add_page");

  const resultPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figma: {
      fileKey: "figma-file-add-page",
      pageId: "7:1",
      pageName: "Designs",
      rootNodeId: "42:10",
      rootNodeName: "Pricing",
    },
    pageSeed: {
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
        style: { fill: "#ffffff" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const result = await resultPromise;
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.result.action, "add_page");
  assert.equal(result.result.projectDir, projectDir);
  assert.equal(result.result.preflightStatus, "pass");
  assert.equal(result.result.verification.status, "passed");
  assert.equal(result.result.verification.visual.status, "passed");
  assert.ok(result.result.transactionId);
  assert.equal(result.result.rootNodeId, "42:10");
  assert.equal(result.result.nodeMappings.length, 1);
  assert.equal(result.result.nodeMappings[0].figmaNodeId, "42:10");

  const manifest = JSON.parse(
    await readFile(path.join(projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.pages.length, 2);
  assert.equal(manifest.pages[1].entry, "pricing.html");
  assert.ok(await readFile(path.join(projectDir, "pricing.css"), "utf8"));
  const baseline = JSON.parse(
    await readFile(
      path.join(projectDir, ".cdb", "sync-baselines", `${result.result.pageId}.json`),
      "utf8",
    ),
  );
  assert.equal(baseline.figma.rootNodeId, "42:10");
  assert.equal(baseline.sourceHash, result.result.sourceHash);
  const synchronized = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  const synchronizedPage = synchronized.structuredContent.workspace.pages.find(
    (page) => page.id === result.result.pageId,
  );
  assert.equal(synchronizedPage.sourceHash, baseline.sourceHash);
  assert.equal(synchronizedPage.pageIrHash, baseline.pageIrHash);
  assert.equal(synchronizedPage.figmaReady, true);
  assert.equal(synchronizedPage.syncState, "synced");

  const updateOfferId = "offer-update-page-1234";
  const updateAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: updateOfferId,
    sessionId,
    figmaFileKey: "figma-file-add-page",
    rootNodeId: "42:10",
    rootName: "Pricing",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: projectKey,
    linkedPageId: result.result.pageId,
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await updateAckPromise).state, "pending");
  const updateAcceptMessage = waitForSocketMessage(socket, "figma.design.accept");
  await client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: {
      offerId: updateOfferId,
      action: "update_page",
      projectDir,
      pageId: result.result.pageId,
    },
  });
  assert.equal((await updateAcceptMessage).target.action, "update_page");
  const updateResultPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: updateOfferId,
    sessionId,
    figma: {
      fileKey: "figma-file-add-page",
      pageId: "7:1",
      pageName: "Designs",
      rootNodeId: "42:10",
      rootNodeName: "Pricing",
    },
    pageSeed: {
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
        style: { fill: "#111111" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750, [17, 17, 17, 255]),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const updateResult = await updateResultPromise;
  assert.equal(updateResult.state, "completed", JSON.stringify(updateResult));
  assert.equal(updateResult.result.action, "update_page");
  assert.equal(updateResult.result.rootNodeId, "42:10");
  assert.equal(updateResult.result.nodeMappings.length, 1);
  assert.equal(updateResult.result.nodeMappings[0].figmaNodeId, "42:10");
  assert.notEqual(updateResult.result.sourceHash, result.result.sourceHash);
  assert.match(
    await readFile(path.join(projectDir, "pricing.css"), "utf8"),
    /background-color:\s*#111111/i,
  );
  const replayPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.result.query",
    ...protocol16(),
    offerId: updateOfferId,
    sessionId,
  }));
  const replay = await replayPromise;
  assert.equal(replay.state, "completed");
  assert.equal(replay.result.action, "update_page");
  assert.equal(replay.result.transactionId, updateResult.result.transactionId);

  const pricingCssPath = path.join(projectDir, "pricing.css");
  await writeFile(
    pricingCssPath,
    (await readFile(pricingCssPath, "utf8")).replaceAll("#111111", "#222222"),
    "utf8",
  );
  const refreshed = await client.request("tools/call", {
    name: "refresh_design_workspace",
    arguments: { projectDir },
  });
  const pricingPage = refreshed.structuredContent.workspace.pages.find(
    (page) => page.id === result.result.pageId,
  );
  assert.equal(pricingPage.syncState, "source_changed");
  const conflictAckPromise = waitForSocketMessage(socket, "page.changes.ack", 10_000);
  socket.send(JSON.stringify({
    type: "page.changes.record",
    requestId: "pricing-conflict-request",
    changeSet: {
      ...protocol16(),
      changeSetId: "pricing-conflict-change",
      pageId: result.result.pageId,
      sourceHash: pricingPage.sourceHash,
      changes: [{
        nodeId: "pricing-root",
        nodeType: "FRAME",
        category: "visual",
        property: "fill",
        sourceRef: {
          file: "pricing.html",
          selector: '[data-codex-id="pricing-root"]',
        },
        from: { color: "#111111", opacity: 1 },
        to: { color: "#333333", opacity: 1 },
      }],
      annotations: [],
      figma: {
        fileKey: "figma-file-add-page",
        pageId: "7:1",
        rootNodeId: "42:10",
        rootNodeName: "Pricing",
      },
      pageSnapshot: {
        responsiveContract: responsiveContract(),
        pageSeed: {
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
            style: { fill: { color: "#333333", opacity: 1 } },
            children: [],
          },
        },
        report: {
          nodeCount: 1,
          resourceBytes: 0,
          resourceCount: 0,
          degradations: [],
        },
        capturedAt: new Date().toISOString(),
      },
    },
  }));
  const conflictAck = await conflictAckPromise;
  assert.equal(conflictAck.state, "pending", JSON.stringify(conflictAck));
  assert.ok(conflictAck.fastApply.conflicts.length >= 1);
  const htmlUpsertPromise = waitForSocketMessage(socket, "page.upsert", 15_000);
  const acceptHtmlPromise = client.request("tools/call", {
    name: "resolve_design_sync_conflict",
    arguments: { projectDir, resolution: "html" },
  });
  const htmlUpsert = await htmlUpsertPromise;
  assert.equal(htmlUpsert.page.conflictResolution.direction, "html");
  assert.match(
    htmlUpsert.page.conflictResolution.transactionId,
    /^conflict-html:/,
  );
  socket.send(JSON.stringify({
    type: "page.import.result",
    result: {
      ok: true,
      pageId: result.result.pageId,
      sourceHash: htmlUpsert.page.sourceHash,
      nodes: 1,
      nodeId: "42:10",
      fileKey: "figma-file-add-page",
      figmaPageId: "7:1",
      transactionId: htmlUpsert.page.conflictResolution.transactionId,
      nodeMappings: [{
        pageNodeId: "pricing-root",
        figmaNodeId: "42:10",
        nodeType: "frame",
        sourceRef: {
          file: "pricing.html",
          selector: '[data-codex-id="pricing-root"]',
        },
      }],
    },
  }));
  const acceptedHtml = await acceptHtmlPromise;
  assert.equal(
    acceptedHtml.structuredContent.workspace.lastConflictResolution,
    "html",
  );
  assert.equal(
    acceptedHtml.structuredContent.workspace.lastTransactionId,
    htmlUpsert.page.conflictResolution.transactionId,
  );
  assert.match(await readFile(pricingCssPath, "utf8"), /#222222/i);

  const htmlUndoRequestPromise = waitForSocketMessage(
    socket,
    "page.import.undo",
  );
  const undoHtmlPromise = client.request("tools/call", {
    name: "undo_design_sync_conflict_resolution",
    arguments: { projectDir },
  });
  const htmlUndoRequest = await htmlUndoRequestPromise;
  assert.equal(htmlUndoRequest.pageId, result.result.pageId);
  assert.equal(
    htmlUndoRequest.transactionId,
    htmlUpsert.page.conflictResolution.transactionId,
  );
  socket.send(JSON.stringify({
    type: "page.import.undo.result",
    requestId: htmlUndoRequest.requestId,
    pageId: htmlUndoRequest.pageId,
    transactionId: htmlUndoRequest.transactionId,
    sourceHash: updateResult.result.sourceHash,
    ok: true,
  }));
  const undoneHtml = await undoHtmlPromise;
  assert.ok(undoneHtml.structuredContent.workspace.syncConflicts.length >= 1);
  assert.equal(
    undoneHtml.structuredContent.workspace.pages.find(
      (page) => page.id === result.result.pageId,
    ).syncState,
    "conflict",
  );
  assert.match(await readFile(pricingCssPath, "utf8"), /#222222/i);

  const acceptedFigma = await client.request("tools/call", {
    name: "resolve_design_sync_conflict",
    arguments: { projectDir, resolution: "figma" },
  });
  assert.equal(acceptedFigma.structuredContent.workspace.lastConflictResolution, "figma");
  assert.ok(acceptedFigma.structuredContent.workspace.lastResolvedConflictPath);
  assert.match(await readFile(pricingCssPath, "utf8"), /#333333/i);
  const undoneConflict = await client.request("tools/call", {
    name: "undo_design_sync_conflict_resolution",
    arguments: { projectDir },
  });
  assert.ok(undoneConflict.structuredContent.workspace.syncConflicts.length >= 1);
  assert.equal(
    undoneConflict.structuredContent.workspace.pages.find(
      (page) => page.id === result.result.pageId,
    ).syncState,
    "conflict",
  );
  assert.match(await readFile(pricingCssPath, "utf8"), /#222222/i);

  const reconnectOfferId = "offer-reconnect-page-1234";
  const reconnectAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: reconnectOfferId,
    sessionId,
    figmaFileKey: "figma-file-add-page",
    rootNodeId: "43:10",
    rootName: "FAQ",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await reconnectAckPromise).state, "pending");
  const reconnectAcceptMessage = waitForSocketMessage(socket, "figma.design.accept");
  await client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: { offerId: reconnectOfferId, action: "add_page", projectDir },
  });
  await reconnectAcceptMessage;
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });

  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const reconnectReadyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId,
    projectKey,
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await reconnectReadyPromise;
  const reconnectResultPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId: reconnectOfferId,
    sessionId,
    figma: {
      fileKey: "figma-file-add-page",
      pageId: "7:1",
      pageName: "Designs",
      rootNodeId: "43:10",
      rootNodeName: "FAQ",
    },
    pageSeed: {
      node: {
        id: "faq-root",
        type: "frame",
        tag: "main",
        name: "FAQ",
        width: 1440,
        height: 900,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: { fill: "#F5F5F5" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750, [245, 245, 245, 255]),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  }));
  const reconnectResult = await reconnectResultPromise;
  assert.equal(reconnectResult.state, "completed", JSON.stringify(reconnectResult));
  assert.equal(reconnectResult.result.action, "add_page");
  assert.equal(reconnectResult.result.entry, "faq.html");
});

test("restores an accepted protocol 16 offer and its completed result across server restarts", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-restart-"));
  const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "cdb-offer-restart-lease-"));
  const clients = [];
  let socket;
  t.after(async () => {
    socket?.close();
    await Promise.allSettled(clients.map((client) => client.close()));
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(leaseRoot, { recursive: true, force: true });
  });
  const startPersistentClient = async () => {
    const bridgePort = await getFreePort();
    const client = startClient({
      CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
      CODEX_DESIGN_BRIDGE_LEASE_ROOT: leaseRoot,
    });
    clients.push(client);
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "restart-test", version: "1.0.0" },
    });
    return { client, bridgePort };
  };
  const connectFigma = async (bridgePort, projectKey, sessionId) => {
    const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
      headers: { origin: "https://www.figma.com" },
    }).then((response) => response.json());
    const next = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
      origin: "https://www.figma.com",
    });
    await new Promise((resolve, reject) => {
      next.once("open", resolve);
      next.once("error", reject);
    });
    const readyPromise = waitForSocketMessage(next, "plugin.ready");
    const inboxPromise = waitForSocketMessage(next, "figma.design.inbox");
    next.send(JSON.stringify({
      type: "plugin.hello",
      ...protocol16(),
      pluginVersion: manifestVersion().split("+")[0],
      sessionId,
      projectKey,
      importedAssetIds: [],
      importedPageIds: [],
    }));
    await readyPromise;
    return { socket: next, inbox: await inboxPromise };
  };

  const first = await startPersistentClient();
  const created = await first.client.request("tools/call", {
    name: "create_design_project",
    arguments: {
      workspaceDir,
      projectName: "restart-project",
      description: "Protocol restart recovery",
    },
  });
  const projectDir = created.structuredContent.workspace.projectDir;
  const projectKey = created.structuredContent.workspace.preflightReport.projectKey;
  const sessionId = "session-restart-1234";
  ({ socket } = await connectFigma(first.bridgePort, projectKey, sessionId));
  const offerId = "offer-restart-1234";
  const offerAckPromise = waitForSocketMessage(socket, "figma.design.offer.ack");
  socket.send(JSON.stringify({
    type: "figma.design.offer",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figmaFileKey: "figma-file-restart",
    rootNodeId: "90:1",
    rootName: "Recovery",
    rootType: "FRAME",
    width: 1440,
    height: 900,
    estimatedNodeCount: 1,
    linkedProjectKey: "",
    linkedPageId: "",
    createdAt: new Date().toISOString(),
  }));
  assert.equal((await offerAckPromise).state, "pending");
  const acceptPromise = waitForSocketMessage(socket, "figma.design.accept");
  await first.client.request("tools/call", {
    name: "accept_figma_design_offer",
    arguments: { offerId, action: "add_page", projectDir },
  });
  assert.equal((await acceptPromise).target.action, "add_page");
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
  socket = null;
  await first.client.close();

  const second = await startPersistentClient();
  await second.client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const reconnected = await connectFigma(second.bridgePort, projectKey, sessionId);
  socket = reconnected.socket;
  const restored = reconnected.inbox.offers.find((offer) => offer.offerId === offerId);
  assert.equal(restored?.state, "accepted", JSON.stringify(reconnected.inbox));
  const payload = {
    type: "figma.design.payload",
    responsiveContract: responsiveContract(),
    ...protocol16(),
    offerId,
    sessionId,
    figma: {
      fileKey: "figma-file-restart",
      pageId: "9:1",
      pageName: "Recovery file",
      rootNodeId: "90:1",
      rootNodeName: "Recovery",
    },
    pageSeed: {
      node: {
        id: "recovery-root",
        type: "frame",
        tag: "main",
        name: "Recovery",
        width: 1440,
        height: 900,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: { fill: "#202020" },
        children: [],
      },
    },
    referenceImage: solidVisualReference(1200, 750, [32, 32, 32, 255]),
    report: {
      nodeCount: 1,
      resourceBytes: 0,
      resourceCount: 0,
      degradations: [],
    },
    capturedAt: new Date().toISOString(),
  };
  const completedPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify(payload));
  const completed = await completedPromise;
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  assert.equal(completed.result.entry, "recovery.html");
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
  socket = null;
  await second.client.close();

  const third = await startPersistentClient();
  await third.client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const finalConnection = await connectFigma(third.bridgePort, projectKey, sessionId);
  socket = finalConnection.socket;
  const completedInboxOffer = finalConnection.inbox.offers.find(
    (offer) => offer.offerId === offerId,
  );
  assert.equal(completedInboxOffer?.state, "completed");
  assert.equal(
    completedInboxOffer?.result?.transactionId,
    completed.result.transactionId,
  );
  const replayPromise = waitForSocketMessage(socket, "figma.design.result");
  socket.send(JSON.stringify({
    type: "figma.design.result.query",
    ...protocol16(),
    offerId,
    sessionId,
  }));
  const replay = await replayPromise;
  assert.equal(replay.state, "completed");
  assert.equal(replay.result.transactionId, completed.result.transactionId);
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, ".cdb", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.pages.filter((page) => page.entry === "recovery.html").length, 1);
});

test("imports an isolated static HTML project and opens its pages", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-html-import-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>Current project</title><main>Current</main>",
    "utf8",
  );
  const client = startClient();
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const files = [
    {
      path: "demo-site/index.html",
      contentBase64: encode(
        '<!doctype html><style>[data-codex-root]{display:block}</style><title>首页</title><main class="page">Home</main>',
      ),
    },
    {
      path: "demo-site/pages/about.html",
      contentBase64: encode(
        "<!doctype html><title>关于我们</title><body>About</body>",
      ),
    },
    {
      path: "demo-site/assets/site.css",
      contentBase64: encode(".page { color: rebeccapurple; }"),
    },
    {
      path: "demo-site/node_modules/ignored.js",
      contentBase64: encode("throw new Error('skip');"),
    },
    {
      path: "demo-site/package-lock.json",
      contentBase64: encode("{}"),
    },
  ];

  const imported = await client.request("tools/call", {
    name: "import_html_project",
    arguments: { projectDir, projectName: "demo-site", files },
  });
  const workspace = imported.structuredContent.workspace;
  const targetDir = path.join(projectDir, ".cdb-imports", "demo-site");
  assert.equal(workspace.projectDir, targetDir);
  assert.equal(workspace.projectName, "demo-site");
  assert.equal(workspace.pages.length, 2);
  assert.equal(workspace.pages[0].path, "/");
  assert.equal(workspace.pages[0].name, "首页");
  assert.equal(workspace.pages[1].path, "/pages/about.html");
  assert.equal(workspace.activePageId, workspace.pages[0].id);
  assert.deepEqual(workspace.importSummary, {
    projectName: "demo-site",
    pageCount: 2,
    htmlFileCount: 2,
    resourceCount: 1,
    skippedFileCount: 2,
    totalBytes:
      Buffer.byteLength(
        '<!doctype html><style>[data-codex-root]{display:block}</style><title>首页</title><main class="page">Home</main>',
      ) +
      Buffer.byteLength(
        "<!doctype html><title>关于我们</title><body>About</body>",
      ) +
      Buffer.byteLength(".page { color: rebeccapurple; }"),
    targetDir,
  });
  assert.match(
    await readFile(path.join(targetDir, "index.html"), "utf8"),
    /<main class="page" data-codex-root data-codex-id="page-root">/,
  );
  assert.match(
    await readFile(path.join(targetDir, "pages", "about.html"), "utf8"),
    /<body data-codex-root data-codex-id="page-root">/,
  );
  assert.equal(
    await readFile(path.join(targetDir, "assets", "site.css"), "utf8"),
    ".page { color: rebeccapurple; }",
  );
  await assert.rejects(
    readFile(path.join(targetDir, "node_modules", "ignored.js")),
    /ENOENT/,
  );

  const importedAgain = await client.request("tools/call", {
    name: "import_html_project",
    arguments: { projectDir, projectName: "demo-site", files },
  });
  assert.equal(
    importedAgain.structuredContent.workspace.projectName,
    "demo-site-2",
  );
  assert.equal(
    importedAgain.structuredContent.workspace.projectDir,
    path.join(projectDir, ".cdb-imports", "demo-site-2"),
  );

  await assert.rejects(
    client.request("tools/call", {
      name: "import_html_project",
      arguments: {
        projectDir,
        files: [
          {
            path: "../escape.html",
            contentBase64: encode("<main>Unsafe</main>"),
          },
        ],
      },
    }),
    /不安全的文件路径/,
  );
});

test("imports finite data-screen tabs as independent capture pages", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-tab-import-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>Current project</title><main>Current</main>",
    "utf8",
  );
  const client = startClient();
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const html = [
    "<!doctype html><title>Tempo — Music Player</title>",
    '<main class="app-shell" data-codex-root>',
    '  <section class="screen is-active" data-screen="home"><h1>Home screen</h1></section>',
    '  <section class="screen" data-screen="discover" hidden><h1>Discover screen</h1></section>',
    '  <section class="screen" data-screen="library" hidden><h1>Library screen</h1></section>',
    '  <nav class="tab-bar">',
    '    <button class="nav-item is-active" data-target="home"><span>Home</span></button>',
    '    <button class="nav-item" data-target="discover"><span>Discover</span></button>',
    '    <button class="nav-item" data-target="library"><span>Library</span></button>',
    "  </nav>",
    "</main>",
    '<script src="script.js"></script>',
  ].join("\n");
  const script = [
    "const screens = [...document.querySelectorAll('[data-screen]')];",
    "document.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => {",
    "  screens.forEach((screen) => { screen.hidden = screen.dataset.screen !== button.dataset.target; });",
    "}));",
  ].join("\n");

  const imported = await client.request("tools/call", {
    name: "import_html_project",
    arguments: {
      projectDir,
      projectName: "music-tabs",
      files: [
        { path: "Music/index.html", contentBase64: encode(html) },
        { path: "Music/script.js", contentBase64: encode(script) },
      ],
    },
  });
  const workspace = imported.structuredContent.workspace;
  const targetDir = path.join(projectDir, ".cdb-imports", "music-tabs");
  const manifest = JSON.parse(
    await readFile(path.join(targetDir, ".cdb", "manifest.json"), "utf8"),
  );

  assert.deepEqual(
    workspace.pages.map((page) => page.name),
    ["Home", "Discover", "Library"],
  );
  assert.deepEqual(
    workspace.pages.map((page) => page.path),
    ["/", "/?__cdb_state=discover", "/?__cdb_state=library"],
  );
  assert.equal(workspace.importSummary.pageCount, 3);
  assert.equal(workspace.importSummary.htmlFileCount, 1);
  assert.deepEqual(manifest.pages[0].captureState, undefined);
  assert.deepEqual(manifest.pages[1].captureState, {
    kind: "tab",
    target: "discover",
  });
  assert.deepEqual(manifest.pages[2].captureState, {
    kind: "tab",
    target: "library",
  });
});

test("ends cleanly and confirms only when Figma has unsent changes", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-end-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><title>Session lifecycle</title><main data-codex-root data-codex-id="session-root"><h1 data-codex-id="session-title">Ready</h1></main>',
    "utf8",
  );
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
  });
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  assert.equal(opened.structuredContent.workspace.sessionActive, true);

  const cleanEnd = await client.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir },
  });
  assert.equal(cleanEnd.structuredContent.workspace.phase, "ended");
  assert.equal(cleanEnd.structuredContent.workspace.needsEndConfirmation, false);

  const reopened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  assert.equal(reopened.structuredContent.workspace.sessionActive, true);
  assert.equal(reopened.structuredContent.workspace.phase, "ready");

  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const pluginReady = waitForSocketMessage(socket, "plugin.ready");
  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      ...protocol16(),
      pluginVersion: manifestVersion().split("+")[0],
      sessionId: "reset-pending-session",
      importedAssetIds: [],
      importedPageIds: [],
      unsentChanges: true,
    }),
  );
  await pluginReady;

  const connected = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  assert.equal(connected.structuredContent.workspace.figmaConnected, true);
  assert.equal(connected.structuredContent.workspace.unsentChanges, true);

  const blocked = await client.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir },
  });
  assert.equal(blocked.structuredContent.workspace.sessionActive, true);
  assert.equal(blocked.structuredContent.workspace.needsEndConfirmation, true);
  assert.equal(blocked.structuredContent.workspace.unsentChanges, true);

  const ended = await client.request("tools/call", {
    name: "end_design_session",
    arguments: { projectDir, force: true },
  });
  assert.equal(ended.structuredContent.workspace.phase, "ended");
  assert.equal(ended.structuredContent.workspace.sessionActive, false);
  assert.equal(ended.structuredContent.workspace.previewUrl, "");
  assert.equal(ended.structuredContent.workspace.needsEndConfirmation, false);
  assert.equal(ended.structuredContent.workspace.summary, "本次设计已结束。");
});

test("clears Figma links without closing the active Codex project", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-reset-"),
  );
  const sourcePath = path.join(projectDir, "index.html");
  const source =
    '<!doctype html><title>Reset lifecycle</title><main data-codex-root data-codex-id="reset-root"><h1 data-codex-id="reset-title">Keep me</h1></main>';
  await writeFile(sourcePath, source, "utf8");
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
  });
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  assert.equal(opened.structuredContent.workspace.sessionActive, true);
  assert.equal(opened.structuredContent.workspace.pages.length, 1);
  const activePageId = opened.structuredContent.workspace.activePageId;
  const previewUrl = opened.structuredContent.workspace.previewUrl;

  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  const socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const pluginReady = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId: "workspace-reset-session",
    importedAssetIds: [],
    importedPageIds: [],
    unsentChanges: true,
  }));
  await pluginReady;

  const resetResult = waitForSocketMessage(socket, "workspace.reset.result");
  socket.send(JSON.stringify({ type: "workspace.reset.request" }));
  assert.equal((await resetResult).ok, true);

  const reset = await client.request("tools/call", {
    name: "get_design_workspace_state",
    arguments: { projectDir },
  });
  assert.equal(reset.structuredContent.workspace.phase, "ready");
  assert.equal(reset.structuredContent.workspace.sessionActive, true);
  assert.equal(reset.structuredContent.workspace.pages.length, 1);
  assert.equal(reset.structuredContent.workspace.pages[0].syncState, "not_imported");
  assert.equal(reset.structuredContent.workspace.pages[0].figmaReady, false);
  assert.equal(reset.structuredContent.workspace.activePageId, activePageId);
  assert.equal(reset.structuredContent.workspace.previewUrl, previewUrl);
  assert.equal(reset.structuredContent.workspace.figmaConnected, true);
  assert.equal(reset.structuredContent.workspace.unsentChanges, false);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("opens a static frontend without showing a desktop process", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><title>Visible preview</title><main data-codex-root data-codex-id="preview-root"><h1 data-codex-id="preview-title">Ready</h1></main>',
    "utf8",
  );
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  const client = startClient();
  t.after(() => client.close());
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const result = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const state = result.structuredContent.workspace;

  assert.equal(state.projectName, path.basename(projectDir));
  assert.equal(state.pluginVersion, manifestVersion());
  assert.equal(state.runtimeVersion, manifestVersion());
  assert.equal(state.sourceVersion, manifestVersion());
  assert.equal(state.runtimeSource, expectedRuntimeSource());
  assert.equal(state.versionStatus, "current");
  assert.equal(state.versionMessage, "");
  assert.equal(state.phase, "ready", JSON.stringify(state));
  assert.equal(state.workspaceMounted, false);
  assert.match(state.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(await (await fetch(state.previewUrl)).text(), /Ready/);

  const mounted = await client.request("tools/call", {
    name: "report_design_workspace_mounted",
    arguments: { projectDir },
  });
  assert.equal(mounted.structuredContent.workspace.workspaceMounted, true);
  assert.match(
    mounted.structuredContent.workspace.uiMountedAt,
    /^\d{4}-\d{2}-\d{2}T/,
  );

  const preview = await client.request("tools/call", {
    name: "get_design_preview_image",
    arguments: { projectDir, width: 390, height: 844 },
  });
  assert.match(
    preview.structuredContent.previewImage.dataUrl,
    /^data:image\/png;base64,/,
  );
  assert.equal(preview.structuredContent.previewImage.width, 390);
  assert.equal(preview.structuredContent.previewImage.height, 844);
});

test("manages and persists multiple workspace routes", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-pages-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><title>Routes</title><main data-codex-root data-codex-id="routes-root"><h1 data-codex-id="routes-title">Route preview</h1></main>',
    "utf8",
  );
  await writeCdbManifest(projectDir, [
    { id: "home", name: "首页", entry: "index.html", route: "/" },
    { id: "settings", name: "团队设置", entry: "index.html", route: "/settings?tab=team" },
  ]);
  const firstClient = startClient();
  let secondClient;
  t.after(async () => {
    await firstClient.close();
    await secondClient?.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await firstClient.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await firstClient.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const homePage = opened.structuredContent.workspace.pages[0];
  assert.equal(opened.structuredContent.workspace.pages.length, 2);
  assert.equal(homePage.name, "首页");
  assert.equal(homePage.path, "/");
  assert.equal(homePage.projectSourceHash, homePage.sourceHash);
  assert.equal(opened.structuredContent.workspace.activePageId, homePage.id);

  const settingsPage = opened.structuredContent.workspace.pages.find(
    (page) => page.path === "/settings?tab=team",
  );
  assert.ok(settingsPage);
  assert.equal(settingsPage.id, "settings");
  const selectedSettings = await firstClient.request("tools/call", {
    name: "manage_design_workspace_page",
    arguments: { projectDir, action: "select", pageId: settingsPage.id },
  });
  assert.equal(
    selectedSettings.structuredContent.workspace.activePageId,
    settingsPage.id,
  );
  const selected = await firstClient.request("tools/call", {
    name: "manage_design_workspace_page",
    arguments: { projectDir, action: "select", pageId: homePage.id },
  });
  assert.equal(selected.structuredContent.workspace.activePageId, homePage.id);
  await assert.rejects(
    firstClient.request("tools/call", {
      name: "manage_design_workspace_page",
      arguments: { projectDir, action: "add", name: "外部页面", path: "/new" },
    }),
    /manifest/,
  );

  const binding = JSON.parse(
    await readFile(path.join(projectDir, ".codex", "design-bridge.json"), "utf8"),
  );
  assert.equal(binding.version, 3);
  assert.equal(binding.runtimeIdentity.exactBuild, manifestVersion());
  assert.equal(binding.pages.length, 2);
  assert.equal(binding.activePageId, homePage.id);

  await firstClient.close();
  secondClient = startClient();
  await secondClient.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const reopened = await secondClient.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  assert.equal(reopened.structuredContent.workspace.pages.length, 2);
  assert.equal(reopened.structuredContent.workspace.activePageId, homePage.id);
  assert.equal(
    reopened.structuredContent.workspace.pages.find(
      (page) => page.id === settingsPage.id,
    ).name,
    "团队设置",
  );

  const removed = await secondClient.request("tools/call", {
    name: "manage_design_workspace_page",
    arguments: { projectDir, action: "remove", pageId: settingsPage.id },
  });
  assert.equal(removed.structuredContent.workspace.pages.length, 1);
  assert.equal(removed.structuredContent.workspace.activePageId, homePage.id);
  assert.equal(removed.structuredContent.workspace.undoAvailable, true);
  assert.deepEqual(removed.structuredContent.workspace.changedFiles, [
    ".cdb/manifest.json",
  ]);
  assert.match(removed.structuredContent.workspace.summary, /源码文件和 Figma 画布均未删除/);
  assert.equal(
    JSON.parse(await readFile(path.join(projectDir, ".cdb", "manifest.json"), "utf8")).pages.length,
    1,
  );
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8").then(Boolean), true);
  await assert.rejects(
    secondClient.request("tools/call", {
      name: "manage_design_workspace_page",
      arguments: { projectDir, action: "remove", pageId: homePage.id },
    }),
    /至少保留一个页面/,
  );

  const undone = await secondClient.request("tools/call", {
    name: "undo_last_design_patch",
    arguments: { projectDir },
  });
  assert.equal(undone.structuredContent.workspace.pages.length, 2);
  assert.equal(undone.structuredContent.workspace.undoAvailable, false);
  assert.equal(
    JSON.parse(await readFile(path.join(projectDir, ".cdb", "manifest.json"), "utf8")).pages.length,
    2,
  );
});

test("discards a project binding from any older exact build instead of restoring it", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "design-workspace-stale-binding-"));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><main data-codex-root data-codex-id="fresh-root">Fresh</main>',
    "utf8",
  );
  await writeCdbManifest(projectDir, [
    { id: "fresh", name: "Fresh", entry: "index.html", route: "/" },
  ]);
  await mkdir(path.join(projectDir, ".codex"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".codex", "design-bridge.json"),
    JSON.stringify({
      version: 2,
      figmaReady: true,
      activePageId: "fresh",
      pages: [{
        id: "fresh",
        name: "Old Fresh",
        path: "/",
        sourceHash: "a".repeat(64),
        syncState: "synced",
        figmaReady: true,
        nodeCount: 999,
      }],
    }),
    "utf8",
  );
  const client = startClient();
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const state = opened.structuredContent.workspace;
  assert.equal(state.figmaReady, false);
  assert.equal(state.pages[0].syncState, "not_imported");
  assert.equal(state.pages[0].nodeCount, 0);
  const binding = JSON.parse(
    await readFile(path.join(projectDir, ".codex", "design-bridge.json"), "utf8"),
  );
  assert.equal(binding.version, 3);
  assert.equal(binding.runtimeIdentity.exactBuild, manifestVersion());
  assert.equal(binding.figmaReady, false);
});

test("sends selected workspace routes as stable independent Figma pages", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-send-pages-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html><title>Route capture</title>",
      '<main data-codex-root data-codex-id="route-root"><h1 data-codex-id="route-title">Home</h1></main>',
      '<script>document.querySelector("h1").textContent = location.pathname;</script>',
    ].join(""),
    "utf8",
  );
  await writeCdbManifest(projectDir, [
    { id: "home", name: "Home", entry: "index.html", route: "/" },
    { id: "settings", name: "Settings", entry: "index.html", route: "/settings?tab=team" },
  ]);
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const homePage = opened.structuredContent.workspace.pages[0];
  const settingsPage = opened.structuredContent.workspace.pages.find(
    (page) => page.path === "/settings?tab=team",
  );

  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      ...protocol16(),
      pluginVersion: manifestVersion().split("+")[0],
      sessionId: "page-import-session",
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  await readyPromise;

  const firstUpsertPromise = waitForSocketMessage(socket, "page.upsert");
  const sendAllPromise = client.request("tools/call", {
    name: "send_preview_to_local_figma",
    arguments: {
      projectDir,
      pageIds: [homePage.id, settingsPage.id],
    },
  });
  const firstUpsert = await Promise.race([
    firstUpsertPromise,
    sendAllPromise.then((result) => {
      throw new Error(`send_preview_to_local_figma completed before emitting page.upsert: ${JSON.stringify(result)}`);
    }),
  ]);
  socket.send(
    JSON.stringify({
      type: "page.import.result",
      result: { ok: true, pageId: firstUpsert.page.pageId, nodes: 2 },
    }),
  );
  const secondUpsert = await waitForSocketMessage(socket, "page.upsert");
  socket.send(
    JSON.stringify({
      type: "page.import.result",
      result: { ok: true, pageId: secondUpsert.page.pageId, nodes: 2 },
    }),
  );
  const sent = await sendAllPromise;
  assert.deepEqual(
    [firstUpsert.page.pageId, secondUpsert.page.pageId],
    [homePage.id, settingsPage.id],
  );
  assert.match(firstUpsert.page.source.file, /\/$/);
  assert.match(secondUpsert.page.source.file, /\/settings\?tab=team$/);
  assert.equal(sent.structuredContent.workspace.pages.length, 2);
  assert.ok(
    sent.structuredContent.workspace.pages.every((page) => page.figmaReady),
  );
  assert.match(sent.structuredContent.workspace.summary, /已发送 2 个页面/);

  const updatePromise = waitForSocketMessage(socket, "page.upsert");
  const sendOnePromise = client.request("tools/call", {
    name: "send_preview_to_local_figma",
    arguments: { projectDir, pageIds: [settingsPage.id] },
  });
  const update = await updatePromise;
  assert.equal(update.page.pageId, settingsPage.id);
  socket.send(
    JSON.stringify({
      type: "page.import.result",
      result: { ok: true, pageId: update.page.pageId, nodes: 2 },
    }),
  );
  const resent = await sendOnePromise;
  assert.match(resent.structuredContent.workspace.summary, /已发送 1 个页面/);
  assert.ok(
    resent.structuredContent.workspace.pages.every(
      (page) => page.figmaReady && page.syncState === "synced",
    ),
  );
  assert.ok(
    resent.structuredContent.workspace.pages.every(
      (page) => page.projectSourceHash && page.projectSourceHash !== page.sourceHash,
    ),
  );
});

test("reports unsupported Figma changes as pending for a Codex handoff", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-figma-handoff-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><main data-codex-root data-codex-id="workspace">Before</main>',
    "utf8",
  );
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const pageId = opened.structuredContent.workspace.activePageId;
  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(
    JSON.stringify({
      type: "plugin.hello",
      ...protocol16(),
      pluginVersion: manifestVersion().split("+")[0],
      sessionId: "page-change-session",
      importedAssetIds: [],
      importedPageIds: [],
    }),
  );
  await readyPromise;

  const ackPromise = waitForSocketMessage(socket, "page.changes.ack");
  socket.send(
    JSON.stringify({
      type: "page.changes.record",
      requestId: "one-way-handoff",
      changeSet: {
        changeSetId: "large-redesign",
        pageId,
        sourceHash: "source-before-redesign",
        changes: [
          {
            nodeId: "workspace",
            category: "structure",
            property: "nodeClone",
            from: { nodeId: "workspace" },
            to: {
              nodeId: "figma-clone-workspace",
              idMap: [{ from: "workspace", to: "figma-clone-workspace" }],
            },
            sourceRef: { selector: '[data-codex-id="workspace"]' },
          },
        ],
        annotations: [],
      },
    }),
  );
  const ack = await ackPromise;
  assert.equal(ack.state, "pending");

  let state;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await client.request("tools/call", {
      name: "get_design_workspace_state",
      arguments: { projectDir },
    });
    state = result.structuredContent.workspace;
    if (state.pendingChangeCount === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(state.phase, "applying");
  assert.equal(state.changeCount, 1);
  assert.equal(state.appliedChangeCount, 0);
  assert.equal(state.pendingChangeCount, 1);
  assert.match(state.designSnapshotPath, /workspace-changes/);
  assert.match(state.summary, /Codex 正在处理/);
  assert.doesNotMatch(state.summary, /已应用 1 处/);

  const binding = JSON.parse(
    await readFile(path.join(projectDir, ".codex", "design-bridge.json"), "utf8"),
  );
  assert.equal(binding.pendingChangeCount, 1);
  assert.equal(binding.designSnapshotPath, state.designSnapshotPath);
});

test("verifies a protocol 16 reparent in the real preview before clearing pending", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-reparent-verify-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      "<!doctype html>",
      '<link rel="stylesheet" href="./styles.css">',
      '<main data-codex-root data-codex-id="page">',
      '  <section data-codex-id="source">',
      '    <button data-codex-id="daodao" aria-label="Daodao">daodao</button>',
      "  </section>",
      '  <section data-codex-id="target"></section>',
      "</main>",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "styles.css"),
    [
      "html, body { margin: 0; }",
      '[data-codex-id="page"] { position: relative; width: 800px; height: 600px; }',
      '[data-codex-id="source"] { position: absolute; inset: 0; }',
      '[data-codex-id="target"] { position: absolute; inset: 0; }',
      '[data-codex-id="daodao"] { position: absolute; left: 0; top: 0; width: 180px; height: 52px; }',
    ].join("\n"),
    "utf8",
  );
  const bridgePort = await getFreePort();
  const client = startClient({
    CODEX_DESIGN_BRIDGE_PORT: String(bridgePort),
  });
  let socket;
  t.after(async () => {
    socket?.close();
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const opened = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const page = opened.structuredContent.workspace.pages.find(
    (entry) => entry.id === opened.structuredContent.workspace.activePageId,
  );
  assert.ok(page?.sourceHash);
  const pairing = await fetch(`http://localhost:${bridgePort}/api/pair`, {
    headers: { origin: "https://www.figma.com" },
  }).then((response) => response.json());
  socket = new WebSocket(`${pairing.wsUrl}?token=${pairing.token}`, {
    origin: "https://www.figma.com",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyPromise = waitForSocketMessage(socket, "plugin.ready");
  socket.send(JSON.stringify({
    type: "plugin.hello",
    ...protocol16(),
    pluginVersion: manifestVersion().split("+")[0],
    sessionId: "page-reparent-session",
    importedAssetIds: [],
    importedPageIds: [],
  }));
  await readyPromise;

  const ackPromise = waitForSocketMessage(socket, "page.changes.ack");
  socket.send(JSON.stringify({
    type: "page.changes.record",
    requestId: "verified-reparent",
    changeSet: {
      ...protocol16(),
      changeSetId: "verified-reparent",
      pageId: page.id,
      sourceHash: page.sourceHash,
      referenceImage: solidVisualReference(800, 600),
      changes: [{
        nodeId: "daodao",
        nodeType: "FRAME",
        category: "structure",
        property: "nodeReparent",
        sourceRef: { selector: '[data-codex-id="daodao"]' },
        fromParentId: "source",
        toParentId: "target",
        fromParentSourceRef: { selector: '[data-codex-id="source"]' },
        toParentSourceRef: { selector: '[data-codex-id="target"]' },
        fromIndex: 0,
        toIndex: 0,
        beforeBounds: { x: 0, y: 0, width: 180, height: 52 },
        afterBounds: { x: 50, y: 60, width: 180, height: 52 },
        beforeWorldTransform: [1, 0, 0, 1, 0, 0],
        afterWorldTransform: [1, 0, 0, 1, 50, 60],
        parentLayout: "NONE",
        positioning: "ABSOLUTE",
      }],
      annotations: [],
    },
  }));
  const ack = await ackPromise;
  assert.equal(ack.state, "applied");
  assert.equal(ack.fastApply.pendingCount, 0);
  assert.equal(ack.fastApply.verification.status, "passed");
  assert.equal(ack.fastApply.verification.visual.status, "passed");
  assert.equal(ack.fastApply.verification.checkedNodes, 1);
  assert.ok(ack.fastApply.verification.maxPositionErrorPx <= 2);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.ok(
    source.indexOf('data-codex-id="target"') <
      source.indexOf('data-codex-id="daodao"'),
  );

  const failedAckPromise = waitForSocketMessage(socket, "page.changes.ack");
  socket.send(JSON.stringify({
    type: "page.changes.record",
    requestId: "failed-verification-reparent",
    changeSet: {
      ...protocol16(),
      changeSetId: "failed-verification-reparent",
      pageId: page.id,
      sourceHash: ack.sourceHash,
      changes: [{
        nodeId: "daodao",
        nodeType: "FRAME",
        category: "structure",
        property: "nodeReparent",
        sourceRef: { selector: '[data-codex-id="daodao"]' },
        fromParentId: "target",
        toParentId: "source",
        fromParentSourceRef: { selector: '[data-codex-id="target"]' },
        toParentSourceRef: { selector: '[data-codex-id="source"]' },
        fromIndex: 0,
        toIndex: 0,
        beforeBounds: { x: 50, y: 60, width: 180, height: 52 },
        afterBounds: { x: 999, y: 999, width: 180, height: 52 },
        beforeWorldTransform: [1, 0, 0, 1, 50, 60],
        afterWorldTransform: [1, 0, 0, 1, 999, 999],
        parentLayout: "HORIZONTAL",
        positioning: "AUTO",
      }],
      annotations: [],
    },
  }));
  const failedAck = await failedAckPromise;
  assert.equal(failedAck.state, "pending");
  assert.equal(failedAck.fastApply.appliedCount, 0);
  assert.equal(failedAck.fastApply.pendingCount, 1);
  assert.equal(failedAck.fastApply.verification.status, "failed");
  assert.equal(failedAck.fastApply.verification.rollback.status, "passed");
  assert.deepEqual(failedAck.fastApply.changedFiles, []);
  assert.equal(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    source,
  );

  const visualFailurePromise = waitForSocketMessage(socket, "page.changes.ack");
  socket.send(JSON.stringify({
    type: "page.changes.record",
    requestId: "failed-visual-verification",
    changeSet: {
      ...protocol16(),
      changeSetId: "failed-visual-verification",
      pageId: page.id,
      sourceHash: ack.sourceHash,
      referenceImage: solidVisualReference(800, 600, [0, 0, 0, 255]),
      changes: [{
        nodeId: "daodao",
        figmaNodeId: "123:4",
        nodeType: "FRAME",
        category: "visual",
        property: "opacity",
        sourceRef: { selector: '[data-codex-id="daodao"]' },
        from: 1,
        to: 0.5,
      }],
      annotations: [],
    },
  }));
  const visualFailure = await visualFailurePromise;
  assert.equal(visualFailure.state, "pending");
  assert.equal(visualFailure.fastApply.verification.status, "failed");
  assert.equal(visualFailure.fastApply.verification.code, "visual_verification_failed");
  assert.equal(visualFailure.fastApply.verification.visual.status, "failed");
  assert.equal(visualFailure.fastApply.verification.differences[0].nodeId, "daodao");
  assert.equal(visualFailure.fastApply.verification.differences[0].property, "opacity");
  assert.equal(visualFailure.fastApply.verification.differences[0].figmaNodeId, "123:4");
  assert.equal(visualFailure.fastApply.verification.differences[0].sourceRef.selector, '[data-codex-id="daodao"]');
  assert.deepEqual(
    visualFailure.fastApply.verification.differences[0].actualBounds,
    { x: 50, y: 60, width: 180, height: 52 },
  );
  assert.equal(visualFailure.fastApply.verification.rollback.status, "passed");
  const verificationImages = await client.request("tools/call", {
    name: "get_design_verification_images",
    arguments: { projectDir, pageId: page.id },
  });
  const comparison = verificationImages.structuredContent.verificationImages;
  assert.match(comparison.reference.dataUrl, /^data:image\/png;base64,/);
  assert.match(comparison.actual.dataUrl, /^data:image\/png;base64,/);
  assert.equal(comparison.reference.width, 800);
  assert.equal(comparison.reference.height, 600);
  assert.equal(comparison.thresholds.channelThreshold, 32);
  const sourceLocationResult = await client.request("tools/call", {
    name: "get_design_source_location",
    arguments: { projectDir, pageId: page.id, nodeId: "daodao" },
  });
  const sourceLocation = sourceLocationResult.structuredContent.sourceLocation;
  assert.equal(sourceLocation.file, "index.html");
  assert.ok(sourceLocation.line > 0);
  assert.equal(sourceLocation.selector, '[data-codex-id="daodao"]');
  assert.match(sourceLocation.snippet, /data-codex-id="daodao"/);
  const focusMessagePromise = waitForSocketMessage(socket, "page.node.locate");
  const focusResult = await client.request("tools/call", {
    name: "focus_figma_design_node",
    arguments: { projectDir, pageId: page.id, nodeId: "daodao" },
  });
  assert.equal(focusResult.structuredContent.figmaFocus.figmaNodeId, "123:4");
  assert.deepEqual(await focusMessagePromise, {
    type: "page.node.locate",
    pageId: page.id,
    figmaNodeId: "123:4",
  });
  assert.equal(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    source,
  );
});

test("reports when the running cache differs from personal plugin source", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-version-project-"),
  );
  const personalSource = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-version-source-"),
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>Version check</title>",
    "utf8",
  );
  await mkdir(path.join(personalSource, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(personalSource, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "codex-design-bridge",
      version: "9.9.9+codex.source",
    }),
    "utf8",
  );

  const client = startClient({
    CODEX_DESIGN_BRIDGE_RUNTIME_SOURCE: "personal-cache",
    CODEX_DESIGN_BRIDGE_PERSONAL_SOURCE: personalSource,
  });
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(personalSource, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const result = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const state = result.structuredContent.workspace;

  assert.equal(state.runtimeVersion, manifestVersion());
  assert.equal(state.sourceVersion, "9.9.9+codex.source");
  assert.equal(state.runtimeSource, "personal-cache");
  assert.equal(state.versionStatus, "mismatch");
  assert.match(state.versionMessage, /Fully quit Codex/);
});

test("undo tool restores the latest Design Bridge transaction", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-undo-"),
  );
  const sourceFile = path.join(projectDir, "index.html");
  const original = "<!doctype html><title>Before</title><h1>Before</h1>";
  await writeFile(sourceFile, original, "utf8");
  await commitPatchTransaction({
    projectDir,
    writes: [
      {
        file: sourceFile,
        content: "<!doctype html><title>After</title><h1>After</h1>",
      },
    ],
  });

  const client = startClient();
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });

  const result = await client.request("tools/call", {
    name: "undo_last_design_patch",
    arguments: { projectDir },
  });
  const state = result.structuredContent.workspace;
  assert.equal(await readFile(sourceFile, "utf8"), original);
  assert.equal(state.phase, "complete");
  assert.equal(state.undoAvailable, false);
  assert.match(state.lastTransactionId, /^\d+-/);
});

test("finds the dedicated macOS personal plugin source from a running cache", { skip: process.platform !== "darwin" }, async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-macos-project-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-macos-home-"),
  );
  const personalSource = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Codex Design Bridge",
    "plugins",
    "codex-design-bridge",
    ".codex-plugin",
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    "<!doctype html><title>macOS source check</title>",
    "utf8",
  );
  await mkdir(personalSource, { recursive: true });
  await writeFile(
    path.join(personalSource, "plugin.json"),
    JSON.stringify({
      name: "codex-design-bridge",
      version: manifestVersion(),
    }),
    "utf8",
  );

  const client = startClient({
    HOME: homeDir,
    CODEX_DESIGN_BRIDGE_RUNTIME_SOURCE: "personal-cache",
  });
  t.after(async () => {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const result = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const state = result.structuredContent.workspace;

  assert.equal(state.runtimeSource, "personal-cache");
  assert.equal(state.sourceVersion, manifestVersion());
  assert.equal(state.versionStatus, "current");
  assert.equal(state.versionMessage, "");
});

test("starts an npm preview script on Windows without spawn EINVAL", { skip: process.platform !== "win32" }, async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "design-workspace-npm-"),
  );
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { dev: "node preview.cjs" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "index.html"),
    '<!doctype html><main data-codex-root data-codex-id="npm-root"><h1 data-codex-id="npm-title">NPM preview</h1></main>',
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "preview.cjs"),
    [
      'const { createServer } = require("node:http");',
      "const server = createServer((_request, response) => {",
      '  response.end("Script preview ready");',
      "});",
      'server.listen(0, "127.0.0.1", () => {',
      "  const address = server.address();",
      '  console.log(`http://127.0.0.1:${address.port}/`);',
      "});",
    ].join("\n"),
    "utf8",
  );

  const client = startClient();
  t.after(async () => {
    await client.close();
    await rm(projectDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  const result = await client.request("tools/call", {
    name: "open_design_workspace",
    arguments: { projectDir },
  });
  const state = result.structuredContent.workspace;

  assert.equal(state.phase, "ready", JSON.stringify(state));
  assert.doesNotMatch(state.message, /spawn EINVAL/);
  assert.match(
    await (await fetch(state.previewUrl)).text(),
    /Script preview ready/,
  );
  assert.ok(state.startupMs >= 0);
  assert.ok(state.startupMs < 10_000);
});

async function writeCdbManifest(projectDir, pages, name = path.basename(projectDir)) {
  await mkdir(path.join(projectDir, ".cdb"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".cdb", "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        projectId: `test-${path.basename(projectDir)}`,
        name,
        source: { kind: "test", root: "." },
        entry: pages[0].entry,
        pages: pages.map((page) => ({
          captureRoot: "[data-codex-root]",
          viewport: { width: 1440, height: 900 },
          ...page,
        })),
        assets: { roots: ["assets"], allowRemote: false },
        mapping: { attribute: "data-codex-id", requireUnique: true },
        runtime: { dom: "static", spa: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function manifestVersion() {
  return JSON.parse(
    readFileSync(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  ).version;
}

function protocol16() {
  return {
    protocolVersion: 16,
    runtimeIdentity: {
      kind: "cdb-0.9-responsive-v2",
      protocolVersion: 16,
      pageIrSchemaVersion: 2,
      exactBuild: manifestVersion(),
    },
  };
}

function responsiveContract(width = 1440, height = 900) {
  return {
    designViewport: { width, height },
    runtimeViewports: [{ id: `runtime-${width}`, width, height, devicePixelRatio: 1 }],
    previewScale: { mode: "one-to-one", value: 1, breakpointId: null },
    breakpoints: [],
  };
}

function expectedRuntimeSource() {
  const normalized = pluginRoot.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.codex/plugins/cache/")) return "personal-cache";
  if (normalized.includes("/plugins/codex-design-bridge")) {
    return "personal-source";
  }
  return "workspace-source";
}

function startClient(environment = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_DESIGN_BRIDGE_PORT: "0",
      ...environment,
    },
  });
  let id = 0;
  let stdout = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
    }
  });
  child.once("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.once("exit", (code, signal) => {
    const error = new Error(
      `Design workspace server exited before replying (code ${code}, signal ${signal}).`,
    );
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  return {
    request(method, params = {}) {
      id += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    },
    close() {
      if (child.exitCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.stdin.end();
      });
    },
  };
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForSocketMessage(socket, type, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${type}.`)),
      timeoutMs,
    );
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
