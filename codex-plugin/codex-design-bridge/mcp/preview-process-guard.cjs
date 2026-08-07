const { existsSync } = require("node:fs");

const guardPath = process.env.CODEX_DESIGN_BRIDGE_PREVIEW_GUARD;

if (guardPath) {
  const timer = setInterval(() => {
    if (!existsSync(guardPath)) {
      process.exit(0);
    }
  }, 250);
  timer.unref();
}
