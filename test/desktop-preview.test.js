import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capturePreviewPage,
  createCapturedPageManifest,
} from "../desktop/page-capture.js";
import { captureLocalPreview } from "../codex-plugin/codex-design-bridge/mcp/browser-capture.mjs";
import {
  choosePreviewScript,
  extractPreviewUrl,
  startProjectPreview,
} from "../desktop/preview-service.js";
import { preparePageManifest } from "../src/page.js";

test("chooses a frontend preview script without starting another Bridge", () => {
  assert.equal(
    choosePreviewScript({
      start: "node ./bin/figma-sync.js start",
      example: "node ./scripts/serve-example.js",
    }),
    "example",
  );
  assert.equal(
    choosePreviewScript({ dev: "vite", preview: "vite preview" }),
    "dev",
  );
});

test("extracts and normalizes a local preview URL", () => {
  assert.equal(
    extractPreviewUrl("\u001b[32mLocal: http://localhost:5173/\u001b[0m"),
    "http://localhost:5173/",
  );
  assert.equal(
    extractPreviewUrl("ready at http://0.0.0.0:3000"),
    "http://127.0.0.1:3000/",
  );
});

test("serves a static frontend with cache disabled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><title>Preview</title><h1>Ready</h1>",
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const response = await fetch(preview.url);

  assert.equal(preview.kind, "static");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /<h1>Ready<\/h1>/);
});

test("wraps a captured preview in a valid editable page manifest", () => {
  const manifest = createCapturedPageManifest(sampleSnapshot(), {
    projectName: "Codex Landing",
    previewUrl: "http://127.0.0.1:4173/",
  });
  const prepared = preparePageManifest({
    json: JSON.stringify(manifest),
    sourcePath: "pages/preview-codex-landing.figma-page.json",
  });

  assert.equal(manifest.pageId, "preview-Codex-Landing");
  assert.equal(prepared.root.children[0].type, "text");
  assert.deepEqual(prepared.nodeIds, ["landing-root", "hero-title"]);
});

test("captures a preview and saves it to the project's pages directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let destroyed = false;
  let scriptCalls = 0;
  const capture = await capturePreviewPage({
    previewUrl: "http://127.0.0.1:4173/",
    rootDirectory: root,
    createBrowserWindow() {
      return {
        webContents: {
          setWindowOpenHandler() {},
          async executeJavaScript() {
            scriptCalls += 1;
            return scriptCalls === 1 ? undefined : sampleSnapshot();
          },
        },
        async loadURL() {},
        isDestroyed() {
          return destroyed;
        },
        destroy() {
          destroyed = true;
        },
      };
    },
  });

  const saved = JSON.parse(await readFile(capture.filePath, "utf8"));
  assert.equal(saved.pageId, `preview-${path.basename(root)}`);
  assert.equal(capture.nodeCount, 2);
  assert.equal(destroyed, true);
});

test("captures adjacent inline SVGs as editable SVG nodes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-svg-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    [
      "<!doctype html>",
      '<main data-codex-id="landing-root">',
      '  <section data-codex-id="hero">',
      '    <svg data-codex-id="gray-star" aria-label="Gray star" width="124" height="86" viewBox="0 0 124 86">',
      '      <path d="M62 0L76 32H124L85 53L100 86L62 65L24 86L38 53L0 32H47Z" fill="#D9D9D9"/>',
      "    </svg>",
      '    <svg data-codex-id="red-star" aria-label="Red star" width="153" height="145" viewBox="0 0 153 145">',
      '      <path d="M76 0L94 55H152L105 89L123 145L76 111L29 145L47 89L0 55H58Z" fill="#FF0000"/>',
      "    </svg>",
      "  </section>",
      "</main>",
    ].join("\n"),
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: preview.url,
    projectDir: root,
  });
  const hero = captured.manifest.root.children.find(
    (node) => node.id === "hero",
  );
  const stars = hero.children.filter((node) =>
    ["gray-star", "red-star"].includes(node.id),
  );

  assert.deepEqual(
    stars.map((node) => node.type),
    ["svg", "svg"],
  );
  assert.match(stars[0].svg, /fill="#D9D9D9"/);
  assert.match(stars[1].svg, /fill="#FF0000"/);
});

test("activates a declared static tab state before capture", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-tab-state-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    [
      "<!doctype html>",
      '<main data-codex-root data-codex-id="app-root">',
      '  <section data-screen="home" data-codex-id="home-screen"><h1 data-codex-id="home-title">Home</h1></section>',
      '  <section data-screen="discover" data-codex-id="discover-screen" hidden><h1 data-codex-id="discover-title">Discover</h1></section>',
      '  <nav data-codex-id="tab-bar">',
      '    <button data-target="home" data-codex-id="home-tab">Home</button>',
      '    <button data-target="discover" data-codex-id="discover-tab">Discover</button>',
      "  </nav>",
      "</main>",
      "<script>",
      "  const screens = [...document.querySelectorAll('[data-screen]')];",
      "  document.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => {",
      "    screens.forEach((screen) => { screen.hidden = screen.dataset.screen !== button.dataset.target; });",
      "  }));",
      "</script>",
    ].join("\n"),
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: `${preview.url}?__cdb_state=discover`,
    projectDir: root,
    captureState: { kind: "tab", target: "discover" },
  });
  const text = collectNodeText(captured.manifest.root);

  assert.match(text, /Discover/);
  assert.doesNotMatch(text, /HomeHome/);
  assert.ok(findNode(captured.manifest.root, "discover-screen"));
  assert.equal(findNode(captured.manifest.root, "home-screen"), undefined);
});

test("captures computed SVG paint, gradients, shadows, rotation, and safe text width", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-fidelity-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    [
      "<!doctype html>",
      "<style>",
      "  main { width: 640px; height: 420px; background: #fff; }",
      "  .icon { width: 24px; height: 24px; color: rgb(109, 94, 247); }",
      "  .icon path { fill: none; stroke: currentColor; stroke-width: 2px; stroke-linecap: round; }",
      "  .linear { width: 180px; height: 96px; background: linear-gradient(135deg, #7262ff, #4e3fe0); box-shadow: 0 12px 25px rgba(86, 70, 225, .24); }",
      "  .radial { width: 80px; height: 80px; background: radial-gradient(circle at 55% 35%, #f4a95e 0 27%, transparent 28%), linear-gradient(160deg, #db4f62 0 55%, #6c1e55 56%); }",
      "  .rotated { width: 25px; height: 95px; background: #f7d8bd; transform: rotate(26deg); }",
      "  .grid { width: 120px; height: 80px; background: linear-gradient(rgba(10, 20, 30, .2) 1px, transparent 1px), linear-gradient(90deg, rgba(10, 20, 30, .2) 1px, transparent 1px); background-size: 20px 20px; }",
      "  .glass { width: 180px; height: 64px; border-top: 1px solid rgba(48, 50, 43, .5); background: rgba(255, 255, 255, .72); backdrop-filter: blur(22px); }",
      "  .version { display: inline-block; font: 700 10px/14px Inter, sans-serif; }",
      "</style>",
      '<main data-codex-root data-codex-id="fidelity-root">',
      '  <svg class="icon" data-codex-id="toolbar-icon" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
      '  <div class="linear" data-codex-id="linear-card"></div>',
      '  <div class="radial" data-codex-id="radial-art"></div>',
      '  <div class="rotated" data-codex-id="rotated-art"></div>',
      '  <div class="grid" data-codex-id="grid-art"></div>',
      '  <div class="glass" data-codex-id="glass-dock"></div>',
      '  <span class="version" data-codex-id="version-label">v0.6</span>',
      "</main>",
    ].join("\n"),
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: preview.url,
    projectDir: root,
  });
  const nodes = new Map(captured.manifest.root.children.map((node) => [node.id, node]));
  const icon = nodes.get("toolbar-icon");
  const linear = nodes.get("linear-card");
  const radial = nodes.get("radial-art");
  const rotated = nodes.get("rotated-art");
  const grid = nodes.get("grid-art");
  const glass = nodes.get("glass-dock");
  const version = nodes.get("version-label");

  assert.equal(icon.type, "svg");
  assert.match(icon.svg, /fill="none"/);
  assert.match(icon.svg, /stroke="#6D5EF7"/);
  assert.equal(linear.style.fills[0].type, "linear-gradient");
  assert.deepEqual(linear.style.fills[0].stops.map((stop) => stop.color), [
    "#7262FF",
    "#4E3FE0",
  ]);
  assert.deepEqual(linear.style.effects[0], {
    type: "drop-shadow",
    color: "#5646E13D",
    offsetX: 0,
    offsetY: 12,
    blur: 25,
    spread: 0,
  });
  assert.deepEqual(radial.style.fills.map((fill) => fill.type), [
    "radial-gradient",
    "linear-gradient",
  ]);
  assert.equal(rotated.rotation, 26);
  assert.equal(rotated.width, 25);
  assert.equal(rotated.height, 95);
  assert.equal(grid.style.fills, undefined);
  assert.equal(grid.children[0].type, "svg");
  assert.match(grid.children[0].svg, /background-grid|<path/);
  assert.deepEqual(glass.style.strokeWidths, {
    top: 1,
    right: 0,
    bottom: 0,
    left: 0,
  });
  assert.deepEqual(glass.style.effects, [
    { type: "background-blur", blur: 22 },
  ]);
  assert.equal(version.type, "text");
  assert.ok(version.width > 23, `expected padded text width, received ${version.width}`);
});

test("captures CSS border triangles and pseudo-element icon details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-css-icon-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "index.html"),
    [
      "<!doctype html>",
      "<style>",
      "  main { width: 320px; height: 240px; background: #111528; }",
      "  .play { width: 0; height: 0; color: rgb(250, 250, 255); border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 9px solid currentColor; }",
      "  .queue, .queue::before, .queue::after { width: 15px; height: 2px; border-radius: 2px; background: rgb(174, 180, 205); }",
      "  .queue { position: relative; display: block; margin-top: 30px; }",
      "  .queue::before, .queue::after { content: ''; position: absolute; left: 0; }",
      "  .queue::before { top: -5px; width: 11px; }",
      "  .queue::after { top: 5px; width: 8px; }",
      "  .pause { position: relative; display: block; width: 3px; height: 13px; margin-top: 30px; color: rgb(250, 250, 255); border-radius: 2px; background: currentColor; }",
      "  .pause::after { content: ''; position: absolute; left: 7px; top: 0; width: 3px; height: 13px; border-radius: 2px; background: currentColor; }",
      "</style>",
      '<main data-codex-root data-codex-id="icon-root">',
      '  <span class="play" data-codex-id="play-icon"></span>',
      '  <span class="queue" data-codex-id="queue-icon"></span>',
      '  <span class="pause" data-codex-id="pause-icon"></span>',
      "</main>",
    ].join("\n"),
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: preview.url,
    projectDir: root,
  });
  const play = findNode(captured.manifest.root, "play-icon");
  const queue = findNode(captured.manifest.root, "queue-icon");
  const pause = findNode(captured.manifest.root, "pause-icon");

  assert.equal(play.type, "frame");
  assert.equal(play.style.stroke, undefined);
  assert.equal(play.children[0].type, "svg");
  assert.match(play.children[0].svg, /<path/);
  assert.match(play.children[0].svg, /#FAFAFF/);
  assert.deepEqual(
    queue.children.map((node) => [node.id, node.width, node.y]),
    [
      ["queue-icon-before", 11, -5],
      ["queue-icon-after", 8, 5],
    ],
  );
  assert.equal(queue.clipsContent, false);
  assert.equal(queue.children[0].style.fill, "#AEB4CD");
  assert.equal(pause.children[0].id, "pause-icon-after");
  assert.equal(pause.children[0].x, 7);
  assert.equal(pause.children[0].style.fill, "#FAFAFF");
});

test("expands a same-origin external SVG into one editable complex SVG node", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-external-svg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "index.html"),
    [
      "<!doctype html>",
      '<main data-codex-id="landing-root">',
      '  <img data-codex-id="hero-art" src="./assets/hero-art.svg" alt="Hero artwork" width="260" height="147">',
      "</main>",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "assets", "hero-art.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 147">',
      "  <defs>",
      '    <linearGradient id="brand-gradient"><stop stop-color="#7C5CFC"/><stop offset="1" stop-color="#18A0FB"/></linearGradient>',
      '    <clipPath id="art-clip"><rect width="260" height="147" rx="18"/></clipPath>',
      '    <mask id="shine-mask"><rect width="260" height="147" fill="white"/><circle cx="210" cy="20" r="50" fill="black"/></mask>',
      "  </defs>",
      '  <g clip-path="url(#art-clip)" mask="url(#shine-mask)">',
      '    <path d="M0 147L90 20L180 147Z" fill="url(#brand-gradient)"/>',
      '    <text x="24" y="126" fill="white">Codex</text>',
      "  </g>",
      "</svg>",
    ].join("\n"),
    "utf8",
  );

  const preview = await startProjectPreview({ rootDirectory: root });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: preview.url,
    projectDir: root,
  });
  const heroArt = captured.manifest.root.children.find(
    (node) => node.id === "hero-art",
  );

  assert.equal(heroArt.type, "svg");
  assert.equal(heroArt.name, "Hero artwork");
  assert.equal(heroArt.sourceRef.file, "assets/hero-art.svg");
  assert.equal(
    heroArt.sourceRef.selector,
    '[data-codex-id="hero-art"]',
  );
  assert.match(heroArt.svg, /linearGradient/);
  assert.match(heroArt.svg, /clipPath/);
  assert.match(heroArt.svg, /mask/);
  assert.match(heroArt.svg, /<text/);
  const prepared = preparePageManifest({
    json: JSON.stringify(captured.manifest),
    sourcePath: "pages/external-svg.figma-page.json",
  });
  assert.equal(
    prepared.root.children.find((node) => node.id === "hero-art").type,
    "svg",
  );
});

test("captures the current design-draft visual reference", async (t) => {
  const designDraftRoot = await mkdtemp(
    path.join(os.tmpdir(), "bridge-design-draft-"),
  );
  t.after(() => rm(designDraftRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(designDraftRoot, "index.html"),
    await readFile(path.resolve("design-draft", "design.html"), "utf8"),
    "utf8",
  );
  const preview = await startProjectPreview({ rootDirectory: designDraftRoot });
  t.after(() => preview.stop());
  const captured = await captureLocalPreview({
    previewUrl: preview.url,
    projectDir: designDraftRoot,
  });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(captured.manifest.root);

  assert.ok(nodes.length >= 60, `captured ${nodes.length} design-draft nodes`);
  assert.ok(nodes.some((node) => node.id === "workspace"));
  assert.ok(nodes.some((node) => node.id === "topbar"));
  assert.ok(nodes.some((node) => node.id === "main-layout"));
  assert.ok(nodes.some((node) => node.id === "music-phone"));
  assert.ok(nodes.some((node) => node.id === "statusbar"));
  assert.ok(
    nodes.some((node) =>
      node.style?.fills?.some((fill) => fill.type === "linear-gradient"),
    ),
  );
});

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function collectNodeText(node) {
  return [node?.text || "", ...(node?.children || []).map(collectNodeText)]
    .filter(Boolean)
    .join(" ");
}

function sampleSnapshot() {
  return {
    root: {
      id: "landing-root",
      type: "frame",
      name: "Landing",
      width: 1440,
      height: 900,
      x: 0,
      y: 0,
      style: { fill: "#101114" },
      layout: { direction: "none" },
      children: [
        {
          id: "hero-title",
          type: "text",
          name: "Hero title",
          width: 640,
          height: 80,
          x: 80,
          y: 160,
          style: { fill: "#FFFFFF" },
          text: "Built by Codex",
          font: {
            family: "Inter",
            style: "Bold",
            size: 64,
            lineHeight: 72,
            letterSpacing: -2,
          },
          textAlign: "left",
        },
      ],
    },
  };
}
