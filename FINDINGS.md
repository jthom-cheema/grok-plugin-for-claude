# Findings Queue

Defect and reliability findings observed while running this plugin inside the Cheema Claude Code harness. Newest first. Each entry carries its own evidence so it can be triaged without access to the original session.

---

## GROK-004: `state.json` is an unlocked multi-process read-modify-write; concurrent writers can lose updates

- Date recorded: 2026-08-10 (surfaced by cross-family review during GROK-002; the same mechanism underlies the cross-plugin clobber risk reported in [openai/codex-plugin-cc#631](https://github.com/openai/codex-plugin-cc/issues/631))
- Status: open
- Environment: same as GROK-001

### Defect

Every writer of the per-workspace `state.json` index (`upsertJob` in `plugins/grok/scripts/lib/state.mjs`) does an unlocked load-modify-save of the whole file. Any two processes writing concurrently (a dispatching parent and a running worker, workers of two parallel jobs, `cancel` racing a worker's completion write) can interleave between one another's load and save, and the later save silently discards the earlier one's update. The per-job `jobs/<id>.json` files have a single writer at any given moment under current code paths and are not affected the same way; the shared index is.

1.0.11 avoids ADDING any instance of this race (the dispatch parent no longer writes anything after a successful spawn), but the underlying architecture is unchanged and pre-existing.

### Candidate fix

Make the per-job files the source of truth and derive listings by scanning `jobs/` (the index becomes a cache or disappears), or serialize index writes with an advisory lock file. Queued for a future release; pairs naturally with GROK-003's liveness reconciliation.

---

## GROK-003: job listings have no PID-liveness reconciliation; a worker that dies after starting leaves a stale queued/running record

- Date recorded: 2026-08-10 (surfaced by cross-family review during GROK-002)
- Status: open
- Environment: same as GROK-001

### Defect

Once a background worker has started, a crash before `runTrackedJob` takes over (module-load failure, OOM kill, external termination) leaves the job record in `queued` or `running` with a recorded pid and nothing ever reconciles it: the status pathway (`plugins/grok/scripts/lib/job-control.mjs`) lists jobs from the state file without checking whether the recorded pid is still alive. The 1.0.11 fixes cover launch-time failures (bad cwd, spawn error); this entry covers death after a successful launch. Same operational lesson as GROK-001/002: bookkeeping that says "running" is not process evidence.

### Candidate fix

Status/result listing checks pid liveness for jobs in non-terminal phases and marks stale ones failed (with a log line noting the reconciliation), or the worker stamps a heartbeat the lister can age out. Not shipped in 1.0.11; queued for a future release.

---

## GROK-002: `--background` task dispatch with a bad cwd dies silently, leaving a permanently queued job

- Date recorded: 2026-08-10 (residual identified during GROK-001 review, both reviewers concurred)
- Status: fixed in 1.0.11
- Environment: same as GROK-001

### Defect

`spawnDetachedTaskWorker` (`plugins/grok/scripts/grok-companion.mjs`) passes the raw job cwd into an async detached `spawn(process.execPath, [... "task-worker" ...], { cwd, detached: true, stdio: "ignore" })` followed by `child.unref()`, with no `error` listener. `enqueueBackgroundTask` then writes the job record with `status: "queued"`. When the cwd does not exist, the spawn's failure surfaces only as an async `error` event after the queued record is already written and the CLI is exiting: the worker never starts, nothing marks the job failed, and the job sits queued forever.

The 1.0.10 guard in `runGrokTurn` does not cover this: it lives inside the code the detached worker would run, and with a bad cwd the worker never launches at all. A background job that dies silently while its bookkeeping says "queued" is precisely the failure class GROK-001's incident history warns about: launch claims are not evidence of a running job.

### Fix (1.0.11)

The workspace-root guard is extracted into a shared `assertWorkspaceRoot(cwd)` helper (same error text as 1.0.10: `Workspace root does not exist or is not a directory: <path>`) and applied at three levels:

1. `handleTask` validates the cwd before any job record or log file is created, so both foreground and `--background` dispatches with a bad cwd exit nonzero with the clear error and write no state at all.
2. `spawnDetachedTaskWorker` calls the guard before spawning, as defense in depth for any other caller.
3. `runGrokTurn` keeps its guard via the shared helper (behavior unchanged from 1.0.10).

Cross-family review of the fix surfaced two adjacent defects in the same silent-death class, folded into 1.0.11:

4. `enqueueBackgroundTask` previously spawned the detached worker BEFORE persisting the queued job record; a worker that won the race would exit `No stored job found` with stdio ignored and the parent would then record a queued job for a dead worker. The queued record is now persisted before the spawn, and the parent performs no write of any kind after a successful spawn: the worker's first `runTrackedJob` write stamps `status: running` and `pid: process.pid` into both the job file and the state index, so until the worker proves itself alive the index honestly shows queued with a null pid.
5. Launch failures now fail loud through a single `markLaunchFailed` path: an `error` listener on the detached child catches async spawn failures (EPERM, EMFILE, resource exhaustion), and a try/catch around the spawn call catches synchronous throws (the TOCTOU where cwd vanishes between the dispatch gate and the spawn). Both append the failure to the job log, persist the job as failed, and the sync path rethrows so the CLI exits nonzero. These writes are safe against worker clobber by construction: both paths fire only when the worker process never started.

### Verification

CLI-level regression test: `task --background` with a nonexistent cwd exits nonzero, prints the workspace-root error, and leaves the plugin data directory empty (no state dir, no job file, no log). Positive path re-confirmed live: a valid `--background` dispatch queues, the detached worker runs, and the job completes with its result collectable.

---

## GROK-001: delegate dispatch fails with `spawnSync grok.exe ENOENT` when the job cwd is a nonexistent path

- Date observed: 2026-08-10
- Status: open
- Environment: Windows 11 Pro 10.0.26200; plugin 1.0.9 (`grok-build-cheema`); grok CLI 0.2.118; binary `C:\Users\ThompsonJackCHEEMA\.grok\bin\grok.exe` (present on disk, 140,687,688 bytes, mtime 2026-08-03)
- Claude Code session: `28af7513-cffa-47fa-a176-e3aa72046423` (automate-at-teamcheema)
- Cross-reference: [openai/codex-plugin-cc#631](https://github.com/openai/codex-plugin-cc/issues/631), filed 2026-08-10 from the same session's evidence. The codex companion (same shared companion codebase, same `CLAUDE_PLUGIN_DATA` state contract as this fork) wrote its broker registration and all job state into this plugin's data directory.

### Reported symptom

Two of three grok-delegate subagent dispatches on 2026-08-10 failed instantly with `spawnSync C:\Users\ThompsonJackCHEEMA\.grok\bin\grok.exe ENOENT`. The binary was verified present between the two attempts. The same subagent pathway had completed a sentinel probe minutes earlier, and every main-thread dispatch worked. Initially logged in the session ledger as nondeterministic, cause unknown, possibly sandbox or env in the subagent context.

### What the state files actually show

All five companion dispatches from that session, times UTC on 2026-08-10:

| # | createdAt | Pathway | Job | workspaceRoot (cwd) | Outcome |
|---|-----------|---------|-----|----------------------|---------|
| 1 | 16:54:45 | grok-delegate subagent | `task-msnh20ve-i1bgi8` | `C:/projects/automate-at-teamcheema` | completed (sentinel probe, correct + DONE) |
| 2 | 16:58:37 | grok-delegate subagent | `task-msnh706v-u9rl89` | `C:\projects\automate-at-teamcheema\<tree>` | failed at 16:58:38.026, spawnSync ENOENT, pid null |
| 3 | 17:00:44 | grok-delegate subagent | `task-msnh9q92-6co9id` | `C:\projects\automate-at-teamcheema\<tree>` | failed at 17:00:45.172, spawnSync ENOENT, pid null |
| 4 | 17:01:40 | main thread | `task-msnhax88-q509qb` | `C:/projects/automate-at-teamcheema` | completed (probe) |
| 5 | 17:02:38 | main thread | `task-msnhc5z8-9zzmg4` | `C:/projects/worktrees/prohibited-review-20260810` | completed mechanically (its narration-only output is a separate served-model issue, tracked in the session ledger, not this defect) |

Both failures, and only the failures, carry `workspaceRoot: C:\projects\automate-at-teamcheema\<tree>`: a literal unexpanded `<tree>` placeholder. Angle brackets are illegal in Windows file names, so this cwd cannot exist. All three successes carry a real existing cwd.

Node's `spawnSync` reports ENOENT naming the target binary when the cwd passed in options does not exist, even when the binary itself is present. That matches everything observed: the binary sits at the exact path the error names, grok.exe never started (see log evidence below), and both failures were instant (147 ms and 206 ms from createdAt to completedAt, versus ~20 s for the successful probe).

Conclusion: the flake is deterministic, not nondeterministic. It fires exactly when a nonexistent cwd reaches the companion's spawn call. The subagent pathway is implicated only because that is where the placeholder cwd was passed; the main-thread dispatches all passed real paths. `<tree>` appears nowhere in this repo, so the placeholder text came from the session's delegation brief and was passed through to the companion unvalidated.

### Evidence

Failed job record, `~\.claude\plugins\data\grok-grok-build-cheema\state\tree-7c64453a3e55d093\jobs\task-msnh706v-u9rl89.json` (the twin failure `task-msnh9q92-6co9id.json` is identical apart from ids and timestamps):

```json
{
  "id": "task-msnh706v-u9rl89",
  "kind": "task",
  "kindLabel": "delegate",
  "title": "Grok Task",
  "workspaceRoot": "C:\\projects\\automate-at-teamcheema\\<tree>",
  "write": false,
  "createdAt": "2026-08-10T16:58:37.879Z",
  "sessionId": "28af7513-cffa-47fa-a176-e3aa72046423",
  "status": "failed",
  "startedAt": "2026-08-10T16:58:37.899Z",
  "phase": "failed",
  "pid": null,
  "errorMessage": "spawnSync C:\\Users\\ThompsonJackCHEEMA\\.grok\\bin\\grok.exe ENOENT",
  "completedAt": "2026-08-10T16:58:38.026Z"
}
```

The full job log for that failure is two lines (91 bytes), confirming death before the CLI ever ran:

```
[2026-08-10T16:58:37.898Z] Starting Grok Task.
[2026-08-10T16:58:38.000Z] Starting Grok...
```

The companion even created a state namespace for the impossible workspace: the state dir `tree-7c64453a3e55d093` is the sanitized basename of `<tree>` plus the workspace-path hash.

`~\.grok\logs\unified.jsonl` (the grok.exe shell's own log) corroborates that no grok process launched for either failed job. The successful subagent probe is pid 40032:

```json
{"ts":"2026-08-10T16:54:46.975Z","src":"shell","pid":40032,"lvl":"info","msg":"AuthManager::new","ctx":{"scope":"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828","grok_home":"C:\\Users\\ThompsonJackCHEEMA\\.grok","HOME":"C:\\Users\\ThompsonJackCHEEMA","GROK_HOME":"(unset)","GROK_AUTH_PATH":"(unset)","GROK_AUTH":"(unset)"}}
{"ts":"2026-08-10T16:55:10.861Z","src":"shell","pid":40032,"ver":"0.2.118","lvl":"info","sid":"019fec99-2607-77e2-9875-1abfa4f024ec","msg":"shell.handle_prompt.done","ctx":{"prompt_id":"2958dabd-3e8f-4d62-9f77-4620564f049d","total_elapsed_ms":19658,"turn_elapsed_ms":18054,"pre_turn_ms":1604,"ok":true}}
```

Between 16:55:11Z (last line of pid 40032) and 17:01:41Z (first line of pid 29532, the main-thread probe), unified.jsonl contains zero entries from any pid. Both failure windows (16:58:37 and 17:00:44) fall inside that silence: grok.exe never started. The next runs, pid 29532 (17:01:41 to 17:01:47) and pid 51572 (17:02:39 to 17:02:48), are dispatches 4 and 5 and both reach `shell.handle_prompt.done` with `ok:true`.

### Repro conditions

1. Any host; Windows makes it airtight because a path containing `<` or `>` cannot exist. On POSIX any nonexistent directory reproduces it.
2. Invoke the companion delegate pathway with cwd set to a directory that does not exist, for example a brief placeholder like `C:\projects\myrepo\<tree>` passed through literally.
3. spawnSync fails immediately with ENOENT naming the grok binary. The job record shows `status: failed`, `phase: failed`, `pid: null`, and a sub-second createdAt to completedAt span.

### Proposed plugin-side fixes

1. Validate the resolved workspaceRoot before spawning (exists and is a directory). Fail the job with `workspace root does not exist: <path>` instead of launching.
2. Keep the binary-existence check separate so the error message can distinguish "grok binary not found" from "cwd not found". Today both surface as the same misleading ENOENT naming the binary.
3. Optional hardening: reject workspaceRoot values containing characters illegal on the host OS at job intake, which catches unexpanded `<placeholder>` briefs in every case, not just when spawn happens to fail.

Note for the harness side (not a plugin defect): the ultimate origin of the bad path is a delegation brief whose `<tree>` placeholder was never substituted before dispatch. Brief templates should carry real absolute paths by the time they reach a forwarder.
