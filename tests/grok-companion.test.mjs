import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../plugins/grok/scripts/lib/args.mjs";
import { normalizeEffort } from "../plugins/grok/scripts/lib/grok.mjs";
import { renderSetupReport } from "../plugins/grok/scripts/lib/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");

test("parseArgs handles value and boolean flags", () => {
  const parsed = parseArgs(["task", "--background", "--model", "grok-build", "fix", "tests"], {
    valueOptions: ["model"],
    booleanOptions: ["background"]
  });

  assert.equal(parsed.options.background, true);
  assert.equal(parsed.options.model, "grok-build");
  assert.deepEqual(parsed.positionals, ["task", "fix", "tests"]);
});

test("normalizeEffort accepts supported values", () => {
  assert.equal(normalizeEffort("high"), "high");
  assert.throws(() => normalizeEffort("turbo"));
});

test("renderSetupReport mentions install guidance when grok is missing", () => {
  const rendered = renderSetupReport({
    ready: false,
    node: { available: true, detail: "v22.0.0" },
    grok: { available: false, detail: "not found" },
    auth: { authenticated: false, detail: "not logged in" },
    sessionRuntime: { ready: false, label: "grok not installed" },
    actionsTaken: []
  });

  assert.match(rendered, /Install Grok CLI/);
  assert.match(rendered, /needs attention/);
});

test("renderSetupReport shows workspace settings when present", () => {
  const rendered = renderSetupReport({
    ready: true,
    node: { available: true, detail: "v22.0.0" },
    grok: { available: true, detail: "grok 1.0" },
    auth: { authenticated: true, detail: "logged in" },
    sessionRuntime: { ready: true, label: "ready" },
    workspace: {
      model: {
        selectedModel: "grok-composer-2.5-fast",
        selectedLabel: "Composer 2.5 Fast"
      },
      web: {
        label: "disabled by default"
      }
    },
    actionsTaken: []
  });

  assert.match(rendered, /Workspace settings/);
  assert.match(rendered, /Composer 2.5 Fast/);
  assert.match(rendered, /disabled by default/);
  assert.match(rendered, /--no-subagents/);
});

test("grok-companion setup exits successfully", () => {
  const result = spawnSync(process.execPath, [COMPANION, "setup"], {
    cwd: ROOT,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Grok Setup/);
});

test("grok-companion task --background with a nonexistent cwd fails loud and writes no state", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bg-data-"));
  const missingCwd = path.join(os.tmpdir(), `grok-bg-missing-cwd-${process.pid}-${Date.now()}`);

  try {
    const env = { ...process.env, GROK_PLUGIN_DATA: dataDir };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(
      process.execPath,
      [COMPANION, "task", "--background", "--cwd", missingCwd, "probe"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env
      }
    );

    assert.notEqual(result.status, 0);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.match(combinedOutput, /Workspace root does not exist/);
    assert.deepEqual(fs.readdirSync(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
