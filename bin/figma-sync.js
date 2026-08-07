#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { BridgeServer, loadOrCreateToken } from "../src/server.js";
import { FeedbackStore } from "../src/feedback-store.js";
import { PageChangeStore } from "../src/page-change-store.js";
import { DesignTaskStore } from "../src/design-task-store.js";

const { command, positional, options } = parseArguments(process.argv.slice(2));

try {
  if (command === "start") {
    await startCommand(options);
  } else if (command === "status") {
    await statusCommand(options);
  } else if (command === "push") {
    await pushCommand(positional, options);
  } else if (command === "push-page") {
    await pushPageCommand(positional, options);
  } else if (command === "pull") {
    await pullCommand(options);
  } else if (command === "token") {
    await tokenCommand(options);
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`Unknown command "${command}". Run figma-sync help.`);
  }
} catch (error) {
  console.error(`figma-sync: ${error.message}`);
  process.exitCode = 1;
}

async function startCommand(options) {
  const rootDirectory = path.resolve(options.root || process.cwd());
  const token = options.token || (await loadOrCreateToken(rootDirectory));
  const server = new BridgeServer({
    rootDirectory,
    assetsDirectory: options.assets || "assets",
    pagesDirectory: options.pages || "pages",
    host: options.host || "127.0.0.1",
    port: options.port ? Number(options.port) : 9847,
    token,
    watchFiles: options.watch !== false,
    codexCommand: options.codex,
  });
  const connection = await server.start();

  if (options.json) {
    console.log(JSON.stringify(connection));
  } else {
    console.log(`Codex Design Bridge is running.`);
    console.log(`WebSocket: ${connection.wsUrl}`);
    console.log(`Token:     ${connection.token}`);
    console.log(`Assets:    ${connection.assetsDirectory}`);
    console.log(`Pages:     ${connection.pagesDirectory}`);
    console.log(`Designs:   ${connection.designRequestsDirectory}`);
    console.log(`Codex:     ${connection.codexCommand}`);
    console.log(`Feedback:  ${path.join(connection.rootDirectory, ".figma-sync", "inbox")}`);
    console.log(`Press Ctrl+C to stop.`);
  }

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function statusCommand(options) {
  const rootDirectory = path.resolve(options.root || process.cwd());
  const connection = await readConnection(rootDirectory);
  const response = await fetch(`http://${connection.host}:${connection.port}/health`);
  if (!response.ok) {
    throw new Error(`Bridge returned HTTP ${response.status}.`);
  }
  const health = await response.json();
  if (options.json) {
    console.log(JSON.stringify({ connection, health }));
  } else {
    console.log(`Bridge: connected`);
    console.log(`Assets: ${health.assets}`);
    console.log(`Pages: ${health.pages}`);
    console.log(`Figma plugins: ${health.pluginClients}`);
    console.log(`Codex runner: ${health.codexRunner.command}`);
    console.log(`PID: ${health.pid}`);
  }
}

async function pushCommand(positional, options) {
  if (!positional[0]) {
    throw new Error("push requires an SVG path.");
  }
  const rootDirectory = path.resolve(options.root || process.cwd());
  const connection = await readConnection(rootDirectory);
  const response = await fetch(`http://${connection.host}:${connection.port}/api/push`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: positional[0] }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || result.error || `HTTP ${response.status}`);
  }
  console.log(options.json ? JSON.stringify(result) : `Pushed ${result.assetId}`);
}

async function pushPageCommand(positional, options) {
  if (!positional[0]) {
    throw new Error("push-page requires a .figma-page.json path.");
  }
  const rootDirectory = path.resolve(options.root || process.cwd());
  const connection = await readConnection(rootDirectory);
  const response = await fetch(
    `http://${connection.host}:${connection.port}/api/push-page`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: positional[0] }),
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || result.error || `HTTP ${response.status}`);
  }
  console.log(options.json ? JSON.stringify(result) : `Pushed page ${result.pageId}`);
}

async function pullCommand(options) {
  const rootDirectory = path.resolve(options.root || process.cwd());
  const feedback = await new FeedbackStore(rootDirectory).list();
  const pageChanges = await new PageChangeStore(rootDirectory).list();
  const designTasks = await new DesignTaskStore(rootDirectory).list();
  if (options.json) {
    console.log(JSON.stringify({ ...feedback, pageChanges, designTasks }));
    return;
  }
  console.log(`Pending feedback: ${feedback.pending.length}`);
  for (const item of feedback.pending) {
    console.log(`- ${item.source.assetId}#${item.elementId} ${item.kind}`);
  }
  console.log(`Conflicts: ${feedback.conflicts.length}`);
  for (const item of feedback.conflicts) {
    console.log(`- ${item.source.assetId}#${item.elementId} ${item.kind}`);
  }
  console.log(`Page change sets: ${pageChanges.pending.length}`);
  for (const item of pageChanges.pending) {
    console.log(`- ${item.page.pageId} ${item.changes.length} change(s)`);
  }
  console.log(`Page change conflicts: ${pageChanges.conflicts.length}`);
  for (const item of pageChanges.conflicts) {
    console.log(`- ${item.page.pageId} ${item.changes.length} change(s)`);
  }
  console.log(`Design-to-code tasks: ${designTasks.length}`);
  for (const task of designTasks.slice(0, 10)) {
    console.log(`- ${task.taskId} ${task.state}`);
  }
}

async function tokenCommand(options) {
  const rootDirectory = path.resolve(options.root || process.cwd());
  console.log(await loadOrCreateToken(rootDirectory));
}

async function readConnection(rootDirectory) {
  const connectionPath = path.join(rootDirectory, ".figma-sync", "connection.json");
  try {
    return JSON.parse(await readFile(connectionPath, "utf8"));
  } catch {
    throw new Error(`No running bridge found at ${connectionPath}.`);
  }
}

function parseArguments(argumentsList) {
  const args = [...argumentsList];
  const command = args.shift() || "help";
  const positional = [];
  const options = {};

  while (args.length > 0) {
    const value = args.shift();
    if (value === "--json") {
      options.json = true;
    } else if (value === "--no-watch") {
      options.watch = false;
    } else if (value.startsWith("--")) {
      const key = value.slice(2);
      const optionValue = args.shift();
      if (!optionValue || optionValue.startsWith("--")) {
        throw new Error(`Option ${value} requires a value.`);
      }
      options[key] = optionValue;
    } else {
      positional.push(value);
    }
  }

  return { command, positional, options };
}

function printHelp() {
  console.log(`Usage:
  figma-sync start [--root DIR] [--assets DIR] [--pages DIR] [--codex PATH] [--host HOST] [--port PORT]
  figma-sync status [--root DIR] [--json]
  figma-sync push <svg-path> [--root DIR] [--json]
  figma-sync push-page <manifest-path> [--root DIR] [--json]
  figma-sync pull [--root DIR] [--json]
  figma-sync token [--root DIR]

The bridge binds to 127.0.0.1 by default and never calls Figma REST or MCP APIs.`);
}
