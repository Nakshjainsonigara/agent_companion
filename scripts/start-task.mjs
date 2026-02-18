#!/usr/bin/env node
import process from "node:process";

const argv = process.argv.slice(2);
const dividerIndex = argv.indexOf("--");
const optionArgs = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv;
const commandArgs = (dividerIndex >= 0 ? argv.slice(dividerIndex + 1) : []).filter(Boolean);
while (commandArgs[0] === "--") {
  commandArgs.shift();
}

const options = parseOptions(optionArgs);
const bridgeUrl = options.bridge || process.env.AGENT_BRIDGE_URL || "http://localhost:8787";
const workspacePath = options.workspace || process.cwd();
const agentType = options.agent === "CLAUDE" ? "CLAUDE" : "CODEX";
const prompt = options.prompt || "";
const title = options.title || "";
const token = options.token || process.env.AGENT_BRIDGE_TOKEN || "";
const fullWorkspaceAccess = parseBooleanOption(options["full-workspace-access"]);
const skipPermissions = parseBooleanOption(options["skip-permissions"]);
const planMode = parseBooleanOption(options["plan-mode"]);

if (commandArgs.length === 0 && !prompt.trim()) {
  printUsageAndExit(1);
}

const payload = {
  agentType,
  workspacePath,
  title,
  prompt
};

if (commandArgs.length > 0) {
  payload.command = commandArgs;
}
if (fullWorkspaceAccess) {
  payload.fullWorkspaceAccess = true;
}
if (skipPermissions) {
  payload.skipPermissions = true;
}
if (planMode) {
  payload.planMode = true;
}

const headers = {
  "Content-Type": "application/json"
};
if (token) {
  headers["x-bridge-token"] = token;
}

const response = await fetch(`${bridgeUrl}/api/launcher/start`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload)
});

const text = await response.text();
let json;
try {
  json = text ? JSON.parse(text) : {};
} catch {
  json = { raw: text };
}

if (!response.ok) {
  console.error(`[start-task] error ${response.status}:`, json);
  process.exit(1);
}

console.log("[start-task] launched:");
console.log(JSON.stringify(json, null, 2));

function parseOptions(args) {
  const out = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    index += 1;
  }

  return out;
}

function printUsageAndExit(code) {
  console.log(`Usage:\n  node scripts/start-task.mjs --agent CODEX|CLAUDE --workspace <path> --prompt "Task" [--title "Name"] [--bridge <url>] [--token <token>] [--full-workspace-access] [--skip-permissions] [--plan-mode]\n\n  # custom command\n  node scripts/start-task.mjs --agent CODEX --workspace <path> --plan-mode -- -- zsh -lc "echo hello"\n`);
  process.exit(code);
}

function parseBooleanOption(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
