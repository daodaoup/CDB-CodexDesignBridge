import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAPTURE_PAGE_SCRIPT,
  createCapturedPageManifest,
} from "../shared/page-capture.mjs";
import { WebSocket } from "../vendor/ws/wrapper.mjs";

const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 900;
const START_TIMEOUT_MS = 12_000;
const CDP_CALL_TIMEOUT_MS = 15_000;

export async function captureLocalPreview({ previewUrl, projectDir, captureState }) {
  const playwright = await loadBundledPlaywright();
  if (playwright) {
    return captureWithPlaywright(playwright, {
      previewUrl,
      projectDir,
      captureState,
    });
  }

  const executable = await findBrowserExecutable();
  const port = await reservePort();
  const profileDirectory = path.join(
    os.tmpdir(),
    `codex-design-capture-${process.pid}-${Date.now()}`,
  );
  await mkdir(profileDirectory, { recursive: true });

  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
      "about:blank",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let browserDiagnostics = "";
  browser.stderr?.setEncoding("utf8");
  browser.stderr?.on("data", (chunk) => {
    browserDiagnostics = `${browserDiagnostics}${chunk}`.slice(-4_000);
  });

  try {
    const target = await waitForPageTarget(port);
    const snapshot = await captureTarget(
      target.webSocketDebuggerUrl,
      previewUrl,
      captureState,
    );
    const manifest = createCapturedPageManifest(snapshot, {
      projectName: path.basename(path.resolve(projectDir)),
      previewUrl,
    });
    return {
      manifest,
      nodeCount: countNodes(manifest.root),
    };
  } catch (error) {
    const diagnostics = browserDiagnostics.trim();
    if (!diagnostics) throw error;
    throw new Error(`${error.message}\n${diagnostics}`);
  } finally {
    await stopProcess(browser);
    browser.stderr?.destroy();
    await removeCaptureProfile(profileDirectory);
  }
}

export async function captureLocalPreviewImage({
  previewUrl,
  width = CAPTURE_WIDTH,
  height = CAPTURE_HEIGHT,
  captureState,
}) {
  const viewport = normalizeViewport(width, height);
  const playwright = await loadBundledPlaywright();
  if (playwright) {
    return captureImageWithPlaywright(playwright, {
      previewUrl,
      ...viewport,
      captureState,
    });
  }

  const executable = await findBrowserExecutable();
  const port = await reservePort();
  const profileDirectory = path.join(
    os.tmpdir(),
    `codex-design-preview-${process.pid}-${Date.now()}`,
  );
  await mkdir(profileDirectory, { recursive: true });

  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  try {
    const target = await waitForPageTarget(port);
    return await captureTargetImage(
      target.webSocketDebuggerUrl,
      previewUrl,
      viewport,
      captureState,
    );
  } finally {
    await stopProcess(browser);
    browser.stderr?.destroy();
    await removeCaptureProfile(profileDirectory, "codex-design-preview-");
  }
}

async function captureWithPlaywright(
  playwright,
  { previewUrl, projectDir, captureState },
) {
  const executablePath = await findBrowserExecutable();
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-gpu", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.goto(previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: START_TIMEOUT_MS,
    });
    await page.waitForLoadState("load", { timeout: START_TIMEOUT_MS });
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await activatePlaywrightCaptureState(page, captureState);
    const snapshot = await page.evaluate(CAPTURE_PAGE_SCRIPT);
    const manifest = createCapturedPageManifest(snapshot, {
      projectName: path.basename(path.resolve(projectDir)),
      previewUrl,
    });
    return {
      manifest,
      nodeCount: countNodes(manifest.root),
    };
  } finally {
    await browser.close();
  }
}

async function captureImageWithPlaywright(
  playwright,
  { previewUrl, width, height, captureState },
) {
  const executablePath = await findBrowserExecutable();
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-gpu", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.goto(previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: START_TIMEOUT_MS,
    });
    await page.waitForLoadState("load", { timeout: START_TIMEOUT_MS });
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await activatePlaywrightCaptureState(page, captureState);
    const image = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
    });
    return {
      dataUrl: `data:image/png;base64,${image.toString("base64")}`,
      width,
      height,
    };
  } finally {
    await browser.close();
  }
}

async function activatePlaywrightCaptureState(page, captureState) {
  const target = tabCaptureTarget(captureState);
  if (!target) return;
  const activated = await page.evaluate((requested) => {
    const screen = [...document.querySelectorAll("[data-screen]")].find(
      (element) => element.getAttribute("data-screen") === requested,
    );
    const trigger = [...document.querySelectorAll("[data-target]")].find(
      (element) => element.getAttribute("data-target") === requested,
    );
    if (!screen || !trigger) return false;
    trigger.click();
    return true;
  }, target);
  if (!activated) {
    throw new Error(`页面状态无法激活：${target}`);
  }
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function activateCdpCaptureState(call, captureState) {
  const target = tabCaptureTarget(captureState);
  if (!target) return;
  const activated = await evaluateWithNavigationRetry(call, {
    expression: `(() => {
      const requested = ${JSON.stringify(target)};
      const screen = [...document.querySelectorAll("[data-screen]")].find(
        (element) => element.getAttribute("data-screen") === requested
      );
      const trigger = [...document.querySelectorAll("[data-target]")].find(
        (element) => element.getAttribute("data-target") === requested
      );
      if (!screen || !trigger) return false;
      trigger.click();
      return true;
    })()`,
    returnByValue: true,
  });
  if (activated?.result?.value !== true) {
    throw new Error(`页面状态无法激活：${target}`);
  }
  await evaluateWithNavigationRetry(call, {
    expression: `Promise.all([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    ])`,
    awaitPromise: true,
    returnByValue: true,
  });
}

function tabCaptureTarget(captureState) {
  if (captureState == null) return "";
  if (captureState?.kind !== "tab") {
    throw new Error(`不支持的页面捕获状态：${captureState?.kind || "空"}`);
  }
  const target = String(captureState.target || "").trim();
  if (!target) throw new Error("页面捕获状态缺少 target。");
  return target;
}

async function loadBundledPlaywright() {
  const candidates = [
    process.env.CODEX_WORKSPACE_NODE_MODULES,
    process.env.CODEX_NODE_MODULES,
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "node_modules",
    ),
    path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
    ),
  ].filter(Boolean);
  for (const modulesDirectory of candidates) {
    const entry = path.join(modulesDirectory, "playwright", "index.mjs");
    try {
      if (!(await stat(entry)).isFile()) continue;
      return await import(pathToFileURL(entry).href);
    } catch {
      // Fall back to the direct CDP implementation below.
    }
  }
  return null;
}

async function captureTarget(webSocketUrl, previewUrl, captureState) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("无法连接页面捕获浏览器。")),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer, method } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) {
      reject(
        new Error(
          `${method}: ${message.error.message || "页面捕获失败。"}`,
        ),
      );
    } else {
      resolve(message.result);
    }
  });

  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(`页面捕获浏览器连接已关闭：${request.method}`),
      );
    }
    pending.clear();
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const requestId = nextId;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`页面捕获步骤超时：${method}`));
      }, CDP_CALL_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });

  try {
    await opened;
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: previewUrl });
    await waitForDocumentReady(call);
    await evaluateWithNavigationRetry(call, {
      expression: `Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
      ])`,
      awaitPromise: true,
      returnByValue: true,
    });
    await activateCdpCaptureState(call, captureState);
    const evaluated = await evaluateWithNavigationRetry(call, {
      expression: CAPTURE_PAGE_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated?.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description ||
          evaluated.exceptionDetails.text ||
          "页面结构捕获失败。",
      );
    }
    const snapshot = evaluated?.result?.value;
    if (!snapshot?.root) {
      throw new Error("页面没有产生可编辑的设计结构。");
    }
    return snapshot;
  } finally {
    socket.terminate();
  }
}

async function captureTargetImage(
  webSocketUrl,
  previewUrl,
  { width, height },
  captureState,
) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("无法连接页面预览浏览器。")),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(
        new Error(
          `${request.method}: ${message.error.message || "页面预览失败。"}`,
        ),
      );
    } else {
      request.resolve(message.result);
    }
  });

  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(`页面预览浏览器连接已关闭：${request.method}`),
      );
    }
    pending.clear();
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const requestId = nextId;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`页面预览步骤超时：${method}`));
      }, CDP_CALL_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });

  try {
    await opened;
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 480,
    });
    await call("Page.navigate", { url: previewUrl });
    await waitForDocumentReady(call);
    await evaluateWithNavigationRetry(call, {
      expression: `Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
      ])`,
      awaitPromise: true,
      returnByValue: true,
    });
    await activateCdpCaptureState(call, captureState);
    const captured = await call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (!captured?.data) throw new Error("页面预览图为空。");
    return {
      dataUrl: `data:image/png;base64,${captured.data}`,
      width,
      height,
    };
  } finally {
    socket.terminate();
  }
}

async function waitForDocumentReady(call) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    try {
      const evaluated = await call("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (evaluated?.result?.value === "complete") {
        stableChecks += 1;
        if (stableChecks >= 3) return;
      } else {
        stableChecks = 0;
      }
    } catch (error) {
      stableChecks = 0;
      if (!/context|navigat|target/i.test(error?.message || "")) {
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error("页面加载超时。");
}

async function evaluateWithNavigationRetry(call, params) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await call("Runtime.evaluate", params);
    } catch (error) {
      if (!/context|navigat|target/i.test(error?.message || "")) {
        throw error;
      }
      await delay(100);
    }
  }
  throw new Error("页面在捕获过程中持续刷新。");
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(700),
      });
      const targets = await response.json();
      const pages = targets.filter(
        (target) =>
          target.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (pages[0]) return pages[0];
    } catch {
      // The browser is still starting.
    }
    await delay(120);
  }
  throw new Error("页面捕获浏览器启动超时。");
}

async function findBrowserExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe",
          ),
          path.join(
            process.env.PROGRAMFILES || "C:\\Program Files",
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
        ]
      : [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/usr/bin/google-chrome",
          "/usr/bin/microsoft-edge",
          "/usr/bin/chromium",
        ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  throw new Error("没有找到可用于页面捕获的 Edge、Chrome 或 Chromium。");
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("无法分配页面捕获端口。");
  return port;
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
    return;
  }
  child.kill("SIGTERM");
}

async function removeCaptureProfile(
  directory,
  expectedPrefix = "codex-design-capture-",
) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith(expectedPrefix)
  ) {
    return;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        return;
      }
      await delay(200);
    }
  }
}

function normalizeViewport(width, height) {
  const normalizedWidth = Number.isFinite(width)
    ? Math.round(width)
    : CAPTURE_WIDTH;
  const normalizedHeight = Number.isFinite(height)
    ? Math.round(height)
    : CAPTURE_HEIGHT;
  return {
    width: Math.min(1920, Math.max(320, normalizedWidth)),
    height: Math.min(1200, Math.max(480, normalizedHeight)),
  };
}

function countNodes(node) {
  if (!node) return 0;
  return (
    1 +
    (node.type === "frame"
      ? node.children.reduce((total, child) => total + countNodes(child), 0)
      : 0)
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
