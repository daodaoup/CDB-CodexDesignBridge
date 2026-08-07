import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const PREVIEW_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_LENGTH = 8_000;

export async function startProjectPreview({
  rootDirectory,
  logger = console,
  timeoutMs = PREVIEW_TIMEOUT_MS,
} = {}) {
  const root = path.resolve(rootDirectory);
  const packageJson = await readPackageJson(root);
  const script = choosePreviewScript(packageJson?.scripts);
  if (script) {
    return await startNpmPreview({
      rootDirectory: root,
      script,
      command: packageJson.scripts[script],
      logger,
      timeoutMs,
    });
  }

  const indexPath = path.join(root, "index.html");
  if (await isFile(indexPath)) {
    return await startStaticPreview(root);
  }

  throw new Error(
    "未找到可预览的入口。项目需要 index.html，或 package.json 中的 dev、preview、start 脚本。",
  );
}

export function choosePreviewScript(scripts) {
  if (!scripts || typeof scripts !== "object") {
    return null;
  }
  for (const name of ["dev", "preview", "start", "example"]) {
    const command = scripts[name];
    if (
      typeof command === "string" &&
      command.trim() &&
      !/\bfigma-sync\b/i.test(command)
    ) {
      return name;
    }
  }
  return null;
}

export function extractPreviewUrl(output) {
  const clean = stripAnsi(output);
  const matches = clean.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s]*)?/gi,
  );
  if (!matches?.length) {
    return null;
  }
  const value = matches
    .at(-1)
    .replace(/[),.;]+$/, "")
    .replace("0.0.0.0", "127.0.0.1")
    .replace("[::]", "127.0.0.1")
    .replace("[::1]", "127.0.0.1");
  return new URL(value).toString();
}

export async function startStaticPreview(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const server = createServer((request, response) => {
    serveStaticRequest(root, request, response).catch(() => {
      response.writeHead(500).end("Preview error");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    await closeServer(server);
    throw new Error("无法为静态预览分配端口。");
  }
  return {
    kind: "static",
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      await closeServer(server);
    },
  };
}

async function startNpmPreview({
  rootDirectory,
  script,
  command,
  logger,
  timeoutMs,
}) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(executable, ["run", script], {
    cwd: rootDirectory,
    env: { ...process.env, BROWSER: "none" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  let timer;
  let probeTimer;

  const stop = async () => {
    clearTimeout(timer);
    clearInterval(probeTimer);
    await stopProcess(child);
  };

  try {
    const url = await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(probeTimer);
        callback(value);
      };
      const inspect = (chunk) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_LENGTH);
        const detected = extractPreviewUrl(output);
        if (detected) {
          finish(resolve, detected);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => finish(reject, error));
      child.once("exit", (code) => {
        finish(
          reject,
          new Error(
            `预览命令 npm run ${script} 已退出（${code ?? "unknown"}）。${summarizeOutput(output)}`,
          ),
        );
      });

      const candidates = inferPreviewUrls(command);
      probeTimer = setInterval(async () => {
        for (const candidate of candidates) {
          if (await isReachable(candidate)) {
            finish(resolve, candidate);
            return;
          }
        }
      }, 500);
      timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            `等待 npm run ${script} 的预览地址超时。${summarizeOutput(output)}`,
          ),
        );
      }, timeoutMs);
    });

    logger.log(`Preview ready: ${url}`);
    return { kind: "npm", script, url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function inferPreviewUrls(command = "") {
  const explicitPort = command.match(/(?:--port|-p)(?:\s+|=)(\d{2,5})/i)?.[1];
  if (explicitPort) {
    return [`http://127.0.0.1:${explicitPort}/`];
  }
  if (/\bnext\b/i.test(command) || /\breact-scripts\b/i.test(command)) {
    return ["http://127.0.0.1:3000/"];
  }
  if (/\bastro\b/i.test(command)) {
    return ["http://127.0.0.1:4321/"];
  }
  if (/\bng\s+serve\b/i.test(command)) {
    return ["http://127.0.0.1:4200/"];
  }
  if (/\bvite\b/i.test(command)) {
    return ["http://127.0.0.1:5173/"];
  }
  return [
    "http://127.0.0.1:3000/",
    "http://127.0.0.1:5173/",
    "http://127.0.0.1:4173/",
  ];
}

async function serveStaticRequest(root, request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const absolutePath = path.resolve(root, requested);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  let filePath = absolutePath;
  if (!(await isFile(filePath)) && request.headers.accept?.includes("text/html")) {
    filePath = path.join(root, "index.html");
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

async function readPackageJson(rootDirectory) {
  try {
    return JSON.parse(
      await readFile(path.join(rootDirectory, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isReachable(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(400),
      redirect: "manual",
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function stripAnsi(value) {
  return String(value).replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

function summarizeOutput(output) {
  const clean = stripAnsi(output).trim().replace(/\s+/g, " ");
  return clean ? ` ${clean.slice(-500)}` : "";
}

function contentType(filePath) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    }[path.extname(filePath).toLowerCase()] || "application/octet-stream"
  );
}
