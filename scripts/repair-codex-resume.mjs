#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const daysValue = readOption(argv, "--days");
const daysBack = safeInt(daysValue, 30);
const maxAgeMs = daysBack > 0 ? daysBack * 24 * 60 * 60 * 1000 : 0;

const codexRoot = path.join(os.homedir(), ".codex");
const sessionsRoot = path.join(codexRoot, "sessions");
const globalStateFile = path.join(codexRoot, ".codex-global-state.json");

let scanned = 0;
let patched = 0;
let titlesFromRollouts = 0;

const discoveredTitles = new Map();

for (const rolloutPath of listRolloutFiles(sessionsRoot)) {
  let stat;
  try {
    stat = fs.statSync(rolloutPath);
  } catch {
    continue;
  }

  if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs) {
    continue;
  }

  scanned += 1;
  const result = repairRollout(rolloutPath, { dryRun });
  if (result.patched) patched += 1;

  if (result.threadId) {
    const existing = discoveredTitles.get(result.threadId) || "";
    if (!existing && result.title) {
      discoveredTitles.set(result.threadId, result.title);
      titlesFromRollouts += 1;
    } else if (!existing) {
      discoveredTitles.set(result.threadId, `Phone task ${result.threadId.slice(0, 8)}`);
    }
  }
}

const indexed = upsertThreadTitles(globalStateFile, discoveredTitles, { dryRun });

console.log(
  `[resume-repair] scanned=${scanned} patched=${patched} indexed=${indexed} titles_detected=${titlesFromRollouts} dry_run=${dryRun}`
);

function repairRollout(filePath, options) {
  const out = { patched: false, threadId: "", title: "" };

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  if (!raw.trim()) return out;

  const newlineIndex = raw.indexOf("\n");
  const firstLine = newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
  const rest = newlineIndex >= 0 ? raw.slice(newlineIndex) : "";
  if (!firstLine.trim()) return out;

  let meta = null;
  try {
    meta = JSON.parse(firstLine);
  } catch {
    return out;
  }
  if (!meta || typeof meta !== "object") return out;

  const topLevelThreadId = typeof meta.thread_id === "string" ? meta.thread_id : "";
  const payloadThreadId =
    meta.payload && typeof meta.payload === "object" && typeof meta.payload.id === "string"
      ? meta.payload.id
      : "";
  const threadId = topLevelThreadId || payloadThreadId;
  if (threadId) out.threadId = threadId;

  const candidates = [meta];
  if (meta.payload && typeof meta.payload === "object") {
    candidates.push(meta.payload);
  }

  let changed = false;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const source = typeof candidate.source === "string" ? candidate.source.trim().toLowerCase() : "";

    if (
      (source === "exec" || source === "cli") &&
      (candidate.originator === "codex_exec" || candidate.originator === "Codex Desktop")
    ) {
      candidate.originator = "codex_cli_rs";
      changed = true;
    }

    if (source === "exec") {
      candidate.source = "cli";
      changed = true;
    }
  }

  out.title = extractPromptTitle(raw);

  if (!changed) return out;
  out.patched = true;

  if (!options.dryRun) {
    const nextRaw = `${JSON.stringify(meta)}${rest}`;
    atomicWriteText(filePath, nextRaw);
  }

  return out;
}

function extractPromptTitle(raw) {
  const lines = raw.split(/\r?\n/);
  const maxLines = Math.min(lines.length, 180);

  for (let index = 1; index < maxLines; index += 1) {
    const line = lines[index].trim();
    if (!line || line[0] !== "{") continue;

    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const eventMessage =
      parsed?.type === "event_msg" && parsed?.payload?.type === "user_message"
        ? parsed?.payload?.message
        : "";
    const responseMessage = extractTextFromResponseItem(parsed);
    const candidate = cleanTitle(eventMessage || responseMessage);

    if (!candidate) continue;
    if (!isLikelyPrompt(candidate)) continue;
    return candidate.slice(0, 120);
  }

  return "";
}

function extractTextFromResponseItem(parsed) {
  if (parsed?.type !== "response_item") return "";
  const payload = parsed?.payload;
  if (!payload || payload.type !== "message" || payload.role !== "user") return "";

  for (const entry of Array.isArray(payload.content) ? payload.content : []) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.input_text === "string" && entry.input_text.trim()) return entry.input_text.trim();
    if (typeof entry.text === "string" && entry.text.trim()) return entry.text.trim();
  }
  return "";
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function isLikelyPrompt(text) {
  const lower = text.toLowerCase();
  if (!lower) return false;
  if (lower.startsWith("# agents.md")) return false;
  if (lower.includes("<permissions instructions>")) return false;
  if (lower.includes("<environment_context>")) return false;
  if (lower.includes("collaboration mode")) return false;
  if (lower.includes("mcp tool discovery")) return false;
  return true;
}

function upsertThreadTitles(filePath, titlesMap, options) {
  if (titlesMap.size === 0) return 0;

  let parsed = {};
  if (fs.existsSync(filePath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      parsed = {};
    }
  }

  if (!parsed || typeof parsed !== "object") {
    parsed = {};
  }

  const current = parsed["thread-titles"];
  const titles =
    current && typeof current === "object" && current.titles && typeof current.titles === "object"
      ? { ...current.titles }
      : {};
  const order =
    current && typeof current === "object" && Array.isArray(current.order)
      ? current.order.filter((item) => typeof item === "string")
      : [];

  let updated = 0;
  const prioritized = [];
  for (const [threadId, title] of titlesMap.entries()) {
    const safeTitle = cleanTitle(title) || `Phone task ${threadId.slice(0, 8)}`;
    const previous = typeof titles[threadId] === "string" ? titles[threadId] : "";

    if (!previous || previous.startsWith("Phone task")) {
      if (previous !== safeTitle) {
        titles[threadId] = safeTitle;
        updated += 1;
      }
    }
    prioritized.push(threadId);
  }

  const nextOrder = [...prioritized, ...order.filter((id) => !prioritized.includes(id))].slice(0, 1200);
  parsed["thread-titles"] = {
    ...(current && typeof current === "object" ? current : {}),
    titles,
    order: nextOrder
  };

  if (!options.dryRun) {
    atomicWriteText(filePath, JSON.stringify(parsed));
  }

  return updated;
}

function listRolloutFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("rollout-")) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      files.push(fullPath);
    }
  }

  return files;
}

function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  let mode = undefined;

  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    mode = undefined;
  }

  if (typeof mode === "number") {
    fs.writeFileSync(tempPath, content, { mode });
  } else {
    fs.writeFileSync(tempPath, content);
  }

  fs.renameSync(tempPath, filePath);
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}
