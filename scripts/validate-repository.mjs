import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const forbiddenDirectories = new Set([
  ".cdb-imports",
  ".codex",
  ".figma-sync",
  ".pnpm-store",
  "node_modules",
]);
const forbiddenExtensions = new Set([".sha256", ".zip"]);
const machinePathPattern = /[A-Z]:\\(?:Users|Codex|Github|Documents)\\/g;
const errors = [];
let checkedJson = 0;

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath);

    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(entry.name)) {
        errors.push(`forbidden runtime/cache directory: ${relativePath}`);
        continue;
      }
      await visit(absolutePath);
      continue;
    }

    if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
      errors.push(`generated release artifact: ${relativePath}`);
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (extension === ".json") {
      try {
        JSON.parse(await readFile(absolutePath, "utf8"));
        checkedJson += 1;
      } catch (error) {
        errors.push(`invalid JSON: ${relativePath} (${error.message})`);
      }
    }

    if ([".md", ".json", ".js", ".mjs", ".cjs", ".html", ".css"].includes(extension)) {
      const contents = await readFile(absolutePath, "utf8");
      if (machinePathPattern.test(contents)) {
        errors.push(`machine-specific absolute path: ${relativePath}`);
      }
      machinePathPattern.lastIndex = 0;
    }
  }
}

await visit(root);

if (errors.length > 0) {
  console.error("Repository validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Repository validation passed (${checkedJson} JSON files checked).`);
}
