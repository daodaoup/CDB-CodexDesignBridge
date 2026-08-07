import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
} from "electron";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeServer } from "../src/server.js";
import { capturePreviewPage } from "./page-capture.js";
import { startProjectPreview } from "./preview-service.js";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 3_000;
const settingsPath = () =>
  path.join(app.getPath("userData"), "desktop-settings.json");

let mainWindow = null;
let bridgeServer = null;
let previewService = null;
let importResultTimer = null;
let isQuitting = false;
let state = {
  phase: "empty",
  importPhase: "idle",
  figmaConnected: false,
  projectName: null,
  projectPath: null,
  previewUrl: null,
  previewRevision: 0,
  message: "选择一个前端项目开始预览",
};

app.setAppUserModelId("com.openai.codex-design-bridge");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createWindow();
    const settings = await readSettings();
    if (settings.projectPath) {
      await startProject(settings.projectPath);
    }
  });
}

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!isQuitting && app.isReady()) {
      createWindow();
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  const forceExitTimer = setTimeout(
    () => app.exit(0),
    SHUTDOWN_TIMEOUT_MS,
  );
  forceExitTimer.unref();
  stopServices().finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#eef0f3",
    title: "Codex Design Bridge",
    show: false,
    webPreferences: {
      preload: path.join(desktopDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(desktopDirectory, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:get-state", () => state);
  ipcMain.handle("desktop:choose-project", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择要由 Codex 更新的前端项目",
      defaultPath: state.projectPath || undefined,
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return state;
    }
    await startProject(result.filePaths[0]);
    return state;
  });
  ipcMain.handle("desktop:refresh-preview", () => {
    if (state.previewUrl) {
      updateState({
        previewRevision: state.previewRevision + 1,
        message: "页面已刷新",
      });
    }
    return state;
  });
  ipcMain.handle("desktop:copy-pairing-token", () => {
    if (!bridgeServer) {
      updateState({ message: "请先选择并启动一个项目" });
      return state;
    }
    clipboard.writeText(bridgeServer.getConnectionInfo().token);
    updateState({
      message: state.figmaConnected
        ? "连接码已复制；当前 Figma 已连接"
        : "连接码已复制，请粘贴到 Figma 插件后点击 Connect",
    });
    return state;
  });
  ipcMain.handle("desktop:import-preview", importCurrentPreview);
}

async function startProject(projectPath) {
  const rootDirectory = path.resolve(projectPath);
  await stopServices();
  updateState({
    phase: "starting",
    importPhase: "idle",
    figmaConnected: false,
    projectName: path.basename(rootDirectory),
    projectPath: rootDirectory,
    previewUrl: null,
    message: "正在启动 Bridge 和页面预览…",
  });

  try {
    await access(rootDirectory);
    bridgeServer = await startBridge(rootDirectory);
  } catch (error) {
    bridgeServer = null;
    updateState({
      phase: "failed",
      message: describeBridgeError(error),
    });
    return;
  }

  try {
    previewService = await startProjectPreview({
      rootDirectory,
      logger: createDesktopLogger(),
    });
    await writeSettings({ projectPath: rootDirectory });
    updateState({
      phase: "ready",
      previewUrl: previewService.url,
      previewRevision: state.previewRevision + 1,
      message: "预览已就绪；可连接 Figma 或直接导入当前页面",
    });
  } catch (error) {
    updateState({
      phase: "failed",
      message: `Bridge 已启动，但页面预览失败：${error.message}`,
    });
  }
}

async function startBridge(rootDirectory) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextBridge = new BridgeServer({
      rootDirectory,
      logger: createDesktopLogger(),
      onDesignTask: handleDesignTask,
      onClientChange: handleClientChange,
      onPageImportResult: handlePageImportResult,
    });
    try {
      await nextBridge.start();
      return nextBridge;
    } catch (error) {
      lastError = error;
      await nextBridge.stop().catch(() => {});
      if (error?.code !== "EADDRINUSE" || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

async function importCurrentPreview() {
  if (!bridgeServer || !state.previewUrl || !state.projectPath) {
    updateState({ message: "当前没有可导入的页面预览" });
    return state;
  }
  if (state.importPhase === "importing") {
    return state;
  }

  clearImportResultTimer();
  updateState({
    importPhase: "importing",
    message: "正在读取当前页面并生成可编辑 Figma 图层…",
  });

  try {
    const capture = await capturePreviewPage({
      createBrowserWindow: (options) => new BrowserWindow(options),
      previewUrl: state.previewUrl,
      rootDirectory: state.projectPath,
    });
    const prepared = await bridgeServer.preparePageAndPublish(capture.filePath);
    const pluginClients = bridgeServer.getPluginClientCount();

    if (pluginClients > 0) {
      updateState({
        message: `已发送 ${prepared.nodeIds.length} 个图层，等待 Figma 确认…`,
      });
      importResultTimer = setTimeout(() => {
        importResultTimer = null;
        if (state.importPhase === "importing") {
          updateState({
            importPhase: "completed",
            message: `页面已发送到 Figma（${prepared.nodeIds.length} 个图层），请在画布中查看`,
          });
        }
      }, 8_000);
    } else {
      updateState({
        importPhase: "completed",
        message: `页面已准备好（${capture.nodeCount} 个图层）；连接 Figma 后会自动导入`,
      });
    }
  } catch (error) {
    clearImportResultTimer();
    updateState({
      importPhase: "failed",
      message: `导入失败：${error.message}`,
    });
  }
  return state;
}

function handleClientChange(count) {
  updateState({ figmaConnected: count > 0 });
}

function handlePageImportResult(result) {
  clearImportResultTimer();
  if (result?.ok) {
    updateState({
      importPhase: "completed",
      message: `Figma 导入完成：${result.nodes ?? 0} 个可编辑图层`,
    });
  } else {
    updateState({
      importPhase: "failed",
      message: `Figma 导入失败：${result?.error || "未知错误"}`,
    });
  }
}

function handleDesignTask(task) {
  if (!task) return;
  if (task.state === "queued") {
    updateState({ phase: "updating", message: "设计已提交，等待 Codex…" });
  } else if (task.state === "running") {
    updateState({ phase: "updating", message: "Codex 正在更新前端…" });
  } else if (task.state === "completed") {
    updateState({
      phase: "completed",
      previewRevision: state.previewRevision + 1,
      message: "Codex 更新完成，页面已刷新",
    });
  } else if (task.state === "failed") {
    updateState({
      phase: "failed",
      message: `Codex 更新失败：${task.error || "未知错误"}`,
    });
  }
}

async function stopServices() {
  clearImportResultTimer();
  const currentPreview = previewService;
  const currentBridge = bridgeServer;
  previewService = null;
  bridgeServer = null;
  await Promise.allSettled([currentPreview?.stop(), currentBridge?.stop()]);
}

function clearImportResultTimer() {
  if (importResultTimer) {
    clearTimeout(importResultTimer);
    importResultTimer = null;
  }
}

function updateState(patch) {
  state = { ...state, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:state", state);
  }
}

function createDesktopLogger() {
  return {
    log(message) {
      console.log(message);
    },
    warn(message) {
      console.warn(message);
    },
    error(message) {
      console.error(message);
    },
  };
}

function describeBridgeError(error) {
  if (error?.code === "EADDRINUSE") {
    return "端口 9847 已被占用。请先关闭正在运行的 PowerShell Bridge，再重试。";
  }
  return `Bridge 启动失败：${error.message}`;
}

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeSettings(value) {
  await writeFile(settingsPath(), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
