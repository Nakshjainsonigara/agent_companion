#!/usr/bin/env node
import { spawn } from "node:child_process";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const runners = [
  {
    name: "bridge",
    cmd: npmCmd,
    args: ["run", "bridge"]
  },
  {
    name: "web",
    cmd: npmCmd,
    args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
  }
];

const children = runners.map((runner) => {
  const child = spawn(runner.cmd, runner.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: process.env
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${runner.name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${runner.name}] ${chunk}`);
  });

  child.on("close", (code) => {
    if (code === 0) return;
    process.stderr.write(`[${runner.name}] exited with code ${code}\n`);
  });

  return child;
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\n[stack] received ${signal}, shutting down...\n`);

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 1200);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
