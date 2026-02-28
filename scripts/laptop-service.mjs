#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { printAgentCompanionBanner } from "./banner.mjs";

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const bridgePort = clampInt(args["bridge-port"], 8787, 1, 65535);
const relayPort = clampInt(args["relay-port"], 9797, 1, 65535);
const withLocalRelay = toBool(args["with-local-relay"]);
const defaultPublicRelayUrl = "https://agent-companion-relay.onrender.com";
const relayUrl = withLocalRelay
  ? trim(args.relay) || trim(process.env.AGENT_RELAY_URL) || `http://localhost:${relayPort}`
  : trim(args.relay) || trim(process.env.AGENT_RELAY_URL) || defaultPublicRelayUrl;
const companionName = trim(args.name);
const companionStateFile = trim(args["state-file"]);
const bridgeToken = trim(args["bridge-token"]) || trim(process.env.AGENT_BRIDGE_TOKEN);
const wakeMac = trim(args["wake-mac"]) || trim(args.wakeMac) || trim(process.env.AGENT_WAKE_MAC);
const verbose = toBool(args.verbose) || toBool(process.env.AGENT_VERBOSE);
const keepAwakeEnabled = !toBool(args["allow-sleep"]) && !toBool(process.env.AGENT_ALLOW_SLEEP);

const bridgeBaseUrl = `http://localhost:${bridgePort}`;
const childSpecs = [];

printAgentCompanionBanner();

childSpecs.push({
  name: "bridge",
  cmd: process.execPath,
  args: ["bridge/server.mjs"],
  env: {
    ...process.env,
    AGENT_BRIDGE_PORT: String(bridgePort),
    ...(bridgeToken ? { AGENT_BRIDGE_TOKEN: bridgeToken } : {})
  }
});

if (withLocalRelay) {
  childSpecs.push({
    name: "relay",
    cmd: process.execPath,
    args: ["relay/server.mjs"],
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
      RELAY_PUBLIC_URL: trim(args["relay-public-url"]) || process.env.RELAY_PUBLIC_URL || `http://localhost:${relayPort}`
    }
  });
}

const children = [];
let shuttingDown = false;

if (keepAwakeEnabled) {
  const keepAwake = startKeepAwakeProcess({ verbose });
  if (keepAwake) {
    children.push({ name: keepAwake.name, child: keepAwake.child });
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const spec of childSpecs) {
  const child = spawn(spec.cmd, spec.args, {
    cwd: projectRoot,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachLogs(spec.name, child);
  children.push({ name: spec.name, child });
}

await waitForHealth(`${bridgeBaseUrl}/health`, 15_000, "bridge");
if (withLocalRelay) {
  await waitForHealth(`${relayUrl}/health`, 15_000, "relay");
}

const companionArgs = [
  "scripts/laptop-companion.mjs",
  "--bridge",
  bridgeBaseUrl,
  "--relay",
  relayUrl
];

if (companionName) {
  companionArgs.push("--name", companionName);
}
if (companionStateFile) {
  companionArgs.push("--state-file", companionStateFile);
}
if (bridgeToken) {
  companionArgs.push("--bridgeToken", bridgeToken);
}
if (wakeMac) {
  companionArgs.push("--wake-mac", wakeMac);
}

const companion = spawn(process.execPath, companionArgs, {
  cwd: projectRoot,
  env: {
    ...process.env,
    AGENT_COMPANION_QUIET: verbose ? "0" : "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
companion.stdout.pipe(process.stdout);
companion.stderr.pipe(process.stderr);
children.push({ name: "companion", child: companion });

companion.on("close", (code) => {
  if (shuttingDown) return;
  if (Number.isInteger(code) && code === 0) return;
  console.error(`[laptop-service] companion exited with code ${code ?? "unknown"}`);
  shutdown("companion-exit");
});

function attachLogs(name, child) {
  if (!verbose) {
    child.on("close", (code) => {
      if (shuttingDown) return;
      if (Number.isInteger(code) && code === 0) return;
      console.error(`[laptop-service] ${name} exited with code ${code ?? "unknown"}`);
    });
    return;
  }

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("close", (code) => {
    if (shuttingDown) return;
    if (Number.isInteger(code) && code === 0) return;
    console.error(`[laptop-service] ${name} exited with code ${code ?? "unknown"}`);
  });
}

function startKeepAwakeProcess({ verbose }) {
  if (process.platform === "darwin") {
    const child = spawn("caffeinate", ["-dimsu"], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", (error) => {
      process.stderr.write(`[laptop-service] keep-awake unavailable: ${String(error?.message || error)}\n`);
    });
    if (verbose) {
      attachLogs("keep-awake", child);
    } else {
      child.stderr.on("data", () => {
        // suppress noisy caffeinate stderr in quiet mode
      });
    }
    process.stdout.write("[laptop-service] sleep prevention active (caffeinate)\n");
    return { name: "keep-awake", child };
  }

  if (process.platform === "linux") {
    const child = spawn(
      "systemd-inhibit",
      ["--what=sleep", "--why=agent-companion", "--mode=block", "sleep", "infinity"],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    child.on("error", (error) => {
      process.stderr.write(`[laptop-service] keep-awake unavailable: ${String(error?.message || error)}\n`);
    });
    if (verbose) {
      attachLogs("keep-awake", child);
    }
    process.stdout.write("[laptop-service] sleep prevention requested (systemd-inhibit)\n");
    return { name: "keep-awake", child };
  }

  process.stdout.write("[laptop-service] sleep prevention not supported on this OS; continuing\n");
  return null;
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\n[laptop-service] shutting down (${reason})...\n`);

  for (const { child } of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(0);
  }, 1500);
}

async function waitForHealth(url, timeoutMs, name) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // keep retrying
    }
    await sleep(250);
  }
  throw new Error(`${name} health check timed out at ${url}`);
}

function parseArgs(tokens) {
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

function toBool(value) {
  const normalized = trim(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function trim(value) {
  return String(value || "").trim();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsageAndExit(code, error = "") {
  if (error) {
    console.error(`[laptop-service] ${error}`);
  }
  console.log(`Usage:
  node scripts/laptop-service.mjs [--relay <url>] [options]
  node scripts/laptop-service.mjs --with-local-relay [options]

Options:
  --relay <url>                 Public or private relay URL for companion
  --with-local-relay            Also run relay in this process group
  --relay-port <port>           Relay port when --with-local-relay (default: 9797)
  --relay-public-url <url>      Public URL relay announces (default local URL)
  --bridge-port <port>          Bridge port (default: 8787)
  --bridge-token <token>        Optional bridge token
  --wake-mac <mac>              Optional Wake-on-LAN MAC (AA:BB:CC:DD:EE:FF)
  --allow-sleep                 Disable keep-awake mode
  --name <label>                Laptop display name for pairing
  --state-file <path>           Companion state file path
`);
  process.exit(code);
}
