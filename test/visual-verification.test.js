import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodePng,
  normalizeVisualReference,
  verifyVisualReference,
} from "../codex-plugin/codex-design-bridge/mcp/visual-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = path.join(root, "test", "fixtures", "page-ir-responsive-v2", "screenshots");

test("normalizes a Figma PNG reference and verifies an identical browser render", async () => {
  const bytes = await readFile(path.join(screenshots, "home-402x874.png"));
  const decoded = decodePng(bytes);
  const reference = normalizeVisualReference({
    mimeType: "image/png",
    base64: bytes.toString("base64"),
    width: decoded.width,
    height: decoded.height,
  });
  assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  const result = verifyVisualReference({
    referenceImage: reference,
    browserImage: {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      width: decoded.width,
      height: decoded.height,
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.differentPixels, 0);
  assert.equal(result.meanChannelError, 0);
});

test("fails the visual gate for a visibly different page", async () => {
  const expectedBytes = await readFile(path.join(screenshots, "home-402x874.png"));
  const actualBytes = await readFile(path.join(screenshots, "search-explore-402x905.png"));
  const expected = decodePng(expectedBytes);
  const result = verifyVisualReference({
    referenceImage: {
      mimeType: "image/png",
      base64: expectedBytes.toString("base64"),
      width: expected.width,
      height: expected.height,
    },
    browserImage: {
      dataUrl: `data:image/png;base64,${actualBytes.toString("base64")}`,
      width: 402,
      height: 905,
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.differentPixelRatio > result.thresholds.maxDifferentPixelRatio);
});

test("rejects mismatched PNG declarations instead of silently accepting them", async () => {
  const bytes = await readFile(path.join(screenshots, "home-402x874.png"));
  assert.throws(
    () => normalizeVisualReference({
      mimeType: "image/png",
      base64: bytes.toString("base64"),
      width: 401,
      height: 874,
    }),
    /声明尺寸与 PNG 不一致/u,
  );
});
