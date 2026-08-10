#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskSessionId,
  getGrokAuthStatus,
  getGrokAvailability,
  getSessionRuntimeStatus,
  normalizeEffort,
  runGrokTurn
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  findLatestResumableTaskJob,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderEffortReport,
  renderModelReport,
  renderQueuedTaskLaunch,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderWebReport
} from "./lib/render.mjs";
import {
  buildModelSnapshot,
  PLUGIN_MODEL_CONFIG_KEY,
  resolvePluginModel,
  validateModelSelection,
  isModelClearValue,
  listGrokModels
} from "./lib/model.mjs";
import {
  PLUGIN_DISABLE_WEB_SEARCH_KEY,
  buildWebSnapshot,
  normalizeWebSetting,
  resolveDisableWebSearch
} from "./lib/web.mjs";
import {
  PLUGIN_EFFORT_KEY,
  buildEffortSnapshot,
  normalizeEffortSetting,
  resolvePluginEffort
} from "./lib/effort.mjs";
import { generateJobId, listJobs, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { assertWorkspaceRoot, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--json]",
      "  node scripts/grok-companion.mjs review [--wait|--background] [--disable-web-search|--no-web|--web] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/grok-companion.mjs task [--background] [--write] [--disable-web-search|--no-web|--web] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/grok-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]",
      "  node scripts/grok-companion.mjs model [--set <model>] [--json]",
      "  node scripts/grok-companion.mjs web [--set on|off] [--json]",
      "  node scripts/grok-companion.mjs effort [--set <low|medium|high|xhigh|max|none>] [--json]",
      "  node scripts/grok-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line || fallback;
}

function shorten(text, max = 120) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function ensureGrokAvailable() {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not installed. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash` or run `/grok:setup`."
    );
  }
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

async function buildSetupReport(workspaceRoot, actionsTaken = []) {
  const node = binaryAvailable("node", ["--version"]);
  const grok = getGrokAvailability();
  const auth = getGrokAuthStatus();
  const sessionRuntime = getSessionRuntimeStatus();
  const model = buildModelSnapshot(workspaceRoot);
  const web = buildWebSnapshot(workspaceRoot);
  const effort = buildEffortSnapshot(workspaceRoot);
  return {
    ready: grok.available && auth.authenticated,
    node,
    grok,
    auth,
    sessionRuntime,
    workspace: { model, web, effort },
    actionsTaken
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const report = await buildSetupReport(workspaceRoot);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function buildReviewPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    BRANCH: context.branch,
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      "`/grok:review` does not support custom focus text. Use `/grok:delegate` with review instructions instead."
    );
  }
  if (target.mode === "working-tree" || target.mode === "branch") {
    return;
  }
  throw new Error("Unsupported review target.");
}

async function executeReviewRun(request) {
  const cwd = request.cwd;
  ensureGrokAvailable();
  const target = resolveReviewTarget(cwd, {
    base: request.base,
    scope: request.scope
  });
  validateNativeReviewRequest(target, request.focusText ?? "");
  const context = collectReviewContext(cwd, target);
  const prompt = buildReviewPrompt(context);
  const result = runGrokTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    write: false,
    disableWebSearch: Boolean(request.disableWebSearch),
    onProgress: request.onProgress
  });

  const payload = {
    review: "Review",
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      sessionId: result.sessionId
    },
    rawOutput: result.finalMessage
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload,
    rendered: renderReviewResult(result, { targetLabel: context.target.label }),
    summary: firstMeaningfulLine(result.finalMessage, "Grok review finished."),
    jobTitle: "Grok Review",
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable();

  let resumeSessionId = null;
  if (request.resumeLast) {
    resumeSessionId = findLatestTaskSessionId(workspaceRoot, listJobs(workspaceRoot));
    if (!resumeSessionId) {
      throw new Error("No previous Grok task session was found for this repository.");
    }
  }

  const prompt = request.prompt || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "");
  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = runGrokTurn(workspaceRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    write: Boolean(request.write),
    disableWebSearch: Boolean(request.disableWebSearch),
    resumeSessionId,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage;
  const rendered = renderTaskResult({
    rawOutput,
    failureMessage: result.failureMessage
  });
  const payload = {
    status: result.status,
    sessionId: result.sessionId,
    rawOutput,
    stopReason: result.stopReason
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(result.failureMessage, "Grok task finished.")),
    jobTitle: request.resumeLast ? "Grok Resume" : "Grok Task",
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Grok Resume" : "Grok Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function getJobKindLabel(kind, jobClass) {
  return jobClass === "review" ? "review" : "delegate";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function resolveDisableWebSearchOption(workspaceRoot, options) {
  return resolveDisableWebSearch(workspaceRoot, options);
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, disableWebSearch, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    disableWebSearch,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  // Progress goes to the job log file (surfaced by /grok:status), not stderr:
  // a foreground run blocks until completion, so stderr "[grok] ..." lines are
  // never seen live and only merge into the stdout the delegate forwarder
  // returns verbatim, corrupting Grok's answer.
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: false
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  assertWorkspaceRoot(cwd);
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Persist the queued record BEFORE spawning the detached worker: the
  // worker is detached and can start running immediately, and if it ever
  // won a race against this write it would find no stored job
  // (handleTaskWorker) and exit with stdio ignored, i.e. silently. Writing
  // first (writeJobFile/upsertJob use synchronous fs calls) closes that
  // window before spawnDetachedTaskWorker is even called.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  // Safe to rewrite the whole job FILE from here: both a synchronous throw
  // out of spawnDetachedTaskWorker (e.g. its internal assertWorkspaceRoot
  // firing on a cwd that vanished between handleTask's gate and this spawn
  // -- a real TOCTOU in worktree-teardown workflows) and the async child
  // "error" event below can only occur when the worker process itself
  // never started, so there is no worker-side write in flight or already
  // persisted for this rewrite to clobber.
  const markLaunchFailed = (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    appendLogLine(logFile, `Background worker failed to start: ${errorMessage}`);
    const completedAt = nowIso();
    const failedRecord = {
      ...queuedRecord,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
  };

  try {
    const child = spawnDetachedTaskWorker(cwd, job.id);

    // The parent does not exit before a queued spawn error can fire: Node
    // always emits "error" asynchronously (never synchronously from spawn()
    // itself), and child.unref() only excludes the child from keeping the
    // event loop alive -- it does not detach listeners already attached to
    // it. If the worker never starts, this is what marks the job failed
    // instead of leaving it queued forever.
    child.on("error", markLaunchFailed);
  } catch (error) {
    // A synchronous throw here (e.g. assertWorkspaceRoot inside
    // spawnDetachedTaskWorker) happens after the queued record above was
    // already persisted. Mark it failed instead of leaving an orphaned
    // "queued" record with no failure marker, then rethrow so the CLI still
    // exits nonzero with the clear message via main()'s catch.
    markLaunchFailed(error);
    throw error;
  }

  // The parent deliberately writes nothing after a successful spawn: a
  // post-spawn upsertJob here would be an unlocked whole-state
  // read-modify-write racing the worker's own index update. The worker's
  // first runTrackedJob write stamps status "running" and pid
  // process.pid into both the job file and the state index; until that
  // happens the index honestly shows "queued" with pid null -- a pid is
  // process evidence, and the parent has none to offer yet.
  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait", "disable-web-search", "no-web", "web", "enable-web-search"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const explicitModel = options.model ? String(options.model).trim() : null;
  const model = resolvePluginModel(workspaceRoot, explicitModel);
  const effort = resolvePluginEffort(workspaceRoot, options.effort);
  const disableWebSearch = resolveDisableWebSearchOption(workspaceRoot, options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  validateNativeReviewRequest(target, focusText);

  const job = createCompanionJob({
    prefix: "review",
    kind: "review",
    title: "Grok Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${target.label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        disableWebSearch,
        focusText,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
      "disable-web-search",
      "no-web",
      "web",
      "enable-web-search"
    ],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  assertWorkspaceRoot(cwd);
  const workspaceRoot = resolveCommandWorkspace(options);
  const explicitModel = options.model ? String(options.model).trim() : null;
  const model = resolvePluginModel(workspaceRoot, explicitModel);
  const effort = resolvePluginEffort(workspaceRoot, options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const disableWebSearch = resolveDisableWebSearchOption(workspaceRoot, options);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    ensureGrokAvailable();
    requireTaskRequest(prompt, resumeLast);
    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      disableWebSearch,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        disableWebSearch,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );

  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...request, onProgress: progress }),
    { logFile }
  );
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };
  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function handleWeb(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const requestedSetting = options.set ?? (positionals.join(" ").trim() || null);

  if (requestedSetting) {
    const disableWebSearch = normalizeWebSetting(requestedSetting);
    setConfig(workspaceRoot, PLUGIN_DISABLE_WEB_SEARCH_KEY, disableWebSearch);
    const snapshot = buildWebSnapshot(workspaceRoot);
    const payload = {
      action: "set",
      changed: true,
      ...snapshot
    };
    outputCommandResult(payload, renderWebReport(payload), options.json);
    return;
  }

  const snapshot = buildWebSnapshot(workspaceRoot);
  const payload = {
    action: "show",
    changed: false,
    ...snapshot
  };
  outputCommandResult(payload, renderWebReport(payload), options.json);
}

function handleEffort(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const requested = options.set ?? (positionals.join(" ").trim() || null);

  if (requested) {
    if (requested.startsWith("-")) {
      // unknown flag, show current
      const snapshot = buildEffortSnapshot(workspaceRoot);
      const payload = {
        action: "show",
        changed: false,
        ...snapshot
      };
      outputCommandResult(payload, renderEffortReport(payload), options.json);
      return;
    }
    const effortValue = normalizeEffortSetting(requested);
    setConfig(workspaceRoot, PLUGIN_EFFORT_KEY, effortValue);
    const snapshot = buildEffortSnapshot(workspaceRoot);
    const payload = {
      action: "set",
      changed: true,
      ...snapshot
    };
    outputCommandResult(payload, renderEffortReport(payload), options.json);
    return;
  }

  const snapshot = buildEffortSnapshot(workspaceRoot);
  const payload = {
    action: "show",
    changed: false,
    ...snapshot
  };
  outputCommandResult(payload, renderEffortReport(payload), options.json);
}

function handleModel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "cwd"],
    booleanOptions: ["json", "refresh"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const refresh = Boolean(options.refresh);

  if (refresh) {
    ensureGrokAvailable();
  }

  const availability = listGrokModels({ refresh });
  const requestedModel = options.set ?? (positionals.join(" ").trim() || null);

  if (requestedModel && isModelClearValue(requestedModel)) {
    setConfig(workspaceRoot, PLUGIN_MODEL_CONFIG_KEY, "");
    const snapshot = buildModelSnapshot(workspaceRoot, { models: availability });
    const payload = {
      action: "clear",
      changed: true,
      ...snapshot
    };
    outputCommandResult(payload, renderModelReport(payload), options.json);
    return;
  }

  if (requestedModel) {
    const selectedModel = validateModelSelection(requestedModel, availability.models);
    setConfig(workspaceRoot, PLUGIN_MODEL_CONFIG_KEY, selectedModel);
    const snapshot = buildModelSnapshot(workspaceRoot, { models: availability });
    const payload = {
      action: "set",
      changed: true,
      ...snapshot
    };
    outputCommandResult(payload, renderModelReport(payload), options.json);
    return;
  }

  const snapshot = buildModelSnapshot(workspaceRoot, { models: availability });
  const payload = {
    action: "show",
    changed: false,
    ...snapshot
  };
  outputCommandResult(payload, renderModelReport(payload), options.json);
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "model":
      handleModel(argv);
      break;
    case "web":
      handleWeb(argv);
      break;
    case "effort":
      handleEffort(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});