#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const dividerIndex = argv.indexOf("--");
const optionArgs = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv;
const command = dividerIndex >= 0 ? argv.slice(dividerIndex + 1) : [];

if (command.length === 0) {
  printUsageAndExit(1);
}

const options = parseOptions(optionArgs);
const agentType = options.agent === "CLAUDE" ? "CLAUDE" : "CODEX";
const bridgeUrl = options.bridge || process.env.AGENT_BRIDGE_URL || "http://localhost:8787";
const sessionId = options.session || `${agentType.toLowerCase()}_${Date.now()}`;
const runId = String(options.run || "").trim();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backgroundHelperPath = path.resolve(__dirname, "background-service.mjs");
const launchOptions = {
  fullWorkspaceAccess: parseBooleanEnv(options.fullWorkspaceAccess, false),
  skipPermissions: parseBooleanEnv(options.skipPermissions, false),
  planMode: parseBooleanEnv(options.planMode, false)
};
const persistentServerHint = buildPersistentServerHint({
  helperScriptPath: backgroundHelperPath,
  bridgeUrl,
  workspacePath: process.cwd(),
  sessionId
});
normalizeCommand(command, {
  agentType,
  fullWorkspaceAccess: launchOptions.fullWorkspaceAccess,
  skipPermissions: launchOptions.skipPermissions,
  planMode: launchOptions.planMode,
  persistentServerHint
});

const title = options.title || command.join(" ").slice(0, 120);
const repo = options.repo || path.basename(process.cwd());
const branch = options.branch || detectBranch();

const usage = {
  promptTokens: safeInt(options.promptTokens, 0),
  completionTokens: safeInt(options.completionTokens, 0),
  totalTokens: safeInt(options.totalTokens, 0),
  costUsd: safeFloat(options.costUsd, 0)
};

if (usage.totalTokens === 0) {
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
}

const startTime = Date.now();
let lastPendingAt = 0;
let lastUpsertAt = 0;
let lastToolCallHint = "";
let lastPendingFingerprint = "";
let done = false;
let codexThreadId = "";
let claudeSessionId = "";
let codexRolloutPromoted = false;
let codexPromotionNoticeShown = false;
const CODEX_GLOBAL_STATE_FILE = path.join(os.homedir(), ".codex", ".codex-global-state.json");
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const ENABLE_CODEX_RESUME_PROMOTION = parseBooleanEnv(
  process.env.AGENT_ENABLE_CODEX_RESUME_PROMOTION,
  true
);
const ENABLE_CODEX_THREAD_INDEX = parseBooleanEnv(process.env.AGENT_ENABLE_CODEX_THREAD_INDEX, true);

const childEnv = {
  ...process.env,
  AGENT_COMPANION_BACKGROUND_HELPER: backgroundHelperPath,
  AGENT_COMPANION_BRIDGE_URL: bridgeUrl,
  AGENT_SESSION_ID: sessionId,
  AGENT_WORKSPACE_PATH: process.cwd()
};

const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"]
});

let stdoutBuffer = "";
let stderrBuffer = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  stdoutBuffer += text;
  stdoutBuffer = consumeBuffer(stdoutBuffer, handleOutputLine);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  stderrBuffer += text;
  stderrBuffer = consumeBuffer(stderrBuffer, handleOutputLine);
});

// Forward remote action replies (phone approvals/replies) to the running CLI command.
process.stdin.on("data", (chunk) => {
  if (agentType !== "CODEX") return;
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
  child.stdin.write(chunk);
});

if (agentType !== "CODEX" && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
  // Claude print-mode can wait on open stdin; close it to force prompt-argument execution.
  child.stdin.end();
}

process.on("SIGINT", () => {
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

await safePost("/api/sessions/upsert", {
  id: sessionId,
  agentType,
  title,
  repo,
  branch,
  state: "RUNNING",
  progress: 6,
  lastUpdated: Date.now(),
  tokenUsage: usage
});

await safePost("/api/events/add", {
  sessionId,
  summary: `Session started: ${title}`,
  category: "INFO",
  timestamp: Date.now()
});

console.log(`\n[agent-runner] session=${sessionId} agent=${agentType}`);
console.log(`[agent-runner] bridge=${bridgeUrl}\n`);

const heartbeat = setInterval(async () => {
  if (done) return;

  const progress = Math.min(95, 6 + Math.floor((Date.now() - startTime) / 6000));
  usage.totalTokens = Math.max(usage.totalTokens, usage.promptTokens + usage.completionTokens);
  if (usage.costUsd === 0 && usage.totalTokens > 0) {
    usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
  }

  await safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: "RUNNING",
    progress,
    lastUpdated: Date.now(),
    tokenUsage: usage
  });
}, 4000);

child.on("close", async (code) => {
  done = true;
  clearInterval(heartbeat);

  const exitCode = Number.isInteger(code) ? code : 1;
  const completed = exitCode === 0;

  usage.totalTokens = Math.max(usage.totalTokens, usage.promptTokens + usage.completionTokens);
  if (usage.costUsd === 0 && usage.totalTokens > 0) {
    usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
  }

  await safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: completed ? "COMPLETED" : "FAILED",
    progress: completed ? 100 : Math.min(99, 6 + Math.floor((Date.now() - startTime) / 8000)),
    lastUpdated: Date.now(),
    tokenUsage: usage
  });

  await safePost("/api/events/add", {
    sessionId,
    summary: completed ? "Session completed." : `Session failed with exit code ${exitCode}.`,
    category: completed ? "ACTION" : "ERROR",
    timestamp: Date.now()
  });

  if (codexThreadId) {
    if (ENABLE_CODEX_RESUME_PROMOTION && !codexRolloutPromoted) {
      codexRolloutPromoted =
        (await promoteExecRolloutToCliWithRetry(codexThreadId, {
          attempts: 12,
          delayMs: 250
        })) || codexRolloutPromoted;
    }

    await safePost("/api/events/add", {
      sessionId,
      summary: `Resume later: codex exec resume ${codexThreadId}`,
      category: "INFO",
      timestamp: Date.now()
    });
  }

  if (claudeSessionId) {
    await safePost("/api/events/add", {
      sessionId,
      summary: `Resume later: claude --resume ${claudeSessionId}`,
      category: "INFO",
      timestamp: Date.now()
    });
  }

  process.exit(exitCode);
});

function handleOutputLine(line) {
  if (tryHandleStructuredJsonLine(line)) return;
  parseTokenSignals(line);
  maybeEmitInputRequest(line);
  maybeEmitMilestoneEvent(line);
}

function tryMarkPendingEmission(kind, prompt) {
  const now = Date.now();
  const normalizedKind = String(kind || "RUNTIME_APPROVAL").trim().toUpperCase();
  const normalizedPrompt = String(prompt || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const fingerprint = `${normalizedKind}|${normalizedPrompt}`;
  if (fingerprint && fingerprint === lastPendingFingerprint && now - lastPendingAt < 90_000) {
    return false;
  }
  if (now - lastPendingAt < 30_000) return false;
  lastPendingAt = now;
  lastPendingFingerprint = fingerprint;
  return true;
}

function emitPendingRequest({
  prompt,
  kind,
  toolCall = null,
  toolName = null,
  questionRequest = false,
  questionHeader = null,
  questionOptions = null,
  multiSelect = false,
  priority = "HIGH"
}) {
  const cleanedPrompt = String(prompt || "").trim().slice(0, 220);
  if (!cleanedPrompt) return false;
  const normalizedKind = String(kind || "RUNTIME_APPROVAL").trim().toUpperCase() || "RUNTIME_APPROVAL";
  if (!tryMarkPendingEmission(normalizedKind, cleanedPrompt)) return false;

  void safePost("/api/pending/add", {
    sessionId,
    prompt: cleanedPrompt,
    priority,
    requestedAt: Date.now(),
    actionable: true,
    source: "RUNNER",
    meta: {
      kind: normalizedKind,
      planMode: launchOptions.planMode,
      agentType,
      runId: runId || null,
      toolCall: toolCall || null,
      toolName: toolName || null,
      questionRequest: Boolean(questionRequest),
      questionHeader: questionHeader ? String(questionHeader).trim().slice(0, 120) : null,
      questionOptions:
        Array.isArray(questionOptions) && questionOptions.length > 0
          ? questionOptions
              .slice(0, 6)
              .map((item) => normalizeQuestionOption(item))
              .filter(Boolean)
          : null
      ,
      multiSelect: Boolean(multiSelect)
    }
  });

  void safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: "WAITING_INPUT",
    progress: Math.min(99, 6 + Math.floor((Date.now() - startTime) / 7000)),
    lastUpdated: Date.now(),
    tokenUsage: usage
  });

  return true;
}

function tryHandleStructuredJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return false;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return false;
  }

  if (!payload || typeof payload !== "object") return true;
  let handled = false;
  const toolHint = extractToolHintFromPayload(payload);
  if (toolHint) {
    lastToolCallHint = toolHint;
    handled = true;
  }
  const askUserQuestion = extractAskUserQuestionPayload(payload);
  if (askUserQuestion) {
    const emitted = emitPendingRequest({
      prompt: askUserQuestion.question,
      kind: "QUESTION_REQUEST",
      questionRequest: true,
      questionHeader: askUserQuestion.header,
      questionOptions: askUserQuestion.options,
      multiSelect: askUserQuestion.multiSelect
    });
    handled = handled || emitted;
  }

  const payloadSessionId = normalizeUuid(payload.session_id);
  if (payloadSessionId) {
    handled = true;
    if (!claudeSessionId) {
      claudeSessionId = payloadSessionId;
      console.log(`[agent-runner] claude_session=${claudeSessionId}`);
      void safePost("/api/events/add", {
        sessionId,
        summary: `Claude session ready: ${claudeSessionId} (resume: claude --resume ${claudeSessionId})`,
        category: "INFO",
        timestamp: Date.now()
      });
    }
  }

  if (payload.type === "thread.started" && typeof payload.thread_id === "string") {
    const threadId = payload.thread_id.trim();
    if (threadId && !codexThreadId) {
      codexThreadId = threadId;
      console.log(`[agent-runner] codex_thread=${threadId}`);
      if (ENABLE_CODEX_THREAD_INDEX) {
        upsertThreadInCodexGlobalState(threadId, title);
      }
      if (ENABLE_CODEX_RESUME_PROMOTION && !codexPromotionNoticeShown) {
        codexPromotionNoticeShown = true;
        console.log(`[agent-runner] will promote resume metadata after run completes: ${threadId}`);
      }
      void safePost("/api/events/add", {
        sessionId,
        summary: `Codex thread ready: ${threadId} (resume: codex exec resume ${threadId})`,
        category: "INFO",
        timestamp: Date.now()
      });
    }
    return true;
  }

  if (payload.type === "turn.completed" && payload.usage && typeof payload.usage === "object") {
    const inputTokens =
      safeInt(payload.usage.input_tokens, 0) + safeInt(payload.usage.cached_input_tokens, 0);
    const outputTokens = safeInt(payload.usage.output_tokens, 0);
    if (inputTokens > 0) usage.promptTokens = inputTokens;
    if (outputTokens > 0) usage.completionTokens = outputTokens;
    if (inputTokens > 0 || outputTokens > 0) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
      if (usage.costUsd === 0 && usage.totalTokens > 0) {
        usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
      }
    }
    return true;
  }

  if (payload.type === "item.completed" && payload.item && typeof payload.item === "object") {
    handled = true;
    if (payload.item.type === "agent_message" && typeof payload.item.text === "string") {
      const message = payload.item.text.trim();
      if (message) {
        maybeEmitInputRequest(message);
        maybeEmitMilestoneEvent(message);
      }
    }
    return true;
  }

  if (payload.type === "assistant" && payload.message && typeof payload.message === "object") {
    handled = true;
    const message = payload.message;
    const assistantText = extractStructuredText(message.content || message.text);
    if (assistantText) {
      maybeEmitInputRequest(assistantText);
      maybeEmitMilestoneEvent(assistantText);
    }
    applyUsageFromRecord(message.usage);
    return true;
  }

  if (payload.type === "result") {
    handled = true;
    const resultText = typeof payload.result === "string" ? payload.result.trim() : "";
    if (resultText) {
      maybeEmitInputRequest(resultText);
      maybeEmitMilestoneEvent(resultText);
    }
    applyUsageFromRecord(payload.usage);
    if (typeof payload.total_cost_usd === "number" && Number.isFinite(payload.total_cost_usd)) {
      usage.costUsd = Number(payload.total_cost_usd.toFixed(4));
    }
    return true;
  }

  const fallbackText = extractStructuredText(
    payload.message || payload.result || payload.content || payload.text || payload.payload
  );
  if (fallbackText) {
    maybeEmitInputRequest(fallbackText);
    maybeEmitMilestoneEvent(fallbackText);
    return true;
  }

  return handled;
}

function maybeEmitMilestoneEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const shouldEmit = /completed|finished|patched|updated|created|error|failed/i.test(trimmed);
  if (!shouldEmit) return;

  if (Date.now() - lastUpsertAt < 2500) return;
  lastUpsertAt = Date.now();

  void safePost("/api/events/add", {
    sessionId,
    summary: trimmed.slice(0, 220),
    category: /error|failed/i.test(trimmed) ? "ERROR" : "INFO",
    timestamp: Date.now()
  });
}

function maybeEmitInputRequest(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const needsInput = /input required|needs input|approval[_\s-]*required|awaiting approval|please approve|approve (?:this|the) plan|should i (?:proceed|implement|execute)|would you like me to (?:proceed|implement|execute)|ready to (?:implement|execute)|want me to (?:implement|execute)/i.test(trimmed);
  const needsQuestionAnswer = isClarifyingQuestionRequest(trimmed);
  const toolPermissionHint = /\[request interrupted by user for tool use\]|tool[_\s-]*(?:approval|permission)|allow.*tool/i.test(
    trimmed
  );
  const isToolPermission = toolPermissionHint || (needsInput && Boolean(lastToolCallHint));
  const isQuestionRequest = !isToolPermission && !needsInput && needsQuestionAnswer;
  let questionOptions = isQuestionRequest ? extractQuestionOptions(trimmed) : [];
  if (isQuestionRequest && questionOptions.length === 0) {
    questionOptions = extractQuestionOptionsFromSerializedPayload(trimmed);
  }
  const questionHeader = isQuestionRequest ? extractQuestionHeaderFromSerializedPayload(trimmed) : null;

  if (!needsInput && !isToolPermission && !isQuestionRequest) return;
  const approvalPrompt = extractApprovalPrompt(trimmed, lastToolCallHint, isQuestionRequest).slice(0, 220);
  const pendingKind = isQuestionRequest
    ? "QUESTION_REQUEST"
    : isToolPermission
      ? "TOOL_PERMISSION"
      : launchOptions.planMode
        ? "PLAN_CONFIRM"
        : "RUNTIME_APPROVAL";
  const toolName = extractToolNameFromHint(lastToolCallHint);
  emitPendingRequest({
    prompt: approvalPrompt || trimmed.slice(0, 220),
    kind: pendingKind,
    toolCall: lastToolCallHint || null,
    toolName: toolName || null,
    questionRequest: isQuestionRequest,
    questionHeader,
    questionOptions: questionOptions.length > 0 ? questionOptions : null
  });
}

function extractApprovalPrompt(text, toolHint = "", isQuestionRequest = false) {
  const cleaned = String(text || "").replace(/\r/g, "").trim();
  if (!cleaned) return "";

  if (/\[request interrupted by user for tool use\]|tool[_\s-]*(?:approval|permission)/i.test(cleaned) && toolHint) {
    return `Approve tool call: ${toolHint}`;
  }
  if (isQuestionRequest) {
    const structuredQuestion = extractQuestionFromSerializedPayload(cleaned);
    if (structuredQuestion) return structuredQuestion;
    const inferredNeedToKnow =
      cleaned.match(/(before i can [^.!?]{0,180}need to know[^.!?]{0,180})/i)?.[1] ||
      cleaned.match(/(i need to know [^.!?]{0,200})/i)?.[1];
    if (inferredNeedToKnow) {
      return inferredNeedToKnow.trim().replace(/\s+/g, " ").slice(0, 220);
    }
    const question = extractBestQuestion(cleaned);
    if (question) return question;
    return cleaned;
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isApprovalQuestion(lines[index])) {
      return lines[index];
    }
  }

  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    if (isApprovalQuestion(sentences[index])) {
      return sentences[index];
    }
  }

  return cleaned;
}

function isApprovalQuestion(text) {
  const candidate = String(text || "").trim();
  if (!candidate) return false;
  return /approval[_\s-]*required|awaiting approval|please approve|approve (?:this|the) plan|should i (?:proceed|implement|execute)|would you like me to (?:proceed|implement|execute)|ready to (?:implement|execute)|want me to (?:implement|execute)|proceed with implementation/i.test(
    candidate
  );
}

function isClarifyingQuestionRequest(text) {
  const candidate = String(text || "").trim();
  if (!candidate) return false;
  if (/input required|approval[_\s-]*required|awaiting approval|please approve/i.test(candidate)) return false;
  if (/askuserquestion|\"question\"\s*:/i.test(candidate)) return true;
  if (/[?]/.test(candidate) && /\b(can you|could you|would you|which|what|where|when|how|do you)\b/i.test(candidate)) {
    return true;
  }
  if (/before i (?:dive|start|proceed)|i have (?:a few|some) questions|need more context|could you clarify|share (?:more|the) details|tell me more/i.test(candidate)) {
    return true;
  }
  if (/before i can .*need to know|i need to know what feature|i need to know (?:what|which|where|when|how)|i'?ve asked the question/i.test(candidate)) {
    return true;
  }
  return false;
}

function extractBestQuestion(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return "";

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/\?$/.test(lines[index])) return lines[index];
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/\b(can you|could you|would you|which|what|where|when|how|do you)\b/i.test(lines[index])) {
      return lines[index];
    }
  }

  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    if (/\?$/.test(sentences[index])) return sentences[index];
  }

  return "";
}

function extractQuestionOptions(text) {
  const cleaned = String(text || "").replace(/\r/g, "").replace(/\\n/g, "\n").trim();
  if (!cleaned) return [];

  const rawLines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const options = [];
  for (const line of rawLines) {
    const bulletMatch = line.match(/^[-*•]\s+(.{2,180})$/);
    if (bulletMatch?.[1]) {
      options.push(bulletMatch[1].trim());
      continue;
    }

    const numberedMatch = line.match(/^(?:\d{1,2}[.)]|[A-Da-d][.)])\s+(.{2,180})$/);
    if (numberedMatch?.[1]) {
      options.push(numberedMatch[1].trim());
      continue;
    }

    const pipeMatch = line.match(/^\s*(?:option\s+)?[A-Da-d]\s*[:\-]\s*(.{2,180})$/i);
    if (pipeMatch?.[1]) {
      options.push(pipeMatch[1].trim());
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const option of options) {
    const normalized = String(option || "").toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalizeQuestionOption(option));
    if (deduped.length >= 6) break;
  }

  return deduped;
}

function extractQuestionFromSerializedPayload(text) {
  const candidate = String(text || "");
  if (!candidate) return "";
  const match = candidate.match(/"question"\s*:\s*"([^"]{3,260})"/i);
  if (!match?.[1]) return "";
  return unescapeJsonText(match[1]).slice(0, 220);
}

function extractQuestionHeaderFromSerializedPayload(text) {
  const candidate = String(text || "");
  if (!candidate) return "";
  const match = candidate.match(/"header"\s*:\s*"([^"]{1,120})"/i);
  if (!match?.[1]) return "";
  return unescapeJsonText(match[1]).slice(0, 120);
}

function extractQuestionOptionsFromSerializedPayload(text) {
  const candidate = String(text || "");
  if (!candidate) return [];
  const optionBlocks = [...candidate.matchAll(/"label"\s*:\s*"([^"]{1,180})"[\s\S]{0,220}?"description"\s*:\s*"([^"]{1,220})"/gi)];
  if (optionBlocks.length > 0) {
    return optionBlocks
      .slice(0, 6)
      .map((match) =>
        normalizeQuestionOption({
          label: unescapeJsonText(match[1]),
          description: unescapeJsonText(match[2])
        })
      )
      .filter(Boolean);
  }

  const labelMatches = [...candidate.matchAll(/"label"\s*:\s*"([^"]{1,180})"/gi)];
  if (!labelMatches.length) return [];

  const deduped = [];
  const seen = new Set();
  for (const match of labelMatches) {
    const value = unescapeJsonText(String(match[1] || "").trim());
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalizeQuestionOption(value));
    if (deduped.length >= 6) break;
  }

  return deduped;
}

function normalizeQuestionOption(option) {
  if (typeof option === "string") {
    const label = option.trim().slice(0, 140);
    return label ? { label } : null;
  }
  if (!option || typeof option !== "object") return null;
  const label = String(option.label || option.value || "").trim().slice(0, 140);
  const description = String(option.description || "").trim().slice(0, 220);
  const value = String(option.value || label || "").trim().slice(0, 140);
  if (!label) return null;
  return {
    label,
    description: description || undefined,
    value: value || undefined
  };
}

function unescapeJsonText(value) {
  const raw = String(value || "");
  return raw
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .trim();
}

function extractAskUserQuestionPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const candidates = [];

  if (payload.type === "assistant" && payload.message && typeof payload.message === "object") {
    const content = Array.isArray(payload.message.content) ? payload.message.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (String(item.type || "").trim().toLowerCase() !== "tool_use") continue;
      if (String(item.name || "").trim() !== "AskUserQuestion") continue;
      candidates.push(item.input || null);
    }
  }

  if (payload.type === "item.completed" && payload.item && typeof payload.item === "object") {
    const itemType = String(payload.item.type || "").trim().toLowerCase();
    if (itemType === "tool_use" && String(payload.item.name || "").trim() === "AskUserQuestion") {
      candidates.push(payload.item.input || null);
    }
  }

  if (payload.type === "response_item" && payload.payload && typeof payload.payload === "object") {
    const payloadType = String(payload.payload.type || "").trim().toLowerCase();
    if (payloadType === "tool_use" && String(payload.payload.name || "").trim() === "AskUserQuestion") {
      candidates.push(payload.payload.input || null);
    }
  }

  if (payload.type === "result" && Array.isArray(payload.permission_denials)) {
    for (const denial of payload.permission_denials) {
      if (!denial || typeof denial !== "object") continue;
      if (String(denial.tool_name || "").trim() !== "AskUserQuestion") continue;
      candidates.push(denial.tool_input || null);
    }
  }

  for (const input of candidates) {
    const parsed = parseAskUserQuestionInput(input);
    if (parsed) return parsed;
  }

  return null;
}

function parseAskUserQuestionInput(input) {
  if (!input || typeof input !== "object") return null;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length === 0) return null;

  const first = questions.find((item) => item && typeof item === "object") || null;
  if (!first) return null;

  const question = String(first.question || first.prompt || "").trim();
  if (!question) return null;
  const header = String(first.header || "").trim().slice(0, 120);

  const options = Array.isArray(first.options)
    ? first.options
        .map((option) => normalizeQuestionOption(option))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return {
    question: question.slice(0, 220),
    header: header || null,
    options,
    multiSelect: Boolean(first.multiSelect)
  };
}

function extractToolHintFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const type = String(payload.type || "").trim().toLowerCase();

  if (type === "item.completed" && payload.item && typeof payload.item === "object") {
    const itemType = String(payload.item.type || "").trim().toLowerCase();
    if (itemType.includes("tool") || itemType.includes("function") || itemType.includes("call")) {
      return formatToolHint(payload.item);
    }
  }

  if (type === "response_item" && payload.payload && typeof payload.payload === "object") {
    const itemType = String(payload.payload.type || "").trim().toLowerCase();
    if (itemType.includes("tool") || itemType.includes("function") || itemType.includes("call")) {
      return formatToolHint(payload.payload);
    }
  }

  if (type === "event_msg" && payload.payload && typeof payload.payload === "object") {
    const payloadType = String(payload.payload.type || "").trim().toLowerCase();
    if (payloadType.includes("tool") || payloadType.includes("function") || payloadType.includes("call")) {
      return formatToolHint(payload.payload);
    }
  }

  return "";
}

function formatToolHint(toolPayload) {
  if (!toolPayload || typeof toolPayload !== "object") return "";
  const toolName =
    String(toolPayload.name || toolPayload.tool_name || toolPayload.toolName || toolPayload.function?.name || "")
      .trim()
      .slice(0, 60);
  const summary = extractStructuredText(toolPayload.text || toolPayload.message || toolPayload.summary || "");
  if (toolName && summary) {
    return `${toolName}: ${summary.slice(0, 120)}`;
  }
  if (toolName) return toolName;
  return summary.slice(0, 120);
}

function extractToolNameFromHint(hint) {
  const value = String(hint || "").trim();
  if (!value) return "";
  const match = value.match(/^([^:]+):/);
  if (match?.[1]) return match[1].trim();
  return value.slice(0, 60);
}

function applyUsageFromRecord(record) {
  if (!record || typeof record !== "object") return;

  const promptTokens =
    safeInt(record.input_tokens, 0) +
    safeInt(record.cached_input_tokens, 0) +
    safeInt(record.cache_read_input_tokens, 0) +
    safeInt(record.cache_creation_input_tokens, 0);
  const completionTokens = safeInt(record.output_tokens, 0);

  if (promptTokens > 0) {
    usage.promptTokens = promptTokens;
  }
  if (completionTokens > 0) {
    usage.completionTokens = completionTokens;
  }
  if (promptTokens > 0 || completionTokens > 0) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
    if (usage.costUsd === 0 && usage.totalTokens > 0) {
      usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
    }
  }
}

function extractStructuredText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .flatMap((item) => {
        if (typeof item === "string") return [item.trim()];
        if (!item || typeof item !== "object") return [];
        if (typeof item.text === "string") return [item.text.trim()];
        if (typeof item.message === "string") return [item.message.trim()];
        if (typeof item.content === "string") return [item.content.trim()];
        return [];
      })
      .filter(Boolean);
    return parts.join("\n").trim();
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.message === "string") return value.message.trim();
    if (typeof value.content === "string") return value.content.trim();
  }

  return "";
}

function normalizeUuid(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
    return "";
  }
  return candidate;
}

function parseTokenSignals(line) {
  const promptMatch = line.match(/prompt[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const completionMatch = line.match(/completion[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const totalMatch = line.match(/total[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const costMatch = line.match(/cost(?:[_\s-]*usd)?\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  if (promptMatch) usage.promptTokens = safeInt(promptMatch[1], usage.promptTokens);
  if (completionMatch) usage.completionTokens = safeInt(completionMatch[1], usage.completionTokens);
  if (totalMatch) usage.totalTokens = safeInt(totalMatch[1], usage.totalTokens);
  if (costMatch) usage.costUsd = safeFloat(costMatch[1], usage.costUsd);

  if (!totalMatch && (promptMatch || completionMatch)) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
}

function consumeBuffer(buffer, onLine) {
  const lines = buffer.split(/\r?\n/);
  const trailing = lines.pop() ?? "";

  for (const line of lines) {
    onLine(line);
  }

  return trailing;
}

async function safePost(pathname, payload) {
  try {
    const response = await fetch(`${bridgeUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[agent-runner] bridge error ${response.status}: ${text}`);
    }
  } catch (error) {
    console.error(`[agent-runner] unable to reach bridge: ${String(error)}`);
  }
}

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

function detectBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "main";
  }
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printUsageAndExit(code) {
  console.log(`Usage:\n  node scripts/agent-runner.mjs [options] -- <command> [args...]\n\nOptions:\n  --agent CODEX|CLAUDE\n  --session <session-id>\n  --run <run-id>\n  --title <display-title>\n  --repo <repo-name>\n  --branch <branch-name>\n  --bridge <bridge-url>\n  --fullWorkspaceAccess\n  --skipPermissions\n  --planMode\n  --promptTokens <n>\n  --completionTokens <n>\n  --totalTokens <n>\n  --costUsd <n>\n`);
  process.exit(code);
}

function normalizeCommand(commandArgs, options = {}) {
  const fullWorkspaceAccess = Boolean(options.fullWorkspaceAccess);
  const skipPermissions = Boolean(options.skipPermissions);
  const planMode = Boolean(options.planMode);
  const persistentServerHint = String(options.persistentServerHint || "").trim();

  if (commandArgs[0] === "claude") {
    normalizeClaudeCommand(commandArgs, { fullWorkspaceAccess, skipPermissions, planMode, persistentServerHint });
    return;
  }

  if (commandArgs[0] !== "codex") return;
  if (commandArgs[1] === "run") {
    commandArgs[1] = "exec";
    console.log("[agent-runner] normalized `codex run ...` to `codex exec ...`");
  }

  const knownSubcommands = new Set([
    "exec",
    "review",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "app-server",
    "app",
    "completion",
    "sandbox",
    "debug",
    "apply",
    "resume",
    "fork",
    "cloud",
    "features",
    "help"
  ]);

  if (commandArgs[1] && !commandArgs[1].startsWith("-") && !knownSubcommands.has(commandArgs[1])) {
    const prompt = commandArgs.slice(1);
    commandArgs.splice(1, commandArgs.length - 1, "exec", ...prompt);
    console.log("[agent-runner] normalized `codex <prompt>` to `codex exec <prompt>`");
  } else if (!commandArgs[1]) {
    commandArgs.push("exec");
    console.log("[agent-runner] normalized bare `codex` to `codex exec`");
  }

  if (commandArgs[1] !== "exec") {
    return;
  }

  if (!commandArgs.includes("--skip-git-repo-check")) {
    commandArgs.splice(2, 0, "--skip-git-repo-check");
    console.log("[agent-runner] added `--skip-git-repo-check` for Codex CLI");
  }

  if (!commandArgs.includes("--json")) {
    commandArgs.splice(2, 0, "--json");
    console.log("[agent-runner] enabled `--json` for Codex session tracking");
  }

  if (
    planMode &&
    !fullWorkspaceAccess &&
    !commandArgs.includes("--sandbox") &&
    !commandArgs.includes("--dangerously-bypass-approvals-and-sandbox")
  ) {
    commandArgs.splice(2, 0, "--sandbox", "read-only");
    console.log("[agent-runner] enabled Codex plan mode (`--sandbox read-only`)");
  }

  if (fullWorkspaceAccess || skipPermissions) {
    removeFlagWithValue(commandArgs, "--sandbox", "-s");
    removeFlagWithValue(commandArgs, "--ask-for-approval", "-a");

    if (!commandArgs.includes("--sandbox")) {
      commandArgs.splice(2, 0, "--sandbox", "danger-full-access");
    }
    if (
      !commandArgs.includes("--dangerously-bypass-approvals-and-sandbox") &&
      !commandArgs.includes("--yolo")
    ) {
      commandArgs.splice(2, 0, "--dangerously-bypass-approvals-and-sandbox");
    }

    if (fullWorkspaceAccess) {
      console.log(
        "[agent-runner] enabled Codex full access (`--sandbox danger-full-access` + dangerous bypass)"
      );
    } else {
      console.log(
        "[agent-runner] enabled Codex permission bypass (`--sandbox danger-full-access` + dangerous bypass)"
      );
    }
  }

  if (persistentServerHint) {
    const promptIndex = findCodexPromptIndex(commandArgs);
    if (promptIndex >= 0) {
      commandArgs[promptIndex] = appendPromptHint(commandArgs[promptIndex], persistentServerHint);
      console.log("[agent-runner] appended managed-server runtime hint to Codex prompt");
    }
  }
}

function normalizeClaudeCommand(commandArgs, options = {}) {
  // `claude code <prompt>` fails in print/non-interactive mode.
  // Convert to the supported one-shot form `claude -p <prompt>`.
  if (commandArgs[1] === "code") {
    const promptParts = commandArgs.slice(2).filter((part) => part !== "--");
    const prompt = promptParts.join(" ").trim();
    if (prompt) {
      commandArgs.splice(1, commandArgs.length - 1, "-p", prompt);
      console.log("[agent-runner] normalized `claude code <prompt>` to `claude -p <prompt>`");
    }
  }

  if ((options.fullWorkspaceAccess || options.skipPermissions) && !commandArgs.includes("--dangerously-skip-permissions")) {
    commandArgs.splice(1, 0, "--dangerously-skip-permissions");
    console.log("[agent-runner] enabled dangerous permission bypass for Claude");
  }

  if (
    options.planMode &&
    !options.fullWorkspaceAccess &&
    !options.skipPermissions &&
    !commandArgs.includes("--permission-mode")
  ) {
    commandArgs.splice(1, 0, "--permission-mode", "plan");
    console.log("[agent-runner] enabled Claude plan mode (`--permission-mode plan`)");
  }

  const usesPrintMode = commandArgs.includes("-p") || commandArgs.includes("--print");
  if (usesPrintMode) {
    if (!commandArgs.includes("--verbose")) {
      commandArgs.splice(1, 0, "--verbose");
      console.log("[agent-runner] enabled `--verbose` for Claude stream-json output");
    }

    const outputFormatIndex = commandArgs.findIndex((part) => part === "--output-format");
    if (outputFormatIndex >= 0) {
      const current = String(commandArgs[outputFormatIndex + 1] || "").trim().toLowerCase();
      if (current !== "stream-json") {
        if (outputFormatIndex + 1 < commandArgs.length && !String(commandArgs[outputFormatIndex + 1]).startsWith("-")) {
          commandArgs[outputFormatIndex + 1] = "stream-json";
        } else {
          commandArgs.splice(outputFormatIndex + 1, 0, "stream-json");
        }
        console.log("[agent-runner] forced Claude output to `--output-format stream-json` for session tracking");
      }
    } else {
      commandArgs.splice(1, 0, "--output-format", "stream-json");
      console.log("[agent-runner] enabled `--output-format stream-json` for Claude session tracking");
    }
  }

  const persistentServerHint = String(options.persistentServerHint || "").trim();
  if (persistentServerHint) {
    const promptIndex = findClaudePromptIndex(commandArgs);
    if (promptIndex >= 0) {
      commandArgs[promptIndex] = appendPromptHint(commandArgs[promptIndex], persistentServerHint);
      console.log("[agent-runner] appended managed-server runtime hint to Claude prompt");
    }
  }
}

function findCodexPromptIndex(commandArgs) {
  if (!Array.isArray(commandArgs) || commandArgs[0] !== "codex" || commandArgs[1] !== "exec") {
    return -1;
  }

  const resumeIndex = commandArgs.findIndex((part, index) => index >= 2 && part === "resume");
  if (resumeIndex >= 0) {
    const promptIndex = resumeIndex + 2;
    if (promptIndex < commandArgs.length) {
      return promptIndex;
    }
    return -1;
  }

  for (let index = commandArgs.length - 1; index >= 2; index -= 1) {
    const token = String(commandArgs[index] || "");
    if (!token) continue;
    if (token.startsWith("-")) continue;
    return index;
  }

  return -1;
}

function findClaudePromptIndex(commandArgs) {
  if (!Array.isArray(commandArgs) || commandArgs[0] !== "claude") return -1;
  for (let index = 0; index < commandArgs.length; index += 1) {
    if (commandArgs[index] === "-p" || commandArgs[index] === "--print") {
      if (index + 1 < commandArgs.length) {
        return index + 1;
      }
      return -1;
    }
  }
  return -1;
}

function appendPromptHint(prompt, hint) {
  const cleanedPrompt = String(prompt || "").trim();
  if (!cleanedPrompt) return cleanedPrompt;

  const marker = "AGENT_COMPANION_PERSIST_SERVER_HINT_V1";
  if (cleanedPrompt.includes(marker)) {
    return cleanedPrompt;
  }

  return `${cleanedPrompt}\n\n${hint}`;
}

function buildPersistentServerHint(input = {}) {
  const helperScriptPath = String(input.helperScriptPath || "").trim();
  const bridgeUrl = String(input.bridgeUrl || "http://localhost:8787").trim();
  const workspacePath = String(input.workspacePath || "").trim();
  const sessionId = String(input.sessionId || "").trim();
  if (!helperScriptPath) return "";

  const escapedHelper = helperScriptPath.replace(/"/g, '\\"');
  const escapedBridge = bridgeUrl.replace(/"/g, '\\"');
  const escapedWorkspace = workspacePath.replace(/"/g, '\\"');
  const escapedSession = sessionId.replace(/"/g, '\\"');

  return (
    "AGENT_COMPANION_PERSIST_SERVER_HINT_V1:\n" +
    "If you need a localhost server to stay alive after this response, do NOT use nohup/setsid/&.\n" +
    `Use this exact pattern:\nnode "${escapedHelper}" --bridge "${escapedBridge}" --workspace "${escapedWorkspace}" --session "${escapedSession}" --label "dev-server" --port <PORT> -- <server command>\n` +
    "Then continue with normal progress updates."
  );
}

function removeFlagWithValue(args, longFlag, shortFlag) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token !== longFlag && token !== shortFlag) continue;

    args.splice(index, 1);
    if (index < args.length && !String(args[index] || "").startsWith("-")) {
      args.splice(index, 1);
    }
    index -= 1;
  }
}

function upsertThreadInCodexGlobalState(threadId, sessionTitle) {
  if (!threadId) return;

  try {
    if (!fs.existsSync(CODEX_GLOBAL_STATE_FILE)) return;

    const raw = fs.readFileSync(CODEX_GLOBAL_STATE_FILE, "utf8");
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    const current = parsed["thread-titles"];
    const titles =
      current && typeof current === "object" && current.titles && typeof current.titles === "object"
        ? { ...current.titles }
        : {};
    const order =
      current && typeof current === "object" && Array.isArray(current.order)
        ? current.order.filter((item) => typeof item === "string")
        : [];

    const cleanedTitle = String(sessionTitle || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const fallbackTitle = `Phone task ${threadId.slice(0, 8)}`;
    titles[threadId] = cleanedTitle || titles[threadId] || fallbackTitle;

    const nextOrder = [threadId, ...order.filter((id) => id !== threadId)].slice(0, 600);
    parsed["thread-titles"] = {
      ...(current && typeof current === "object" ? current : {}),
      titles,
      order: nextOrder
    };

    atomicWriteText(CODEX_GLOBAL_STATE_FILE, JSON.stringify(parsed));
    console.log(`[agent-runner] indexed thread in Codex resume list: ${threadId}`);
  } catch (error) {
    console.error(`[agent-runner] unable to update Codex global state: ${String(error)}`);
  }
}

async function promoteExecRolloutToCliWithRetry(threadId, options = {}) {
  const attempts = Math.max(1, safeInt(options.attempts, 8));
  const delayMs = Math.max(10, safeInt(options.delayMs, 250));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const promoted = promoteExecRolloutToCli(threadId, { silentMissing: attempt < attempts });
    if (promoted) return true;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  console.log(`[agent-runner] rollout metadata unchanged for ${threadId} after ${attempts} attempts`);
  return false;
}

function promoteExecRolloutToCli(threadId, options = {}) {
  if (!threadId) return false;
  const silentMissing = Boolean(options.silentMissing);

  try {
    const rolloutPath = findRolloutFileByThreadId(threadId);
    if (!rolloutPath) {
      if (!silentMissing) {
        console.log(`[agent-runner] rollout file not found yet for ${threadId} (resume picker metadata unchanged)`);
      }
      return false;
    }

    const raw = fs.readFileSync(rolloutPath, "utf8");
    if (!raw.trim()) return false;

    const newlineIndex = raw.indexOf("\n");
    const firstLine = newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
    const rest = newlineIndex >= 0 ? raw.slice(newlineIndex) : "";
    if (!firstLine.trim()) return false;

    let meta = null;
    try {
      meta = JSON.parse(firstLine);
    } catch {
      console.error(`[agent-runner] unable to parse rollout metadata line for ${threadId}`);
      return false;
    }

    if (!meta || typeof meta !== "object") {
      return false;
    }

    const topLevelThreadId = typeof meta.thread_id === "string" ? meta.thread_id : "";
    const payloadThreadId =
      meta.payload && typeof meta.payload === "object" && typeof meta.payload.id === "string"
        ? meta.payload.id
        : "";
    const discoveredThreadId = topLevelThreadId || payloadThreadId;
    if (discoveredThreadId && discoveredThreadId !== threadId) {
      return false;
    }

    let changed = false;

    const candidates = [meta];
    if (meta.payload && typeof meta.payload === "object") {
      candidates.push(meta.payload);
    }

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

    if (!changed) {
      return true;
    }

    const patchedLine = JSON.stringify(meta);
    atomicWriteText(rolloutPath, `${patchedLine}${rest}`);
    console.log(`[agent-runner] promoted session metadata for resume picker: ${threadId}`);
    return true;
  } catch (error) {
    console.error(`[agent-runner] unable to promote rollout metadata: ${String(error)}`);
    return false;
  }
}

function findRolloutFileByThreadId(threadId) {
  const candidates = candidateSessionDayDirs(8);
  const suffix = `${threadId}.jsonl`;

  for (const dayDir of candidates) {
    let files = [];
    try {
      files = fs.readdirSync(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.startsWith("rollout-")) continue;
      if (!file.name.endsWith(suffix)) continue;
      return path.join(dayDir, file.name);
    }
  }

  return "";
}

function candidateSessionDayDirs(daysBack) {
  const dirs = [];
  const seen = new Set();
  const now = new Date();

  for (let offset = 0; offset <= daysBack; offset += 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dir = path.join(CODEX_SESSIONS_ROOT, year, month, day);
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }

  return dirs;
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

function parseBooleanEnv(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
