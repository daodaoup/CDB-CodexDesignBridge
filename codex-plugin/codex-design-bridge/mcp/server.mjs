import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureLocalPreview,
  captureLocalPreviewImage,
} from "./browser-capture.mjs";
import { LocalFigmaBridge } from "./local-figma-bridge.mjs";
import { undoLastPatchTransaction } from "./patch-transaction.mjs";
import {
  applyDesignPreflightFixes,
  createDesignProject,
  createFigmaSeedProject,
  detectImportedTabStates,
  loadProjectDescriptor,
  prepareImportedHtml,
  preflightDesignProject,
  workspacePagesFromReport,
  writeImportedManifest,
} from "./project-contract.mjs";
import { WorkspaceLeaseManager } from "./workspace-lease.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(ROOT, "..");
const PLUGIN_VERSION = JSON.parse(
  readFileSync(
    path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
    "utf8",
  ),
).version;
const SERVER_NAME = "codex-design-workspace";
const SERVER_VERSION = PLUGIN_VERSION;
const UI_URI = "ui://codex-design-bridge/workspace-v2.html";
const UI_MIME = "text/html;profile=mcp-app";
const PREVIEW_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_LENGTH = 8_000;
const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 24 * 1024 * 1024;

const states = new Map();
const previews = new Map();
const figmaBridges = new Map();
const launcherStates = new Map();
const bindingWriteQueues = new Map();
let activeProject = "";
let uiHtmlPromise;

const leaseRoot = process.env.CODEX_DESIGN_BRIDGE_LEASE_ROOT ||
  (process.env.CODEX_DESIGN_BRIDGE_PORT === "0"
    ? path.join(tmpdir(), `cdb-design-bridge-test-${process.pid}`)
    : path.join(tmpdir(), "cdb-design-bridge"));
const leaseManager = new WorkspaceLeaseManager({
  leaseRoot,
  getStatus: () => {
    const state = activeProject ? states.get(activeProject) : null;
    const bridge = activeProject ? figmaBridges.get(activeProject) : null;
    return {
      unsentChanges: Boolean(
        bridge?.status().unsentChanges || state?.unsentChanges,
      ),
      sessionActive: Boolean(state?.sessionActive),
    };
  },
  onShutdown: async ({ force }) => {
    if (activeProject) {
      await shutdownWorkspaceResources(activeProject, { force, handoff: true });
    }
  },
});

const tools = [
  {
    name: "open_design_launcher",
    title: "Open CDB launcher",
    description:
      "Open an unbound CDB launcher without scanning a project, starting a preview, or occupying the local Figma connection.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceDir: {
          type: "string",
          description:
            "Optional writable workspace used only as a destination for a later import or new design.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      "ui.resourceUri": UI_URI,
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在打开 CDB",
      "openai/toolInvocation/invoked": "CDB 已打开",
    },
  },
  {
    name: "resolve_design_source",
    title: "Resolve a CDB project source",
    description:
      "Resolve only an explicitly requested path, attachment path, or current workspace into a bounded static CDB project candidate.",
    inputSchema: {
      type: "object",
      properties: {
        explicitPath: { type: "string" },
        attachmentPaths: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        },
        workspaceDir: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "create_design_project",
    title: "Create a CDB design project",
    description:
      "Create a dependency-free CDB HTML/CSS scaffold from a supplied design description and open it after preflight.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceDir: { type: "string" },
        description: { type: "string", minLength: 1, maxLength: 2_000 },
        projectName: { type: "string", maxLength: 80 },
      },
      required: ["workspaceDir", "description"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      "ui.resourceUri": UI_URI,
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在新建设计",
      "openai/toolInvocation/invoked": "新设计已创建",
    },
  },
  {
    name: "create_figma_seed_project",
    title: "Create a CDB project from Figma",
    description:
      "Create and open a single-page CDB project that accepts an existing Figma frame as its initial source.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceDir: { type: "string" },
        projectName: { type: "string", maxLength: 80 },
      },
      required: ["workspaceDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      "ui.resourceUri": UI_URI,
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在等待 Figma 页面",
      "openai/toolInvocation/invoked": "Figma 页面工作台已创建",
    },
  },
  {
    name: "preflight_design_project",
    title: "Preflight a CDB project",
    description:
      "Check entries, capture roots, stable IDs, assets, cross-origin content, runtime DOM, editable layers, blank capture, and manifest pages.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "apply_design_preflight_fixes",
    title: "Apply safe CDB preflight fixes",
    description:
      "Apply selected deterministic preflight fixes transactionally, then rerun preflight.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        reportId: { type: "string" },
        sourceHash: { type: "string" },
        fixIds: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          minItems: 1,
        },
        openAfterFix: { type: "boolean", default: true },
      },
      required: ["projectDir", "reportId", "sourceHash", "fixIds"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "open_design_workspace",
    title: "Open design workspace",
    description:
      "Open a designer-facing workspace that shows the current frontend preview and its Figma round-trip state.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the current frontend project.",
        },
        previewUrl: {
          type: "string",
          description: "Optional already-verified local frontend URL.",
        },
        forceHandoff: {
          type: "boolean",
          description:
            "Take over an old workspace after the user explicitly confirmed unsent Figma changes may remain in Figma.",
          default: false,
        },
      },
      required: ["projectDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      "ui.resourceUri": UI_URI,
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在打开设计工作台",
      "openai/toolInvocation/invoked": "设计工作台已打开",
    },
  },
  {
    name: "get_design_workspace_state",
    title: "Get design workspace state",
    description: "Read the current visible state for a design workspace.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "open_design_preview_in_browser",
    title: "Open design preview in browser",
    description:
      "Open the active project-local preview route in the system default browser.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the active frontend project.",
        },
        pageId: {
          type: "string",
          description: "Optional workspace page id. Defaults to the active page.",
        },
      },
      required: ["projectDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "refresh_design_workspace",
    title: "Refresh design preview",
    description:
      "Refresh the visible frontend preview, restarting it in the background only when needed.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "report_design_workspace_mounted",
    title: "Report embedded workspace mounted",
    description:
      "Record that the MCP Apps workspace resource actually rendered inside Codex.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "undo_last_design_patch",
    title: "Undo the latest Design Bridge patch",
    description:
      "Safely undo the latest transaction only when its output files have not changed since it was applied.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "end_design_session",
    title: "End this design session",
    description:
      "End the active preview and local Figma session. If Figma has unsent changes, ask for confirmation unless force is true.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the active frontend project.",
        },
        force: {
          type: "boolean",
          description: "End even when Figma has unsent changes.",
          default: false,
        },
      },
      required: ["projectDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_design_preview_image",
    title: "Get embedded design preview",
    description:
      "Render the current local frontend as an embedded preview image that is safe to display inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the active frontend project.",
        },
        width: {
          type: "integer",
          minimum: 320,
          maximum: 1920,
        },
        height: {
          type: "integer",
          minimum: 480,
          maximum: 1200,
        },
        pageId: {
          type: "string",
          description: "Optional workspace page to preview.",
        },
      },
      required: ["projectDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "send_preview_to_local_figma",
    title: "Send preview to local Figma",
    description:
      "Capture one or more workspace pages and send them directly to the local Figma plugin without using the official Figma connector.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the active frontend project.",
        },
        pageIds: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          description:
            "Workspace page ids to send. Defaults to the active page.",
        },
      },
      required: ["projectDir"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "manage_design_workspace_page",
    title: "Manage a design workspace page",
    description:
      "Add, select, or rename a local route in the workspace page list.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        action: {
          type: "string",
          enum: ["select"],
        },
        pageId: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
      },
      required: ["projectDir", "action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "import_html_project",
    title: "Import a static HTML project",
    description:
      "Copy selected HTML files and local assets into an isolated project, register its pages, and open it in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        projectName: { type: "string", maxLength: 80 },
        files: {
          type: "array",
          minItems: 1,
          maxItems: MAX_IMPORT_FILES,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              contentBase64: { type: "string" },
              size: { type: "integer", minimum: 0 },
            },
            required: ["path", "contentBase64"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectDir", "files"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "capture_local_figma_changes",
    title: "Capture local Figma changes",
    description:
      "Read visual changes from the local Figma plugin and save them as a project-local change snapshot without using the official Figma connector.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "set_design_workspace_intent",
    title: "Set design workspace intent",
    description:
      "Show immediate progress in the workspace while Codex performs a Figma or undo action.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        action: {
          type: "string",
          enum: [
            "send-to-figma",
            "send-all-to-figma",
            "apply-from-figma",
            "undo",
          ],
        },
      },
      required: ["projectDir", "action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update_design_workspace",
    title: "Update design workspace",
    description:
      "Publish the visible result of a completed Figma or code action back to the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        phase: {
          type: "string",
          enum: [
            "ready",
            "preparing_figma",
            "in_figma",
            "applying",
            "complete",
            "error",
            "ended",
          ],
        },
        message: { type: "string" },
        figmaUrl: { type: "string" },
        changedFiles: {
          type: "array",
          items: { type: "string" },
        },
        changeCount: { type: "integer", minimum: 0 },
        appliedChangeCount: { type: "integer", minimum: 0 },
        pendingChangeCount: { type: "integer", minimum: 0 },
        summary: { type: "string" },
        undoAvailable: { type: "boolean" },
      },
      required: ["projectDir", "phase"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) {
    return;
  }

  try {
    const result = await handleRequest(request.method, request.params ?? {});
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: friendlyError(error),
      },
    });
  }
});

input.on("close", cleanup);
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

async function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(params.name, params.arguments ?? {});
    case "resources/list":
      return {
        resources: [
          {
            uri: UI_URI,
            name: "Codex Design Workspace",
            title: "Codex Design Workspace",
            description:
              "Designer-facing frontend preview and Figma round-trip workspace.",
            mimeType: UI_MIME,
          },
        ],
      };
    case "resources/read":
      if (params.uri !== UI_URI) {
        throw new Error("Workspace view not found.");
      }
      return {
        contents: [
          {
            uri: UI_URI,
            mimeType: UI_MIME,
            text: await readWorkspaceHtml(),
            _meta: resourceMeta(),
          },
        ],
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), {
        code: -32601,
      });
  }
}

async function callTool(name, args) {
  switch (name) {
    case "open_design_launcher": {
      const state = await openDesignLauncher(args);
      return toolResult(state, "CDB 启动器已就绪。");
    }
    case "resolve_design_source": {
      const state = await resolveDesignSource(args);
      return toolResult(state, state.message);
    }
    case "create_design_project": {
      const created = await createDesignProject(args);
      const state = await openWorkspace({ projectDir: created.projectDir });
      return toolResult(state, "新设计已创建并打开。");
    }
    case "create_figma_seed_project": {
      const created = await createFigmaSeedProject(args);
      const state = await openWorkspace({ projectDir: created.projectDir });
      return toolResult(state, "请选择一个 Figma 页面 Frame 发送给 Codex。");
    }
    case "preflight_design_project": {
      const state = await preflightWorkspace(args.projectDir);
      return toolResult(state, state.message);
    }
    case "apply_design_preflight_fixes": {
      const fixed = await applyDesignPreflightFixes(args);
      const state =
        args.openAfterFix !== false &&
        ["pass", "warning"].includes(fixed.report.status)
          ? await openWorkspace({ projectDir: args.projectDir })
          : stateFromPreflight(fixed.report);
      return toolResult(state, state.message);
    }
    case "open_design_workspace": {
      const state = await openWorkspace(args);
      return toolResult(state, "设计工作台已就绪。");
    }
    case "get_design_workspace_state": {
      const state = await getWorkspace(args.projectDir);
      return toolResult(state, state.message);
    }
    case "open_design_preview_in_browser": {
      const state = await openDesignPreviewInBrowser(args);
      return toolResult(state, state.message);
    }
    case "refresh_design_workspace": {
      const state = await refreshWorkspace(args.projectDir);
      return toolResult(state, "预览已刷新。");
    }
    case "report_design_workspace_mounted": {
      const state = await reportWorkspaceMounted(args.projectDir);
      return toolResult(state, "内嵌设计工作台已挂载。");
    }
    case "undo_last_design_patch": {
      const state = await undoLastDesignPatch(args.projectDir);
      return toolResult(state, state.message);
    }
    case "end_design_session": {
      const state = await endDesignSession(args.projectDir, args.force);
      return toolResult(state, state.message);
    }
    case "get_design_preview_image": {
      const preview = await getDesignPreviewImage(args);
      return previewImageResult(preview.state, preview.image);
    }
    case "send_preview_to_local_figma": {
      const state = await sendPreviewToLocalFigma(
        args.projectDir,
        args.pageIds,
      );
      return toolResult(state, state.message);
    }
    case "manage_design_workspace_page": {
      const state = await manageWorkspacePage(args);
      return toolResult(state, state.message);
    }
    case "import_html_project": {
      const state = await importHtmlProject(args);
      return toolResult(state, state.message);
    }
    case "capture_local_figma_changes": {
      const state = await captureLocalFigmaChanges(args.projectDir);
      return toolResult(state, state.message);
    }
    case "set_design_workspace_intent": {
      const state = await setIntent(args.projectDir, args.action);
      return toolResult(state, state.message);
    }
    case "update_design_workspace": {
      const state = await updateWorkspace(args);
      return toolResult(state, state.message);
    }
    default:
      return {
        isError: true,
        content: [{ type: "text", text: "没有找到这个设计操作。" }],
      };
  }
}

async function openDesignLauncher({ workspaceDir } = {}) {
  let destination = "";
  if (typeof workspaceDir === "string" && workspaceDir.trim()) {
    destination = await normalizeProjectDir(workspaceDir);
  }
  const launcherId = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 20);
  const state = {
    mode: "launcher",
    launcherId,
    workspaceDir: destination,
    projectDir: "",
    projectName: "CDB",
    pages: [],
    activePageId: "",
    phase: "launcher_ready",
    sessionActive: false,
    previewUrl: "",
    previewRevision: 0,
    figmaUrl: "",
    figmaReady: false,
    figmaConnected: false,
    bridgeReady: false,
    unsentChanges: false,
    needsEndConfirmation: false,
    needsHandoffConfirmation: false,
    lastFigmaConnectedAt: "",
    connectionIssue: "",
    message: "拖入 HTML 文件或文件夹、选择项目，或描述一个新设计。",
    changeCount: 0,
    appliedChangeCount: 0,
    pendingChangeCount: 0,
    changedFiles: [],
    summary: "",
    importSummary: null,
    designSnapshotPath: "",
    undoAvailable: false,
    lastTransactionId: "",
    workspaceMounted: false,
    uiMountedAt: "",
    startupMs: 0,
    preflightReport: null,
    lease: { owned: false },
    updatedAt: new Date().toISOString(),
  };
  launcherStates.set(launcherId, state);
  return publicState(state);
}

async function resolveDesignSource({
  explicitPath,
  attachmentPaths,
  workspaceDir,
}) {
  const candidates = [
    explicitPath,
    ...(Array.isArray(attachmentPaths) ? attachmentPaths : []),
    workspaceDir,
  ].filter((value) => typeof value === "string" && value.trim());
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate.trim());
      const candidateStat = await stat(resolved);
      const project = candidateStat.isDirectory()
        ? resolved
        : candidateStat.isFile() && /\.html?$/i.test(resolved)
          ? path.dirname(resolved)
          : "";
      if (!project) continue;
      await loadProjectDescriptor(project);
      return preflightWorkspace(project);
    } catch {
      // Continue through the explicit, attachment, then workspace priority.
    }
  }
  const launcher = await openDesignLauncher({ workspaceDir });
  launcher.message = "没有找到可打开的静态 CDB 项目，请从启动器选择来源。";
  return launcher;
}

async function preflightWorkspace(projectDir) {
  const report = await preflightDesignProject(projectDir);
  return stateFromPreflight(report);
}

function stateFromPreflight(report, previous = {}) {
  const project = report.descriptor.rootDir;
  const pages = workspacePagesFromReport(report, previous.pages);
  const fixable = report.issues.filter((entry) => entry.fixId);
  const phase =
    report.status === "blocker"
      ? "preflight_blocked"
      : report.status === "safe_fix"
        ? "preflight_fix_available"
        : "preflight_ready";
  const message =
    report.status === "pass"
      ? "项目预检通过。"
      : report.status === "warning"
        ? `项目预检通过，但有 ${report.issues.length} 个警告。`
        : report.status === "safe_fix"
          ? `发现 ${fixable.length} 项可安全修复的问题。`
          : `发现 ${report.issues.length} 个阻断问题，尚未启动预览。`;
  return publicState({
    ...previous,
    mode: "workspace",
    workspaceDir: previous.workspaceDir || "",
    projectDir: project,
    projectName: report.descriptor.manifest.name || path.basename(project),
    pages,
    activePageId:
      pages.some((page) => page.id === previous.activePageId)
        ? previous.activePageId
        : pages[0]?.id || "",
    phase,
    sessionActive: false,
    previewUrl: "",
    previewRevision: previous.previewRevision || 0,
    figmaUrl: previous.figmaUrl || "",
    figmaReady: pages.some((page) => page.figmaReady),
    figmaConnected: false,
    bridgeReady: false,
    unsentChanges: false,
    needsEndConfirmation: false,
    needsHandoffConfirmation: false,
    lastFigmaConnectedAt: previous.lastFigmaConnectedAt || "",
    connectionIssue: "",
    message,
    changeCount: previous.changeCount || 0,
    appliedChangeCount: previous.appliedChangeCount || 0,
    pendingChangeCount: previous.pendingChangeCount || 0,
    changedFiles: [],
    summary: "",
    importSummary: previous.importSummary || null,
    designSnapshotPath: previous.designSnapshotPath || "",
    undoAvailable: false,
    lastTransactionId: "",
    workspaceMounted: false,
    uiMountedAt: "",
    startupMs: 0,
    preflightReport: publicPreflightReport(report),
    lease: { owned: false },
    updatedAt: new Date().toISOString(),
  });
}

function publicPreflightReport(report) {
  return {
    reportId: report.reportId,
    projectKey: report.projectKey,
    sourceHash: report.sourceHash,
    status: report.status,
    pageCount: report.pageCount,
    dependencyCount: report.dependencyCount,
    estimatedEditableLayers: report.estimatedEditableLayers,
    issues: report.issues.map((entry) => ({ ...entry })),
  };
}

async function openWorkspace({ projectDir, previewUrl, forceHandoff = false }) {
  const startedAt = Date.now();
  const project = await normalizeProjectDir(projectDir);
  const report = await preflightDesignProject(project);
  let state = await getWorkspace(project, report);
  state = {
    ...state,
    mode: "workspace",
    projectName: report.descriptor.manifest.name || path.basename(project),
    pages: workspacePagesFromReport(report, state.pages),
    preflightReport: publicPreflightReport(report),
  };
  state.activePageId = state.pages.some(
    (page) => page.id === state.activePageId,
  )
    ? state.activePageId
    : state.pages[0]?.id || "";
  if (["blocker", "safe_fix"].includes(report.status)) {
    state = {
      ...stateFromPreflight(report, state),
      importSummary: state.importSummary || null,
    };
    states.set(project, state);
    return publicState(state);
  }

  if (activeProject && activeProject !== project) {
    const oldState = states.get(activeProject);
    const oldBridge = figmaBridges.get(activeProject);
    const unsentChanges = Boolean(
      oldBridge?.status().unsentChanges || oldState?.unsentChanges,
    );
    if (unsentChanges && !forceHandoff) {
      state = {
        ...state,
        phase: "handoff_confirmation_required",
        sessionActive: false,
        needsHandoffConfirmation: true,
        message: "旧工作台的 Figma 中还有尚未发送的修改。",
        lease: { owned: false },
        updatedAt: new Date().toISOString(),
      };
      states.set(project, state);
      return publicState(state);
    }
    await shutdownWorkspaceResources(activeProject, {
      force: true,
      handoff: true,
      releaseLease: false,
    });
  }

  const leaseResult = await leaseManager.acquire({
    projectKey: report.projectKey,
    force: forceHandoff,
  });
  if (!leaseResult.acquired) {
    state = {
      ...state,
      phase: leaseResult.confirmationRequired
        ? "handoff_confirmation_required"
        : "workspace_degraded",
      sessionActive: false,
      needsHandoffConfirmation: Boolean(leaseResult.confirmationRequired),
      message: leaseResult.confirmationRequired
        ? "旧工作台的 Figma 中还有尚未发送的修改。"
        : "旧 CDB 工作台暂时无法接管，请稍后重试。",
      lease: {
        owned: false,
        reason: leaseResult.reason || "busy",
      },
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
    return publicState(state);
  }
  activeProject = project;
  if (!state.sessionActive) {
    state = {
      ...state,
      figmaUrl: "",
      figmaReady: false,
      figmaConnected: false,
      unsentChanges: false,
      changeCount: 0,
      appliedChangeCount: 0,
      pendingChangeCount: 0,
      changedFiles: [],
      summary: "",
      designSnapshotPath: "",
      undoAvailable: false,
      lastTransactionId: "",
    };
  }
  state.phase = "opening";
  state.sessionActive = true;
  state.needsEndConfirmation = false;
  state.needsHandoffConfirmation = false;
  state.message = "正在准备页面预览…";
  state.workspaceMounted = false;
  state.uiMountedAt = "";
  state.updatedAt = new Date().toISOString();
  states.set(project, state);

  try {
    const preview = await ensurePreview(project, previewUrl);
    let figmaConnected = false;
    let bridgeMessage = "";
    try {
      const bridge = await ensureLocalFigmaBridge(project);
      figmaConnected = bridge.status().connected;
    } catch (error) {
      bridgeMessage = friendlyBridgeError(error);
    }
    state = {
      ...state,
      phase: state.figmaReady || state.figmaUrl ? "in_figma" : "ready",
      previewUrl: preview.url,
      previewRevision: state.previewRevision + 1,
      figmaConnected,
      bridgeReady: !bridgeMessage,
      message:
        bridgeMessage ||
        (state.figmaReady
          ? "页面已就绪，可以继续检查 Figma 修改。"
          : figmaConnected
            ? "页面与本地 Figma 插件已就绪。"
            : "页面已就绪；在 Figma 中打开本地插件后即可继续。"),
      startupMs: Date.now() - startedAt,
      preflightReport: publicPreflightReport(report),
      lease: leaseManager.status(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    state = {
      ...state,
      phase: "error",
      message: friendlyError(error),
      startupMs: Date.now() - startedAt,
      lease: leaseManager.status(),
      updatedAt: new Date().toISOString(),
    };
  }
  states.set(project, state);
  await writeBinding(project, state);
  return publicState(state);
}

async function getWorkspace(projectDir, preparedReport = null) {
  const project = await normalizeProjectDir(projectDir);
  if (states.has(project)) {
    return synchronizeBridgeState(project, states.get(project));
  }

  const binding = await readBinding(project);
  const report = preparedReport || await preflightDesignProject(project);
  const pages = workspacePagesFromReport(report, binding.pages);
  const activePageId = pages.some((page) => page.id === binding.activePageId)
    ? binding.activePageId
    : pages[0]?.id || "";
  const state = {
    mode: "workspace",
    projectDir: project,
    projectName: report.descriptor.manifest.name || path.basename(project),
    pages,
    activePageId,
    phase: binding.figmaReady || binding.figmaUrl ? "in_figma" : "ready",
    sessionActive: true,
    previewUrl: "",
    previewRevision: 0,
    figmaUrl: "",
    figmaReady: Boolean(binding.figmaReady || binding.figmaUrl),
    figmaConnected: false,
    bridgeReady: false,
    unsentChanges: false,
    needsEndConfirmation: false,
    needsHandoffConfirmation: false,
    lastFigmaConnectedAt: "",
    connectionIssue: "",
    message: binding.figmaReady || binding.figmaUrl
      ? "可以检查 Figma 中的最新修改。"
      : "可以开始预览并在 Figma 中继续设计。",
    changeCount: binding.changeCount || 0,
    appliedChangeCount: binding.appliedChangeCount || 0,
    pendingChangeCount: binding.pendingChangeCount || 0,
    changedFiles: [],
    summary: "",
    designSnapshotPath: binding.designSnapshotPath || "",
    undoAvailable: false,
    lastTransactionId: "",
    workspaceMounted: false,
    uiMountedAt: "",
    startupMs: 0,
    preflightReport: publicPreflightReport(report),
    lease: { owned: false },
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);
  return state;
}

function synchronizeBridgeState(projectDir, state) {
  if (!state.sessionActive) return state;
  const bridge = figmaBridges.get(projectDir);
  if (!bridge) return state;
  const status = bridge.status();
  const figmaPluginVersion = status.figmaPluginVersions?.[0] || "";
  const catalog = new Map(
    (status.pageStates || []).map((page) => [page.id, page]),
  );
  const pages = state.pages.map((page) => {
    const catalogPage = catalog.get(page.id);
    if (!catalogPage) return page;
    return {
      ...page,
      syncState: catalogPage.state || page.syncState,
      figmaReady:
        page.figmaReady ||
        !["not_imported", "failed"].includes(catalogPage.state),
    };
  });
  const pageStateChanged = pages.some(
    (page, index) =>
      page.syncState !== state.pages[index]?.syncState ||
      page.figmaReady !== state.pages[index]?.figmaReady,
  );
  const versionMismatch = status.lastError === "version_mismatch";
  const connectedAt =
    status.connected && !state.figmaConnected
      ? new Date().toISOString()
      : state.lastFigmaConnectedAt;
  if (
    state.bridgeReady === true &&
    state.figmaConnected === status.connected &&
    state.unsentChanges === status.unsentChanges &&
    state.lastFigmaConnectedAt === connectedAt &&
    state.figmaPluginVersion === figmaPluginVersion &&
    state.connectionIssue === (versionMismatch ? "version_mismatch" : "") &&
    !pageStateChanged
  ) {
    return state;
  }
  const updated = {
    ...state,
    pages,
    bridgeReady: true,
    figmaConnected: status.connected,
    figmaPluginVersion,
    unsentChanges: status.unsentChanges,
    lastFigmaConnectedAt: connectedAt,
    ...(versionMismatch
      ? {
          phase: "error",
          connectionIssue: "version_mismatch",
          message:
            "Figma 插件版本与当前工作台不匹配，请更新并重新打开 Figma 插件。",
        }
      : status.connected && state.connectionIssue
        ? {
            phase: state.figmaReady || state.figmaUrl ? "in_figma" : "ready",
            connectionIssue: "",
            message: "Figma 已重新连接，可以继续设计。",
          }
        : { connectionIssue: "" }),
    updatedAt: new Date().toISOString(),
  };
  states.set(projectDir, updated);
  return updated;
}

async function refreshWorkspace(projectDir) {
  const project = await normalizeProjectDir(projectDir);
  let state = await getWorkspace(project);
  const report = await preflightDesignProject(project);
  state = {
    ...state,
    pages: workspacePagesFromReport(report, state.pages),
    preflightReport: publicPreflightReport(report),
  };
  if (["blocker", "safe_fix"].includes(report.status)) {
    state = { ...stateFromPreflight(report, state), sessionActive: state.sessionActive };
    states.set(project, state);
    return publicState(state);
  }
  if (!state.sessionActive) {
    return openWorkspace({ projectDir: project });
  }
  try {
    const preview = await ensurePreview(project, state.previewUrl);
    const bridge = await ensureLocalFigmaBridge(project);
    state = {
      ...state,
      previewUrl: preview.url,
      previewRevision: state.previewRevision + 1,
      figmaConnected: bridge.status().connected,
      bridgeReady: true,
      message: "预览已刷新，可以继续检查。",
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    state = {
      ...state,
      phase: "error",
      message: friendlyError(error),
      updatedAt: new Date().toISOString(),
    };
  }
  states.set(project, state);
  return publicState(state);
}

async function endDesignSession(projectDir, force = false) {
  const project = await normalizeProjectDir(projectDir);
  let state = await getWorkspace(project);
  if (!state.sessionActive) {
    return publicState(state);
  }

  const bridge = figmaBridges.get(project);
  const unsentChanges = Boolean(
    bridge?.status().unsentChanges || state.unsentChanges,
  );
  if (unsentChanges && !force) {
    state = {
      ...state,
      unsentChanges: true,
      needsEndConfirmation: true,
      message: "Figma 中还有尚未发送给 Codex 的修改。",
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
    return publicState(state);
  }
  await shutdownWorkspaceResources(project, {
    force: true,
    handoff: false,
    releaseLease: true,
  });
  return publicState(states.get(project) || state);
}

async function clearFigmaLinksForWorkspace(projectDir) {
  const project = await normalizeProjectDir(projectDir);
  const state = states.get(project) || (await getWorkspace(project));
  const updated = {
    ...state,
    pages: state.pages.map((page) => ({
      ...page,
      figmaReady: false,
      syncState: "not_imported",
      lastSentAt: "",
      nodeCount: 0,
    })),
    phase: state.previewUrl ? "ready" : state.phase,
    sessionActive: true,
    figmaUrl: "",
    figmaReady: false,
    figmaConnected: true,
    bridgeReady: true,
    unsentChanges: false,
    needsEndConfirmation: false,
    needsHandoffConfirmation: false,
    connectionIssue: "",
    changeCount: 0,
    appliedChangeCount: 0,
    pendingChangeCount: 0,
    changedFiles: [],
    summary: "Figma 页面关联与传输记录已清空。",
    importSummary: null,
    designSnapshotPath: "",
    undoAvailable: false,
    lastTransactionId: "",
    message: "Figma 关联数据已清空；Codex 项目与预览仍保持打开。",
    updatedAt: new Date().toISOString(),
  };
  states.set(project, updated);
  await writeBinding(project, updated);
  return publicState(updated);
}

async function shutdownWorkspaceResources(
  project,
  { handoff = false, releaseLease = false } = {},
) {
  const state = states.get(project) || (await getWorkspace(project));
  const preview = previews.get(project);
  const bridge = figmaBridges.get(project);
  previews.delete(project);
  figmaBridges.delete(project);
  await Promise.allSettled(
    [preview?.stop(), bridge?.endSession()].filter(Boolean),
  );
  const updated = {
    ...state,
    phase: "ended",
    sessionActive: false,
    previewUrl: "",
    figmaConnected: false,
    bridgeReady: false,
    unsentChanges: false,
    needsEndConfirmation: false,
    needsHandoffConfirmation: false,
    summary: handoff ? "工作台已由新任务接管。" : "本次设计已结束。",
    message: handoff
      ? "旧预览与 Figma 会话已释放。"
      : "预览与 Figma 会话已停止；再次打开项目会创建新会话。",
    lease: { owned: false },
    updatedAt: new Date().toISOString(),
  };
  states.set(project, updated);
  if (activeProject === project) activeProject = "";
  if (releaseLease) await leaseManager.release();
  return updated;
}

async function getDesignPreviewImage({ projectDir, width, height, pageId }) {
  const project = await normalizeProjectDir(projectDir);
  let state = await getWorkspace(project);
  const preview = await ensurePreview(project, state.previewUrl);
  if (state.previewUrl !== preview.url) {
    state = {
      ...state,
      previewUrl: preview.url,
      previewRevision: state.previewRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
  }
  const page = workspacePage(state, pageId);
  const image = await captureLocalPreviewImage({
    previewUrl: previewUrlForPage(preview.url, page.path),
    width,
    height,
    captureState: page.captureState,
  });
  return { state: publicState(state), image };
}

async function openDesignPreviewInBrowser({ projectDir, pageId }) {
  const project = await normalizeProjectDir(projectDir);
  const current = await getWorkspace(project);
  const preview = await ensurePreview(project, current.previewUrl);
  const page = workspacePage(current, pageId);
  const url = previewUrlForPage(preview.url, page.path);
  if (!normalizeLocalUrl(url)) {
    throw new Error("只能打开当前项目的本地预览页面。");
  }
  await openLocalUrlInDefaultBrowser(url);
  const state = {
    ...current,
    previewUrl: preview.url,
    previewRevision:
      current.previewUrl === preview.url
        ? current.previewRevision
        : current.previewRevision + 1,
    message: `已在默认浏览器中打开 ${page.name}。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);
  return publicState(state);
}

async function openLocalUrlInDefaultBrowser(url) {
  const capturePath = process.env.CODEX_DESIGN_BRIDGE_BROWSER_OPEN_CAPTURE_PATH;
  if (capturePath) {
    await writeFile(capturePath, url, "utf8");
    return;
  }

  const launch =
    process.platform === "win32"
      ? {
          command: "rundll32.exe",
          args: ["url.dll,FileProtocolHandler", url],
        }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };

  await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function manageWorkspacePage(args) {
  const project = await normalizeProjectDir(args.projectDir);
  const state = await getWorkspace(project);
  if (args.action !== "select") {
    throw new Error("CDB 页面由 .cdb/manifest.json 管理，不支持运行时添加或重命名假页面。");
  }
  const pages = [...state.pages];
  const selected = pages.find((page) => page.id === args.pageId);
  if (!selected) {
    throw new Error("不支持这个页面操作。");
  }

  const updated = {
    ...state,
    pages,
    activePageId: selected.id,
    figmaReady: pages.some((page) => page.figmaReady),
    message: `正在预览 ${selected.name}。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, updated);
  await writeBinding(project, updated);
  return publicState(updated);
}

async function importHtmlProject({ projectDir, projectName, files }) {
  const sourceProject = await normalizeProjectDir(projectDir);
  const plan = planHtmlImport(files, projectName);
  const importsRoot = path.join(sourceProject, ".cdb-imports");
  await mkdir(importsRoot, { recursive: true });
  const targetDir = await nextImportDirectory(importsRoot, plan.projectName);
  const stagingDir = path.join(
    importsRoot,
    `.${path.basename(targetDir)}.import-${process.pid}-${Date.now()}`,
  );
  const htmlPages = [];

  await mkdir(stagingDir, { recursive: true });
  try {
    for (const file of plan.files) {
      const destination = safeImportDestination(stagingDir, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      let content = file.content;
      if (isHtmlFile(file.path)) {
        const html = prepareImportedHtml(content.toString("utf8"));
        content = Buffer.from(html, "utf8");
        htmlPages.push({
          path: file.path,
          name: htmlPageName(html, file.path),
          tabStates: detectImportedTabStates(html),
        });
      }
      await writeFile(destination, content);
    }
    await writeImportedManifest(
      stagingDir,
      htmlPages,
      path.basename(targetDir),
    );
    await rename(stagingDir, targetDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }

  await openWorkspace({ projectDir: targetDir });
  const current = states.get(targetDir) || (await getWorkspace(targetDir));
  const importSummary = {
    projectName: path.basename(targetDir),
    pageCount: current.pages.length,
    htmlFileCount: htmlPages.length,
    resourceCount: plan.files.length - htmlPages.length,
    skippedFileCount: plan.skippedFileCount,
    totalBytes: plan.totalBytes,
    targetDir,
  };
  const message = current.pages.length === htmlPages.length
    ? `已导入 ${htmlPages.length} 个 HTML 页面和 ${importSummary.resourceCount} 个资源。`
    : `已导入 ${htmlPages.length} 个 HTML 文件，识别 ${current.pages.length} 个可捕获页面/状态和 ${importSummary.resourceCount} 个资源。`;
  const updated = {
    ...current,
    phase: current.phase === "error" ? "error" : "ready",
    importSummary,
    summary: `${message} 项目已切换到 ${path.basename(targetDir)}。`,
    changedFiles: [],
    message,
    updatedAt: new Date().toISOString(),
  };
  states.set(targetDir, updated);
  await writeBinding(targetDir, updated);
  return publicState(updated);
}

function planHtmlImport(files, requestedName) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("请选择至少一个 HTML 文件或项目文件夹。");
  }
  if (files.length > MAX_IMPORT_FILES) {
    throw new Error(`单次最多导入 ${MAX_IMPORT_FILES} 个文件。`);
  }

  const candidates = files.map((file) => {
    if (!file || typeof file !== "object") {
      throw new Error("导入文件信息无效。");
    }
    const segments = safeImportSegments(file.path);
    if (typeof file.contentBase64 !== "string") {
      throw new Error(`文件缺少内容：${segments.join("/")}`);
    }
    return { file, segments };
  });
  const sharedRoot = commonImportRoot(candidates.map(({ segments }) => segments));
  const accepted = [];
  const seen = new Set();
  let skippedFileCount = 0;
  let totalBytes = 0;

  for (const candidate of candidates) {
    const segments = sharedRoot
      ? candidate.segments.slice(1)
      : candidate.segments;
    if (segments.length === 0 || shouldSkipImportedPath(segments)) {
      skippedFileCount += 1;
      continue;
    }
    const relativePath = segments.join("/");
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      skippedFileCount += 1;
      continue;
    }
    seen.add(key);
    const content = decodeImportContent(
      candidate.file.contentBase64,
      relativePath,
    );
    if (
      Number.isInteger(candidate.file.size) &&
      candidate.file.size !== content.length
    ) {
      throw new Error(`文件大小校验失败：${relativePath}`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_IMPORT_BYTES) {
      throw new Error("单次导入内容不能超过 24 MB。");
    }
    accepted.push({ path: relativePath, content });
  }

  const htmlFiles = accepted.filter((file) => isHtmlFile(file.path));
  if (htmlFiles.length === 0) {
    throw new Error("没有找到可导入的 HTML 文件。");
  }
  accepted.sort((left, right) => left.path.localeCompare(right.path));
  const inferredName =
    sharedRoot || path.basename(htmlFiles[0].path, path.extname(htmlFiles[0].path));
  return {
    projectName: sanitizeImportProjectName(requestedName || inferredName),
    files: accepted,
    skippedFileCount,
    totalBytes,
  };
}

function safeImportSegments(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("导入文件路径为空。");
  }
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`不支持绝对文件路径：${value}`);
  }
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error(`不安全的文件路径：${value}`);
  }
  return segments;
}

function commonImportRoot(paths) {
  if (
    paths.length === 0 ||
    paths.some((segments) => segments.length < 2) ||
    !paths.every((segments) => segments[0] === paths[0][0])
  ) {
    return "";
  }
  return paths[0][0];
}

function shouldSkipImportedPath(segments) {
  const ignoredDirectories = new Set([
    "node_modules",
    ".git",
    ".codex",
    ".figma-sync",
  ]);
  if (segments.some((segment) => ignoredDirectories.has(segment.toLowerCase()))) {
    return true;
  }
  return /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(
    segments.at(-1),
  );
}

function decodeImportContent(value, relativePath) {
  const compact = value.replace(/\s+/g, "");
  if (
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new Error(`文件编码无效：${relativePath}`);
  }
  return Buffer.from(compact, "base64");
}

function sanitizeImportProjectName(value) {
  let name = String(value || "html-project")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  if (!name || name === "." || name === "..") name = "html-project";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
    name = `project-${name}`;
  }
  return name;
}

async function nextImportDirectory(importsRoot, projectName) {
  for (let index = 1; index <= 999; index += 1) {
    const leaf = index === 1 ? projectName : `${projectName}-${index}`;
    const candidate = path.join(importsRoot, leaf);
    try {
      await stat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("同名导入项目过多，请更换项目名称。");
}

function safeImportDestination(root, relativePath) {
  const destination = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`不安全的文件路径：${relativePath}`);
  }
  return destination;
}

function isHtmlFile(relativePath) {
  return /\.html?$/i.test(relativePath);
}

function ensureHtmlCaptureRoot(html) {
  if (/<[A-Za-z][^>]*\bdata-codex-root(?:\s|=|>)/i.test(html)) return html;
  const mappedRoot = html.match(
    /<[A-Za-z][^>]*\bdata-codex-id\s*=\s*(["'])page-root\1[^>]*>/i,
  )?.[0];
  if (mappedRoot) {
    return html.replace(mappedRoot, addCaptureAttributes(mappedRoot, false));
  }
  const mainTags = html.match(/<main\b[^>]*>/gi) || [];
  if (mainTags.length === 1) {
    return html.replace(mainTags[0], addCaptureAttributes(mainTags[0], true));
  }
  const bodyTag = html.match(/<body\b[^>]*>/i)?.[0];
  if (bodyTag) {
    return html.replace(bodyTag, addCaptureAttributes(bodyTag, true));
  }
  return `<main data-codex-root data-codex-id="page-root">${html}</main>`;
}

function addCaptureAttributes(openingTag, addId) {
  const attributes = ["data-codex-root"];
  if (addId && !/\bdata-codex-id\s*=/i.test(openingTag)) {
    attributes.push('data-codex-id="page-root"');
  }
  return openingTag.replace(/>$/, ` ${attributes.join(" ")}>`);
}

function htmlPageName(html, relativePath) {
  const title = html
    .match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (title || path.basename(relativePath, path.extname(relativePath))).slice(
    0,
    80,
  );
}

function importedWorkspacePages(projectName, htmlPages) {
  const ordered = [...htmlPages].sort((left, right) => {
    const leftIndex = left.path.toLowerCase() === "index.html" ? 0 : 1;
    const rightIndex = right.path.toLowerCase() === "index.html" ? 0 : 1;
    return leftIndex - rightIndex || left.path.localeCompare(right.path);
  });
  const pages = ordered.map((page) => {
    const pagePath = page.path.toLowerCase() === "index.html"
      ? "/"
      : `/${page.path.split("/").map(encodeURIComponent).join("/")}`;
    return {
      id: workspacePageId(projectName, pagePath),
      name: page.name,
      path: pagePath,
      figmaReady: false,
      lastSentAt: "",
      nodeCount: 0,
    };
  });
  return { pages, activePageId: pages[0].id };
}

async function sendPreviewToLocalFigma(projectDir, pageIds) {
  const project = await normalizeProjectDir(projectDir);
  let state = await getWorkspace(project);
  const report = await preflightDesignProject(project);
  state = {
    ...state,
    pages: workspacePagesFromReport(report, state.pages),
    preflightReport: publicPreflightReport(report),
  };
  if (["blocker", "safe_fix"].includes(report.status)) {
    state = { ...stateFromPreflight(report, state), sessionActive: state.sessionActive };
    states.set(project, state);
    return publicState(state);
  }
  const selectedPages = selectWorkspacePages(state, pageIds);
  state = {
    ...state,
    phase: "preparing_figma",
    message:
      selectedPages.length > 1
        ? `正在把 ${selectedPages.length} 个页面发送到本地 Figma 插件…`
        : `正在把 ${selectedPages[0].name} 发送到本地 Figma 插件…`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);

  try {
    const bridge = await ensureLocalFigmaBridge(project);
    if (!bridge.status().connected) {
      state = {
        ...state,
        phase: "ready",
        bridgeReady: true,
        figmaConnected: false,
        message: "请先在 Figma 中打开本地 CDB 插件。",
        updatedAt: new Date().toISOString(),
      };
      states.set(project, state);
      return publicState(state);
    }
    const preview = await ensurePreview(project, state.previewUrl);
    const results = [];
    const failures = [];
    let pages = [...state.pages];
    for (const page of selectedPages) {
      try {
        const routeUrl = previewUrlForPage(preview.url, page.path);
        const captured = await captureLocalPreview({
          previewUrl: routeUrl,
          projectDir: project,
          captureState: page.captureState,
        });
        captured.manifest.pageId = page.id;
        captured.manifest.name = `${state.projectName} · ${page.name}`;
        captured.manifest.source = {
          ...(captured.manifest.source || {}),
          file: routeUrl,
          previewUrl: routeUrl,
        };
        const imported = await bridge.pushPage(captured.manifest);
        const nodeCount = imported.nodeCount || captured.nodeCount;
        const sentAt = new Date().toISOString();
        pages = pages.map((candidate) =>
          candidate.id === page.id
            ? {
                ...candidate,
                figmaReady: true,
                lastSentAt: sentAt,
                nodeCount,
                syncState: "synced",
              }
            : candidate,
        );
        results.push({ page, nodeCount });
      } catch (error) {
        failures.push({ page, error: friendlyBridgeError(error) });
        pages = pages.map((candidate) =>
          candidate.id === page.id
            ? { ...candidate, syncState: "failed" }
            : candidate,
        );
      }
    }
    const totalNodes = results.reduce(
      (sum, result) => sum + result.nodeCount,
      0,
    );
    state = {
      ...state,
      pages,
      phase: results.length > 0 ? "in_figma" : "ready",
      previewUrl: preview.url,
      figmaUrl: "",
      figmaReady: pages.some((page) => page.figmaReady),
      figmaConnected: true,
      bridgeReady: true,
      unsentChanges: false,
      changeCount: totalNodes,
      appliedChangeCount: 0,
      pendingChangeCount: 0,
      designSnapshotPath: "",
      summary:
        results.length > 0
          ? `已发送 ${results.length} 个页面、${totalNodes} 个可编辑图层。`
          : "没有页面成功发送到 Figma。",
      message:
        failures.length === 0
          ? "Figma 设计已生成；修改完成后在 Figma 中点击“发送修改给 Codex”。"
          : results.length > 0
            ? `已发送 ${results.length} 个页面，${failures.length} 个页面失败：${failures.map(({ page }) => page.name).join("、")}。`
            : failures[0].error,
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
    bridge.setPageCatalog(pages);
    await writeBinding(project, state);
    return publicState(state);
  } catch (error) {
    state = {
      ...state,
      phase: "ready",
      figmaConnected: false,
      bridgeReady: Boolean(figmaBridges.get(project)),
      message: friendlyBridgeError(error),
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
    return publicState(state);
  }
}

async function captureLocalFigmaChanges(projectDir) {
  const project = await normalizeProjectDir(projectDir);
  let state = await getWorkspace(project);
  state = {
    ...state,
    phase: "applying",
    message: "正在读取本地 Figma 插件中的修改…",
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);

  try {
    const bridge = await ensureLocalFigmaBridge(project);
    const captured = await bridge.captureChanges();
    if (captured.empty) {
      state = {
        ...state,
        phase: "in_figma",
        figmaConnected: true,
        bridgeReady: true,
        unsentChanges: false,
        changeCount: 0,
        appliedChangeCount: 0,
        pendingChangeCount: 0,
        designSnapshotPath: "",
        message: "没有检测到新的 Figma 修改。",
        updatedAt: new Date().toISOString(),
      };
    } else if (captured.fastApply) {
      const current = await getWorkspace(project);
      const fastApply = captured.fastApply;
      const appliedCount = fastApply.appliedCount || 0;
      const pendingCount = fastApply.pendingCount || 0;
      const pageCount = captured.pages || 1;
      const durationSeconds = Math.max(
        0.1,
        (fastApply.durationMs || 0) / 1000,
      ).toFixed(1);
      state = {
        ...current,
        phase: pendingCount > 0 ? "in_figma" : "complete",
        figmaConnected: true,
        bridgeReady: true,
        unsentChanges: false,
        changeCount: captured.changeCount,
        appliedChangeCount: appliedCount,
        pendingChangeCount: pendingCount,
        changedFiles: fastApply.changedFiles || [],
        summary:
          pendingCount > 0
            ? `已收到 ${pageCount} 个页面的 Figma 修改，等待 Codex 应用。`
            : `已从 ${pageCount} 个页面更新 ${appliedCount} 处设计。`,
        designSnapshotPath: captured.snapshotPath,
        lastTransactionId: fastApply.transactionId || "",
        undoAvailable: Boolean(fastApply.undoAvailable),
        message:
          appliedCount > 0 && pendingCount === 0
            ? `已更新 ${pageCount} 个页面的 ${appliedCount} 处修改 · ${durationSeconds} 秒`
            : appliedCount > 0
              ? `已更新 ${pageCount} 个页面的 ${appliedCount} 处，另有 ${pendingCount} 处需要 Codex 处理。`
              : `已收到 ${pageCount} 个页面的 ${pendingCount} 处修改，需要 Codex 处理。`,
        updatedAt: new Date().toISOString(),
      };
      await writeBinding(project, state);
    } else {
      state = {
        ...state,
        phase: "applying",
        figmaConnected: true,
        bridgeReady: true,
        changeCount: captured.changeCount,
        appliedChangeCount: 0,
        pendingChangeCount: captured.changeCount,
        designSnapshotPath: captured.snapshotPath,
        message: `已读取 ${captured.changeCount} 项 Figma 修改，正在应用到代码。`,
        updatedAt: new Date().toISOString(),
      };
    }
    states.set(project, state);
    return publicState(state);
  } catch (error) {
    state = {
      ...state,
      phase: state.figmaReady || state.figmaUrl ? "in_figma" : "ready",
      figmaConnected: false,
      bridgeReady: Boolean(figmaBridges.get(project)),
      designSnapshotPath: "",
      message: friendlyBridgeError(error),
      updatedAt: new Date().toISOString(),
    };
    states.set(project, state);
    return publicState(state);
  }
}

async function ensureLocalFigmaBridge(projectDir) {
  const workspace = states.get(projectDir);
  const identity = {
    projectName: workspace?.projectName || path.basename(projectDir),
    projectKey: workspace?.preflightReport?.projectKey || "",
  };
  const existing = figmaBridges.get(projectDir);
  if (existing) {
    existing.setWorkspaceIdentity(identity);
    existing.setPageCatalog(states.get(projectDir)?.pages || []);
    return existing;
  }
  const configuredPort = Number.parseInt(
    process.env.CODEX_DESIGN_BRIDGE_PORT || "9847",
    10,
  );
  const bridge = new LocalFigmaBridge(projectDir, {
    port: Number.isFinite(configuredPort) ? configuredPort : 9847,
    runtimeVersion: PLUGIN_VERSION,
    ...identity,
    onFastApply: (result) => recordFastApply(projectDir, result),
    onImportPages: (pageIds) =>
      sendPreviewToLocalFigma(projectDir, pageIds),
    onResetWorkspace: () => clearFigmaLinksForWorkspace(projectDir),
  });
  try {
    await bridge.start();
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        "另一个设计工作台正在使用本地 Figma 连接。请关闭旧任务后重试。",
      );
    }
    throw error;
  }
  bridge.setPageCatalog(states.get(projectDir)?.pages || []);
  figmaBridges.set(projectDir, bridge);
  return bridge;
}

async function recordFastApply(projectDir, result) {
  const current = await getWorkspace(projectDir);
  const fastApply = result.fastApply || {};
  if ((fastApply.pendingCount || 0) === 0 && (fastApply.appliedCount || 0) > 0) {
    await verifyFastApply(projectDir, current, result, fastApply);
  }
  const appliedCount = fastApply.appliedCount || 0;
  const pendingCount = fastApply.pendingCount || 0;
  const durationSeconds = Math.max(
    0.1,
    (fastApply.durationMs || 0) / 1000,
  ).toFixed(1);
  const changedFiles = Array.isArray(fastApply.changedFiles)
    ? fastApply.changedFiles
    : [];
  const state = {
    ...current,
    pages: current.pages.map((page) =>
      page.id === result.pageId
        ? {
            ...page,
            figmaReady: true,
            syncState: pendingCount > 0 ? "conflict" : "synced",
          }
        : page,
    ),
    phase: pendingCount > 0 ? "in_figma" : "complete",
    figmaConnected: true,
    bridgeReady: true,
    unsentChanges: false,
    changeCount: result.changeCount || 0,
    appliedChangeCount: appliedCount,
    pendingChangeCount: pendingCount,
    changedFiles,
    summary:
      pendingCount > 0
        ? "已收到 Figma 修改，等待 Codex 应用。"
        : `已更新 ${appliedCount} 处设计。`,
    designSnapshotPath: result.snapshotPath || "",
    lastTransactionId: fastApply.transactionId || "",
    undoAvailable: Boolean(fastApply.undoAvailable),
    message:
      appliedCount > 0 && pendingCount === 0
        ? `已更新 ${appliedCount} 处修改 · ${durationSeconds} 秒`
        : appliedCount > 0
          ? `已更新 ${appliedCount} 处，另有 ${pendingCount} 处需要 Codex 处理。`
          : `已收到 ${pendingCount} 处修改，需要 Codex 处理。`,
    previewRevision:
      current.previewRevision + (appliedCount > 0 ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  await writeBinding(projectDir, state);
  states.set(projectDir, state);
  figmaBridges.get(projectDir)?.setPageCatalog(state.pages);
  return {
    sourceHash:
      state.pages.find((page) => page.id === result.pageId)?.sourceHash || "",
    fastApply,
  };
}

async function verifyFastApply(projectDir, current, result, fastApply) {
  const changes = Array.isArray(result.changeSet?.changes)
    ? result.changeSet.changes
    : [];
  const structural = changes.filter((change) =>
    ["nodeMove", "nodeReparent"].includes(change?.property),
  );
  if (structural.length === 0) {
    fastApply.verification = { status: "not_required" };
    return;
  }
  try {
    const report = await preflightDesignProject(projectDir);
    if (["blocker", "safe_fix"].includes(report.status)) {
      throw Object.assign(new Error("项目预检未通过。"), {
        code: "verification_preflight_failed",
      });
    }
    const page = current.pages.find((entry) => entry.id === result.pageId);
    if (!page) {
      throw Object.assign(new Error("无法定位待验证页面。"), {
        code: "verification_page_missing",
      });
    }
    const preview = await ensurePreview(projectDir, current.previewUrl);
    const captured = await captureLocalPreview({
      previewUrl: previewUrlForPage(preview.url, page.path),
      projectDir,
      captureState: page.captureState,
    });
    let maxPositionErrorPx = 0;
    for (const change of structural) {
      const located = findCapturedNode(captured.manifest.root, change.nodeId);
      if (!located) {
        throw Object.assign(
          new Error(`验证页面中缺少节点：${change.nodeId}`),
          { code: "verification_node_missing" },
        );
      }
      if (located.parent?.id !== change.toParentId) {
        throw Object.assign(
          new Error(`节点 ${change.nodeId} 的父级与 Figma 不一致。`),
          { code: "verification_parent_mismatch" },
        );
      }
      const actualIndex = located.parent.children.indexOf(located.node);
      if (actualIndex !== change.toIndex) {
        throw Object.assign(
          new Error(`节点 ${change.nodeId} 的顺序与 Figma 不一致。`),
          { code: "verification_order_mismatch" },
        );
      }
      if (change.afterBounds) {
        const error = Math.max(
          Math.abs(located.node.x - change.afterBounds.x),
          Math.abs(located.node.y - change.afterBounds.y),
        );
        maxPositionErrorPx = Math.max(maxPositionErrorPx, error);
        if (error > 2) {
          throw Object.assign(
            new Error(`节点 ${change.nodeId} 的位置误差为 ${error.toFixed(2)}px。`),
            { code: "verification_geometry_mismatch" },
          );
        }
      }
    }
    fastApply.verification = {
      status: "passed",
      preflight: report.status,
      checkedNodes: structural.length,
      maxPositionErrorPx,
    };
  } catch (error) {
    let rollback = { status: "failed", reason: "rollback_not_attempted" };
    try {
      const undo = await undoLastPatchTransaction(projectDir);
      rollback = {
        status: undo.status === "committed" ? "passed" : "failed",
        reason:
          undo.status === "committed"
            ? ""
            : `rollback_${undo.status || "not_committed"}`,
      };
    } catch (rollbackError) {
      rollback = {
        status: "failed",
        reason: rollbackError?.code || "rollback_conflict",
        message:
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
      };
    }
    const rolledBack = rollback.status === "passed";
    if (rolledBack) {
      fastApply.appliedCount = 0;
      fastApply.changedFiles = [];
      fastApply.undoAvailable = false;
    }
    fastApply.pendingCount = changes.length;
    fastApply.pending = changes.map((change) => ({
      nodeId: change?.nodeId || null,
      property: change?.property || null,
      stage: "verification",
      reason: rolledBack
        ? error?.code || "verification_failed"
        : `verification_rollback_failed:${rollback.reason}`,
    }));
    fastApply.verification = {
      status: "failed",
      code: error?.code || "verification_failed",
      message: error instanceof Error ? error.message : String(error),
      rollback,
    };
  }
}

function findCapturedNode(root, nodeId, parent = null) {
  if (!root) return null;
  if (root.id === nodeId) return { node: root, parent };
  for (const child of root.children || []) {
    const found = findCapturedNode(child, nodeId, root);
    if (found) return found;
  }
  return null;
}

async function reportWorkspaceMounted(projectDir) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  const mountedAt = new Date().toISOString();
  const updated = {
    ...state,
    workspaceMounted: true,
    uiMountedAt: mountedAt,
    updatedAt: mountedAt,
  };
  states.set(project, updated);
  return updated;
}

async function undoLastDesignPatch(projectDir) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  try {
    const result = await undoLastPatchTransaction(project);
    if (result.status === "nothing_to_undo") {
      const unchanged = {
        ...state,
        undoAvailable: false,
        message: "没有可安全撤销的 Design Bridge 修改。",
        updatedAt: new Date().toISOString(),
      };
      states.set(project, unchanged);
      return unchanged;
    }
    const updated = {
      ...state,
      phase: "complete",
      changedFiles: result.changedFiles,
      changeCount: result.changedFiles.length,
      summary: `已安全撤销 ${result.changedFiles.length} 个文件中的修改。`,
      message: `已撤销上一次 Design Bridge 修改 · ${result.changedFiles.length} 个文件`,
      undoAvailable: false,
      lastTransactionId: result.transactionId,
      previewRevision: state.previewRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    states.set(project, updated);
    await writeBinding(project, updated);
    return updated;
  } catch (error) {
    const conflict = error.code === "undo_conflict";
    const updated = {
      ...state,
      phase: "error",
      message: conflict
        ? "源码在写回后又发生了变化，已停止自动撤销以保护当前修改。"
        : "撤销没有完成，源码保持在可检查状态。",
      summary: conflict ? "撤销冲突，需要 Codex 处理。" : "撤销失败。",
      updatedAt: new Date().toISOString(),
    };
    states.set(project, updated);
    return updated;
  }
}

async function setIntent(projectDir, action) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  const next =
    {
      "send-to-figma": {
        phase: "preparing_figma",
        message: "正在把页面准备为可编辑设计…",
      },
      "send-all-to-figma": {
        phase: "preparing_figma",
        message: "正在把页面列表准备为可编辑设计…",
      },
      "apply-from-figma": {
        phase: "applying",
        message: "正在应用 Figma 中的修改…",
      },
      undo: {
        phase: "applying",
        message: "正在撤销上一次修改…",
      },
    }[action] || {};
  const updated = {
    ...state,
    ...next,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, updated);
  return publicState(updated);
}

async function updateWorkspace(args) {
  const project = await normalizeProjectDir(args.projectDir);
  const state = await getWorkspace(project);
  const updated = {
    ...state,
    ...definedFields(args, [
      "phase",
      "message",
      "figmaUrl",
      "figmaReady",
      "figmaConnected",
      "bridgeReady",
      "unsentChanges",
      "changedFiles",
      "changeCount",
      "appliedChangeCount",
      "pendingChangeCount",
      "summary",
      "designSnapshotPath",
      "undoAvailable",
    ]),
    updatedAt: new Date().toISOString(),
  };
  if (!updated.message) {
    updated.message = messageForPhase(updated.phase);
  }
  if (args.phase === "complete") {
    updated.pendingChangeCount = 0;
    updated.appliedChangeCount =
      args.appliedChangeCount ?? updated.changeCount ?? 0;
    updated.previewRevision += 1;
  }
  states.set(project, updated);
  await writeBinding(project, updated);
  return publicState(updated);
}

async function ensurePreview(projectDir, preferredUrl) {
  const running = previews.get(projectDir);
  if (running && (await isReachable(running.url))) {
    return running;
  }
  if (running) {
    await running.stop();
    previews.delete(projectDir);
  }

  const verified = normalizeLocalUrl(preferredUrl);
  if (verified && (await isReachable(verified))) {
    const external = { kind: "existing", url: verified, stop: async () => {} };
    previews.set(projectDir, external);
    return external;
  }

  const preview = await startProjectPreview(projectDir);
  previews.set(projectDir, preview);
  return preview;
}

async function startProjectPreview(projectDir) {
  const packageJson = await readJson(path.join(projectDir, "package.json"));
  const script = choosePreviewScript(packageJson?.scripts);
  if (script) {
    return startNpmPreview(
      projectDir,
      script,
      packageJson.scripts[script],
    );
  }

  if (await isFile(path.join(projectDir, "index.html"))) {
    return startStaticPreview(projectDir);
  }

  throw new Error(
    "暂时没有找到可以预览的页面。请确认当前任务打开的是前端项目。",
  );
}

function choosePreviewScript(scripts) {
  if (!scripts || typeof scripts !== "object") return null;
  for (const name of ["dev", "preview", "start", "example"]) {
    const command = scripts[name];
    if (
      typeof command === "string" &&
      command.trim() &&
      !/\b(figma-sync|electron)\b/i.test(command)
    ) {
      return name;
    }
  }
  return null;
}

async function startNpmPreview(projectDir, script, command) {
  const guardDirectory = await mkdtemp(
    path.join(tmpdir(), "codex-design-preview-"),
  );
  const guardPath = path.join(guardDirectory, "active");
  await writeFile(guardPath, `${process.pid}\n`, "utf8");
  const windows = process.platform === "win32";
  const executable = windows
    ? process.env.ComSpec || "cmd.exe"
    : "npm";
  const args = windows
    ? ["/d", "/s", "/c", `npm.cmd run ${script}`]
    : ["run", script];
  const guardModule = path
    .join(ROOT, "preview-process-guard.cjs")
    .replaceAll("\\", "/");
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--require="${guardModule}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const child = spawn(executable, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      BROWSER: "none",
      CODEX_DESIGN_BRIDGE_PREVIEW_GUARD: guardPath,
      NODE_OPTIONS: nodeOptions,
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let timer;
  let probeTimer;
  let settled = false;

  const stop = async () => {
    clearTimeout(timer);
    clearInterval(probeTimer);
    await rm(guardPath, { force: true });
    if (!(await waitForProcessExit(child, 1_500))) {
      await stopProcess(child);
    }
    await rm(guardDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
        const url = extractPreviewUrl(output);
        if (url) finish(resolve, url);
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => finish(reject, error));
      child.once("exit", () =>
        finish(
          reject,
          new Error(
            `页面预览没有成功启动。${summarizeOutput(output)}`,
          ),
        ),
      );

      const candidates = inferPreviewUrls(command);
      probeTimer = setInterval(async () => {
        for (const candidate of candidates) {
          if (await isReachable(candidate)) {
            finish(resolve, candidate);
            break;
          }
        }
      }, 500);
      timer = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              `页面准备时间过长，请检查项目能否正常运行。${summarizeOutput(output)}`,
            ),
          ),
        PREVIEW_TIMEOUT_MS,
      );
    });
    return { kind: "npm", script, url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startStaticPreview(projectDir) {
  const server = createServer((request, response) => {
    serveStatic(projectDir, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Preview error");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    await closeServer(server);
    throw new Error("无法打开页面预览。");
  }
  return {
    kind: "static",
    url: `http://127.0.0.1:${address.port}/`,
    stop: () => closeServer(server),
  };
}

async function serveStatic(root, request, response) {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(root, requested);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  let target = filePath;
  if (!(await isFile(target)) && request.headers.accept?.includes("text/html")) {
    target = path.join(root, "index.html");
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

async function normalizeProjectDir(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("没有找到当前项目。");
  }
  const project = path.resolve(value.trim());
  try {
    if (!(await stat(project)).isDirectory()) throw new Error();
  } catch {
    throw new Error("当前项目目录不可用。");
  }
  return project;
}

function normalizeWorkspacePages({
  pages,
  activePageId,
  projectName,
  previewUrl,
}) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of Array.isArray(pages) ? pages : []) {
    try {
      const pagePath = normalizePagePath(candidate?.path);
      const id = workspacePageId(projectName, pagePath);
      if (seen.has(id)) continue;
      seen.add(id);
      normalized.push({
        id,
        name: normalizePageName(candidate?.name, pagePath),
        path: pagePath,
        figmaReady: Boolean(candidate?.figmaReady),
        lastSentAt:
          typeof candidate?.lastSentAt === "string"
            ? candidate.lastSentAt
            : "",
        nodeCount: Number.isInteger(candidate?.nodeCount)
          ? Math.max(0, candidate.nodeCount)
          : 0,
      });
    } catch {
      // Ignore malformed persisted page entries and keep the valid list usable.
    }
  }
  if (normalized.length === 0) {
    const pagePath = pagePathFromPreviewUrl(previewUrl);
    normalized.push({
      id: workspacePageId(projectName, pagePath),
      name: normalizePageName("", pagePath),
      path: pagePath,
      figmaReady: false,
      lastSentAt: "",
      nodeCount: 0,
    });
  }
  const active = normalized.some((page) => page.id === activePageId)
    ? activePageId
    : normalized[0].id;
  return { pages: normalized, activePageId: active };
}

function normalizePagePath(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "/";
  let parsed;
  try {
    parsed = new URL(raw, "http://cdb.local/");
  } catch {
    throw new Error("页面路径无效，请输入 /settings 这样的本地路径。");
  }
  if (parsed.origin !== "http://cdb.local") {
    throw new Error("页面列表只支持当前本地预览中的路径。");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

function pagePathFromPreviewUrl(previewUrl) {
  try {
    const parsed = new URL(previewUrl);
    return normalizePagePath(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
    );
  } catch {
    return "/";
  }
}

function normalizePageName(value, pagePath) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (requested) return requested.slice(0, 80);
  if (pagePath === "/") return "首页";
  const route = pagePath.split(/[?#]/, 1)[0];
  const segment = route.split("/").filter(Boolean).at(-1) || "页面";
  try {
    return decodeURIComponent(segment).slice(0, 80);
  } catch {
    return segment.slice(0, 80);
  }
}

function workspacePageId(projectName, pagePath) {
  const project = safePageIdPart(projectName) || "frontend";
  const route = safePageIdPart(pagePath) || "home";
  const digest = createHash("sha256").update(pagePath).digest("hex").slice(0, 8);
  return `preview-${project}-${route.slice(0, 40)}-${digest}`;
}

function safePageIdPart(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function workspacePage(state, requestedId) {
  const id = requestedId || state.activePageId;
  const page = state.pages.find((candidate) => candidate.id === id);
  if (!page) throw new Error("没有找到这个工作台页面。");
  return page;
}

function selectWorkspacePages(state, requestedIds) {
  const ids = Array.isArray(requestedIds) && requestedIds.length > 0
    ? [...new Set(requestedIds)]
    : [state.activePageId];
  return ids.map((id) => workspacePage(state, id));
}

function previewUrlForPage(basePreviewUrl, pagePath) {
  const base = new URL(basePreviewUrl);
  const target = new URL(normalizePagePath(pagePath), `${base.origin}/`);
  if (target.origin !== base.origin) {
    throw new Error("页面路径必须属于当前本地预览。");
  }
  return target.toString();
}

function normalizeLocalUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

async function readBinding(projectDir) {
  return (
    (await readJson(path.join(projectDir, ".codex", "design-bridge.json"))) ||
    {}
  );
}

async function writeBinding(projectDir, state) {
  if (
    !state.figmaUrl &&
    !state.figmaReady &&
    !state.changeCount &&
    !state.pages?.length
  ) return;
  const previous = bindingWriteQueues.get(projectDir) || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(() => writeBindingFile(projectDir, state));
  bindingWriteQueues.set(projectDir, pending);
  try {
    await pending;
  } finally {
    if (bindingWriteQueues.get(projectDir) === pending) {
      bindingWriteQueues.delete(projectDir);
    }
  }
}

async function writeBindingFile(projectDir, state) {
  const directory = path.join(projectDir, ".codex");
  await mkdir(directory, { recursive: true });
  const bindingPath = path.join(directory, "design-bridge.json");
  const temporaryPath = `${bindingPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const content = `${JSON.stringify(
      {
        version: 2,
        figmaUrl: state.figmaUrl || "",
        figmaReady: Boolean(state.figmaReady),
        changeCount: state.changeCount || 0,
        appliedChangeCount: state.appliedChangeCount || 0,
        pendingChangeCount: state.pendingChangeCount || 0,
        designSnapshotPath: state.designSnapshotPath || "",
        activePageId: state.activePageId || "",
        pages: (state.pages || []).map((page) => ({
          id: page.id,
          name: page.name,
          path: page.path,
          entry: page.entry || "",
          route: page.route || page.path,
          sourceHash: page.sourceHash || "",
          acceptsFigmaSeed: Boolean(page.acceptsFigmaSeed),
          syncState: page.syncState || "not_imported",
          figmaReady: Boolean(page.figmaReady),
          lastSentAt: page.lastSentAt || "",
          nodeCount: page.nodeCount || 0,
        })),
        updatedAt: state.updatedAt,
      },
      null,
      2,
    )}\n`;
  await writeFile(temporaryPath, content, "utf8");
  try {
    await rename(temporaryPath, bindingPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readWorkspaceHtml() {
  uiHtmlPromise ??= readFile(path.join(ROOT, "workspace.html"), "utf8");
  return uiHtmlPromise;
}

function resourceMeta() {
  const csp = {
    frameDomains: [
      "http://127.0.0.1:*",
      "http://localhost:*",
    ],
    connectDomains: [
      "http://127.0.0.1:*",
      "http://localhost:*",
    ],
    redirectDomains: [
      "http://127.0.0.1:*",
      "http://localhost:*",
    ],
  };
  return {
    ui: {
      prefersBorder: false,
      csp,
    },
    "openai/widgetDescription":
      "A visual frontend preview with one-button Figma round trips.",
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": {
      connect_domains: csp.connectDomains,
      frame_domains: csp.frameDomains,
      redirect_domains: csp.redirectDomains,
    },
  };
}

function toolResult(state, text) {
  const workspace = publicState(state);
  return {
    content: [{ type: "text", text }],
    structuredContent: { workspace },
    _meta: { workspace },
  };
}

function previewImageResult(state, previewImage) {
  const workspace = publicState(state);
  return {
    content: [{ type: "text", text: "页面预览已生成。" }],
    structuredContent: { workspace, previewImage },
    _meta: { workspace, previewImage },
  };
}

function publicState(state) {
  const identity = pluginIdentity();
  return {
    pluginVersion: PLUGIN_VERSION,
    runtimeVersion: identity.runtimeVersion,
    sourceVersion: identity.sourceVersion,
    runtimeSource: identity.runtimeSource,
    versionStatus: identity.versionStatus,
    versionMessage: identity.versionMessage,
    mode: state.mode || (state.projectDir ? "workspace" : "launcher"),
    launcherId: state.launcherId || "",
    workspaceDir: state.workspaceDir || "",
    projectDir: state.projectDir || "",
    projectName: state.projectName || "CDB",
    pages: Array.isArray(state.pages)
      ? state.pages.map((page) => ({ ...page }))
      : [],
    activePageId: state.activePageId || "",
    phase: state.phase,
    sessionActive: state.sessionActive !== false,
    previewUrl: state.previewUrl,
    previewRevision: state.previewRevision,
    figmaUrl: state.figmaUrl,
    figmaReady: Boolean(state.figmaReady),
    figmaConnected: Boolean(state.figmaConnected),
    figmaPluginVersion: state.figmaPluginVersion || "",
    bridgeReady: Boolean(state.bridgeReady),
    unsentChanges: Boolean(state.unsentChanges),
    needsEndConfirmation: Boolean(state.needsEndConfirmation),
    needsHandoffConfirmation: Boolean(state.needsHandoffConfirmation),
    lastFigmaConnectedAt: state.lastFigmaConnectedAt || "",
    message: state.message,
    changeCount: state.changeCount,
    appliedChangeCount: state.appliedChangeCount || 0,
    pendingChangeCount: state.pendingChangeCount || 0,
    changedFiles: state.changedFiles,
    summary: state.summary,
    importSummary: state.importSummary
      ? { ...state.importSummary }
      : null,
    designSnapshotPath: state.designSnapshotPath || "",
    undoAvailable: Boolean(state.undoAvailable),
    lastTransactionId: state.lastTransactionId || "",
    workspaceMounted: Boolean(state.workspaceMounted),
    uiMountedAt: state.uiMountedAt || "",
    startupMs: state.startupMs || 0,
    preflightReport: state.preflightReport
      ? {
          ...state.preflightReport,
          issues: Array.isArray(state.preflightReport.issues)
            ? state.preflightReport.issues.map((entry) => ({ ...entry }))
            : [],
        }
      : null,
    lease: state.lease ? { ...state.lease } : { owned: false },
    updatedAt: state.updatedAt,
  };
}

function pluginIdentity() {
  const runtimeSource =
    process.env.CODEX_DESIGN_BRIDGE_RUNTIME_SOURCE ||
    classifyPluginRoot(PLUGIN_ROOT);
  const personalSources = process.env.CODEX_DESIGN_BRIDGE_PERSONAL_SOURCE
    ? [process.env.CODEX_DESIGN_BRIDGE_PERSONAL_SOURCE]
    : [
        path.join(homedir(), "plugins", "codex-design-bridge"),
        path.join(
          homedir(),
          "Library",
          "Application Support",
          "Codex Design Bridge",
          "plugins",
          "codex-design-bridge",
        ),
      ];
  const sourceVersion =
    runtimeSource === "personal-cache"
      ? personalSources
          .map((personalSource) => readOptionalPluginVersion(personalSource))
          .find(Boolean) || ""
      : PLUGIN_VERSION;
  const versionStatus = !sourceVersion
    ? "source_missing"
    : sourceVersion === PLUGIN_VERSION
      ? "current"
      : "mismatch";
  return {
    runtimeVersion: PLUGIN_VERSION,
    sourceVersion,
    runtimeSource,
    versionStatus,
    versionMessage:
      versionStatus === "mismatch"
        ? `Runtime ${PLUGIN_VERSION}; personal source ${sourceVersion}. Fully quit Codex, then reinstall the plugin.`
        : versionStatus === "source_missing"
          ? "Personal plugin source was not found; only the runtime cache version could be verified."
          : "",
  };
}

function classifyPluginRoot(pluginRoot) {
  const normalized = pluginRoot.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.codex/plugins/cache/")) {
    return "personal-cache";
  }
  if (normalized.includes("/plugins/codex-design-bridge")) {
    return "personal-source";
  }
  return "workspace-source";
}

function readOptionalPluginVersion(pluginRoot) {
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

function projectInputSchema() {
  return {
    type: "object",
    properties: {
      projectDir: {
        type: "string",
        description: "Absolute path to the active frontend project.",
      },
    },
    required: ["projectDir"],
    additionalProperties: false,
  };
}

function definedFields(source, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

function messageForPhase(phase) {
  return (
    {
      ready: "页面已就绪，可以在 Figma 中继续设计。",
      preparing_figma: "正在把页面准备为可编辑设计…",
      in_figma: "设计已在 Figma 中就绪。",
      applying: "正在应用 Figma 中的修改…",
      complete: "修改已应用，预览已刷新。",
      error: "这次操作没有完成，请重试。",
      ended: "本次设计已结束。",
    }[phase] || "设计工作台已更新。"
  );
}

function inferPreviewUrls(command = "") {
  const explicitPort = command.match(/(?:--port|-p)(?:\s+|=)(\d{2,5})/i)?.[1];
  if (explicitPort) return [`http://127.0.0.1:${explicitPort}/`];
  if (/\bnext\b|\breact-scripts\b/i.test(command)) {
    return ["http://127.0.0.1:3000/"];
  }
  if (/\bastro\b/i.test(command)) return ["http://127.0.0.1:4321/"];
  if (/\bng\s+serve\b/i.test(command)) return ["http://127.0.0.1:4200/"];
  if (/\bvite\b/i.test(command)) {
    return [
      "http://127.0.0.1:5173/",
      "http://127.0.0.1:4173/",
    ];
  }
  return [];
}

function extractPreviewUrl(output) {
  const matches = stripAnsi(output).match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s]*)?/gi,
  );
  if (!matches?.length) return "";
  return new URL(
    matches
      .at(-1)
      .replace(/[),.;]+$/, "")
      .replace("0.0.0.0", "127.0.0.1")
      .replace("[::]", "127.0.0.1")
      .replace("[::1]", "127.0.0.1"),
  ).toString();
}

async function isReachable(url) {
  if (!normalizeLocalUrl(url)) return false;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(600),
      redirect: "manual",
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
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
    await waitForProcessExit(child, 500);
    return;
  }
  child.kill("SIGTERM");
  await waitForProcessExit(child, 500);
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function cleanup() {
  const running = [...previews.values()];
  const bridges = [...figmaBridges.values()];
  previews.clear();
  figmaBridges.clear();
  await Promise.allSettled([
    ...running.map((preview) => preview.stop()),
    ...bridges.map((bridge) => bridge.stop()),
    leaseManager.stop(),
  ]);
  process.exit(0);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function friendlyError(error) {
  if (error?.code === "ENOENT") {
    return "页面所需的本地工具还没有准备好。";
  }
  return String(error?.message || error || "设计工作台暂时不可用.");
}

function friendlyBridgeError(error) {
  const message = String(error?.message || error || "");
  if (/EADDRINUSE/i.test(message)) {
    return "另一个设计工作台正在使用本地 Figma 连接。请关闭旧任务后重试。";
  }
  return message || "本地 Figma 插件暂时不可用。";
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
  return clean ? ` ${clean.slice(-300)}` : "";
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
