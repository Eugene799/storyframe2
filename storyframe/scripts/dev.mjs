import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const apiPort = process.env.API_PORT?.trim() || "8787";

const commands = [
  { name: "api", args: ["run", "dev:server"], env: { ...process.env, API_PORT: apiPort, PORT: apiPort } },
  { name: "web", args: ["run", "dev:web", "--", "--host", "0.0.0.0"], env: { ...process.env, API_PORT: apiPort } },
];

const children = commands.map(({ name, args, env }) => {
  const child = spawn(npm, args, { stdio: "inherit", env });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[storyframe] ${name} process exited (${code ?? "unknown"}); stopping dev servers.`);
      shutdown(code ?? 1);
    }
  });
  return child;
});

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
