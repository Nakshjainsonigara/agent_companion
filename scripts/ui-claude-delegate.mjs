#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_RESUME_ID = "9f359518-cae4-4da8-9e55-0ac7e261e85a";
const JOBS_DIR = path.resolve(projectRoot, ".agent", "ui-jobs");

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const prompt = resolvePrompt(args);
const resumeId = trim(args.resume) || DEFAULT_RESUME_ID;
const cwd = path.resolve(trim(args.cwd) || projectRoot);
const wait = toBool(args.wait);
const dryRun = toBool(args["dry-run"]);

if (!prompt) {
  printUsageAndExit(1, "prompt is required");
}

if (!isUuid(resumeId)) {
  printUsageAndExit(1, `invalid resume id: ${resumeId}`);
}

if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
  printUsageAndExit(1, `cwd must be an existing directory: ${cwd}`);
}

fs.mkdirSync(JOBS_DIR, { recursive: true });

const jobId = buildJobId();
const logPath = path.resolve(JOBS_DIR, `${jobId}.log`);
const metaPath = path.resolve(JOBS_DIR, `${jobId}.json`);

const commandArgs = [
  "--resume",
  resumeId,
  "--dangerously-skip-permissions",
  "--verbose",
  "--output-format",
  "stream-json",
  "-p",
  prompt
];

const commandPreview = `claude ${commandArgs.map(shellEscape).join(" ")}`;
const metadata = {
  id: jobId,
  createdAt: Date.now(),
  cwd,
  resumeId,
  prompt,
  command: ["claude", ...commandArgs],
  status: "STARTING",
  pid: null,
  logPath
};

fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

if (dryRun) {
  metadata.status = "DRY_RUN";
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  console.log(`[ui-delegate] dry-run`);
  console.log(`[ui-delegate] command: ${commandPreview}`);
  console.log(`[ui-delegate] meta: ${metaPath}`);
  process.exit(0);
}

if (wait) {
  const outFd = fs.openSync(logPath, "a");
  fs.writeSync(outFd, `# ${new Date().toISOString()} ${commandPreview}\n`);

  const child = spawn("claude", commandArgs, {
    cwd,
    env: process.env,
    stdio: ["ignore", outFd, outFd]
  });

  metadata.pid = child.pid || null;
  metadata.status = "RUNNING";
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  child.on("close", (code, signal) => {
    metadata.status = Number.isInteger(code) && code === 0 ? "COMPLETED" : "FAILED";
    metadata.exitCode = Number.isInteger(code) ? code : null;
    metadata.signal = signal || null;
    metadata.endedAt = Date.now();
    fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    fs.closeSync(outFd);
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    metadata.status = "FAILED";
    metadata.error = String(error?.message || error);
    metadata.endedAt = Date.now();
    fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    fs.closeSync(outFd);
    process.exit(1);
  });

  console.log(`[ui-delegate] running (wait mode): ${jobId}`);
  console.log(`[ui-delegate] log: ${logPath}`);
  console.log(`[ui-delegate] meta: ${metaPath}`);
  process.exit(0);
}

const outFd = fs.openSync(logPath, "a");
fs.writeSync(outFd, `# ${new Date().toISOString()} ${commandPreview}\n`);

const child = spawn("claude", commandArgs, {
  cwd,
  env: process.env,
  detached: true,
  stdio: ["ignore", outFd, outFd]
});

metadata.pid = child.pid || null;
metadata.status = "RUNNING";
fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

child.unref();
fs.closeSync(outFd);

console.log(`[ui-delegate] started: ${jobId}`);
console.log(`[ui-delegate] pid: ${metadata.pid ?? "unknown"}`);
console.log(`[ui-delegate] log: ${logPath}`);
console.log(`[ui-delegate] meta: ${metaPath}`);
console.log(`[ui-delegate] tail: tail -f ${shellEscape(logPath)}`);

function parseArgs(tokens) {
  const out = { _: [] };
  const valueFlags = new Set(["resume", "cwd", "prompt"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!valueFlags.has(key)) {
      out[key] = "true";
      continue;
    }
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      printUsageAndExit(1, `missing value for --${key}`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function resolvePrompt(argsInput) {
  const explicit = trim(argsInput.prompt);
  if (explicit) return explicit;
  const fromPositional = Array.isArray(argsInput._) ? argsInput._ : [];
  return trim(fromPositional.join(" "));
}

function toBool(value) {
  const normalized = trim(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function trim(value) {
  return String(value || "").trim();
}

function isUuid(value) {
  const candidate = trim(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate);
}

function buildJobId() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0")
  ];
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `ui_${parts.join("")}_${rand}`;
}

function shellEscape(value) {
  const text = String(value || "");
  if (/^[a-zA-Z0-9_./:@-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function printUsageAndExit(code, error = "") {
  if (error) {
    console.error(`[ui-delegate] ${error}`);
  }
  console.log(`Usage:
  node scripts/ui-claude-delegate.mjs --prompt "<text>" [options]
  node scripts/ui-claude-delegate.mjs "<text>" [options]

Options:
  --resume <uuid>    Claude resume thread id (default project UI thread)
  --cwd <path>       Working directory for Claude (default: repo root)
  --wait             Run in foreground and wait for completion
  --dry-run          Print command and metadata without running Claude
`);
  process.exit(code);
}
