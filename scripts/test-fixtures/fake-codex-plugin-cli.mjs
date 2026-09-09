import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.env.CDB_FAKE_CODEX_STATE;
if (!statePath) throw new Error("CDB_FAKE_CODEX_STATE is required.");
const profileDirectory =
  process.env.USERPROFILE || process.env.HOME || process.cwd();
const args = process.argv.slice(2);
const state = await readState();

if (args[0] !== "plugin") fail("unsupported command");

if (args[1] === "list") {
  respond({ installed: state.installed });
} else if (args[1] === "add") {
  const selector = args[2] || "";
  const separator = selector.lastIndexOf("@");
  if (separator < 1) fail("invalid plugin selector");
  const pluginName = selector.slice(0, separator);
  const marketplaceName = selector.slice(separator + 1);
  const marketplace = state.marketplaces.find(
    (entry) => entry.name === marketplaceName,
  );
  if (!marketplace) fail(`marketplace not found: ${marketplaceName}`);
  const source = path.join(marketplace.root, "plugins", pluginName);
  const manifest = JSON.parse(
    await readFile(path.join(source, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const cachePath = path.join(
    profileDirectory,
    ".codex",
    "plugins",
    "cache",
    marketplaceName,
    pluginName,
    manifest.version,
  );
  await rm(cachePath, { recursive: true, force: true });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await cp(source, cachePath, { recursive: true });
  state.installed = state.installed.filter(
    (entry) => entry.pluginId !== selector,
  );
  state.installed.push({ pluginId: selector, version: manifest.version });
  await saveState();
  respond({ installed: true, pluginId: selector, version: manifest.version });
} else if (args[1] === "remove") {
  const selector = args[2] || "";
  state.installed = state.installed.filter(
    (entry) => entry.pluginId !== selector,
  );
  await saveState();
  respond({ removed: true, pluginId: selector });
} else if (args[1] === "marketplace" && args[2] === "list") {
  respond({ marketplaces: state.marketplaces });
} else if (args[1] === "marketplace" && args[2] === "add") {
  const root = path.resolve(args[3]);
  const config = JSON.parse(
    await readFile(
      path.join(root, ".agents", "plugins", "marketplace.json"),
      "utf8",
    ),
  );
  state.marketplaces = state.marketplaces.filter(
    (entry) => entry.name !== config.name,
  );
  state.marketplaces.push({ name: config.name, root });
  await saveState();
  respond({ added: true, name: config.name, root });
} else if (args[1] === "marketplace" && args[2] === "remove") {
  const name = args[3] || "";
  state.marketplaces = state.marketplaces.filter(
    (entry) => entry.name !== name,
  );
  await saveState();
  respond({ removed: true, name });
} else {
  fail(`unsupported command: ${args.join(" ")}`);
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
      marketplaces: Array.isArray(parsed.marketplaces)
        ? parsed.marketplaces
        : [],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { installed: [], marketplaces: [] };
  }
}

async function saveState() {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
