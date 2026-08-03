// Spawns a detached grandchild that also hangs, then hangs itself. The
// cli-process helper must kill the whole process group on timeout so neither
// this process nor the grandchild leaks.
import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
process.stdout.write(`started ${process.pid} ${grandchild.pid}\n`);
setInterval(() => {}, 1000);
