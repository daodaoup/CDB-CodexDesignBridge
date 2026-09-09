import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceProject = process.argv[2];
if (!sourceProject) {
  throw new Error("Usage: node scripts/freeze-responsive-v2-fixtures.mjs <source-project> [fixture-output]");
}
const projectRoot = path.resolve(sourceProject);
const fixtureRoot = path.resolve(
  process.argv[3]
    || new URL("../test/fixtures/page-ir-responsive-v2/", import.meta.url).pathname,
);
const exactBuild = "0.8.0+codex.20260823004648";
const manifest = JSON.parse(await readFile(path.join(projectRoot, ".cdb/manifest.json"), "utf8"));
const projectState = JSON.parse(await readFile(path.join(projectRoot, ".codex/design-bridge.json"), "utf8"));

await mkdir(path.join(fixtureRoot, "pages"), { recursive: true });

const pages = [];
for (const page of manifest.pages) {
  const slug = page.name === "search-explore" ? "search-explore" : "home";
  const baselinePath = path.join(projectRoot, ".cdb/sync-baselines", `${page.id}.json`);
  const baselineText = await readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineText);
  const htmlText = await readFile(path.join(projectRoot, page.entry), "utf8");
  const cssEntry = slug === "home" ? "styles.css" : "search-explore.css";
  const cssText = await readFile(path.join(projectRoot, cssEntry), "utf8");
  const screenshotEntry = `screenshots/${slug}-${page.viewport.width}x${page.viewport.height}.png`;
  const screenshotPath = path.join(fixtureRoot, screenshotEntry);
  const screenshotBytes = await readFile(screenshotPath);

  if (baseline.pageId !== page.id || baseline.pageIr?.pageId !== page.id) {
    throw new Error(`Baseline identity mismatch for ${page.id}.`);
  }
  if (baseline.pageIrSchemaVersion !== 1 || baseline.pageIr?.schemaVersion !== 1) {
    throw new Error(`Expected the frozen 0.8 Page IR v1 baseline for ${page.id}.`);
  }
  if (baseline.nodeMappings.length !== Object.keys(baseline.pageIr.nodes).length) {
    throw new Error(`Node mapping count mismatch for ${page.id}.`);
  }

  const pageDir = path.join(fixtureRoot, "pages", slug);
  await mkdir(pageDir, { recursive: true });
  await writeFile(path.join(pageDir, page.entry), htmlText);
  await writeFile(path.join(pageDir, cssEntry), cssText);
  await writeFile(path.join(pageDir, "page-ir-v1-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  await writeFile(path.join(pageDir, "node-mappings.json"), `${JSON.stringify(baseline.nodeMappings, null, 2)}\n`);

  const projectPageState = projectState.pages.find((candidate) => candidate.id === page.id);
  pages.push({
    id: page.id,
    name: page.name,
    entry: page.entry,
    cssEntry,
    route: page.route,
    designViewport: { width: page.viewport.width, height: page.viewport.height },
    runtimeViewports: [{ id: `design-${page.viewport.width}`, width: page.viewport.width, height: page.viewport.height }],
    previewScale: { mode: "one-to-one", value: 1 },
    figma: baseline.figma,
    projectKey: baseline.projectKey,
    sourceHash: baseline.sourceHash,
    pageIrHash: baseline.pageIrHash,
    nodeCount: Object.keys(baseline.pageIr.nodes).length,
    mappingCount: baseline.nodeMappings.length,
    workspaceNodeCount: projectPageState?.nodeCount ?? null,
    files: {
      html: fileRecord(path.relative(fixtureRoot, path.join(pageDir, page.entry)), Buffer.from(htmlText)),
      css: fileRecord(path.relative(fixtureRoot, path.join(pageDir, cssEntry)), Buffer.from(cssText)),
      pageIr: fileRecord(
        path.relative(fixtureRoot, path.join(pageDir, "page-ir-v1-baseline.json")),
        Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`),
      ),
      nodeMappings: fileRecord(
        path.relative(fixtureRoot, path.join(pageDir, "node-mappings.json")),
        Buffer.from(`${JSON.stringify(baseline.nodeMappings, null, 2)}\n`),
      ),
      screenshot: fileRecord(screenshotEntry, screenshotBytes),
    },
  });
}

const assets = [];
for (const entry of (await readdir(path.join(projectRoot, "assets"))).sort()) {
  const assetPath = path.join(projectRoot, "assets", entry);
  if (!(await stat(assetPath)).isFile()) continue;
  const bytes = await readFile(assetPath);
  assets.push({ file: `assets/${entry}`, bytes: bytes.length, sha256: sha256(bytes) });
}

const fixture = {
  fixtureVersion: 1,
  frozenFromExactBuild: exactBuild,
  frozenAt: "2026-08-24T00:00:00.000Z",
  project: {
    id: manifest.projectId,
    name: manifest.name,
    sourceKind: manifest.source.kind,
    runtime: manifest.runtime,
    mapping: manifest.mapping,
  },
  contract: {
    pageIrBaselineSchemaVersion: 1,
    targetPageIrSchemaVersion: 2,
    previewScaleIsDisplayOnly: true,
    legacyIdentityAccepted: false,
  },
  pages,
  assets,
};

await writeFile(path.join(fixtureRoot, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);

function fileRecord(file, bytes) {
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
