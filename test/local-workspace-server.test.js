import test from "node:test";
import assert from "node:assert/strict";
import { startLocalWorkspaceServer } from "../codex-plugin/codex-design-bridge/mcp/local-workspace-server.mjs";

test("serves the CDB workspace directly and forwards same-origin tool calls", async (t) => {
  const calls = [];
  let activeProject = "";
  let workspace = {
    mode: "launcher",
    launcherId: "launcher-local",
    projectName: "CDB",
  };
  const handleRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === "tools/call" && params.name === "get_cdb_health") {
      return {
        structuredContent: {
          health: { healthy: true, workspaceUrl: "local", activeProject },
        },
      };
    }
    if (method === "resources/read") {
      return { contents: [{ text: "<html><body>Workspace    <script>\n      (() => {</body></html>" }] };
    }
    return { structuredContent: { workspace } };
  };
  const server = await startLocalWorkspaceServer({
    handleRequest,
    port: 0,
    initialArguments: { workspaceDir: "/tmp/cdb-projects" },
  });
  t.after(() => server.stop());

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /window\.__CDB_STANDALONE__ = true/);
  assert.match(html, /launcher-local/);
  assert.match(html, /fetch\('\/api\/tools\/call'/);
  assert.equal(
    calls.find((call) => call.params.name === "open_cdb").params.arguments.workspaceDir,
    "/tmp/cdb-projects",
  );

  const health = await fetch(`${server.url}api/health`).then((response) => response.json());
  assert.deepEqual(health, { healthy: true, workspaceUrl: "local", activeProject: "" });

  activeProject = "/tmp/cdb-project";
  workspace = {
    mode: "workspace",
    projectDir: activeProject,
    projectName: "Current project",
  };
  const resumedHtml = await fetch(server.url).then((response) => response.text());
  assert.match(resumedHtml, /Current project/);
  assert.match(resumedHtml, /\/tmp\/cdb-project/);

  const result = await fetch(`${server.url}api/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.url.slice(0, -1),
    },
    body: JSON.stringify({ name: "get_figma_design_offers", arguments: { launcherId: "launcher-local" } }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).structuredContent.workspace, workspace);
  assert.equal(calls.at(-1).params.name, "get_figma_design_offers");

  const denied = await fetch(`${server.url}api/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ name: "open_cdb" }),
  });
  assert.equal(denied.status, 403);
});
