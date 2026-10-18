import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Runs the API and the worker together in one container (`PROCESS=all`). Used on hosts where
 * the two can't share a disk volume: uploads are stored on local disk, and the worker has to
 * read what the API stored. Each still runs as its own process, so a crash in one is visible:
 * if either exits, the other is stopped and the container exits for the platform to restart.
 */
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const children: ChildProcess[] = [here("./server.js"), here("./worker.js")].map((script) =>
  spawn(process.execPath, [script], { stdio: "inherit" }),
);

let stopping = false;
function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  // Give them time to finish running jobs and close connections.
  setTimeout(() => process.exit(code), 35_000).unref();
  Promise.all(
    children.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : c.once("exit", r)))),
  ).then(() => process.exit(code));
}

for (const child of children) child.once("exit", (code) => stopAll(code ?? 1));
process.on("SIGTERM", () => stopAll(0));
process.on("SIGINT", () => stopAll(0));
