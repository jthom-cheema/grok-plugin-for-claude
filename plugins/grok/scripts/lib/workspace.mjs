import fs from "node:fs";

import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

export function assertWorkspaceRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Workspace root does not exist or is not a directory: ${cwd}`);
  }
}
