import { createServer } from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9846;
const MAX_REQUEST_BYTES = 1024 * 1024;
const BOOTSTRAP_MARKER = "    <script>\n      (() => {";

export async function startLocalWorkspaceServer({
  handleRequest,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  initialArguments = {},
}) {
  if (typeof handleRequest !== "function") {
    throw new TypeError("Local workspace server requires a request handler.");
  }

  let currentToolOutput = null;
  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        return sendJson(response, 403, { error: "Local workspace access denied." });
      }

      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/api/health") {
        const result = await handleRequest("tools/call", {
          name: "get_cdb_health",
          arguments: {},
        });
        return sendJson(response, 200, result?.structuredContent?.health || {});
      }

      if (request.method === "POST" && url.pathname === "/api/tools/call") {
        requireSameOrigin(request);
        const body = await readJsonBody(request);
        const result = await handleRequest("tools/call", {
          name: body.name,
          arguments: body.arguments ?? {},
        });
        currentToolOutput = result;
        return sendJson(response, 200, result);
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/workspace")) {
        const healthResult = await handleRequest("tools/call", {
          name: "get_cdb_health",
          arguments: {},
        });
        const activeProject = String(
          healthResult?.structuredContent?.health?.activeProject || "",
        );
        const currentProject = String(
          currentToolOutput?.structuredContent?.workspace?.projectDir || "",
        );
        if (
          !currentToolOutput ||
          (activeProject && currentProject !== activeProject) ||
          (!activeProject && currentProject)
        ) {
          currentToolOutput = await handleRequest("tools/call", {
            name: "open_cdb",
            arguments: { action: "auto", ...initialArguments },
          });
        }
        const resource = await handleRequest("resources/read", {
          uri: "ui://codex-design-bridge/workspace-v2.html",
        });
        const html = resource?.contents?.[0]?.text;
        if (typeof html !== "string") throw new Error("CDB workspace UI is unavailable.");
        return sendHtml(response, standaloneWorkspaceHtml(html, currentToolOutput));
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, error?.statusCode || 500, {
        error: String(error?.message || error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;

  return {
    host,
    port: actualPort,
    url,
    stop: () => new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(resolve);
    }),
  };
}

function standaloneWorkspaceHtml(html, initialToolOutput) {
  const bootstrap = [
    "    <script>",
    "      window.__CDB_STANDALONE__ = true;",
    `      window.openai = { toolOutput: ${safeJson(initialToolOutput)},`,
    "        async callTool(name, args) {",
    "          const response = await fetch('/api/tools/call', {",
    "            method: 'POST',",
    "            headers: { 'content-type': 'application/json' },",
    "            body: JSON.stringify({ name, arguments: args || {} }),",
    "          });",
    "          const result = await response.json();",
    "          if (!response.ok) throw new Error(result.error || 'CDB request failed.');",
    "          return result;",
    "        },",
    "        async requestDisplayMode({ mode }) {",
    "          if (mode === 'fullscreen') await document.documentElement.requestFullscreen?.();",
    "          else if (document.fullscreenElement) await document.exitFullscreen?.();",
    "          return { mode };",
    "        },",
    "      };",
    "    </script>",
    BOOTSTRAP_MARKER,
  ].join("\n");
  if (!html.includes(BOOTSTRAP_MARKER)) {
    throw new Error("CDB workspace bootstrap marker is missing.");
  }
  return html.replace(BOOTSTRAP_MARKER, bootstrap);
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isLoopbackHost(value) {
  const host = String(value || "").toLowerCase();
  return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host);
}

function requireSameOrigin(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
    throw httpError(415, "CDB only accepts JSON requests.");
  }
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = `http://${request.headers.host}`;
  if (origin !== expected) throw httpError(403, "Cross-origin workspace request denied.");
}

async function readJsonBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw httpError(413, "Workspace request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, "Workspace request must be a JSON object.");
  }
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(html);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
