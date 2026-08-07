import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PageValidationError, preparePageManifest } from "../src/page.js";
import { preparePageManifest as preparePluginPageManifest } from "../codex-plugin/codex-design-bridge/shared/page.mjs";

test("prepares a hybrid page manifest with stable node ids and safe SVG", () => {
  const prepared = preparePageManifest({
    json: JSON.stringify(samplePage()),
    sourcePath: "pages/landing.figma-page.json",
  });

  assert.equal(prepared.protocolVersion, 3);
  assert.equal(prepared.pageId, "landing-page");
  assert.deepEqual(prepared.nodeIds, ["landing-root", "hero-copy", "hero-icon"]);
  assert.equal(prepared.root.layout.direction, "vertical");
  assert.deepEqual(prepared.root.layout.padding, {
    top: 40,
    right: 40,
    bottom: 40,
    left: 40,
  });
  assert.equal(prepared.root.children[0].font.family, "Inter");
  assert.equal(prepared.root.children[1].type, "svg");
  assert.equal(prepared.root.style.fills[0].type, "linear-gradient");
  assert.equal(prepared.root.style.effects[0].blur, 24);
  assert.deepEqual(prepared.root.style.strokeWidths, {
    top: 1,
    right: 0,
    bottom: 0,
    left: 0,
  });
  assert.deepEqual(prepared.root.style.effects[1], {
    type: "background-blur",
    blur: 22,
  });
  assert.match(prepared.sourceHash, /^[a-f0-9]{64}$/);

  const pluginPrepared = preparePluginPageManifest({
    json: JSON.stringify(samplePage()),
    sourcePath: "pages/landing.figma-page.json",
  });
  assert.deepEqual(pluginPrepared.root.style.strokeWidths, prepared.root.style.strokeWidths);
  assert.deepEqual(pluginPrepared.root.style.effects, prepared.root.style.effects);
});

test("rejects duplicate ids, unsafe SVG, and unsupported colors", () => {
  const duplicate = samplePage();
  duplicate.root.children[1].id = "hero-copy";
  assert.throws(
    () =>
      preparePageManifest({
        json: JSON.stringify(duplicate),
        sourcePath: "pages/landing.figma-page.json",
      }),
    /Duplicate page node id/,
  );

  const unsafe = samplePage();
  unsafe.root.children[1].svg =
    '<svg viewBox="0 0 10 10"><script/><path id="icon" d="M0 0"/></svg>';
  assert.throws(
    () =>
      preparePageManifest({
        json: JSON.stringify(unsafe),
        sourcePath: "pages/landing.figma-page.json",
      }),
    /script.*not supported/i,
  );

  const invalidColor = samplePage();
  invalidColor.root.style.fill = "red";
  assert.throws(
    () =>
      preparePageManifest({
        json: JSON.stringify(invalidColor),
        sourcePath: "pages/landing.figma-page.json",
      }),
    PageValidationError,
  );
});

test("validates the Codex-generated frontend example manifest", async () => {
  const json = await readFile(
    new URL("../pages/codex-landing.figma-page.json", import.meta.url),
    "utf8",
  );
  const prepared = preparePageManifest({
    json,
    sourcePath: "pages/codex-landing.figma-page.json",
  });
  assert.equal(prepared.pageId, "codex-landing");
  assert.ok(prepared.nodeIds.length >= 20);
  assert.equal(
    prepared.source.file,
    "examples/codex-landing/index.html",
  );
});

function samplePage() {
  return {
    pageId: "landing-page",
    name: "Landing page",
    source: {
      file: "examples/landing/index.html",
      component: "LandingPage",
    },
    root: {
      id: "landing-root",
      type: "frame",
      width: 1440,
      height: 900,
      layout: {
        direction: "vertical",
        gap: 24,
        padding: 40,
      },
      style: {
        fill: "#101114",
        fills: [
          {
            type: "linear-gradient",
            angle: 135,
            stops: [
              { color: "#7262FF", position: 0 },
              { color: "#4E3FE0", position: 1 },
            ],
          },
        ],
        effects: [
          {
            type: "drop-shadow",
            color: "#20193C21",
            offsetX: 0,
            offsetY: 12,
            blur: 24,
            spread: 0,
          },
          {
            type: "background-blur",
            blur: 22,
          },
        ],
        stroke: "#30322B80",
        strokeWidths: { top: 1, right: 0, bottom: 0, left: 0 },
      },
      children: [
        {
          id: "hero-copy",
          type: "text",
          width: 720,
          height: 120,
          text: "Codex generates the page.",
          font: {
            family: "Inter",
            style: "Bold",
            size: 56,
            lineHeight: 64,
          },
          style: { fill: "#FFFFFF" },
          sourceRef: {
            file: "examples/landing/index.html",
            selector: "[data-codex-id='hero-copy']",
          },
        },
        {
          id: "hero-icon",
          type: "svg",
          width: 32,
          height: 32,
          svg: '<svg viewBox="0 0 32 32"><path id="spark" d="M16 2L20 12L30 16L20 20L16 30L12 20L2 16L12 12Z" fill="#7C5CFC"/></svg>',
        },
      ],
    },
  };
}
