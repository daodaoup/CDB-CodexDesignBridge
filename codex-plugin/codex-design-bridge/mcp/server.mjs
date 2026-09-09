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
import { DesignOfferStore } from "./design-offer-store.mjs";
import { SyncBaselineStore } from "./sync-baseline-store.mjs";
import {
  recoverIncompletePatchTransactions,
  undoLastPatchTransaction,
} from "./patch-transaction.mjs";
import {
  addPageFromFigmaPayload,
  applyDesignPreflightFixes,
  createDesignProject,
  createFigmaSeedProject,
  createProjectFromFigmaPayload,
  detectImportedTabStates,
  loadProjectDescriptor,
  prepareImportedHtml,
  preflightDesignProject,
  recoverAbandonedProjectStaging,
  removeProjectPage,
  workspacePagesFromReport,
  writeImportedManifest,
} from "./project-contract.mjs";
import {
  compactResponsivePageIr as compactPageIr,
  resolveResponsivePageIrConflicts as resolvePageIrConflicts,
} from "../shared/page-ir-responsive-v2.mjs";
import {
  currentRuntimeIdentity,
  validateExactRuntimeIdentity,
} from "../shared/runtime-contract.mjs";
import { WorkspaceLeaseManager } from "./workspace-lease.mjs";
import { verifyVisualReference } from "./visual-verification.mjs";

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
const BINDING_VERSION = 3;

const states = new Map();
const previews = new Map();
const figmaBridges = new Map();
const launcherStates = new Map();
const bindingWriteQueues = new Map();
const verificationArtifacts = new Map();
let activeProject = "";
let launcherBridge = null;
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
const designOfferStore = new DesignOfferStore(
  process.env.CODEX_DESIGN_BRIDGE_OFFER_STORE ||
    path.join(
      leaseRoot,
      `design-offers-v15-${PLUGIN_VERSION.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`,
    ),
);

const tools = [
  {
    name: "open_cdb",
    title: "Open CDB",
    description:
      "Deterministically open CDB: resume a bound workspace when present, otherwise open the launcher. Can also explicitly start from Figma or open a project.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["auto", "launcher", "project", "figma"],
          default: "auto",
        },
        workspaceDir: { type: "string" },
        projectDir: { type: "string" },
      },
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
      "openai/toolInvocation/invoking": "正在连接 CDB",
      "openai/toolInvocation/invoked": "CDB 已打开",
    },
  },
  {
    name: "get_cdb_health",
    title: "Get CDB health",
    description:
      "Return the local CDB daemon, workspace, preview, and Figma bridge health without opening a workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
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
    name: "get_figma_design_offers",
    title: "Get pending Figma design offers",
    description: "Read the protocol 16 Figma design offer inbox for a CDB launcher.",
    inputSchema: {
      type: "object",
      properties: { launcherId: { type: "string", minLength: 1 } },
      required: ["launcherId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "accept_figma_design_offer",
    title: "Accept a Figma design offer",
    description: "Ask the connected Figma plugin to collect the accepted Frame as a protocol 16 Responsive v2 page payload.",
    inputSchema: {
      type: "object",
      properties: {
        launcherId: { type: "string", minLength: 1 },
        offerId: { type: "string", minLength: 8 },
        action: { enum: ["create_project", "add_page", "update_page"] },
        workspaceDir: { type: "string" },
        projectDir: { type: "string" },
        pageId: { type: "string" },
      },
      required: ["offerId", "action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
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
    name: "get_design_verification_images",
    title: "Get design verification images",
    description:
      "Return the latest Figma reference and browser render for local visual-difference review.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the active frontend project.",
        },
        pageId: {
          type: "string",
          description: "Optional workspace page. Defaults to the active page.",
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
    name: "focus_figma_design_node",
    title: "Focus a verified Figma difference node",
    description:
      "Select and zoom to a Figma node referenced by the current visual-verification differences.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        pageId: { type: "string" },
        nodeId: { type: "string" },
      },
      required: ["projectDir", "pageId", "nodeId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_design_source_location",
    title: "Get a verified design source location",
    description:
      "Return a small source snippet for a node referenced by the current visual-verification differences.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        pageId: { type: "string" },
        nodeId: { type: "string" },
      },
      required: ["projectDir", "pageId", "nodeId"],
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
      "Select a manifest page or remove it from the CDB page list without deleting source files or Figma layers.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        action: {
          type: "string",
          enum: ["select", "remove"],
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
    name: "resolve_design_sync_conflict",
    title: "Resolve a Figma and HTML sync conflict",
    description: "Explicitly keep the current HTML or accepted Figma snapshot for a field-level Page IR conflict, then verify and advance the common baseline.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: { type: "string" },
        resolution: { enum: ["html", "figma"] },
      },
      required: ["projectDir", "resolution"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "copy_design_sync_conflict",
    title: "Copy the saved Figma conflict as a new local page",
    description: "Preserve the saved Figma page snapshot as a new transaction-backed local HTML page without overwriting or resolving the original conflicted page.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "undo_design_sync_conflict_resolution",
    title: "Undo the last design sync conflict resolution",
    description: "Undo the latest explicit HTML- or Figma-side conflict resolution, restore its previous common baseline, and reopen the saved conflict.",
    inputSchema: projectInputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
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

if (process.env.CDB_MCP_TRANSPORT !== "daemon") {
  startStdioTransport();
}

function startStdioTransport() {
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
          code: error?.code || -32603,
          message: friendlyError(error),
        },
      });
    }
  });

  input.on("close", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

export async function handleRequest(method, params) {
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
    case "open_cdb": {
      const state = await openCdb(args);
      return toolResult(state, state.message || "CDB 已打开。");
    }
    case "get_cdb_health": {
      const health = runtimeStatus();
      return {
        content: [
          {
            type: "text",
            text: health.healthy
              ? "CDB 后台服务运行正常。"
              : "CDB 后台服务需要检查。",
          },
        ],
        structuredContent: { health },
      };
    }
    case "open_design_launcher": {
      const state = await openDesignLauncher(args);
      return toolResult(state, "CDB 启动器已就绪。");
    }
    case "resolve_design_source": {
      const state = await resolveDesignSource(args);
      return toolResult(state, state.message);
    }
    case "get_figma_design_offers": {
      const state = await refreshLauncherOffers(args.launcherId);
      return toolResult(state, state.message);
    }
    case "accept_figma_design_offer": {
      const state = await acceptLauncherOffer(args);
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
    case "get_design_verification_images": {
      const comparison = await getDesignVerificationImages(args);
      return verificationImagesResult(comparison.state, comparison.images);
    }
    case "focus_figma_design_node": {
      const focused = await focusFigmaDesignNode(args);
      return figmaFocusResult(focused.state, focused.focus);
    }
    case "get_design_source_location": {
      const located = await getDesignSourceLocation(args);
      return sourceLocationResult(located.state, located.sourceLocation);
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
    case "resolve_design_sync_conflict": {
      const state = await resolveDesignSyncConflict(args);
      return toolResult(state, state.message);
    }
    case "copy_design_sync_conflict": {
      const state = await copyDesignSyncConflict(args);
      return toolResult(state, state.message);
    }
    case "undo_design_sync_conflict_resolution": {
      const state = await undoDesignSyncConflictResolution(args);
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

async function openCdb({ action = "auto", workspaceDir, projectDir } = {}) {
  if (action === "launcher") {
    return openDesignLauncher({ workspaceDir });
  }
  if (action === "figma") {
    const created = await createFigmaSeedProject({ workspaceDir });
    return openWorkspace({ projectDir: created.projectDir });
  }
  if (action === "project" || projectDir) {
    const requestedProject = projectDir || workspaceDir;
    if (!requestedProject) {
      throw new Error("请提供要打开的 CDB 项目目录。");
    }
    return openWorkspace({ projectDir: requestedProject });
  }

  if (activeProject && states.has(activeProject)) {
    return getWorkspace(activeProject);
  }

  if (workspaceDir) {
    const candidate = await normalizeProjectDir(workspaceDir);
    if (await isFile(path.join(candidate, ".cdb", "manifest.json"))) {
      return openWorkspace({ projectDir: candidate });
    }
  }
  return openDesignLauncher({ workspaceDir });
}

export function runtimeStatus() {
  const activeState = activeProject ? states.get(activeProject) : null;
  const activeBridge = activeProject ? figmaBridges.get(activeProject) : null;
  return {
    healthy: true,
    pid: process.pid,
    version: SERVER_VERSION,
    transport: process.env.CDB_MCP_TRANSPORT || "stdio",
    workspaceUrl: process.env.CODEX_DESIGN_BRIDGE_WORKSPACE_URL || "",
    activeProject,
    activeWorkspaceCount: states.size,
    previewCount: previews.size,
    figmaBridgeCount: figmaBridges.size + (launcherBridge ? 1 : 0),
    sessionActive: Boolean(activeState?.sessionActive),
    unsentChanges: Boolean(
      activeBridge?.status().unsentChanges || activeState?.unsentChanges,
    ),
  };
}

async function openDesignLauncher({ workspaceDir } = {}) {
  let destination = "";
  let stagingRecovery = { recoveredCount: 0, removedDirectories: [] };
  if (typeof workspaceDir === "string" && workspaceDir.trim()) {
    destination = await normalizeProjectDir(workspaceDir);
    stagingRecovery = await recoverAbandonedProjectStaging(destination);
  }
  const launcherId = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 20);
  const offers = await designOfferStore.list();
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
    designOffers: offers,
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
    summary: stagingRecovery.recoveredCount > 0
      ? `已清理 ${stagingRecovery.recoveredCount} 个异常终止后遗留的项目临时目录。`
      : "",
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
  if (!activeProject) {
    try {
      await ensureLauncherFigmaBridge();
      state.bridgeReady = true;
      state.figmaConnected = launcherBridge.status().connected;
      state.message = offers.length > 0
        ? `收到 ${offers.length} 个来自 Figma 的设计提案。`
        : "等待 Figma 发送完整页面，或选择其他设计来源。";
    } catch (error) {
      state.connectionIssue = friendlyBridgeError(error);
      state.message = "启动器已打开；本地 Figma 连接暂时不可用。";
    }
  }
  if (stagingRecovery.recoveredCount > 0) {
    state.message = `已恢复异常终止前的项目目录状态；${state.message}`;
  }
  return publicState(state);
}

async function refreshLauncherOffers(launcherId) {
  const state = launcherStates.get(String(launcherId || ""));
  if (!state) throw new Error("CDB 启动器已经失效，请重新打开。");
  if (state.mode === "workspace" && state.projectDir) {
    const workspace = await getWorkspace(state.projectDir);
    const transitioned = { ...workspace, launcherId: state.launcherId };
    launcherStates.set(state.launcherId, transitioned);
    return publicState(transitioned);
  }
  const offers = await designOfferStore.list();
  state.designOffers = offers;
  state.bridgeReady = Boolean(launcherBridge);
  state.figmaConnected = Boolean(launcherBridge?.status().connected);
  state.message = offers.length > 0
    ? `收到 ${offers.length} 个来自 Figma 的设计提案。`
    : state.figmaConnected
      ? "Figma 已连接，选择一个完整页面后发送到 CDB。"
      : "等待 Figma 发送完整页面，或选择其他设计来源。";
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

async function acceptLauncherOffer({ launcherId, offerId, action, workspaceDir, projectDir, pageId }) {
  const launcherState = launcherStates.get(String(launcherId || ""));
  const resolvedProject = projectDir ? await normalizeProjectDir(projectDir) : "";
  const state = launcherState || (resolvedProject ? await getWorkspace(resolvedProject) : null);
  if (!state) throw new Error("CDB 启动器或项目工作台已经失效，请重新打开。");
  const bridge = launcherState
    ? await ensureLauncherFigmaBridge()
    : await ensureLocalFigmaBridge(resolvedProject);
  const target = {
    action,
    launcherId: launcherState?.launcherId || "",
    workspaceDir: String(workspaceDir || state.workspaceDir || ""),
    projectDir: resolvedProject,
    pageId: String(pageId || ""),
  };
  await bridge.acceptDesignOffer(offerId, target);
  const updated = {
    ...state,
    designOffers: await designOfferStore.list(),
    message: "已请求 Figma 重新采集完整页面。",
    updatedAt: new Date().toISOString(),
  };
  if (launcherState) launcherStates.set(launcherState.launcherId, updated);
  else states.set(resolvedProject, updated);
  return publicState(updated);
}

async function processLauncherDesignPayload(offer) {
  const payload = JSON.parse(await readFile(offer.payloadPath, "utf8"));
  if (offer.target?.action === "add_page") {
    return processAddPageOffer(offer, payload);
  }
  if (offer.target?.action === "update_page") {
    return processUpdatePageOffer(offer, payload);
  }
  if (offer.target?.action !== "create_project") {
    throw Object.assign(new Error("当前候选只支持从 Figma 创建项目或加入现有静态项目。"), {
      code: "offer_target_not_implemented",
    });
  }
  if (!offer.target.workspaceDir) {
    throw Object.assign(new Error("创建 Figma 项目需要本地工作区目录。"), {
      code: "workspace_required",
    });
  }
  const created = await createProjectFromFigmaPayload({
    workspaceDir: offer.target.workspaceDir,
    projectName: offer.rootName || "figma-design",
    pageId: payload.pageIr.pageId,
    pageName: offer.rootName,
    pageSeed: payload.pageSeed,
  });
  const page = created.report.pages[0];
  const pageIr = compactPageIr({
    ...payload.pageIr,
    projectKey: created.descriptor.projectKey,
    nodes: Object.fromEntries(
      Object.entries(payload.pageIr.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          figma:
            id === payload.pageIr.rootId && !node.figma?.nodeId
              ? { ...(node.figma || {}), nodeId: offer.rootNodeId }
              : node.figma,
          sourceRef: {
            ...node.sourceRef,
            file: page.entry,
          },
        },
      ]),
    ),
  });
  const current = await getWorkspace(created.projectDir);
  const bridge = launcherBridge
    ? createLocalFigmaBridge(created.projectDir)
    : await ensureLocalFigmaBridge(created.projectDir);
  const captured = await bridge.captureHtmlPageIr(created.generated.pageId);
  const verification = await verifyOfferedPageVisual({
    projectDir: created.projectDir,
    current,
    page: current.pages.find((entry) => entry.id === created.generated.pageId) || page,
    payload,
  }).catch(async (error) => {
    await shutdownWorkspaceResources(created.projectDir, { force: true }).catch(() => {});
    states.delete(created.projectDir);
    await rm(created.projectDir, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(error, {
      code: error?.code || "visual_verification_failed",
      rollback: { status: "passed", action: "removed_created_project" },
    });
  });
  const common = resolvePageIrConflicts({
    baseline: pageIr,
    html: captured.pageIr,
    figma: pageIr,
    resolution: "html",
  });
  const reconciledPageIr = compactPageIr({
    ...common.merged,
    nodes: Object.fromEntries(
      Object.entries(common.merged.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          figma: pageIr.nodes[id]?.figma || node.figma,
          sourceRef: {
            ...node.sourceRef,
            file: page.entry,
          },
        },
      ]),
    ),
  });
  const baseline = await new SyncBaselineStore(created.projectDir).commit({
    pageIr: reconciledPageIr,
    sourceHash: page.sourceHash,
    figma: {
      fileKey: offer.figmaFileKey,
      rootNodeId: offer.rootNodeId,
      rootNodeName: offer.rootName,
    },
    transactionId: `offer:${offer.offerId}`,
  });
  const synchronizedPages = workspacePagesFromReport(
    created.report,
    current.pages,
  ).map((candidate) =>
    candidate.id === created.generated.pageId
      ? {
          ...candidate,
          sourceHash: page.sourceHash,
          pageIrHash: baseline.pageIrHash,
          figmaReady: true,
          syncState: "synced",
        }
      : candidate,
  );
  const synchronizedState = {
    ...current,
    pages: synchronizedPages,
    activePageId: created.generated.pageId,
    figmaReady: true,
    verification,
    message: `已从 Figma 创建项目“${offer.rootName || created.descriptor.manifest.name}”。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(created.projectDir, synchronizedState);
  await writeBinding(created.projectDir, synchronizedState);
  const result = {
    action: "create_project",
    projectDir: created.projectDir,
    projectKey: created.descriptor.projectKey,
    pageId: created.generated.pageId,
    entry: page.entry,
    route: page.route,
    sourceHash: page.sourceHash,
    pageIrHash: baseline.pageIrHash,
    rootNodeId: offer.rootNodeId,
    rootNodeName: offer.rootName,
    nodeMappings: baseline.nodeMappings,
    transactionId: `offer:${offer.offerId}`,
    nodeCount: created.generated.nodeCount,
    resourceCount: created.generated.resourceCount,
    resourceBytes: created.generated.resourceBytes,
    preflightStatus: created.report.status,
    verification,
  };
  setTimeout(async () => {
    try {
      const opened = await openWorkspace({ projectDir: created.projectDir });
      const launcherId = String(offer.target?.launcherId || "");
      if (launcherId && launcherStates.has(launcherId)) {
        launcherStates.set(launcherId, { ...opened, launcherId });
      }
    } catch (error) {
      console.error(`[CDB Figma Offer] Created project could not be opened: ${error?.stack || error}`);
    }
  }, 100);
  return result;
}

async function processAddPageOffer(offer, payload) {
  if (!offer.target?.projectDir) {
    throw Object.assign(new Error("加入 Figma 页面需要明确的本地项目目录。"), {
      code: "project_required",
    });
  }
  const descriptor = await loadProjectDescriptor(offer.target.projectDir);
  if (offer.linkedPageId) {
    throw Object.assign(new Error("这个 Figma Frame 已关联页面，请选择更新关联页面或复制为新页面。"), {
      code: "figma_page_already_linked",
    });
  }
  if (offer.linkedProjectKey && offer.linkedProjectKey !== descriptor.projectKey) {
    throw Object.assign(new Error("这个 Figma Frame 属于另一个本地项目，不能静默加入当前项目。"), {
      code: "figma_project_identity_conflict",
    });
  }
  for (const page of descriptor.manifest.pages) {
    const baseline = await new SyncBaselineStore(descriptor.rootDir).get(page.id);
    if (
      baseline?.figma?.fileKey === offer.figmaFileKey &&
      baseline?.figma?.rootNodeId === offer.rootNodeId
    ) {
      throw Object.assign(new Error(`这个 Figma Frame 已关联到页面 ${page.name}。`), {
        code: "figma_root_identity_conflict",
      });
    }
  }

  const added = await addPageFromFigmaPayload({
    projectDir: descriptor.rootDir,
    pageId: offer.target.pageId || payload.pageIr.pageId,
    pageName: offer.rootName,
    pageSeed: payload.pageSeed,
  });
  const pageIr = compactPageIr({
    ...payload.pageIr,
    pageId: added.generated.pageId,
    projectKey: added.descriptor.projectKey,
    nodes: Object.fromEntries(
      Object.entries(payload.pageIr.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          figma:
            id === payload.pageIr.rootId && !node.figma?.nodeId
              ? { ...(node.figma || {}), nodeId: offer.rootNodeId }
              : node.figma,
          sourceRef: {
            ...node.sourceRef,
            file: added.generated.entry,
          },
        },
      ]),
    ),
  });
  const current = await getWorkspace(added.projectDir);
  const pages = workspacePagesFromReport(added.report, current.pages);
  const updated = {
    ...current,
    pages,
    activePageId: added.generated.pageId,
    lastTransactionId: added.transaction.transactionId,
    undoAvailable: added.transaction.undoAvailable,
    changedFiles: added.transaction.changedFiles,
    message: `已从 Figma 添加页面“${added.generated.pageName}”。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(added.projectDir, updated);
  await writeBinding(added.projectDir, updated);
  figmaBridges.get(added.projectDir)?.setPageCatalog(pages);
  const bridge = launcherBridge
    ? createLocalFigmaBridge(added.projectDir)
    : await ensureLocalFigmaBridge(added.projectDir);
  const captured = await bridge.captureHtmlPageIr(added.generated.pageId);
  const verification = await verifyOfferedPageVisual({
    projectDir: added.projectDir,
    current: updated,
    page: pages.find((entry) => entry.id === added.generated.pageId),
    payload,
  }).catch(async (error) => {
    let rollback = { status: "failed", reason: "rollback_not_attempted" };
    try {
      const undone = await undoLastPatchTransaction(added.projectDir, {
        expectedTransactionId: added.transaction.transactionId,
      });
      rollback = {
        status: undone.status === "committed" ? "passed" : "failed",
        reason: undone.status === "committed" ? "" : `rollback_${undone.status}`,
      };
    } catch (rollbackError) {
      rollback = {
        status: "failed",
        reason: rollbackError?.code || "rollback_conflict",
      };
    }
    throw Object.assign(error, { rollback });
  });
  const common = resolvePageIrConflicts({
    baseline: pageIr,
    html: captured.pageIr,
    figma: pageIr,
    resolution: "html",
  });
  const reconciledPageIr = compactPageIr({
    ...common.merged,
    nodes: Object.fromEntries(
      Object.entries(common.merged.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          figma: pageIr.nodes[id]?.figma || node.figma,
          sourceRef: {
            ...node.sourceRef,
            file: added.generated.entry,
          },
        },
      ]),
    ),
  });
  const baseline = await new SyncBaselineStore(added.projectDir).commit({
    pageIr: reconciledPageIr,
    sourceHash:
      pages.find((page) => page.id === added.generated.pageId)?.sourceHash || "",
    figma: {
      fileKey: offer.figmaFileKey,
      rootNodeId: offer.rootNodeId,
      rootNodeName: offer.rootName,
    },
    transactionId: added.transaction.transactionId,
  });
  const sourceHash =
    pages.find((page) => page.id === added.generated.pageId)?.sourceHash || "";
  const synchronizedPages = pages.map((page) =>
    page.id === added.generated.pageId
      ? {
          ...page,
          sourceHash,
          pageIrHash: baseline.pageIrHash,
          figmaReady: true,
          syncState: "synced",
        }
      : page,
  );
  const synchronizedState = {
    ...updated,
    pages: synchronizedPages,
    verification,
    updatedAt: new Date().toISOString(),
  };
  states.set(added.projectDir, synchronizedState);
  await writeBinding(added.projectDir, synchronizedState);
  figmaBridges.get(added.projectDir)?.setPageCatalog(synchronizedPages);
  const result = {
    action: "add_page",
    projectDir: added.projectDir,
    projectKey: added.descriptor.projectKey,
    pageId: added.generated.pageId,
    entry: added.generated.entry,
    route: added.generated.route,
    sourceHash,
    pageIrHash: baseline.pageIrHash,
    rootNodeId: offer.rootNodeId,
    rootNodeName: offer.rootName,
    nodeMappings: baseline.nodeMappings,
    transactionId: added.transaction.transactionId,
    nodeCount: added.generated.nodeCount,
    resourceCount: added.generated.resourceCount,
    resourceBytes: added.generated.resourceBytes,
    preflightStatus: added.report.status,
    verification,
  };
  setTimeout(() => {
    openWorkspace({ projectDir: added.projectDir })
      .then(() => manageWorkspacePage({
        projectDir: added.projectDir,
        action: "select",
        pageId: added.generated.pageId,
      }))
      .catch((error) => {
        console.error(`[CDB Figma Offer] Added page could not be opened: ${error?.stack || error}`);
      });
  }, 100);
  return result;
}

async function processUpdatePageOffer(offer, payload) {
  if (!offer.target?.projectDir) {
    throw Object.assign(new Error("更新关联页面需要明确的本地项目目录。"), {
      code: "project_required",
    });
  }
  const descriptor = await loadProjectDescriptor(offer.target.projectDir);
  if (!offer.linkedPageId) {
    throw Object.assign(new Error("这个 Figma Frame 尚未关联本地页面，请选择添加为新页面。"), {
      code: "figma_page_not_linked",
    });
  }
  if (offer.linkedProjectKey !== descriptor.projectKey) {
    throw Object.assign(new Error("这个 Figma Frame 的项目身份与目标本地项目不一致。"), {
      code: "figma_project_identity_conflict",
    });
  }
  const pageId = offer.target.pageId || offer.linkedPageId;
  if (pageId !== offer.linkedPageId) {
    throw Object.assign(new Error("请求更新的页面与 Figma Frame 关联身份不一致。"), {
      code: "linked_page_identity_conflict",
    });
  }
  await getWorkspace(descriptor.rootDir);
  const bridge = launcherBridge
    ? createLocalFigmaBridge(descriptor.rootDir)
    : await ensureLocalFigmaBridge(descriptor.rootDir);
  const result = await bridge.applyDesignPayloadToLinkedPage({ offer, payload, pageId });
  setTimeout(() => {
    openWorkspace({ projectDir: descriptor.rootDir })
      .then(() => manageWorkspacePage({
        projectDir: descriptor.rootDir,
        action: "select",
        pageId,
      }))
      .catch((error) => {
        console.error(`[CDB Figma Offer] Updated page could not be selected: ${error?.stack || error}`);
      });
  }, 100);
  return result;
}

async function ensureLauncherFigmaBridge() {
  if (launcherBridge) return launcherBridge;
  const configuredPort = Number.parseInt(
    process.env.CODEX_DESIGN_BRIDGE_PORT || "9847",
    10,
  );
  launcherBridge = new LocalFigmaBridge(leaseRoot, {
    port: Number.isFinite(configuredPort) ? configuredPort : 9847,
    runtimeVersion: PLUGIN_VERSION,
    projectName: "CDB",
    projectKey: "",
    offerStore: designOfferStore,
    onOffersChanged: async (offers) => {
      for (const state of launcherStates.values()) {
        if (state.mode !== "launcher") continue;
        state.designOffers = offers;
        state.message = offers.length > 0
          ? `收到 ${offers.length} 个来自 Figma 的设计提案。`
          : "等待 Figma 发送完整页面，或选择其他设计来源。";
        state.updatedAt = new Date().toISOString();
      }
    },
    onDesignPayload: (offer) => processLauncherDesignPayload(offer),
  });
  try {
    await launcherBridge.start();
  } catch (error) {
    launcherBridge = null;
    throw error;
  }
  return launcherBridge;
}

async function stopLauncherFigmaBridge() {
  if (!launcherBridge) return;
  const bridge = launcherBridge;
  launcherBridge = null;
  await bridge.stop();
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
    lastResolvedConflictPath: previous.lastResolvedConflictPath || "",
    lastConflictResolution: previous.lastConflictResolution || "",
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

async function openWorkspace({ projectDir, previewUrl }) {
  const startedAt = Date.now();
  const project = await normalizeProjectDir(projectDir);
  const recovery = await recoverIncompletePatchTransactions(project);
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
    await shutdownWorkspaceResources(activeProject, {
      force: true,
      handoff: true,
      releaseLease: false,
    });
  }
  await stopLauncherFigmaBridge();

  const leaseResult = await leaseManager.acquire({
    projectKey: report.projectKey,
  });
  if (!leaseResult.acquired) {
    state = {
      ...state,
      phase: "workspace_degraded",
      sessionActive: false,
      needsHandoffConfirmation: false,
      message: "旧 CDB 工作台暂时无法接管，请稍后重试。",
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
      figmaReady: state.pages.some((page) => page.figmaReady),
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
  if (recovery.recoveredCount > 0) {
    state = {
      ...state,
      changedFiles: recovery.changedFiles,
      summary: `已自动回滚 ${recovery.recoveredCount} 个被异常终止的源码事务。`,
      message: `已恢复异常终止前的源码状态；${state.message}`,
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
    syncConflicts: Array.isArray(binding.syncConflicts) ? binding.syncConflicts : [],
    syncConflictPath: binding.syncConflictPath || "",
    lastResolvedConflictPath: binding.lastResolvedConflictPath || "",
    lastConflictResolution: binding.lastConflictResolution || "",
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

async function getDesignVerificationImages({ projectDir, pageId }) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  const page = workspacePage(state, pageId);
  const images = verificationArtifacts.get(
    verificationArtifactKey(project, page.id),
  );
  if (!images) {
    throw Object.assign(new Error("当前页面还没有可审查的视觉对比图。"), {
      code: "verification_images_unavailable",
    });
  }
  return { state: publicState(state), images: structuredClone(images) };
}

async function focusFigmaDesignNode({ projectDir, pageId, nodeId }) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  const page = workspacePage(state, pageId);
  const difference = currentVerificationDifference(state, page.id, nodeId);
  const figmaNodeId = String(difference.figmaNodeId || "");
  if (!figmaNodeId) {
    throw Object.assign(new Error("这个视觉差异没有可定位的 Figma 节点。"), {
      code: "verification_figma_node_unavailable",
    });
  }
  const bridge = await ensureLocalFigmaBridge(project);
  const focus = bridge.focusNode({ pageId: page.id, figmaNodeId });
  return { state: publicState(state), focus };
}

async function getDesignSourceLocation({ projectDir, pageId, nodeId }) {
  const project = await normalizeProjectDir(projectDir);
  const state = await getWorkspace(project);
  const page = workspacePage(state, pageId);
  const difference = currentVerificationDifference(state, page.id, nodeId);
  const requestedFile = String(difference.sourceRef?.file || page.entry || page.path || "");
  if (!requestedFile) {
    throw Object.assign(new Error("这个视觉差异没有可定位的源码文件。"), {
      code: "verification_source_unavailable",
    });
  }
  const filePath = path.resolve(project, requestedFile.replace(/^[/\\]+/, ""));
  const relativeFile = path.relative(project, filePath);
  if (!relativeFile || relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
    throw Object.assign(new Error("视觉差异引用了项目目录之外的文件。"), {
      code: "verification_source_outside_project",
    });
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) {
    throw Object.assign(new Error("源码文件不可读取或超过 2 MB。"), {
      code: "verification_source_unreadable",
    });
  }
  const source = await readFile(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const needle = sourceNeedle(difference.sourceRef?.selector, difference.nodeId);
  const locatedIndex = needle ? lines.findIndex((line) => line.includes(needle)) : -1;
  const matchedIndex = Math.max(0, locatedIndex);
  const startIndex = Math.max(0, matchedIndex - 3);
  const endIndex = Math.min(lines.length, matchedIndex + 4);
  const snippet = lines
    .slice(startIndex, endIndex)
    .map((line, index) => `${String(startIndex + index + 1).padStart(4, " ")}  ${line}`)
    .join("\n");
  return {
    state: publicState(state),
    sourceLocation: {
      file: relativeFile.split(path.sep).join("/"),
      line: matchedIndex + 1,
      selector: String(difference.sourceRef?.selector || ""),
      snippet,
    },
  };
}

function currentVerificationDifference(state, pageId, nodeId) {
  if (state.activePageId !== pageId) {
    throw Object.assign(new Error("只能定位当前页面最新视觉验收中的差异。"), {
      code: "verification_page_not_active",
    });
  }
  const difference = (state.verification?.differences || []).find(
    (entry) => String(entry?.nodeId || "") === String(nodeId || ""),
  );
  if (!difference) {
    throw Object.assign(new Error("这个差异已不属于当前视觉验收，请重新运行同步。"), {
      code: "verification_difference_stale",
    });
  }
  return difference;
}

function sourceNeedle(selector, nodeId) {
  const value = String(selector || "");
  const match = value.match(/\[data-codex-id=(?:"([^"]+)"|'([^']+)')\]/);
  const codexId = match?.[1] || match?.[2] || "";
  if (codexId) return `data-codex-id="${codexId}"`;
  return String(nodeId || "");
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
  const browserUrl = preview.kind === "static"
    ? browserPreviewUrl(url, page.viewport)
    : url;
  await openLocalUrlInDefaultBrowser(browserUrl);
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
  if (!["select", "remove"].includes(args.action)) {
    throw new Error("CDB 页面由 .cdb/manifest.json 管理，不支持运行时添加或重命名假页面。");
  }
  const pages = [...state.pages];
  const selected = pages.find((page) => page.id === args.pageId);
  if (!selected) {
    throw new Error("不支持这个页面操作。");
  }

  if (args.action === "remove") {
    const hasPageConflict = (state.syncConflicts || []).some(
      (conflict) => conflict.pageId === selected.id,
    );
    if (Number(state.pendingChangeCount) > 0 || hasPageConflict) {
      throw new Error("当前页面还有待处理的 Figma 修改或冲突，请先处理后再清除。");
    }
    const removed = await removeProjectPage({
      projectDir: project,
      pageId: selected.id,
    });
    const nextPages = workspacePagesFromReport(removed.report, pages);
    const removedIndex = pages.findIndex((page) => page.id === selected.id);
    const nextActive = nextPages[Math.min(removedIndex, nextPages.length - 1)] || nextPages[0];
    const updated = {
      ...state,
      pages: nextPages,
      activePageId: nextActive.id,
      phase: "complete",
      figmaReady: nextPages.some((page) => page.figmaReady),
      changedFiles: removed.transaction.changedFiles,
      changeCount: removed.transaction.changedFiles.length,
      summary: `已从 CDB 页面列表清除 ${selected.name}；源码文件和 Figma 画布均未删除。`,
      message: `已清除当前页面 ${selected.name}，现在预览 ${nextActive.name}。`,
      undoAvailable: removed.transaction.undoAvailable,
      lastTransactionId: removed.transaction.transactionId,
      previewRevision: state.previewRevision + 1,
      preflightReport: removed.report,
      updatedAt: new Date().toISOString(),
    };
    states.set(project, updated);
    figmaBridges.get(project)?.setPageCatalog(nextPages);
    await writeBinding(project, updated);
    return publicState(updated);
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

async function sendPreviewToLocalFigma(projectDir, pageIds, options = {}) {
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
          width: page.viewport?.width,
          height: page.viewport?.height,
        });
        captured.manifest.pageId = page.id;
        captured.manifest.name = `${state.projectName} · ${page.name}`;
        captured.manifest.projectKey = state.preflightReport?.projectKey || "";
        captured.manifest.source = {
          ...(captured.manifest.source || {}),
          file: routeUrl,
          previewUrl: routeUrl,
        };
        const imported = await bridge.pushPage(captured.manifest, {
          conflictResolution: options.conflictResolution || null,
        });
        const nodeCount = imported.nodeCount || captured.nodeCount;
        const sentAt = new Date().toISOString();
        pages = pages.map((candidate) =>
          candidate.id === page.id
            ? {
                ...candidate,
                figmaReady: true,
                lastSentAt: sentAt,
                nodeCount,
                projectSourceHash:
                  candidate.projectSourceHash || page.projectSourceHash || page.sourceHash,
                sourceHash: imported.sourceHash || candidate.sourceHash,
                pageIrHash: imported.pageIrHash || candidate.pageIrHash || "",
                syncState: "synced",
              }
            : candidate,
        );
        results.push({
          page,
          nodeCount,
          transactionId: imported.transactionId || "",
        });
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
      lastTransactionId:
        results.map((result) => result.transactionId).filter(Boolean).at(-1)
        || state.lastTransactionId
        || "",
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
        phase: pendingCount > 0 ? "applying" : "complete",
        figmaConnected: true,
        bridgeReady: true,
        unsentChanges: false,
        changeCount: captured.changeCount,
        appliedChangeCount: appliedCount,
        pendingChangeCount: pendingCount,
        changedFiles: fastApply.changedFiles || [],
        summary:
          pendingCount > 0
            ? `已收到 ${pageCount} 个页面的 Figma 修改，Codex 正在处理。`
            : `已从 ${pageCount} 个页面更新 ${appliedCount} 处设计。`,
        designSnapshotPath: captured.snapshotPath,
        lastTransactionId: fastApply.transactionId || "",
        undoAvailable: Boolean(fastApply.undoAvailable),
        message:
          appliedCount > 0 && pendingCount === 0
            ? `已更新 ${pageCount} 个页面的 ${appliedCount} 处修改 · ${durationSeconds} 秒`
            : appliedCount > 0
              ? `已更新 ${pageCount} 个页面的 ${appliedCount} 处，另有 ${pendingCount} 处需要 Codex 处理。`
              : `已收到 ${pageCount} 个页面的 ${pendingCount} 处修改，Codex 正在处理。`,
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

async function resolveDesignSyncConflict({ projectDir, resolution }) {
  const project = await normalizeProjectDir(projectDir);
  const current = await getWorkspace(project);
  if (!Array.isArray(current.syncConflicts) || current.syncConflicts.length === 0) {
    throw new Error("当前工作台没有待解决的 Page IR 冲突。");
  }
  const pageId = current.pages.find((page) => page.syncState === "conflict")?.id || current.activePageId;
  if (!pageId) throw new Error("无法确定冲突所属页面。");
  const bridge = await ensureLocalFigmaBridge(project);
  const rollbackBaseline = await bridge.baselineStore.get(pageId);
  if (!rollbackBaseline) {
    throw new Error("当前页面缺少可恢复的共同基线。");
  }
  let transactionId = "";
  if (resolution === "html") {
    if (!bridge.status().connected) {
      throw new Error("接受 HTML 需要 Figma 插件保持连接，以便更新目标 Frame。");
    }
    const snapshotPath = await conflictChangeSetPath(project, current);
    const snapshotRelative = path.relative(project, snapshotPath);
    if (
      !snapshotPath ||
      snapshotRelative.startsWith("..") ||
      path.isAbsolute(snapshotRelative)
    ) {
      throw new Error("原始 Figma ChangeSet 不可用，无法建立安全的 HTML 撤销快照。");
    }
    const changeSet = JSON.parse(await readFile(snapshotPath, "utf8"));
    const undoSnapshot = changeSet?.pageSnapshot?.pageSeed?.node;
    if (!undoSnapshot || changeSet.pageId !== pageId) {
      throw new Error("原始 Figma ChangeSet 缺少当前页面的完整撤销快照。");
    }
    transactionId = `conflict-html:${Date.now()}:${createHash("sha256")
      .update(`${project}:${pageId}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16)}`;
    const result = await sendPreviewToLocalFigma(project, [pageId], {
      conflictResolution: { direction: "html", transactionId, undoSnapshot },
    });
    if (result.pages.find((page) => page.id === pageId)?.syncState !== "synced") {
      throw new Error(result.message || "HTML 未能更新到 Figma。");
    }
    if (result.lastTransactionId !== transactionId) {
      throw new Error("Figma 没有确认本次接受 HTML 的撤销事务身份。");
    }
  } else if (resolution === "figma") {
    const snapshotPath = await conflictChangeSetPath(project, current);
    const relative = path.relative(project, snapshotPath);
    if (!snapshotPath || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("原始 Figma ChangeSet 不可用，无法安全接受 Figma。");
    }
    const changeSet = JSON.parse(await readFile(snapshotPath, "utf8"));
    const resolved = await bridge.resolveThreeWaySync(changeSet, "figma");
    transactionId = resolved.fastApply.transactionId || "";
  } else {
    throw new Error("冲突解决方向必须是 html 或 figma。");
  }
  if (current.syncConflictPath) {
    await bridge.baselineStore.markConflictResolved(current.syncConflictPath, {
      resolution,
      transactionId,
      rollbackBaseline,
    });
  }
  const latest = await getWorkspace(project);
  const state = {
    ...latest,
    phase: "complete",
    pendingChangeCount: 0,
    syncConflicts: [],
    syncConflictPath: "",
    designSnapshotPath:
      current.designSnapshotPath || latest.designSnapshotPath || "",
    lastResolvedConflictPath: current.syncConflictPath || "",
    lastConflictResolution: resolution,
    lastTransactionId: transactionId || latest.lastTransactionId || "",
    message: resolution === "html"
      ? "已接受 HTML，并更新 Figma 与共同基线。"
      : "已接受 Figma，并更新源码、验证回读和共同基线。",
    summary: `Page IR 冲突已按 ${resolution === "html" ? "HTML" : "Figma"} 方向解决。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);
  await writeBinding(project, state);
  return publicState(state);
}

async function conflictChangeSetPath(project, current) {
  if (current.designSnapshotPath) return path.resolve(current.designSnapshotPath);
  if (!current.syncConflictPath) return "";
  const conflictPath = path.resolve(current.syncConflictPath);
  const conflictRoot = path.join(project, ".cdb", "sync-conflicts");
  const conflictRelative = path.relative(conflictRoot, conflictPath);
  if (
    !conflictRelative ||
    conflictRelative.startsWith("..") ||
    path.isAbsolute(conflictRelative)
  ) {
    return "";
  }
  const record = JSON.parse(await readFile(conflictPath, "utf8"));
  if (!record.changeSetPath) return "";
  return path.resolve(project, record.changeSetPath);
}

async function undoDesignSyncConflictResolution({ projectDir }) {
  const project = await normalizeProjectDir(projectDir);
  const current = await getWorkspace(project);
  if (
    !current.lastResolvedConflictPath ||
    !["html", "figma"].includes(current.lastConflictResolution)
  ) {
    throw new Error("当前没有可撤销的冲突解决事务。");
  }
  const conflictPath = path.resolve(current.lastResolvedConflictPath);
  const conflictRoot = path.join(project, ".cdb", "sync-conflicts");
  const relative = path.relative(conflictRoot, conflictPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("已解决冲突记录路径无效。");
  }
  const record = JSON.parse(await readFile(conflictPath, "utf8"));
  if (
    record.status !== "resolved" ||
    record.resolution !== current.lastConflictResolution ||
    !record.transactionId ||
    !record.rollbackBaseline?.pageIr
  ) {
    throw new Error("已解决冲突没有完整的事务身份或回滚基线。");
  }
  let undo;
  if (record.resolution === "figma") {
    undo = await undoLastPatchTransaction(project, {
      expectedTransactionId: record.transactionId,
    });
  } else {
    const bridge = await ensureLocalFigmaBridge(project);
    const figmaUndo = await bridge.undoHtmlConflictResolution({
      pageId: record.pageId,
      transactionId: record.transactionId,
    });
    undo = {
      transactionId: figmaUndo.transactionId || record.transactionId,
      changedFiles: [],
    };
  }
  const baselineStore = new SyncBaselineStore(project);
  await baselineStore.commit({
    pageIr: record.rollbackBaseline.pageIr,
    sourceHash: record.rollbackBaseline.sourceHash,
    figma: record.rollbackBaseline.figma,
    transactionId: undo.transactionId,
  });
  const reopened = await baselineStore.reopenConflict(conflictPath, {
    undoTransactionId: undo.transactionId,
    expectedResolution: record.resolution,
  });
  const report = await preflightDesignProject(project);
  const pages = workspacePagesFromReport(report, current.pages).map((page) =>
    page.id === reopened.pageId
      ? { ...page, syncState: "conflict" }
      : page,
  );
  const state = {
    ...current,
    pages,
    activePageId: reopened.pageId,
    phase: "complete",
    pendingChangeCount: Math.max(1, reopened.conflicts?.length || 0),
    syncConflicts: Array.isArray(reopened.conflicts) ? reopened.conflicts : [],
    syncConflictPath: conflictPath,
    lastResolvedConflictPath: "",
    lastConflictResolution: "",
    lastTransactionId: undo.transactionId,
    undoAvailable: false,
    changedFiles: undo.changedFiles,
    message: record.resolution === "figma"
      ? "已撤销接受 Figma 的源码事务并恢复原共同基线；字段冲突重新等待选择。"
      : "已撤销接受 HTML 的 Figma 事务并恢复原共同基线；字段冲突重新等待选择。",
    summary: `已撤销接受 ${record.resolution === "figma" ? "Figma" : "HTML"}，HTML 与 Figma 差异重新打开。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);
  await writeBinding(project, state);
  figmaBridges.get(project)?.setPageCatalog(pages);
  return publicState(state);
}

async function copyDesignSyncConflict({ projectDir }) {
  const project = await normalizeProjectDir(projectDir);
  const current = await getWorkspace(project);
  if (!Array.isArray(current.syncConflicts) || current.syncConflicts.length === 0) {
    throw new Error("当前工作台没有可复制的 Page IR 冲突。");
  }
  const page = current.pages.find((candidate) => candidate.syncState === "conflict") ||
    current.pages.find((candidate) => candidate.id === current.activePageId);
  if (!page) throw new Error("无法确定冲突所属页面。");
  const snapshotPath = path.resolve(current.designSnapshotPath || "");
  const relative = path.relative(project, snapshotPath);
  if (!current.designSnapshotPath || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("原始 Figma ChangeSet 不可用，无法安全复制页面。");
  }
  const changeSet = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!changeSet?.pageSnapshot?.pageSeed?.node) {
    throw new Error("原始 Figma ChangeSet 缺少完整页面快照。");
  }
  const descriptor = await loadProjectDescriptor(project);
  const names = new Set(descriptor.manifest.pages.map((candidate) => candidate.name.toLocaleLowerCase()));
  const baseName = `${page.name} · Figma 副本`;
  let copyName = baseName;
  for (let index = 2; names.has(copyName.toLocaleLowerCase()); index += 1) {
    copyName = `${baseName} ${index}`;
  }
  const copy = await addPageFromFigmaPayload({
    projectDir: project,
    pageId: `${page.id}-figma-copy-${Date.now().toString(36)}`,
    pageName: copyName,
    pageSeed: changeSet.pageSnapshot.pageSeed,
  });
  if (current.syncConflictPath) {
    await new SyncBaselineStore(project).markConflictCopied(current.syncConflictPath, {
      copyPageId: copy.generated.pageId,
      transactionId: copy.transaction.transactionId,
    });
  }
  const pages = workspacePagesFromReport(copy.report, current.pages);
  const state = {
    ...current,
    pages,
    activePageId: copy.generated.pageId,
    phase: "complete",
    lastTransactionId: copy.transaction.transactionId,
    undoAvailable: copy.transaction.undoAvailable,
    changedFiles: copy.transaction.changedFiles,
    message: `已把 Figma 快照复制为新页面“${copyName}”；原页面冲突仍保留，请再选择 HTML 或 Figma。`,
    summary: `已保留 Figma 版本为独立页面 ${copy.generated.entry}。`,
    updatedAt: new Date().toISOString(),
  };
  states.set(project, state);
  await writeBinding(project, state);
  figmaBridges.get(project)?.setPageCatalog(pages);
  return publicState(state);
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
  const bridge = createLocalFigmaBridge(projectDir);
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

function createLocalFigmaBridge(projectDir) {
  const workspace = states.get(projectDir);
  const identity = {
    projectName: workspace?.projectName || path.basename(projectDir),
    projectKey: workspace?.preflightReport?.projectKey || "",
  };
  const configuredPort = Number.parseInt(
    process.env.CODEX_DESIGN_BRIDGE_PORT || "9847",
    10,
  );
  const bridge = new LocalFigmaBridge(projectDir, {
    port: Number.isFinite(configuredPort) ? configuredPort : 9847,
    runtimeVersion: PLUGIN_VERSION,
    ...identity,
    offerStore: designOfferStore,
    onOffersChanged: async (offers) => {
      const current = states.get(projectDir);
      if (!current) return;
      states.set(projectDir, {
        ...current,
        designOffers: offers,
        message: offers.length > 0
          ? `收到 ${offers.length} 个来自 Figma 的设计提案。`
          : current.message,
        updatedAt: new Date().toISOString(),
      });
    },
    onDesignPayload: (offer) => processLauncherDesignPayload(offer),
    onFastApply: (result) => recordFastApply(projectDir, result),
    onCaptureHtmlPage: (pageId) => captureWorkspacePageManifest(projectDir, pageId),
    onSyncCommitted: (result) => recordSyncBaselineAdvanced(projectDir, result),
    onFastRollback: (result) => recordFastRollback(projectDir, result),
    onImportPages: (pageIds) =>
      sendPreviewToLocalFigma(projectDir, pageIds),
    onResetWorkspace: () => clearFigmaLinksForWorkspace(projectDir),
  });
  bridge.setPageCatalog(states.get(projectDir)?.pages || []);
  return bridge;
}

async function captureWorkspacePageManifest(projectDir, pageId) {
  const current = await getWorkspace(projectDir);
  const page = current.pages.find((entry) => entry.id === pageId);
  if (!page) throw new Error(`无法采集页面 ${pageId} 的 HTML Page IR。`);
  const descriptor = await loadProjectDescriptor(projectDir);
  const descriptorPage = descriptor.manifest.pages.find(
    (entry) => entry.id === page.id,
  ) || descriptor.manifest.pages.find(
    (entry) => entry.route === page.route || entry.route === page.path,
  ) || (descriptor.manifest.pages.length === 1 ? descriptor.manifest.pages[0] : null);
  const sourceFile = page.entry || descriptorPage?.entry || "";
  const preview = await ensurePreview(projectDir, current.previewUrl);
  const routeUrl = previewUrlForPage(preview.url, page.path);
  const captured = await captureLocalPreview({
    previewUrl: routeUrl,
    projectDir,
    captureState: page.captureState,
    width: page.viewport?.width,
    height: page.viewport?.height,
  });
  const pageIr = captured.manifest.pageIr
    ? compactPageIr({
        ...captured.manifest.pageIr,
        nodes: Object.fromEntries(
          Object.entries(captured.manifest.pageIr.nodes || {}).map(([id, node]) => [
            id,
            {
              ...node,
              sourceRef: {
                ...node.sourceRef,
                file: sourceFile,
              },
            },
          ]),
        ),
      })
    : null;
  return {
    ...captured.manifest,
    ...(pageIr ? { pageIr } : {}),
    pageId: page.id,
    name: current.projectName ? `${current.projectName} · ${page.name}` : page.name,
    projectKey: current.preflightReport?.projectKey || "",
    source: {
      ...(captured.manifest.source || {}),
      file: routeUrl,
      previewUrl: routeUrl,
    },
  };
}

async function recordSyncBaselineAdvanced(projectDir, result) {
  const current = await getWorkspace(projectDir);
  const pages = current.pages.map((page) =>
    page.id === result.pageId
      ? {
          ...page,
          sourceHash: result.sourceHash,
          pageIrHash: result.pageIrHash,
          syncState: "synced",
        }
      : page,
  );
  const next = {
    ...current,
    pages,
    syncConflicts: [],
    syncConflictPath: "",
    lastTransactionId: result.transactionId || current.lastTransactionId,
    updatedAt: new Date().toISOString(),
  };
  states.set(projectDir, next);
  await writeBinding(projectDir, next);
  figmaBridges.get(projectDir)?.setPageCatalog(pages);
}

async function recordFastRollback(projectDir, result) {
  const current = await getWorkspace(projectDir);
  const report = await preflightDesignProject(projectDir);
  const pages = workspacePagesFromReport(report, current.pages).map((page) =>
    page.id === result.pageId
      ? { ...page, figmaReady: true, syncState: "synced" }
      : page,
  );
  const next = {
    ...current,
    pages,
    phase: "in_figma",
    appliedChangeCount: 0,
    pendingChangeCount: 0,
    changedFiles: result.rollback?.changedFiles || [],
    lastTransactionId: result.rollback?.transactionId || current.lastTransactionId,
    undoAvailable: false,
    preflightReport: publicPreflightReport(report),
    message: "写后校验未通过，源码事务已自动回滚。",
    updatedAt: new Date().toISOString(),
  };
  states.set(projectDir, next);
  await writeBinding(projectDir, next);
  figmaBridges.get(projectDir)?.setPageCatalog(pages);
  return publicState(next);
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
  let refreshedPages = current.pages;
  let refreshedPreflightReport = current.preflightReport;
  if (pendingCount === 0 && appliedCount > 0) {
    const report = await preflightDesignProject(projectDir);
    refreshedPages = workspacePagesFromReport(report, current.pages);
    refreshedPreflightReport = publicPreflightReport(report);
  }
  const state = {
    ...current,
    pages: refreshedPages.map((page) =>
      page.id === result.pageId
        ? {
            ...page,
            figmaReady: true,
            syncState: pendingCount > 0 ? "conflict" : "synced",
          }
        : page,
    ),
    phase: fastApply.conflicts?.length > 0 ? "conflict" : pendingCount > 0 ? "applying" : "complete",
    figmaConnected: true,
    bridgeReady: true,
    unsentChanges: false,
    changeCount: result.changeCount || 0,
    appliedChangeCount: appliedCount,
    pendingChangeCount: pendingCount,
    changedFiles,
    summary:
      fastApply.conflicts?.length > 0
        ? `HTML 与 Figma 有 ${fastApply.conflicts.length} 个字段冲突，源码未修改。`
        : pendingCount > 0
          ? "已收到 Figma 修改，Codex 正在处理。"
          : `已更新 ${appliedCount} 处设计。`,
    designSnapshotPath: result.snapshotPath || "",
    syncConflicts: Array.isArray(fastApply.conflicts) ? fastApply.conflicts : [],
    syncConflictPath: fastApply.conflictPath || "",
    lastTransactionId: fastApply.transactionId || "",
    undoAvailable: Boolean(fastApply.undoAvailable),
    preflightReport: refreshedPreflightReport,
    verification: fastApply.verification || null,
    message:
      fastApply.conflicts?.length > 0
        ? `检测到 ${fastApply.conflicts.length} 个 Page IR 冲突；请明确选择保留 HTML 或 Figma。`
        : appliedCount > 0 && pendingCount === 0
          ? `已更新 ${appliedCount} 处修改 · ${durationSeconds} 秒`
          : appliedCount > 0
            ? `已更新 ${appliedCount} 处，另有 ${pendingCount} 处需要 Codex 处理。`
            : `已收到 ${pendingCount} 处修改，Codex 正在处理。`,
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

async function verifyOfferedPageVisual({ projectDir, current, page, payload }) {
  if (!page) {
    throw Object.assign(new Error("无法定位待验收页面。"), {
      code: "verification_page_missing",
    });
  }
  const report = await preflightDesignProject(projectDir);
  if (["blocker", "safe_fix"].includes(report.status)) {
    throw Object.assign(new Error("生成页面未通过项目预检。"), {
      code: "verification_preflight_failed",
    });
  }
  const viewport = payload.responsiveContract?.designViewport;
  if (!viewport?.width || !viewport?.height) {
    throw Object.assign(new Error("Figma payload 缺少设计 viewport。"), {
      code: "verification_viewport_missing",
    });
  }
  const preview = await ensurePreview(projectDir, current.previewUrl);
  const browserImage = await captureLocalPreviewImage({
    previewUrl: previewUrlForPage(preview.url, page.path || page.route || "/"),
    width: viewport.width,
    height: viewport.height,
    captureState: page.captureState,
  });
  const visual = verifyVisualReference({
    referenceImage: payload.referenceImage,
    browserImage,
  });
  storeVerificationArtifacts(projectDir, page.id, {
    referenceImage: payload.referenceImage,
    browserImage,
    visual,
  });
  if (visual.status !== "passed") {
    throw Object.assign(
      new Error(
        `浏览器与 Figma 像素差为 ${(visual.differentPixelRatio * 100).toFixed(2)}%，生成结果未通过视觉门禁。`,
      ),
      { code: "visual_verification_failed", visual },
    );
  }
  return {
    status: "passed",
    stage: "generated_page",
    preflight: report.status,
    visual,
  };
}

async function verifyFastApply(projectDir, current, result, fastApply) {
  const changes = Array.isArray(result.changeSet?.changes)
    ? result.changeSet.changes
    : [];
  const structural = changes.filter((change) =>
    ["nodeMove", "nodeReparent"].includes(change?.property),
  );
  const referenceImage =
    result.changeSet?.pageSnapshot?.referenceImage ||
    result.changeSet?.referenceImage ||
    null;
  if (structural.length === 0 && !referenceImage) {
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
    const routeUrl = previewUrlForPage(preview.url, page.path);
    const captured = structural.length > 0 || referenceImage
      ? await captureLocalPreview({
          previewUrl: routeUrl,
          projectDir,
          captureState: page.captureState,
          width: page.viewport?.width,
          height: page.viewport?.height,
        })
      : null;
    let maxPositionErrorPx = 0;
    for (const change of structural) {
      const located = findCapturedNode(captured?.manifest?.root, change.nodeId);
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
    let visual = null;
    if (referenceImage) {
      const viewport = result.changeSet?.pageSnapshot?.responsiveContract?.designViewport ||
        result.changeSet?.responsiveContract?.designViewport ||
        page.viewport ||
        { width: referenceImage.width, height: referenceImage.height };
      const browserImage = await captureLocalPreviewImage({
        previewUrl: routeUrl,
        width: viewport.width,
        height: viewport.height,
        captureState: page.captureState,
      });
      visual = verifyVisualReference({ referenceImage, browserImage });
      storeVerificationArtifacts(projectDir, page.id, {
        referenceImage,
        browserImage,
        visual,
      });
      if (visual.status !== "passed") {
        const differences = verificationDifferences(
          changes,
          result.changeSet?.pageSnapshot?.pageSeed?.node,
          captured,
        );
        throw Object.assign(
          new Error(
            `浏览器与 Figma 像素差为 ${(visual.differentPixelRatio * 100).toFixed(2)}%，未通过视觉门禁。`,
          ),
          { code: "visual_verification_failed", visual, differences },
        );
      }
    }
    fastApply.verification = {
      status: "passed",
      preflight: report.status,
      checkedNodes: structural.length,
      maxPositionErrorPx,
      visual,
      differences: [],
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
      ...(error?.visual ? { visual: error.visual } : {}),
      differences: Array.isArray(error?.differences) ? error.differences : [],
      rollback,
    };
  }
}

function verificationDifferences(changes, expectedRoot, captured) {
  const actualNodes = captured?.manifest?.pageIr?.nodes || {};
  return changes.slice(0, 100).map((change) => {
    const expectedNode = findSeedNode(expectedRoot, change?.nodeId);
    const capturedNode = actualNodes[change?.nodeId] ||
      findCapturedNode(captured?.manifest?.root, change?.nodeId)?.node ||
      null;
    return {
      nodeId: change?.nodeId || "",
      figmaNodeId:
        change?.figmaNodeId ||
        expectedNode?.figmaNodeId ||
        expectedNode?.figma?.nodeId ||
        "",
      sourceRef: change?.sourceRef || expectedNode?.sourceRef || null,
      property: change?.property || "visual",
      expected: change?.to ?? expectedVisualValue(expectedNode, change?.property),
      actual: capturedVisualValue(capturedNode, change?.property),
      expectedBounds: visualNodeBounds(expectedNode),
      actualBounds: visualNodeBounds(capturedNode),
    };
  });
}

function visualNodeBounds(node) {
  if (!node) return null;
  const geometry = node.geometry || node;
  if (![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) {
    return null;
  }
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  };
}

function storeVerificationArtifacts(
  projectDir,
  pageId,
  { referenceImage, browserImage, visual },
) {
  if (!referenceImage?.base64 || !browserImage?.dataUrl) return;
  verificationArtifacts.set(verificationArtifactKey(projectDir, pageId), {
    pageId,
    capturedAt: new Date().toISOString(),
    reference: {
      dataUrl: `data:image/png;base64,${referenceImage.base64}`,
      width: visual?.expected?.width || referenceImage.width,
      height: visual?.expected?.height || referenceImage.height,
      sha256: visual?.expected?.sha256 || referenceImage.sha256 || "",
    },
    actual: {
      dataUrl: browserImage.dataUrl,
      width: visual?.actual?.width || browserImage.width,
      height: visual?.actual?.height || browserImage.height,
      sha256: visual?.actual?.sha256 || "",
    },
    thresholds: visual?.thresholds ? { ...visual.thresholds } : null,
  });
}

function verificationArtifactKey(projectDir, pageId) {
  return `${path.resolve(projectDir)}\u0000${String(pageId || "")}`;
}

function findSeedNode(root, nodeId) {
  if (!root || !nodeId) return null;
  if (root.id === nodeId) return root;
  for (const child of root.children || []) {
    const found = findSeedNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function expectedVisualValue(node, property) {
  if (!node) return null;
  if (["width", "height", "x", "y"].includes(property)) return node[property] ?? null;
  if (property === "opacity") return node.opacity ?? null;
  if (["fill", "stroke", "strokeWeight", "cornerRadius"].includes(property)) {
    return node.style?.[property] ?? node.appearance?.[property] ?? null;
  }
  if (["characters", "text"].includes(property)) return node.text ?? node.content?.characters ?? "";
  return null;
}

function capturedVisualValue(node, property) {
  if (!node) return null;
  if (["width", "height", "x", "y"].includes(property)) {
    return node.geometry?.[property] ?? node[property] ?? null;
  }
  if (property === "opacity") return node.visibility?.opacity ?? node.opacity ?? null;
  if (["fill", "stroke", "strokeWeight", "cornerRadius"].includes(property)) {
    return node.appearance?.[property] ?? node.style?.[property] ?? null;
  }
  if (["characters", "text"].includes(property)) return node.content?.characters ?? node.text ?? "";
  if (["nodeMove", "nodeReparent"].includes(property)) return node.parentId ?? null;
  return null;
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
  if (
    state.lastResolvedConflictPath &&
    ["html", "figma"].includes(state.lastConflictResolution)
  ) {
    throw Object.assign(
      new Error("最近一次事务是 Page IR 冲突解决，请使用专用撤销同时恢复目标端与共同基线。"),
      { code: "conflict_resolution_undo_required" },
    );
  }
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
    const report = await preflightDesignProject(project);
    const pages = workspacePagesFromReport(report, state.pages);
    const activePageId = pages.some((page) => page.id === state.activePageId)
      ? state.activePageId
      : pages[0]?.id || "";
    const updated = {
      ...state,
      pages,
      activePageId,
      phase: "complete",
      changedFiles: result.changedFiles,
      changeCount: result.changedFiles.length,
      summary: `已安全撤销 ${result.changedFiles.length} 个文件中的修改。`,
      message: `已撤销上一次 Design Bridge 修改 · ${result.changedFiles.length} 个文件`,
      undoAvailable: false,
      lastTransactionId: result.transactionId,
      previewRevision: state.previewRevision + 1,
      preflightReport: report,
      updatedAt: new Date().toISOString(),
    };
    states.set(project, updated);
    figmaBridges.get(project)?.setPageCatalog(pages);
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
    let body = await readFile(target);
    const type = contentType(target);
    const browserViewport = parseBrowserPreviewViewport(
      url.searchParams.get("__cdb_viewport"),
    );
    if (type.startsWith("text/html") && browserViewport) {
      body = Buffer.from(
        injectBrowserPreviewCanvas(body.toString("utf8"), browserViewport),
        "utf8",
      );
    }
    response.writeHead(200, {
      "content-type": type,
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

function browserPreviewUrl(pageUrl, viewport) {
  const width = boundedViewportDimension(viewport?.width);
  const height = boundedViewportDimension(viewport?.height);
  if (!width || !height) return pageUrl;
  const target = new URL(pageUrl);
  target.searchParams.set("__cdb_viewport", `${width}x${height}`);
  return target.toString();
}

function parseBrowserPreviewViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/u.exec(String(value || ""));
  if (!match) return null;
  const width = boundedViewportDimension(match[1]);
  const height = boundedViewportDimension(match[2]);
  return width && height ? { width, height } : null;
}

function boundedViewportDimension(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const rounded = Math.round(number);
  return rounded >= 64 && rounded <= 8_192 ? rounded : 0;
}

function injectBrowserPreviewCanvas(html, { width, height }) {
  const marker = "data-cdb-browser-preview";
  if (html.includes(marker)) return html;
  const injection = [
    `<style ${marker}>`,
    "html[data-cdb-fit-preview], html[data-cdb-fit-preview] body { width: 100%; height: 100%; min-width: 0; min-height: 0; margin: 0; overflow: hidden; }",
    "#cdb-browser-preview-stage { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #111116; }",
    `#cdb-browser-preview-canvas { flex: 0 0 auto; width: ${width}px; height: ${height}px; transform-origin: center center; }`,
    "</style>",
    `<script ${marker}>`,
    "(() => {",
    "  const root = document.querySelector('[data-codex-root]');",
    "  if (!root || root.closest('#cdb-browser-preview-canvas')) return;",
    "  document.documentElement.setAttribute('data-cdb-fit-preview', '');",
    "  const stage = document.createElement('div');",
    "  stage.id = 'cdb-browser-preview-stage';",
    "  const canvas = document.createElement('div');",
    "  canvas.id = 'cdb-browser-preview-canvas';",
    "  root.before(stage);",
    "  stage.append(canvas);",
    "  canvas.append(root);",
    `  const width = ${width};`,
    `  const height = ${height};`,
    "  const fit = () => {",
    "    const scale = Math.min(1, Math.max(0.05, (innerWidth - 32) / width), Math.max(0.05, (innerHeight - 32) / height));",
    "    canvas.style.transform = `scale(${scale})`;",
    "    canvas.dataset.scale = String(scale);",
    "  };",
    "  addEventListener('resize', fit, { passive: true });",
    "  fit();",
    "})();",
    "</script>",
  ].join("\n");
  return /<\/body\s*>/iu.test(html)
    ? html.replace(/<\/body\s*>/iu, `${injection}\n</body>`)
    : `${html}\n${injection}\n`;
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
  const binding = await readJson(path.join(projectDir, ".codex", "design-bridge.json"));
  if (!binding || binding.version !== BINDING_VERSION) return {};
  try {
    validateExactRuntimeIdentity(binding.runtimeIdentity, PLUGIN_VERSION);
    return binding;
  } catch {
    return {};
  }
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
        version: BINDING_VERSION,
        runtimeIdentity: currentRuntimeIdentity(PLUGIN_VERSION),
        figmaUrl: state.figmaUrl || "",
        figmaReady: Boolean(state.figmaReady),
        changeCount: state.changeCount || 0,
        appliedChangeCount: state.appliedChangeCount || 0,
        pendingChangeCount: state.pendingChangeCount || 0,
        designSnapshotPath: state.designSnapshotPath || "",
        syncConflicts: Array.isArray(state.syncConflicts) ? state.syncConflicts : [],
        syncConflictPath: state.syncConflictPath || "",
        lastResolvedConflictPath: state.lastResolvedConflictPath || "",
        lastConflictResolution: state.lastConflictResolution || "",
        activePageId: state.activePageId || "",
        pages: (state.pages || []).map((page) => ({
          id: page.id,
          name: page.name,
          path: page.path,
          entry: page.entry || "",
          route: page.route || page.path,
          sourceHash: page.sourceHash || "",
          projectSourceHash: page.projectSourceHash || "",
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

function verificationImagesResult(state, verificationImages) {
  const workspace = publicState(state);
  return {
    content: [{ type: "text", text: "视觉对比图已生成。" }],
    structuredContent: { workspace, verificationImages },
    _meta: { workspace, verificationImages },
  };
}

function figmaFocusResult(state, focus) {
  const workspace = publicState(state);
  return {
    content: [{ type: "text", text: "已在 Figma 中定位视觉差异节点。" }],
    structuredContent: { workspace, figmaFocus: focus },
    _meta: { workspace, figmaFocus: focus },
  };
}

function sourceLocationResult(state, sourceLocation) {
  const workspace = publicState(state);
  return {
    content: [{ type: "text", text: "已定位视觉差异对应的源码。" }],
    structuredContent: { workspace, sourceLocation },
    _meta: { workspace, sourceLocation },
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
    designOffers: Array.isArray(state.designOffers)
      ? state.designOffers.map((offer) => ({ ...offer }))
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
    syncConflicts: Array.isArray(state.syncConflicts)
      ? state.syncConflicts.map((entry) => ({ ...entry }))
      : [],
    syncConflictPath: state.syncConflictPath || "",
    verification: state.verification ? structuredClone(state.verification) : null,
    lastResolvedConflictPath: state.lastResolvedConflictPath || "",
    lastConflictResolution: state.lastConflictResolution || "",
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

export async function cleanup({ exit = true } = {}) {
  const running = [...previews.values()];
  const bridges = [...figmaBridges.values()];
  previews.clear();
  figmaBridges.clear();
  await Promise.allSettled([
    ...running.map((preview) => preview.stop()),
    ...bridges.map((bridge) => bridge.stop()),
    stopLauncherFigmaBridge(),
    leaseManager.stop(),
  ]);
  if (exit) process.exit(0);
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
