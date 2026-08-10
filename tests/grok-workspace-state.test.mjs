import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { assertWorkspaceRoot } from "../plugins/grok/scripts/lib/workspace.mjs";
import { handleSessionStart, SESSION_ID_ENV } from "../plugins/grok/scripts/session-lifecycle-hook.mjs";

test("runGrokTurn throws synchronously when cwd does not exist", () => {
  const missingCwd = path.join(os.tmpdir(), `grok-missing-cwd-${process.pid}-${Date.now()}`);

  assert.throws(
    () => runGrokTurn(missingCwd, { prompt: "hello" }),
    (error) => {
      assert.match(error.message, /Workspace root does not exist/);
      assert.match(error.message, new RegExp(missingCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
});

test("runGrokTurn throws synchronously when cwd is an empty string", () => {
  assert.throws(
    () => runGrokTurn("", { prompt: "hello" }),
    (error) => {
      assert.match(error.message, /Workspace root does not exist/);
      return true;
    }
  );
});

test("runGrokTurn throws synchronously when cwd points at a file, not a directory", () => {
  const filePath = path.join(os.tmpdir(), `grok-cwd-is-file-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, "not a directory", "utf8");

  try {
    assert.throws(
      () => runGrokTurn(filePath, { prompt: "hello" }),
      (error) => {
        assert.match(error.message, /Workspace root does not exist/);
        assert.match(error.message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("resolveStateDir uses <dataDir>/grok/state when GROK_PLUGIN_DATA is set", () => {
  const previousFork = process.env.GROK_PLUGIN_DATA;
  const previousGeneric = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = path.join(os.tmpdir(), "grok-fork-data");

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    process.env.GROK_PLUGIN_DATA = dataDir;

    const stateDir = resolveStateDir(process.cwd());
    assert.match(stateDir, /[/\\]grok-fork-data[/\\]grok[/\\]state[/\\]/);
  } finally {
    if (previousFork === undefined) {
      delete process.env.GROK_PLUGIN_DATA;
    } else {
      process.env.GROK_PLUGIN_DATA = previousFork;
    }
    if (previousGeneric === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousGeneric;
    }
  }
});

test("resolveStateDir uses <dataDir>/grok/state when only CLAUDE_PLUGIN_DATA is set", () => {
  const previousFork = process.env.GROK_PLUGIN_DATA;
  const previousGeneric = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = path.join(os.tmpdir(), "grok-generic-data");

  try {
    delete process.env.GROK_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;

    const stateDir = resolveStateDir(process.cwd());
    assert.match(stateDir, /[/\\]grok-generic-data[/\\]grok[/\\]state[/\\]/);
  } finally {
    if (previousFork === undefined) {
      delete process.env.GROK_PLUGIN_DATA;
    } else {
      process.env.GROK_PLUGIN_DATA = previousFork;
    }
    if (previousGeneric === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousGeneric;
    }
  }
});

test("resolveStateDir prefers GROK_PLUGIN_DATA over CLAUDE_PLUGIN_DATA when both are set", () => {
  const previousFork = process.env.GROK_PLUGIN_DATA;
  const previousGeneric = process.env.CLAUDE_PLUGIN_DATA;
  const forkDataDir = path.join(os.tmpdir(), "grok-fork-wins");
  const genericDataDir = path.join(os.tmpdir(), "grok-generic-loses");

  try {
    process.env.GROK_PLUGIN_DATA = forkDataDir;
    process.env.CLAUDE_PLUGIN_DATA = genericDataDir;

    const stateDir = resolveStateDir(process.cwd());
    assert.match(stateDir, /[/\\]grok-fork-wins[/\\]grok[/\\]state[/\\]/);
    assert.doesNotMatch(stateDir, /grok-generic-loses/);
  } finally {
    if (previousFork === undefined) {
      delete process.env.GROK_PLUGIN_DATA;
    } else {
      process.env.GROK_PLUGIN_DATA = previousFork;
    }
    if (previousGeneric === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousGeneric;
    }
  }
});

test("handleSessionStart exports GROK_PLUGIN_DATA and does not re-export CLAUDE_PLUGIN_DATA", () => {
  const envFile = path.join(os.tmpdir(), `grok-session-start-env-${process.pid}-${process.hrtime.bigint()}.sh`);
  const previousEnvFile = process.env.CLAUDE_ENV_FILE;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const knownDataDir = path.join(os.tmpdir(), "grok-session-start-data");

  process.env.CLAUDE_ENV_FILE = envFile;
  process.env.CLAUDE_PLUGIN_DATA = knownDataDir;

  try {
    handleSessionStart({ session_id: "test-session" });

    const contents = fs.readFileSync(envFile, "utf8");
    assert.match(
      contents,
      new RegExp(`export GROK_PLUGIN_DATA='${knownDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`)
    );
    assert.doesNotMatch(contents, /export CLAUDE_PLUGIN_DATA=/);
    assert.match(contents, new RegExp(`export ${SESSION_ID_ENV}='test-session'`));
  } finally {
    if (previousEnvFile === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previousEnvFile;
    }
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
  }
});

test("assertWorkspaceRoot does not throw for a real directory", () => {
  assert.doesNotThrow(() => assertWorkspaceRoot(os.tmpdir()));
});

test("assertWorkspaceRoot throws for a nonexistent path", () => {
  const missingCwd = path.join(os.tmpdir(), `grok-assert-missing-${process.pid}-${Date.now()}`);

  assert.throws(
    () => assertWorkspaceRoot(missingCwd),
    (error) => {
      assert.match(error.message, /Workspace root does not exist or is not a directory:/);
      assert.match(error.message, new RegExp(missingCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
});

test("assertWorkspaceRoot throws for an empty string", () => {
  assert.throws(
    () => assertWorkspaceRoot(""),
    (error) => {
      assert.match(error.message, /Workspace root does not exist or is not a directory:/);
      return true;
    }
  );
});

test("assertWorkspaceRoot throws when the path points at a file", () => {
  const filePath = path.join(os.tmpdir(), `grok-assert-is-file-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, "not a directory", "utf8");

  try {
    assert.throws(
      () => assertWorkspaceRoot(filePath),
      (error) => {
        assert.match(error.message, /Workspace root does not exist or is not a directory:/);
        assert.match(error.message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
