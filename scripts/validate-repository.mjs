import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

const trackedFiles = stdout.split("\0").filter(Boolean);

for (const relativePath of trackedFiles) {
  const pathSegments = relativePath.split("/");
  if (pathSegments.some((segment) => forbiddenDirectories.has(segment))) {
    errors.push(`forbidden runtime/cache path: ${relativePath}`);
    continue;
  }

  const extension = path.extname(relativePath).toLowerCase();
  if (forbiddenExtensions.has(extension)) {
    errors.push(`generated release artifact: ${relativePath}`);
  }

  const absolutePath = path.join(root, relativePath);
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

if (errors.length > 0) {
  console.error("Repository validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Repository validation passed (${trackedFiles.length} tracked files, ${checkedJson} JSON files checked).`,
  );
}
