import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayPath = path.join(
  root,
  "codex-plugin",
  "codex-design-bridge",
  "mcp",
  "gateway.mjs",
);
const gateway = spawn(process.execPath, [gatewayPath], {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
gateway.stdout.setEncoding("utf8");
gateway.stdout.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const response = JSON.parse(buffer.slice(0, newline));
  const url = response?.result?.structuredContent?.health?.workspaceUrl;
  if (!url) finish(new Error("CDB 本地工作台地址不可用。"));
  else openBrowser(url);
});
gateway.once("error", finish);
gateway.once("exit", (code) => {
  if (code && code !== 0) finish(new Error(`CDB gateway exited with code ${code}.`));
});
gateway.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get_cdb_health", arguments: {} },
})}\n`);

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", finish);
  child.unref();
  process.stdout.write(`CDB 本地工作台：${url}\n`);
  gateway.stdin.end();
}

let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  gateway.stdin.end();
  if (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
