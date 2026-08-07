import test from "node:test";
import assert from "node:assert/strict";
import { prepareSvgAsset, SvgValidationError } from "../src/svg.js";

test("prepares deterministic fragments for explicit stable targets", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
      <defs><linearGradient id="brand"><stop stop-color="#fff"/></linearGradient></defs>
      <g transform="translate(10 20)">
        <rect id="card" data-figma-sync="target" width="80" height="40" fill="url(#brand)"/>
      </g>
    </svg>
  `;

  const prepared = prepareSvgAsset({
    svg,
    assetId: "sample.svg",
    sourcePath: "assets/sample.svg",
  });

  assert.equal(prepared.assetId, "sample.svg");
  assert.equal(prepared.width, 200);
  assert.equal(prepared.height, 100);
  assert.deepEqual(prepared.elementIds, ["card"]);
  assert.equal(prepared.targets[0].tagName, "rect");
  assert.match(prepared.targets[0].fragment, /<defs(?:\s|>)/);
  assert.match(prepared.targets[0].fragment, /transform="translate\(10 20\)"/);
  assert.match(prepared.targets[0].fragment, /id="card"/);
});

test("uses top-level stable ids as a small-SVG fallback", () => {
  const svg = `
    <svg viewBox="0 0 24 24">
      <path id="check" d="M2 12l6 6L22 4" stroke="#000"/>
    </svg>
  `;
  const prepared = prepareSvgAsset({
    svg,
    assetId: "check.svg",
    sourcePath: "assets/check.svg",
  });
  assert.equal(prepared.width, 24);
  assert.equal(prepared.height, 24);
  assert.deepEqual(prepared.elementIds, ["check"]);
});

test("rejects duplicate ids and nested sync targets", () => {
  assert.throws(
    () =>
      prepareSvgAsset({
        svg: `<svg viewBox="0 0 10 10"><rect id="same"/><circle id="same"/></svg>`,
        assetId: "bad.svg",
        sourcePath: "assets/bad.svg",
      }),
    /Duplicate SVG id/,
  );

  assert.throws(
    () =>
      prepareSvgAsset({
        svg: `<svg viewBox="0 0 10 10"><g id="outer" data-figma-sync="target"><rect id="inner" data-figma-sync="target"/></g></svg>`,
        assetId: "bad.svg",
        sourcePath: "assets/bad.svg",
      }),
    /Nested sync target/,
  );
});

test("rejects executable, external, and silently unsupported SVG features", () => {
  const unsafe = [
    `<svg viewBox="0 0 10 10"><script>alert(1)</script><rect id="x"/></svg>`,
    `<svg viewBox="0 0 10 10"><image id="x" href="https://example.com/a.png"/></svg>`,
    `<svg viewBox="0 0 10 10"><rect id="x" onclick="alert(1)"/></svg>`,
    `<svg viewBox="0 0 10 10"><rect id="x" fill="url(https://example.com/a.svg)"/></svg>`,
    `<svg viewBox="0 0 10 10"><pattern id="x"/></svg>`,
  ];

  for (const svg of unsafe) {
    assert.throws(
      () =>
        prepareSvgAsset({
          svg,
          assetId: "unsafe.svg",
          sourcePath: "assets/unsafe.svg",
        }),
      SvgValidationError,
    );
  }
});
