const chooseProjectButton = document.getElementById("choose-project");
const emptyChooseProjectButton = document.getElementById(
  "empty-choose-project",
);
const refreshButton = document.getElementById("refresh");
const copyTokenButton = document.getElementById("copy-token");
const importFigmaButton = document.getElementById("import-figma");
const emptyState = document.getElementById("empty-state");
const previewShell = document.getElementById("preview-shell");
const previewFrame = document.getElementById("preview");
const updateOverlay = document.getElementById("update-overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayDetail = document.getElementById("overlay-detail");
const statusChip = document.getElementById("status-chip");
const statusLabel = document.getElementById("status-label");
const footerStatus = document.getElementById("footer-status");
const projectName = document.getElementById("project-name");
const projectPath = document.getElementById("project-path");

let currentPreviewKey = null;

chooseProjectButton.addEventListener("click", chooseProject);
emptyChooseProjectButton.addEventListener("click", chooseProject);
refreshButton.addEventListener("click", async () => {
  render(await window.bridgeDesktop.refreshPreview());
});
copyTokenButton.addEventListener("click", async () => {
  render(await window.bridgeDesktop.copyPairingToken());
});
importFigmaButton.addEventListener("click", async () => {
  render(await window.bridgeDesktop.importPreview());
});

window.bridgeDesktop.onState(render);
window.bridgeDesktop.getState().then(render);

async function chooseProject() {
  chooseProjectButton.disabled = true;
  emptyChooseProjectButton.disabled = true;
  try {
    render(await window.bridgeDesktop.chooseProject());
  } finally {
    chooseProjectButton.disabled = false;
    emptyChooseProjectButton.disabled = false;
  }
}

function render(state) {
  const hasPreview = Boolean(state.previewUrl);
  const isCodexBusy = state.phase === "starting" || state.phase === "updating";
  const isImporting = state.importPhase === "importing";
  const isBusy = isCodexBusy || isImporting;
  const previewKey = hasPreview
    ? `${state.previewUrl}|${state.previewRevision}`
    : null;

  statusChip.className = `status-chip ${statusClass(state)}`;
  statusLabel.textContent = statusText(state);
  footerStatus.textContent = state.message;
  projectName.textContent = state.projectName || "No project";
  projectPath.textContent = state.projectPath || "尚未选择项目";
  chooseProjectButton.textContent = state.projectPath ? "更换项目" : "选择项目";
  chooseProjectButton.disabled = isBusy;
  emptyChooseProjectButton.disabled = isBusy;
  refreshButton.disabled = !hasPreview || isBusy;
  copyTokenButton.disabled = !state.projectPath || state.phase === "starting";
  copyTokenButton.textContent = state.figmaConnected
    ? "复制连接码"
    : "连接 Figma";
  importFigmaButton.disabled = !hasPreview || isBusy;
  importFigmaButton.textContent = isImporting ? "正在导入…" : "导入到 Figma";

  updateOverlay.hidden = !isCodexBusy && !isImporting;
  if (isImporting) {
    overlayTitle.textContent = "正在生成可编辑 Figma 图层";
    overlayDetail.textContent = "完成后会直接发送到已连接的 Figma";
  } else {
    overlayTitle.textContent = "Codex 正在更新前端";
    overlayDetail.textContent = "完成后页面会自动刷新";
  }

  emptyState.hidden = hasPreview;
  previewShell.hidden = !hasPreview;
  if (!hasPreview) {
    const title = emptyState.querySelector("h2");
    const description = emptyState.querySelector("p");
    title.textContent =
      state.phase === "failed" ? "预览暂时不可用" : "选择一个前端项目";
    description.textContent =
      state.phase === "failed"
        ? state.message
        : "Bridge 会在后台自动启动。你可以在这里预览页面，或一键导入到 Figma。";
  }

  if (previewKey && previewKey !== currentPreviewKey) {
    currentPreviewKey = previewKey;
    previewFrame.src = versionedUrl(state.previewUrl, state.previewRevision);
  }
}

function statusClass(state) {
  if (state.importPhase === "failed") return "failed";
  if (state.importPhase === "importing") return "updating";
  return state.phase;
}

function statusText(state) {
  if (state.importPhase === "importing") return "正在导入";
  if (state.importPhase === "failed") return "导入失败";
  if (state.importPhase === "completed") return "导入完成";
  return (
    {
      empty: "未启动",
      starting: "正在启动",
      ready: state.figmaConnected ? "Figma 已连接" : "预览已就绪",
      updating: "正在更新",
      completed: "更新完成",
      failed: "需要处理",
    }[state.phase] || "未启动"
  );
}

function versionedUrl(url, revision) {
  const value = new URL(url);
  value.searchParams.set("codexBridgeRefresh", String(revision));
  return value.toString();
}
