import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTempDir } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { assertWorkspaceRoot } from "./workspace.mjs";

const AUTH_FILE = path.join(os.homedir(), ".grok", "auth.json");
const DEFAULT_GROK_BIN_DIR = path.join(os.homedir(), ".grok", "bin");
export const DEFAULT_CONTINUE_PROMPT = "Continue from where you left off.";
export const DEFAULT_MAX_TURNS = 50;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function defaultGrokBinaryCandidates() {
  const binaryName = process.platform === "win32" ? "grok.exe" : "grok";
  return [
    process.env.GROK_BIN,
    process.env.GROK_BIN_DIR ? path.join(process.env.GROK_BIN_DIR, binaryName) : null,
    path.join(DEFAULT_GROK_BIN_DIR, binaryName)
  ].filter(Boolean);
}

export function resolveGrokCommand() {
  for (const candidate of defaultGrokBinaryCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "grok";
}

export function getGrokInstallDir() {
  const command = resolveGrokCommand();
  if (command !== "grok") {
    return path.dirname(command);
  }
  return DEFAULT_GROK_BIN_DIR;
}

export function getGrokAvailability() {
  const command = resolveGrokCommand();
  const availability = binaryAvailable(command, ["--version"]);
  return {
    ...availability,
    command,
    installDir: getGrokInstallDir()
  };
}

export function getGrokAuthStatus() {
  const result = runCommand(resolveGrokCommand(), ["models"]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status === 0 && /logged in/i.test(output)) {
    return { authenticated: true, detail: output.split("\n")[0] };
  }
  if (fs.existsSync(AUTH_FILE)) {
    return { authenticated: true, detail: "Credentials found in ~/.grok/auth.json" };
  }
  return {
    authenticated: false,
    detail: output || "Not logged in. Run `grok login` or `/grok:setup`."
  };
}

export function getSessionRuntimeStatus() {
  const availability = getGrokAvailability();
  const auth = getGrokAuthStatus();
  const ready = availability.available && auth.authenticated;
  return {
    ready,
    label: ready ? "ready" : availability.available ? "needs authentication" : "grok not installed"
  };
}

export function normalizeEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported effort "${effort}". Use one of: low, medium, high, xhigh, max.`);
  }
  return normalized;
}

// Effort support varies by MODEL, not just CLI version (grok-4.6 accepts
// xhigh but not max; grok-4.5 accepts neither), and the CLI reports an
// unsupported level with EXIT 0 and the error as its only output — which
// would otherwise record as a completed run whose "answer" is the error
// string (FINDINGS.md GROK-005). These helpers detect that error and pick
// the closest supported downgrade from the CLI's own authoritative list.
const EFFORT_RANKING = ["max", "xhigh", "high", "medium", "low"];
const EFFORT_ERROR_RE =
  /--effort\/--reasoning-effort: unknown effort level '([^']+)'; use one of: ([a-z,\s]+)/;

export function parseEffortError(result) {
  const candidates = [
    result?.parsed && result.parsed.type === "error" ? result.parsed.message : null,
    result?.finalMessage
  ];
  for (const candidate of candidates) {
    const match = typeof candidate === "string" ? candidate.match(EFFORT_ERROR_RE) : null;
    if (match) {
      return {
        requested: match[1],
        supported: match[2]
          .split(",")
          .map((level) => level.trim())
          .filter(Boolean)
      };
    }
  }
  return null;
}

export function pickSupportedEffort(requested, supported) {
  const start = EFFORT_RANKING.indexOf(requested);
  for (const level of EFFORT_RANKING.slice(start >= 0 ? start : 0)) {
    if (supported.includes(level)) {
      return level;
    }
  }
  return supported[0] ?? null;
}

// Completion-sentinel support for delegated tasks. Grok drops tool calls on
// complex briefs — it emits a planning message with no tool call, and the
// CLI's headless mode treats any no-tool-call assistant message as the final
// answer and exits 0 (FINDINGS.md GROK-006; spans grok-4.5 and grok-4.6).
// When a caller declares the brief's completion sentinel, a "completed" run
// whose output lacks it is not a completion: the session is resumed (the
// thread survives) up to SENTINEL_MAX_RESUMES times, then failed loud.
export const SENTINEL_MAX_RESUMES = 2;

// Line-anchored on purpose: the harness convention is a sentinel on its own
// line, so a substring hit inside prose does not count.
export function outputHasSentinel(text, sentinel) {
  if (!sentinel) {
    return true;
  }
  return String(text ?? "")
    .split(/\r?\n/)
    .some((line) => line.trim() === sentinel);
}

export function buildSentinelResumePrompt(sentinel) {
  return [
    "Your previous reply ended without the required completion sentinel, so the task is not finished.",
    "Continue the task from where you left off.",
    "Every message before the final answer must contain a tool call — never stop on a planning or narration message.",
    `When the task is genuinely complete, end your final message with "${sentinel}" on its own line.`
  ].join(" ");
}

export function parseGrokJsonOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    throw new Error("Grok returned empty output.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Failed to parse Grok JSON output.");
  }
}

export function preparePromptFile(prompt) {
  const tempDir = createTempDir("grok-prompt-");
  const promptFile = path.join(tempDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");
  return {
    promptFile,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

export function buildGrokArgs(cwd, options = {}) {
  const args = [];

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  }

  args.push("--output-format", "json", "--cwd", cwd, "--max-turns", String(options.maxTurns ?? DEFAULT_MAX_TURNS));

  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.reasoningEffort) {
    args.push("--reasoning-effort", options.reasoningEffort);
  }

  if (options.write) {
    args.push("--always-approve");
  } else {
    args.push("--permission-mode", "plan");
    args.push("--sandbox", "read-only");
  }

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    args.push("-c");
  }

  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }

  return args;
}

// Map a raw Grok CLI invocation (`--output-format json`) into the result shape
// the companion consumes. Grok returns `{ text, sessionId, stopReason }`; the
// answer lives in `text`. Kept as a pure, exported function so the schema
// contract is locked by tests — a future CLI field rename that silently routes
// the answer to the stderr fallback would then break a test instead of prod.
export function interpretGrokResult({ stdout = "", stderr = "", status = 1 } = {}) {
  let parsed = null;
  let text = "";
  let sessionId = null;
  let stopReason = null;

  if (String(stdout).trim()) {
    try {
      parsed = parseGrokJsonOutput(stdout);
      text = parsed.text ?? "";
      sessionId = parsed.sessionId ?? null;
      stopReason = parsed.stopReason ?? null;
    } catch {
      text = String(stdout).trim();
    }
  }

  const cleanStderr = String(stderr || "").trim();
  const exitStatus = status ?? 1;

  return {
    status: exitStatus,
    stdout,
    stderr: cleanStderr,
    finalMessage: text || cleanStderr,
    sessionId,
    stopReason,
    parsed,
    failureMessage:
      exitStatus === 0 ? "" : cleanStderr || text || `Grok exited with status ${exitStatus}.`
  };
}

export function runGrokTurn(cwd, options = {}) {
  assertWorkspaceRoot(cwd);

  let promptFile = options.promptFile ?? null;
  let cleanupPrompt = null;

  if (!promptFile && options.prompt) {
    const prepared = preparePromptFile(options.prompt);
    promptFile = prepared.promptFile;
    cleanupPrompt = prepared.cleanup;
  }

  const args = buildGrokArgs(cwd, { ...options, promptFile });
  options.onProgress?.({ message: "Starting Grok...", phase: "starting" });

  try {
    const result = runCommand(resolveGrokCommand(), args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024
    });

    if (result.error) {
      throw result.error;
    }

    let interpreted = interpretGrokResult({
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status
    });

    // Unsupported-effort runs exit 0 with the error as their only output
    // (FINDINGS.md GROK-005). Retry once at the closest level the CLI itself
    // says is supported; if the error persists anyway, force a failure so it
    // can never record as a completed run.
    const effortError = parseEffortError(interpreted);
    if (effortError && options.effort && !options._effortRetried) {
      const fallback = pickSupportedEffort(effortError.requested, effortError.supported);
      if (fallback && fallback !== effortError.requested) {
        options.onProgress?.({
          message: `Effort "${effortError.requested}" is not supported by this model (CLI offers: ${effortError.supported.join(", ")}); retrying at "${fallback}".`
        });
        return runGrokTurn(cwd, {
          ...options,
          promptFile,
          effort: fallback,
          _effortRetried: true
        });
      }
    }
    if (interpreted.status === 0 && parseEffortError(interpreted)) {
      interpreted = {
        ...interpreted,
        status: 1,
        failureMessage:
          interpreted.finalMessage || "Grok rejected the requested effort level."
      };
    }

    options.onProgress?.({
      message:
        interpreted.status === 0 ? "Grok finished." : `Grok failed with exit ${interpreted.status}.`,
      phase: interpreted.status === 0 ? "done" : "failed",
      sessionId: interpreted.sessionId
    });

    return interpreted;
  } finally {
    cleanupPrompt?.();
  }
}

export function findLatestTaskSessionId(workspaceRoot, jobs) {
  const taskJobs = jobs
    .filter((job) => job.jobClass === "task" && job.threadId)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  return taskJobs[0]?.threadId ?? null;
}
