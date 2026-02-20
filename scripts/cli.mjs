#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const command = String(argv[0] || "").trim().toLowerCase();
const rest = argv.slice(1);

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp(0);
}

if (command === "laptop") {
  runNodeScript(path.resolve(projectRoot, "scripts", "laptop-service.mjs"), rest);
} else if (command === "relay") {
  runNodeScript(path.resolve(projectRoot, "relay", "server.mjs"), rest);
} else if (command === "bridge") {
  runNodeScript(path.resolve(projectRoot, "bridge", "server.mjs"), rest);
} else if (command === "wake-proxy") {
  runNodeScript(path.resolve(projectRoot, "wake-proxy", "server.mjs"), rest);
} else {
  console.error(`[agent-companion] unknown command "${command}"`);
  printHelp(1);
}

function runNodeScript(scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(Number.isInteger(code) ? code : 1);
  });
}

function printHelp(exitCode) {
  console.log(`Usage:
  agent-companion laptop
  agent-companion laptop --relay <url>
  agent-companion laptop --with-local-relay
  agent-companion relay
  agent-companion bridge
  agent-companion wake-proxy

Examples:
  agent-companion laptop
  agent-companion laptop --relay https://agent-companion-relay.onrender.com
  agent-companion laptop --with-local-relay
  agent-companion wake-proxy
`);
  process.exit(exitCode);
}
