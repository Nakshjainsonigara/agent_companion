#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const dividerIndex = argv.indexOf("--");
const optionArgs = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv;
const commandArgs = dividerIndex >= 0 ? argv.slice(dividerIndex + 1).filter(Boolean) : [];
while (commandArgs[0] === "--") {
  commandArgs.shift();
}

const options = parseOptions(optionArgs);
const bridgeUrl = trimTrailingSlash(
  options.bridge || process.env.AGENT_COMPANION_BRIDGE_URL || process.env.AGENT_BRIDGE_URL || "http://localhost:8787"
);
const workspacePath = path.resolve(options.workspace || process.env.AGENT_WORKSPACE_PATH || process.cwd());
const sessionId = trim(options.session || process.env.AGENT_SESSION_ID || "");
const label = trim(options.label || "");
const commandText = trim(options.command || "");
const token = trim(options.token || process.env.AGENT_BRIDGE_TOKEN || "");

const portRaw = Number.parseInt(String(options.port || "").trim(), 10);
const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : null;

const payload = {
  workspacePath,
};
if (sessionId) payload.sessionId = sessionId;
if (label) payload.label = label;
if (port) payload.port = port;

if (commandArgs.length > 0) {
  payload.command = commandArgs;
} else if (commandText) {
  payload.command = commandText;
} else {
  printUsageAndExit(1, "missing command");
}

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json",
};
if (token) {
  headers["x-bridge-token"] = token;
}

const response = await fetch(`${bridgeUrl}/api/launcher/services/start`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});

const text = await response.text();
let body;
try {
  body = text ? JSON.parse(text) : {};
} catch {
  body = { raw: text };
}

if (!response.ok || !body?.ok || !body?.service) {
  const errorText = typeof body?.error === "string" ? body.error : `request failed (${response.status})`;
  console.error(`[background-service] ${errorText}`);
  if (body && typeof body === "object") {
    console.error(JSON.stringify(body, null, 2));
  }
  process.exit(1);
}

const service = body.service;
console.log(`[background-service] started ${service.id}`);
console.log(`[background-service] status=${service.status} pid=${service.pid ?? "pending"}`);
if (service.localhostUrl) {
  console.log(`[background-service] localhost=${service.localhostUrl}`);
}
console.log(JSON.stringify({ ok: true, service }, null, 2));

function parseOptions(tokens) {
  const out = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function trim(value) {
  return String(value || "").trim();
}

function trimTrailingSlash(value) {
  return trim(value).replace(/\/+$/, "");
}

function printUsageAndExit(code, error = "") {
  if (error) {
    console.error(`[background-service] ${error}`);
  }
  console.log(`Usage:
  node scripts/background-service.mjs [options] -- <command> [args...]
  node scripts/background-service.mjs --command "<shell command>" [options]

Options:
  --bridge <url>        Bridge URL (default: http://localhost:8787)
  --workspace <path>    Workspace path (default: current directory)
  --session <id>        Optional session id for timeline events
  --label <text>        Optional display label
  --port <n>            Optional localhost port hint
  --token <token>       Optional bridge token
`);
  process.exit(code);
}
