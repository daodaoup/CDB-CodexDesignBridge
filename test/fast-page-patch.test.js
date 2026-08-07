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
import { applyFastPageChanges } from "../codex-plugin/codex-design-bridge/mcp/fast-page-patch.mjs";
import { undoLastPatchTransaction } from "../codex-plugin/codex-design-bridge/mcp/patch-transaction.mjs";

test("fast page patch writes visual, size, opacity, and typography changes directly", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-page-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css" />',
      '<main data-codex-id="page">',
      '  <h1 data-codex-id="headline">Before</h1>',
      '  <section data-codex-id="card">Card</section>',
      "</main>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "styles.css"),
    "body {\n  margin: 0;\n}\n",
    "utf8",
  );

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change("headline", "TEXT", "characters", "After & better"),
        change("headline", "TEXT", "fill", {
          color: "#FF3366",
          opacity: 1,
        }),
        change("headline", "TEXT", "fontSize", 52),
        change("page", "FRAME", "padding", {
          top: 24,
          right: 32,
          bottom: 24,
          left: 32,
        }),
        change("page", "FRAME", "itemSpacing", 20),
        change("card", "FRAME", "cornerRadius", 16),
        change("card", "FRAME", "fill", {
          color: "#101114",
          opacity: 0.8,
        }),
      ],
    },
  });

  assert.equal(result.appliedCount, 7);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles.sort(), ["index.html", "styles.css"]);
  assert.match(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    /After &amp; better/,
  );
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /\[data-codex-id="headline"\] \{/);
  assert.match(css, /color: #FF3366 !important;/);
  assert.match(css, /font-size: 52px !important;/);
  assert.match(css, /padding: 24px 32px 24px 32px !important;/);
  assert.match(css, /gap: 20px !important;/);
  assert.match(css, /border-radius: 16px !important;/);
  assert.match(
    css,
    /background: rgba\(16, 17, 20, 0\.8\) !important;/,
  );

  const followUp = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change("headline", "TEXT", "fontSize", 56),
        change("card", "FRAME", "width", 480),
        change("card", "FRAME", "height", 240),
        change("card", "FRAME", "opacity", 0.65),
        change("card", "FRAME", "visible", false),
        change("headline", "TEXT", "fontName", {
          family: "Inter",
          style: "Semi Bold Italic",
        }),
        change("headline", "TEXT", "lineHeight", {
          unit: "PIXELS",
          value: 64,
        }),
        change("headline", "TEXT", "letterSpacing", {
          unit: "PERCENT",
          value: 2,
        }),
        change("headline", "TEXT", "textAlignHorizontal", "CENTER"),
        change("headline", "TEXT", "textAlignVertical", "BOTTOM"),
        change("headline", "TEXT", "textCase", "UPPER"),
        change("headline", "TEXT", "textDecoration", "UNDERLINE"),
      ],
    },
  });
  assert.equal(followUp.appliedCount, 12);
  assert.equal(followUp.pendingCount, 0);
  const updatedCss = await readFile(
    path.join(projectDir, "styles.css"),
    "utf8",
  );
  assert.match(updatedCss, /font-size: 56px !important;/);
  assert.match(updatedCss, /width: 480px !important;/);
  assert.match(updatedCss, /height: 240px !important;/);
  assert.match(updatedCss, /opacity: 0\.65 !important;/);
  assert.match(updatedCss, /display: none !important;/);
  assert.match(updatedCss, /font-family: "Inter" !important;/);
  assert.match(updatedCss, /font-weight: 600 !important;/);
  assert.match(updatedCss, /font-style: italic !important;/);
  assert.match(updatedCss, /line-height: 64px !important;/);
  assert.match(updatedCss, /letter-spacing: 2% !important;/);
  assert.match(updatedCss, /text-align: center !important;/);
  assert.match(updatedCss, /align-content: end !important;/);
  assert.match(updatedCss, /text-transform: uppercase !important;/);
  assert.match(updatedCss, /text-decoration: underline !important;/);
  assert.match(updatedCss, /color: #FF3366 !important;/);
  assert.equal(
    updatedCss.match(/Codex Design Bridge overrides: start/g)?.length,
    1,
  );

  const restored = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [change("card", "FRAME", "visible", true)],
    },
  });
  assert.equal(restored.appliedCount, 1);
  assert.equal(restored.pendingCount, 0);
  assert.doesNotMatch(
    await readFile(path.join(projectDir, "styles.css"), "utf8"),
    /display: none !important;/,
  );
});

test("fast page patch replaces inline SVG contents and preserves source attributes", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-svg-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "App.jsx"),
    [
      "export function HeroGraphic() {",
      "  return (",
      '    <svg data-codex-id="hero-graphic" className="hero-art" aria-label="Hero graphic" viewBox="0 0 260 147">',
      '      <path id="old-path" d="M0 0L10 10" stroke="#FFFFFF" />',
      "    </svg>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const exportedSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
    '<defs><linearGradient id="arrow-gradient"><stop stop-color="#FF4D55"/><stop offset="1" stop-color="#FFAA55"/></linearGradient><clipPath id="art-clip"><rect width="320" height="180"/></clipPath></defs>',
    '<g clip-path="url(#art-clip)">',
    '<path id="star" d="M20 90L90 20L160 90L20 60L160 40L90 120Z" fill="none" stroke="#FFFFFF"/>',
    '<path id="arrow" d="M190 80L300 150L220 100Z" fill="url(#arrow-gradient)"/>',
    "</g>",
    "</svg>",
  ].join("");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change(
          "hero-graphic",
          "SVG",
          "svg",
          svgPayload(exportedSvg),
        ),
      ],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles, ["App.jsx"]);
  const source = await readFile(path.join(projectDir, "App.jsx"), "utf8");
  assert.match(source, /data-codex-id="hero-graphic"/);
  assert.match(source, /className="hero-art"/);
  assert.match(source, /aria-label="Hero graphic"/);
  assert.match(source, /viewBox="0 0 320 180"/);
  assert.match(source, /id="arrow-gradient"/);
  assert.match(source, /id="art-clip"/);
  assert.match(source, /id="star"/);
  assert.match(source, /id="arrow"/);
  assert.doesNotMatch(source, /id="old-path"/);

  const unsafe = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change(
          "hero-graphic",
          "SVG",
          "svg",
          svgPayload('<svg><script>alert(1)</script></svg>'),
        ),
      ],
    },
  });
  assert.equal(unsafe.appliedCount, 0);
  assert.equal(unsafe.pendingCount, 1);
  assert.equal(unsafe.pending[0].reason, "unsafe_svg_export");
});

test("fast page patch writes Frame stroke changes as CSS borders", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-border-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css" />',
      '<nav data-codex-id="nav">Codex Flow</nav>',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "styles.css"),
    [
      '[data-codex-id="nav"] {',
      "  border-top: 1px solid #30322b;",
      "  border-bottom: 1px solid #30322b;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const removed = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [change("nav", "FRAME", "stroke", null)],
    },
  });
  assert.equal(removed.appliedCount, 1);
  assert.equal(removed.pendingCount, 0);
  assert.match(
    await readFile(path.join(projectDir, "styles.css"), "utf8"),
    /border: 0 !important;/,
  );

  const addedStroke = change("nav", "FRAME", "stroke", {
    color: "#FFAA00",
    opacity: 0.5,
  });
  addedStroke.strokeWeight = 3;
  const added = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        addedStroke,
        change("nav", "FRAME", "strokeWeight", 5),
      ],
    },
  });
  assert.equal(added.appliedCount, 2);
  assert.equal(added.pendingCount, 0);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /border: 3px solid rgba\(255, 170, 0, 0\.5\) !important;/);
  assert.match(css, /border-width: 5px !important;/);
});

test("fast page patch deletes mapped SVG, image, and container subtrees", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-delete-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<main data-codex-id="page">',
      '  <svg data-codex-id="decorative-star" viewBox="0 0 20 20">',
      '    <path d="M10 0L12 7L20 8L14 13L16 20L10 16L4 20L6 13L0 8L8 7Z" />',
      "  </svg>",
      '  <img data-codex-id="hero-image" src="./hero.png" alt="">',
      '  <img data-codex-id="external-art" src="./art.svg" alt="">',
      '  <section data-codex-id="content">Keep this container</section>',
      "</main>",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change("decorative-star", "SVG", "nodeDelete", null),
        change("hero-image", "IMAGE", "nodeDelete", null),
        change("external-art", "SVG", "nodeDelete", null),
        change("content", "FRAME", "nodeDelete", null),
      ],
    },
  });

  assert.equal(result.appliedCount, 4);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles, ["index.html"]);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.doesNotMatch(source, /data-codex-id="decorative-star"/);
  assert.doesNotMatch(source, /data-codex-id="hero-image"/);
  assert.doesNotMatch(source, /data-codex-id="external-art"/);
  assert.doesNotMatch(source, /data-codex-id="content"/);
  assert.doesNotMatch(source, /Keep this container/);
});

test("fast page patch retains a container deletion in unsafe JSX context", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-delete-context-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "App.jsx"),
    'export function App() { return <section data-codex-id="content">Keep</section>; }\n',
    "utf8",
  );
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [change("content", "FRAME", "nodeDelete", null)],
    },
  });
  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].reason, "unsafe_delete_context");
  assert.match(
    await readFile(path.join(projectDir, "App.jsx"), "utf8"),
    /data-codex-id="content"/,
  );
});

test("fast page patch clones a mapped button before applying copied styles", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-clone-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css">',
      '<div data-codex-id="hero-actions">',
      '  <button class="primary" data-codex-id="primary-cta">',
      '    <span data-codex-id="primary-cta-label">test</span>',
      "  </button>",
      "</div>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "styles.css"),
    [
      "/* Codex Design Bridge overrides: start */",
      '[data-codex-id="primary-cta"] {',
      "  background: #947EFF !important;",
      "  border-radius: 12px !important;",
      "}",
      "",
      '[data-codex-id="primary-cta-label"] {',
      "  color: #10110E !important;",
      "}",
      "/* Codex Design Bridge overrides: end */",
      "",
    ].join("\n"),
    "utf8",
  );
  const cloneChange = {
    nodeId: "hero-actions",
    nodeType: "FRAME",
    property: "nodeClone",
    sourceRef: {
      selector: '[data-codex-id="primary-cta"]',
    },
    from: {
      nodeId: "primary-cta",
      sourceRef: {
        selector: '[data-codex-id="primary-cta"]',
      },
    },
    to: {
      nodeId: "figma-clone-62-59",
      idMap: [
        { from: "primary-cta", to: "figma-clone-62-59" },
        {
          from: "primary-cta-label",
          to: "figma-clone-62-60",
        },
      ],
    },
  };
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        cloneChange,
        change("figma-clone-62-59", "FRAME", "fill", {
          color: "#FFE656",
          opacity: 1,
        }),
        change(
          "figma-clone-62-60",
          "TEXT",
          "characters",
          "eee",
        ),
      ],
    },
  });

  assert.equal(result.appliedCount, 3);
  assert.equal(result.pendingCount, 0);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.equal(source.match(/class="primary"/g)?.length, 2);
  assert.match(
    source,
    /data-codex-id="primary-cta"[\s\S]*>test<\/span>/,
  );
  assert.match(source, /data-codex-id="figma-clone-62-59"/);
  assert.match(source, /data-codex-id="figma-clone-62-60">eee<\/span>/);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /\[data-codex-id="figma-clone-62-59"\]/);
  assert.match(css, /background: #FFE656 !important;/);
  assert.match(
    css,
    /\[data-codex-id="figma-clone-62-59"\]\s*\{[\s\S]*?border-radius: 12px !important;/,
  );
  assert.match(
    css,
    /\[data-codex-id="figma-clone-62-60"\]\s*\{[\s\S]*?color: #10110E !important;/,
  );
});

test("fast page patch keeps the original page when a replacement clone is pending", async (t) => {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "fast-pending-replacement-"),
  );
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const original = [
    '<main data-codex-id="workspace">',
    '  <header data-codex-id="topbar">Top</header>',
    '  <section data-codex-id="main-layout">Main</section>',
    '  <footer data-codex-id="statusbar">Status</footer>',
    "</main>",
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, "index.html"), original, "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          nodeId: "workspace",
          nodeType: "FRAME",
          property: "nodeClone",
          sourceRef: { selector: '[data-codex-id="workspace"]' },
          to: {
            nodeId: "figma-clone-workspace",
            idMap: [
              { from: "workspace", to: "figma-clone-workspace" },
              { from: "workspace", to: "figma-clone-workspace-copy" },
            ],
          },
        },
        change("topbar", "FRAME", "nodeDelete", null),
        change("main-layout", "FRAME", "nodeDelete", null),
        change("statusbar", "FRAME", "nodeDelete", null),
      ],
    },
  });

  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 4);
  assert.ok(
    result.pending.every(
      (pending) => pending.reason === "dependent_structure_pending",
    ),
  );
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), original);
});

test("fast page patch inserts a generic subtree and reorders mapped siblings", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-structure-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css">',
      '<main data-codex-id="page">',
      '  <div data-codex-id="toolbar">',
      '    <button data-codex-id="first"><span data-codex-id="first-label">One</span></button>',
      '    <button data-codex-id="second">Two</button>',
      "  </div>",
      "</main>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const insertedNode = {
    id: "figma-node-70-1",
    type: "frame",
    tag: "button",
    name: "Checkout button",
    width: 220,
    height: 56,
    opacity: 0.9,
    visible: true,
    rotation: 0,
    style: {
      fill: { color: "#FFE656", opacity: 1 },
      stroke: { color: "#202020", opacity: 1 },
      strokeWeight: 1,
      cornerRadius: 18,
    },
    layout: {
      mode: "HORIZONTAL",
      itemSpacing: 8,
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
    },
    children: [
      {
        id: "figma-node-70-2",
        type: "text",
        tag: "span",
        name: "Button label",
        width: 100,
        height: 24,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: {
          fill: { color: "#111111", opacity: 1 },
          stroke: null,
          strokeWeight: 0,
          cornerRadius: 0,
        },
        text: "Checkout",
        fontName: { family: "Inter", style: "Bold" },
        fontSize: 16,
        lineHeight: { unit: "PIXELS", value: 24 },
        letterSpacing: { unit: "PIXELS", value: 0 },
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
        textCase: "ORIGINAL",
        textDecoration: "NONE",
      },
      {
        id: "figma-node-70-3",
        type: "image",
        tag: "img",
        name: "Checkout icon",
        width: 16,
        height: 16,
        opacity: 1,
        visible: true,
        rotation: 0,
        style: {
          fill: null,
          stroke: null,
          strokeWeight: 0,
          cornerRadius: 0,
        },
        image: {
          mimeType: "image/png",
          base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        },
      },
    ],
  };
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          nodeId: "toolbar",
          nodeType: "FRAME",
          property: "nodeInsert",
          sourceRef: { selector: '[data-codex-id="toolbar"]' },
          to: { node: insertedNode },
        },
        {
          nodeId: "toolbar",
          nodeType: "FRAME",
          property: "nodeReorder",
          sourceRef: { selector: '[data-codex-id="toolbar"]' },
          to: {
            children: [
              {
                nodeId: "second",
                sourceRef: { selector: '[data-codex-id="second"]' },
              },
              {
                nodeId: "figma-node-70-1",
                sourceRef: {
                  selector: '[data-codex-id="figma-node-70-1"]',
                },
              },
              {
                nodeId: "first",
                sourceRef: { selector: '[data-codex-id="first"]' },
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(result.appliedCount, 2);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles.sort(), [
    "codex-design-assets/figma-node-70-3.png",
    "index.html",
    "styles.css",
  ]);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.ok(source.indexOf('data-codex-id="second"') < source.indexOf('data-codex-id="figma-node-70-1"'));
  assert.ok(source.indexOf('data-codex-id="figma-node-70-1"') < source.indexOf('data-codex-id="first"'));
  assert.match(source, /data-codex-id="figma-node-70-2">Checkout<\/span>/);
  assert.match(source, /src="\/codex-design-assets\/figma-node-70-3\.png"/);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /\[data-codex-id="figma-node-70-1"\]/);
  assert.match(css, /display: flex !important;/);
  assert.match(css, /width: 220px !important;/);
  assert.match(css, /font-weight: 700 !important;/);
});

test("fast page patch replaces a Figma seed root and removes its placeholder styling", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-page-seed-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css">',
      '<main data-codex-root data-codex-id="page-root" class="figma-seed">',
      '  <p data-codex-id="figma-seed-placeholder">Waiting</p>',
      '</main>',
      '',
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "styles.css"),
    '.figma-seed { background: linear-gradient(#f00, #00f); }\n',
    "utf8",
  );
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [{
        nodeId: "page-root",
        nodeType: "FRAME",
        property: "pageSeed",
        sourceRef: { selector: '[data-codex-id="page-root"]' },
        to: {
          node: {
            id: "page-root",
            type: "frame",
            tag: "main",
            name: "Landing page",
            width: 390,
            height: 844,
            opacity: 1,
            visible: true,
            rotation: 0,
            style: {
              fill: { color: "#2D1FF2", opacity: 1 },
              stroke: null,
              strokeWeight: 0,
              cornerRadius: 24,
            },
            layout: {
              mode: "VERTICAL",
              itemSpacing: 16,
              padding: { top: 24, right: 24, bottom: 24, left: 24 },
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "MIN",
            },
            children: [{
              id: "figma-node-title",
              type: "text",
              tag: "span",
              name: "Title",
              width: 220,
              height: 48,
              opacity: 1,
              visible: true,
              rotation: 0,
              style: {
                fill: { color: "#FFFFFF", opacity: 1 },
                stroke: null,
                strokeWeight: 0,
                cornerRadius: 0,
              },
              text: "From Figma",
              fontName: { family: "Inter", style: "Bold" },
              fontSize: 36,
              lineHeight: { unit: "PIXELS", value: 44 },
              letterSpacing: { unit: "PIXELS", value: 0 },
              textAlignHorizontal: "LEFT",
              textAlignVertical: "TOP",
              textCase: "ORIGINAL",
              textDecoration: "NONE",
            }],
          },
        },
      }],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.match(source, /<main data-codex-root data-codex-id="page-root">/);
  assert.match(source, /data-codex-id="figma-node-title">From Figma<\/span>/);
  assert.doesNotMatch(source, /figma-seed-placeholder/);
  assert.doesNotMatch(source, /class="figma-seed"/);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /background-color: #2D1FF2 !important;/);
});

test("fast page patch inserts, reorders, and deletes mapped JSX children", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-jsx-structure-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "App.jsx"),
    [
      'import "./App.css";',
      "",
      "export function App() {",
      "  return (",
      '    <div data-codex-id="toolbar">',
      '      <button data-codex-id="first">One</button>',
      '      <button data-codex-id="second">Two</button>',
      "    </div>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "App.css"), "", "utf8");
  const insertedText = {
    id: "figma-node-80-1",
    type: "text",
    tag: "span",
    name: "Status",
    width: 80,
    height: 24,
    opacity: 1,
    visible: true,
    rotation: 0,
    style: {
      fill: { color: "#FF3366", opacity: 1 },
      stroke: null,
      strokeWeight: 0,
      cornerRadius: 0,
    },
    text: "Ready",
    fontName: { family: "Inter", style: "Medium" },
    fontSize: 14,
    lineHeight: { unit: "PIXELS", value: 20 },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textCase: "ORIGINAL",
    textDecoration: "NONE",
  };
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          nodeId: "toolbar",
          nodeType: "FRAME",
          property: "nodeInsert",
          sourceRef: { selector: '[data-codex-id="toolbar"]' },
          to: { node: insertedText },
        },
        {
          nodeId: "toolbar",
          nodeType: "FRAME",
          property: "nodeReorder",
          sourceRef: { selector: '[data-codex-id="toolbar"]' },
          to: {
            children: [
              {
                nodeId: "figma-node-80-1",
                sourceRef: {
                  selector: '[data-codex-id="figma-node-80-1"]',
                },
              },
              {
                nodeId: "second",
                sourceRef: { selector: '[data-codex-id="second"]' },
              },
              {
                nodeId: "first",
                sourceRef: { selector: '[data-codex-id="first"]' },
              },
            ],
          },
        },
        change("second", "FRAME", "nodeDelete", null),
      ],
    },
  });

  assert.equal(result.appliedCount, 3);
  assert.equal(result.pendingCount, 0);
  const source = await readFile(path.join(projectDir, "App.jsx"), "utf8");
  assert.doesNotMatch(source, /data-codex-id="second"/);
  assert.ok(source.indexOf('data-codex-id="figma-node-80-1"') < source.indexOf('data-codex-id="first"'));
  assert.match(source, />Ready<\/span>/);
  assert.match(
    await readFile(path.join(projectDir, "App.css"), "utf8"),
    /font-weight: 500 !important;/,
  );
});

test("fast page patch retains a reorder when unmapped source content is interleaved", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-reorder-safety-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const original = [
    '<div data-codex-id="toolbar">',
    "  Intro text",
    '  <button data-codex-id="first">One</button>',
    '  <button data-codex-id="second">Two</button>',
    "</div>",
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, "index.html"), original, "utf8");
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          nodeId: "toolbar",
          nodeType: "FRAME",
          property: "nodeReorder",
          sourceRef: { selector: '[data-codex-id="toolbar"]' },
          to: {
            children: [
              {
                nodeId: "second",
                sourceRef: { selector: '[data-codex-id="second"]' },
              },
              {
                nodeId: "first",
                sourceRef: { selector: '[data-codex-id="first"]' },
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].reason, "unsafe_reorder_context");
  assert.equal(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    original,
  );
});

test("fast page patch writes a complex edited SVG back to its external source file", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-external-svg-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, "assets"));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<img data-codex-id="hero-art" src="./assets/hero-art.svg" alt="Hero artwork">\n',
    "utf8",
  );
  await writeFile(
    path.join(projectDir, "assets", "hero-art.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" class="hero-source" viewBox="0 0 260 147"><path d="M0 0L10 10"/></svg>\n',
    "utf8",
  );
  const exportedSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
    "<style>.hero-label{fill:#fff;font-family:Inter,sans-serif}</style>",
    "<defs>",
    '<linearGradient id="surface-gradient"><stop stop-color="#7C5CFC"/><stop offset="1" stop-color="#18A0FB"/></linearGradient>',
    '<clipPath id="surface-clip"><rect width="320" height="180" rx="20"/></clipPath>',
    '<mask id="surface-mask"><rect width="320" height="180" fill="white"/><circle cx="280" cy="20" r="54" fill="black"/></mask>',
    "</defs>",
    '<g clip-path="url(#surface-clip)" mask="url(#surface-mask)">',
    '<path id="surface" d="M0 180L110 20L230 180Z" fill="url(#surface-gradient)"/>',
    '<text id="label" class="hero-label" x="28" y="150">Codex</text>',
    "</g>",
    "</svg>",
  ].join("");
  const externalChange = change(
    "hero-art",
    "SVG",
    "svg",
    svgPayload(exportedSvg),
  );
  externalChange.sourceRef.file = "assets/hero-art.svg";

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [externalChange],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles, ["assets/hero-art.svg"]);
  const source = await readFile(
    path.join(projectDir, "assets", "hero-art.svg"),
    "utf8",
  );
  assert.match(source, /class="hero-source"/);
  assert.match(source, /viewBox="0 0 320 180"/);
  assert.match(source, /id="surface-gradient"/);
  assert.match(source, /id="surface-clip"/);
  assert.match(source, /id="surface-mask"/);
  assert.match(source, /class="hero-label"/);
  assert.match(source, /<text id="label"/);
  assert.match(
    await readFile(path.join(projectDir, "index.html"), "utf8"),
    /src="\.\/assets\/hero-art\.svg"/,
  );

  const unsafeChange = change(
    "hero-art",
    "SVG",
    "svg",
    svgPayload(
      '<svg viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    ),
  );
  unsafeChange.sourceRef.file = "assets/hero-art.svg";
  const unsafe = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [unsafeChange],
    },
  });
  assert.equal(unsafe.appliedCount, 0);
  assert.equal(unsafe.pending[0].reason, "unsafe_svg_export");
});

test("fast page patch inserts a Figma vector as a mapped inline SVG", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-svg-insert-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<main data-codex-id="landing-root">',
      '  <div class="hero-copy" data-codex-id="hero-copy">',
      "    <p>Existing content</p>",
      "  </div>",
      "</main>",
      "",
    ].join("\n"),
    "utf8",
  );
  const insertedSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="140" viewBox="0 0 160 140">',
    '<path id="custom-star" d="M80 0L100 50L160 55L115 90L130 140L80 110L30 140L45 90L0 55L60 50Z" fill="#FFE32C"/>',
    "</svg>",
  ].join("");
  const insertion = change("hero-copy", "FRAME", "svgInsert", {
    ...svgPayload(insertedSvg),
    elementId: "figma-svg-52-1552",
    name: 'Custom "star"',
    x: 180,
    y: 420,
    width: 160,
    height: 140,
    rotation: 12,
  });

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [insertion],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(result.changedFiles, ["index.html"]);
  let source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.match(source, /data-codex-id="figma-svg-52-1552"/);
  assert.match(source, /aria-label="Custom &quot;star&quot;"/);
  assert.match(source, /id="custom-star"/);
  assert.match(source, /left: 180px/);
  assert.match(source, /top: 420px/);
  assert.match(source, /width: 160px/);
  assert.match(source, /height: 140px/);
  assert.match(source, /rotate\(12deg\)/);

  const retry = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [insertion],
    },
  });
  assert.equal(retry.appliedCount, 1);
  assert.equal(retry.pendingCount, 0);
  assert.deepEqual(retry.changedFiles, []);
  source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.equal(
    source.match(/data-codex-id="figma-svg-52-1552"/g)?.length,
    1,
  );

  const replacement = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change(
          "figma-svg-52-1552",
          "SVG",
          "svg",
          svgPayload(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path id="edited-path" d="M0 0L200 100"/></svg>',
          ),
        ),
      ],
    },
  });
  assert.equal(replacement.appliedCount, 1);
  assert.equal(replacement.pendingCount, 0);
  source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.match(source, /data-codex-id="figma-svg-52-1552"/);
  assert.match(source, /viewBox="0 0 200 100"/);
  assert.match(source, /id="edited-path"/);
  assert.doesNotMatch(source, /id="custom-star"/);
});

test("fast page patch follows a React component stylesheet import", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-react-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, "src"));
  await writeFile(
    path.join(projectDir, "src", "App.jsx"),
    [
      'import "./App.css";',
      "",
      "export function App() {",
      '  return <button data-codex-id="cta">Continue</button>;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "src", "App.css"), "", "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [change("cta", "FRAME", "cornerRadius", 12)],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.deepEqual(result.changedFiles, ["src/App.css"]);
  assert.match(
    await readFile(path.join(projectDir, "src", "App.css"), "utf8"),
    /border-radius: 12px !important;/,
  );
});

test("fast page patch retains an unexportable SVG as a pending difference", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-svg-pending-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<main data-codex-id="page"></main>\n',
    "utf8",
  );

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          nodeId: "empty-svg",
          nodeType: "SVG",
          property: "svgUnavailable",
          sourceRef: { file: "assets/empty.svg" },
          error:
            "Failed to export node. This node may not have any visible layers.",
        },
      ],
    },
  });

  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].reason, "svg_not_exportable");
  assert.deepEqual(result.changedFiles, []);
});

test("fast page patch writes same-parent Figma position changes as visual translation", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-position-patch-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css" />',
      '<button data-codex-id="hero-play-button">Play</button>',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        {
          ...change("hero-play-button", "FRAME", "x", 173),
          from: 22,
        },
        {
          ...change("hero-play-button", "FRAME", "y", 84),
          from: 64,
        },
      ],
    },
  });

  assert.equal(result.appliedCount, 2);
  assert.equal(result.pendingCount, 0);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /--cdb-translate-x: 151px !important;/);
  assert.match(css, /--cdb-translate-y: 20px !important;/);
  assert.match(
    css,
    /translate: var\(--cdb-translate-x, 0px\) var\(--cdb-translate-y, 0px\) !important;/,
  );
});

test("fast page patch ignores imported project caches when resolving selectors", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-import-cache-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const importedDir = path.join(projectDir, ".cdb-imports", "Music");
  await mkdir(importedDir, { recursive: true });
  const html = [
    '<link rel="stylesheet" href="./styles.css" />',
    '<button data-codex-id="profile-button">Profile</button>',
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, "index.html"), html, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  await writeFile(path.join(importedDir, "index.html"), html, "utf8");
  await writeFile(path.join(importedDir, "styles.css"), "", "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [
        change("profile-button", "FRAME", "fill", {
          color: "#FF6D00",
          opacity: 1,
        }),
      ],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.deepEqual(result.changedFiles, ["styles.css"]);
  assert.match(
    await readFile(path.join(projectDir, "styles.css"), "utf8"),
    /background: #FF6D00 !important;/,
  );
  assert.equal(await readFile(path.join(importedDir, "styles.css"), "utf8"), "");
});

for (const property of ["nodeMove", "nodeReparent"]) {
  test(`fast page patch applies ${property} atomically with target-parent geometry and undo`, async (t) => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), `fast-${property}-`));
    t.after(() => rm(projectDir, { recursive: true, force: true }));
    const original = [
      '<link rel="stylesheet" href="./styles.css" />',
      '<main data-codex-id="landing-root">',
      '  <section data-codex-id="hero-copy">',
      '    <p data-codex-id="hero-eyebrow">Intro</p>',
      '    <div data-codex-id="hero-actions">',
      '      <button data-codex-id="primary-cta">Primary</button>',
      '      <button data-codex-id="daodao" aria-label="Keep me" onclick="runAction()"><span data-codex-id="daodao-label">daodao</span></button>',
      "    </div>",
      '    <p data-codex-id="hero-proof">Proof</p>',
      "  </section>",
      "</main>",
      "",
    ].join("\n");
    await writeFile(path.join(projectDir, "index.html"), original, "utf8");
    await writeFile(path.join(projectDir, "styles.css"), "", "utf8");

    const result = await applyFastPageChanges({
      projectDir,
      manifest: manifest(),
      changeSet: {
        pageId: "sample-page",
        sourceHash: "page-hash",
        changes: [{
          nodeId: "daodao",
          nodeType: "FRAME",
          property,
          sourceRef: { selector: '[data-codex-id="daodao"]' },
          fromParentId: "hero-actions",
          toParentId: "hero-copy",
          fromParentSourceRef: { selector: '[data-codex-id="hero-actions"]' },
          toParentSourceRef: { selector: '[data-codex-id="hero-copy"]' },
          fromIndex: 1,
          toIndex: 2,
          beforeBounds: { x: 190, y: 0, width: 180, height: 52 },
          afterBounds: { x: 647, y: 397, width: 180, height: 52 },
          beforeWorldTransform: [1, 0, 0, 1, 190, 397],
          afterWorldTransform: [1, 0, 0, 1, 647, 397],
          parentLayout: "NONE",
          positioning: "ABSOLUTE",
        }],
      },
    });

    assert.equal(result.appliedCount, 1);
    assert.equal(result.pendingCount, 0);
    assert.deepEqual(result.changedFiles.sort(), ["index.html", "styles.css"]);
    const source = await readFile(path.join(projectDir, "index.html"), "utf8");
    const actionsEnd = source.indexOf("</div>");
    const buttonStart = source.indexOf('data-codex-id="daodao"');
    const proofStart = source.indexOf('data-codex-id="hero-proof"');
    assert.ok(actionsEnd < buttonStart && buttonStart < proofStart);
    assert.match(source, /aria-label="Keep me" onclick="runAction\(\)"/);
    assert.match(source, /data-codex-id="daodao-label">daodao<\/span>/);
    const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
    assert.match(css, /position: absolute !important;/);
    assert.match(css, /left: 647px !important;/);
    assert.match(css, /top: 397px !important;/);
    assert.match(css, /translate: none !important;/);

    const undone = await undoLastPatchTransaction(projectDir);
    assert.equal(undone.status, "committed");
    assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), original);
    assert.equal(await readFile(path.join(projectDir, "styles.css"), "utf8"), "");
  });
}

test("fast page patch rejects a reparent cycle without partial source or CSS writes", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-reparent-cycle-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const original = [
    '<link rel="stylesheet" href="./styles.css" />',
    '<section data-codex-id="hero-copy">',
    '  <button data-codex-id="daodao">daodao</button>',
    "</section>",
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, "index.html"), original, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [{
        nodeId: "hero-copy",
        nodeType: "FRAME",
        property: "nodeReparent",
        sourceRef: { selector: '[data-codex-id="hero-copy"]' },
        toParentSourceRef: { selector: '[data-codex-id="daodao"]' },
        toIndex: 0,
        afterBounds: { x: 0, y: 0, width: 800, height: 700 },
        parentLayout: "NONE",
        positioning: "ABSOLUTE",
      }],
    },
  });

  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].stage, "structure");
  assert.equal(result.pending[0].reason, "invalid_reparent_cycle");
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), original);
  assert.equal(await readFile(path.join(projectDir, "styles.css"), "utf8"), "");
});

test("fast page patch maps Figma Auto Layout and item sizing back to CSS flex", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-auto-layout-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css" />',
      '<section data-codex-id="cards">',
      '  <article data-codex-id="card">Card</article>',
      "</section>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const layoutContext = { layoutMode: "HORIZONTAL", width: 720, height: 320 };
  const changes = [
    { ...change("cards", "FRAME", "layoutMode", "HORIZONTAL"), layoutContext },
    { ...change("cards", "FRAME", "layoutWrap", "WRAP"), layoutContext },
    { ...change("cards", "FRAME", "itemSpacing", 24), layoutContext },
    { ...change("cards", "FRAME", "counterAxisSpacing", 16), layoutContext },
    {
      ...change("cards", "FRAME", "padding", {
        top: 12,
        right: 20,
        bottom: 12,
        left: 20,
      }),
      layoutContext,
    },
    { ...change("cards", "FRAME", "primaryAxisAlignItems", "SPACE_BETWEEN"), layoutContext },
    { ...change("cards", "FRAME", "counterAxisAlignItems", "CENTER"), layoutContext },
    { ...change("cards", "FRAME", "primaryAxisSizingMode", "AUTO"), layoutContext },
    { ...change("card", "FRAME", "layoutAlign", "STRETCH"), layoutContext },
    { ...change("card", "FRAME", "layoutGrow", 1), layoutContext },
    { ...change("card", "FRAME", "layoutSizingHorizontal", "FILL"), layoutContext },
    { ...change("card", "FRAME", "layoutSizingVertical", "HUG"), layoutContext },
  ];
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes,
    },
  });

  assert.equal(result.appliedCount, changes.length);
  assert.equal(result.pendingCount, 0);
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /\[data-codex-id="cards"\][^]*display: flex !important;/);
  assert.match(css, /flex-direction: row !important;/);
  assert.match(css, /flex-wrap: wrap !important;/);
  assert.match(css, /gap: 24px !important;/);
  assert.match(css, /row-gap: 16px !important;/);
  assert.match(css, /padding: 12px 20px 12px 20px !important;/);
  assert.match(css, /justify-content: space-between !important;/);
  assert.match(css, /align-items: center !important;/);
  assert.match(css, /width: fit-content !important;/);
  assert.match(css, /\[data-codex-id="card"\][^]*align-self: stretch !important;/);
  assert.match(css, /flex-grow: 1 !important;/);
  assert.match(css, /width: 100% !important;/);
  assert.match(css, /height: fit-content !important;/);
});

test("fast page patch maps an atomic move into a CSS grid placement", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-grid-move-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    [
      '<link rel="stylesheet" href="./styles.css" />',
      '<main data-codex-id="page">',
      '  <div data-codex-id="source">',
      '    <article data-codex-id="card">Card</article>',
      "  </div>",
      '  <section data-codex-id="grid"></section>',
      "</main>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [{
        nodeId: "card",
        nodeType: "FRAME",
        property: "nodeMove",
        sourceRef: { selector: '[data-codex-id="card"]' },
        toParentSourceRef: { selector: '[data-codex-id="grid"]' },
        toIndex: 0,
        afterBounds: { x: 0, y: 0, width: 200, height: 120 },
        parentLayout: "GRID",
        positioning: "AUTO",
        grid: { row: 2, column: 1 },
      }],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  const source = await readFile(path.join(projectDir, "index.html"), "utf8");
  assert.ok(
    source.indexOf('data-codex-id="grid"') <
      source.indexOf('data-codex-id="card"'),
  );
  const css = await readFile(path.join(projectDir, "styles.css"), "utf8");
  assert.match(css, /grid-row: 2 !important;/);
  assert.match(css, /grid-column: 1 !important;/);
});

test("codex-landing daodao regression reparents without screenshots or regenerated markup", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-daodao-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const liveSource = await readFile(
    new URL("../examples/codex-landing/index.html", import.meta.url),
    "utf8",
  );
  const liveCss = await readFile(
    new URL("../examples/codex-landing/styles.css", import.meta.url),
    "utf8",
  );
  const buttonMatch = liveSource.match(
    /\n\s*<button[^>]*data-codex-id="figma-clone-566-68"[^>]*>[\s\S]*?<\/button>/,
  );
  assert.ok(buttonMatch);
  let baseline = liveSource.replace(buttonMatch[0], "");
  const actionsStart = baseline.indexOf('data-codex-id="hero-actions"');
  const actionsClose = baseline.indexOf("</div>", actionsStart);
  assert.ok(actionsStart > 0 && actionsClose > actionsStart);
  baseline =
    baseline.slice(0, actionsClose) +
    buttonMatch[0] +
    "\n          " +
    baseline.slice(actionsClose);
  await writeFile(path.join(projectDir, "index.html"), baseline, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), liveCss, "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      protocolVersion: 14,
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [{
        nodeId: "figma-clone-566-68",
        nodeType: "FRAME",
        property: "nodeReparent",
        sourceRef: { selector: '[data-codex-id="figma-clone-566-68"]' },
        fromParentId: "hero-actions",
        toParentId: "hero-copy",
        fromParentSourceRef: { selector: '[data-codex-id="hero-actions"]' },
        toParentSourceRef: { selector: '[data-codex-id="hero-copy"]' },
        fromIndex: 2,
        toIndex: 4,
        beforeBounds: { x: 380, y: 0, width: 180, height: 52 },
        afterBounds: { x: 647, y: 397, width: 180, height: 52 },
        beforeWorldTransform: [1, 0, 0, 1, 380, 397],
        afterWorldTransform: [1, 0, 0, 1, 647, 397],
        parentLayout: "NONE",
        positioning: "ABSOLUTE",
      }],
    },
  });

  assert.equal(result.appliedCount, 1);
  assert.equal(result.pendingCount, 0);
  const updated = await readFile(path.join(projectDir, "index.html"), "utf8");
  const actionsEnd = updated.indexOf("</div>", updated.indexOf('data-codex-id="hero-actions"'));
  const daodao = updated.indexOf('data-codex-id="figma-clone-566-68"');
  const proof = updated.indexOf('data-codex-id="hero-proof"');
  assert.ok(actionsEnd < daodao && daodao < proof);
  assert.match(updated, /data-codex-id="figma-clone-566-69">daodao<\/span>/);
  assert.equal((updated.match(/data-codex-id="figma-clone-566-68"/g) || []).length, 1);
});

test("fast page patch keeps a future structural protocol safely pending", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-future-protocol-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await writeFile(
    path.join(projectDir, "index.html"),
    '<main data-codex-id="page"></main>\n',
    "utf8",
  );
  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      protocolVersion: 99,
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [change("page", "FRAME", "futureLayout", {})],
    },
  });
  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].reason, "unsupported_change_protocol");
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), '<main data-codex-id="page"></main>\n');
});

test("protocol 14 rejects incomplete structural payloads without writing files", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "fast-invalid-v14-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const original = [
    '<link rel="stylesheet" href="./styles.css" />',
    '<main data-codex-id="page">',
    '  <div data-codex-id="source"><button data-codex-id="move-me">Move</button></div>',
    '  <div data-codex-id="target"></div>',
    "</main>",
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, "index.html"), original, "utf8");
  await writeFile(path.join(projectDir, "styles.css"), "", "utf8");

  const result = await applyFastPageChanges({
    projectDir,
    manifest: manifest(),
    changeSet: {
      protocolVersion: 14,
      pageId: "sample-page",
      sourceHash: "page-hash",
      changes: [{
        property: "nodeReparent",
        nodeId: "move-me",
        sourceRef: { selector: '[data-codex-id="move-me"]' },
        toParentSourceRef: { selector: '[data-codex-id="target"]' },
        toIndex: 0,
        afterBounds: { x: 0, y: 0, width: 80, height: 32 },
        parentLayout: "NONE",
        positioning: "ABSOLUTE",
      }],
    },
  });

  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].stage, "protocol");
  assert.equal(
    result.pending[0].reason,
    "invalid_protocol14_structure:missing_fromParentId",
  );
  assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), original);
  assert.equal(await readFile(path.join(projectDir, "styles.css"), "utf8"), "");
});

test("protocol 14 schema keeps structural changes exclusive from the generic branch", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../codex-plugin/codex-design-bridge/shared/change-set-v14.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.properties.protocolVersion.const, 14);
  assert.deepEqual(
    schema.$defs.genericChange.properties.property.not.enum,
    ["nodeMove", "nodeReparent"],
  );
  for (const field of [
    "fromParentId",
    "toParentId",
    "fromIndex",
    "toIndex",
    "beforeBounds",
    "afterBounds",
    "beforeWorldTransform",
    "afterWorldTransform",
    "parentLayout",
    "positioning",
  ]) {
    assert.ok(schema.$defs.nodeMove.required.includes(field), field);
  }
});

function change(nodeId, nodeType, property, to) {
  return {
    nodeId,
    nodeType,
    property,
    to,
    sourceRef: {
      selector: `[data-codex-id="${nodeId}"]`,
    },
  };
}

function svgPayload(svg) {
  return {
    mimeType: "image/svg+xml",
    base64: Buffer.from(svg).toString("base64"),
  };
}

function manifest() {
  return {
    pageId: "sample-page",
    sourceHash: "page-hash",
  };
}
