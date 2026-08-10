#!/usr/bin/env node

// SessionStart hook: stamps the current Claude Code session id into the
// environment as GROK_COMPANION_SESSION_ID so that grok-companion jobs are
// scoped to the session that created them. Without this, /grok:status,
// /grok:result (no id), /grok:cancel (no id), and task-resume-candidate fall
// back to workspace-wide scoping and can surface another session's job.
//
// The value is appended to $CLAUDE_ENV_FILE, which Claude Code sources for the
// main session and every subagent Bash call, so the id is stable across the
// delegate subagent boundary.
//
// The plugin-data path is re-exported under the fork-specific name
// GROK_PLUGIN_DATA (instead of the generic CLAUDE_PLUGIN_DATA) so that other
// companion-family plugins sharing this codebase stop overwriting each
// other's state root in the shared env file.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FORK_PLUGIN_DATA_ENV = "GROK_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

export function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(FORK_PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
