import path from "node:path";
import { commitPatchTransaction } from "../../codex-plugin/codex-design-bridge/mcp/patch-transaction.mjs";

const projectDir = path.resolve(process.argv[2]);
const firstFile = String(process.argv[3] || "first.txt");
const secondFile = String(process.argv[4] || "second.txt");

await commitPatchTransaction({
  projectDir,
  writes: [
    { file: path.join(projectDir, firstFile), content: "first after" },
    { file: path.join(projectDir, secondFile), content: "second after" },
  ],
  faultInjector({ index }) {
    if (index === 1) process.kill(process.pid, "SIGKILL");
  },
});
