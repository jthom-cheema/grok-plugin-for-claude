# Grok Plugin for Claude Code | Use Grok in Claude Code

**Current version: 1.0.11**

Use [Grok Build CLI](https://x.ai/cli) from inside Claude Code. 

This is the Grok plugin for Claude Code (also known as claude grok or grok claude code plugin). It wraps your local `grok` binary and lets you delegate tasks, do reviews, generate images, use vision, TTS, and more directly inside Claude Code.

Popular search terms: claude code grok, grok claude code, claude grok plugin, use grok in claude code.

Inspired by the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), this plugin wraps your local `grok` binary and exposes slash commands plus a `grok:grok-delegate` subagent.

Full release history: [plugins/grok/CHANGELOG.md](plugins/grok/CHANGELOG.md)

## What You Get

| Command | What it does |
|---------|--------------|
| `/grok:setup` | Check Grok install/auth, offer to install or log in |
| `/grok:login` | Sign in to Grok using the full binary path (no PATH needed) |
| `/grok:model` | View or change the default Grok model for this workspace |
| `/grok:web` | View or change the default web-search setting for this workspace |
| `/grok:effort` | View or change the default reasoning effort for this workspace |
| `/grok:delegate` | General delegation. Also supports advanced features via natural language (image/video, vision, TTS/STT, etc.) |
| `/grok:review` | Read-only Grok code review of your working tree or branch |
| `/grok:image` | Generate images |
| `/grok:edit-image` | Edit existing images (provide path + instructions) |
| `/grok:video` | Generate videos |
| `/grok:edit-video` | Edit existing videos |
| `/grok:vision` | Analyze / describe images (vision) |
| `/grok:tts` | Text-to-speech |
| `/grok:stt` | Speech-to-text (transcribe audio) |
| `/grok:status` | Show running and recent Grok jobs for this repo |
| `/grok:result` | Show the final output of a finished job |
| `/grok:cancel` | Cancel an active background Grok job |

You also get the `grok:grok-delegate` subagent in `/agents`.

## Requirements

- **Grok Build CLI** with an active login
- **Node.js 18.18+** (used by the plugin runtime scripts)
- **Git** (recommended for `/grok:review`)

## Install the plugin

In Claude Code:

```text
/plugin marketplace add dashpot4/grok-plugin-for-claude
/plugin install grok@grok-build
/reload-plugins
```

For local development:

```text
/plugin marketplace add ./path/to/grok-plugin-for-claude
/plugin install grok@grok-build
/reload-plugins
```

After install you should see the slash commands above and `grok:grok-delegate` in `/agents`.

Update to the latest release:

```text
/plugin marketplace update grok-build
/plugin install grok@grok-build
/reload-plugins
```

---

## Recent changes

| Version | Highlights |
|---------|------------|
| **1.0.9** | Model selection now **follows the Grok Build CLI default** — no workspace model set means no `-m`, so runs use the CLI's own default (**`grok-4.5`** since 2026-07-08) and auto-follow future changes. `/grok:model` catalog updated (grok-4.5 + composer; **`grok-build` removed** — CLI rejects it); added `/grok:model none` to clear; `--model` aliases normalized. Docs: `grok resume` → `grok --resume` |
| **1.0.8** | `/grok:delegate` returns Grok's answer **in-band by default** (no `/grok:status` + `/grok:result` hunt); `--background` reliably detaches for runs over the Bash ~10-minute limit; jobs are scoped to the Claude session (`GROK_COMPANION_SESSION_ID`); `interpretGrokResult` locks the `--output-format json` contract (`text` / `sessionId` / `stopReason`) with tests |
| **1.0.7** | `/grok:effort` + full advanced Grok feature support (image/video generation & editing, vision/analysis, file upload, brainstorm, search, code execution, TTS, etc.) via `/grok:delegate` with natural language detection, exact path handling, and permission guidance |
| **1.0.6** | `--no-subagents` direct delegate; `/grok:web`; web search off by default (`--web` to enable); setup shows workspace settings; CI |
| **1.0.5** | `--no-web` / `--disable-web-search` per run (helps with large prompts + web-search `400 Bad Request`) |
| **1.0.4** | `/grok:model` is instant (like `/grok:status`); use `/grok:model grok-build` or `composer` |
| **1.0.3** | `/grok:model` saves workspace default model (`grok-composer-2.5-fast` by default) |
| **1.0.2** | Windows fix: prompts go through UTF-8 `--prompt-file` (parentheses / Korean safe) |
| **1.0.1** | `/grok:login`, full-path Grok resolve when PATH is missing |

---

## First-time setup

There are two common paths depending on whether Grok is already on your machine.

### Path A — Grok is **not** installed yet (most common for new users)

This is the flow when you install Grok **from inside Claude Code** via `/grok:setup`.

**Step 1. Run setup**

```text
/grok:setup
```

Claude will check whether Grok is installed. If not, it asks whether to install. Choose **Install Grok (Recommended)**.

- **Windows**: installs to `%USERPROFILE%\.grok\bin\grok.exe`
- **macOS/Linux**: installs to `~/.grok/bin/grok`

**Step 2. Log in to Grok**

After install, `/grok:setup` asks whether to run Grok login. Choose **Run Grok login (Recommended)**.

Alternatively:

```text
/grok:login
```

**Step 3. Confirm readiness**

```text
/grok:setup
```

You should see `Status: ready` plus workspace settings (default model, web search default).

**Step 4. Try a first delegate**

```text
/grok:delegate say hello and list files in the current directory
```

---

### Path B — Grok is **already** installed before you open Claude Code

If you installed Grok earlier (outside Claude Code) **and** your shell PATH already includes the Grok bin directory, setup is usually one step:

```text
/grok:setup
```

If you are already logged in (`grok models` works in a normal terminal), `/grok:setup` should report `Status: ready` immediately.

You can skip `/grok:login` and go straight to:

```text
/grok:delegate investigate the failing test
```

---

## Important: `!grok login` and PATH on Windows

### The problem

`!grok login` runs a shell command inside your **current** Claude Code session. On Windows, Claude Code only sees the **PATH from when the session started**.

If Grok was installed **during** this Claude Code session (via `/grok:setup`), the new install path is **not** visible to that session yet. In that case:

```text
!grok login
```

often fails with:

```text
command not found
```

This is expected. It does **not** mean Grok failed to install.

### What to do instead

Use one of these — they work **without** restarting:

```text
/grok:login
```

or

```text
/grok:setup
```

and choose **Run Grok login**.

These call the full path (`%USERPROFILE%\.grok\bin\grok.exe` on Windows) directly.

### When you need a new Claude Code session

You need to **fully quit and reopen Claude Code** if you want `!grok` shell commands to work directly:

- after installing Grok from inside Claude Code, **and**
- you prefer typing `!grok login`, `!grok models`, etc. instead of slash commands

After restart, Windows picks up the updated user PATH and `!grok` should work.

> **Summary**
> - Installed Grok inside Claude Code → use `/grok:login` or `/grok:setup` for login
> - Want `!grok` to work → quit Claude Code completely and start a new session
> - Grok was already installed before opening Claude Code → usually no extra steps needed

The plugin runtime itself resolves `~/.grok/bin/grok.exe` directly, so `/grok:delegate` and `/grok:review` work even when `!grok` does not.

---

## Usage

### `/grok:model`

Pick the default Grok model for this workspace. By default the plugin saves **no** model and follows the Grok Build CLI's own default — **`grok-4.5`** as of 2026-07 (`grok models` shows `* grok-4.5 (default)`).

```text
/grok:model
/grok:model grok-4.5
/grok:model composer
/grok:model none
```

> **Grok model note (v1.0.9, 2026-07):** As of 2026-07-08 the Grok Build CLI's default model is **`grok-4.5`**. This plugin no longer pins an older model — when no workspace model is saved it passes no `-m` and follows the CLI default, so future xAI default changes are picked up automatically. Use `/grok:model <id>` to pin one (e.g. `grok-4.5`, `composer`) or `/grok:model none` to clear it and return to the CLI default. **`grok-build` was removed upstream** and is no longer selectable (`-m grok-build` errors `unknown model id`). Flags and the `--output-format json` contract are unchanged.

Runs instantly (no Claude orchestration). `/grok:delegate` and `/grok:review` use the saved model unless you pass `--model`.

### `/grok:delegate`

Hands a task to Grok through the `grok:grok-delegate` subagent.

By default the delegate runs in the **foreground** and returns Grok's answer directly in the conversation — no follow-up commands needed. Pass `--background` only for long-running or fire-and-forget work, then retrieve the result with `/grok:status` and `/grok:result`.

```text
/grok:delegate investigate why the build is failing in CI
/grok:delegate fix the failing test with the smallest safe patch
/grok:delegate --resume apply the top fix from the last run
/grok:delegate --model grok-composer-2.5-fast --effort high investigate the flaky test
/grok:delegate grok max 모드로 flaky test 분석해줘
/grok:delegate use maximum effort to fix the regression
/grok:delegate --background investigate the regression
/grok:delegate --no-subagents investigate the failing test
/grok:delegate --web search for recent breaking changes in the dependency
```

Web search is **disabled by default**. Use `--web` when you want Grok to search the web for this run. Use `--no-web` to force-disable even when the workspace default is on.

You can also ask naturally:

```text
Ask Grok to redesign the database connection to be more resilient.
```

| Flag | Meaning |
|------|---------|
| `--background` | Long-running / fire-and-forget: launches a detached Grok worker and returns a job id. Retrieve the answer with `/grok:status` and `/grok:result`. Survives runs longer than ~10 minutes. |
| `--wait` | **Default.** Run in the foreground and return Grok's answer in-band (no `/grok:status`/`/grok:result` needed). Best for normal tasks; bounded by a ~10-minute limit — use `--background` for longer runs. |
| `--resume` | Continue the latest Grok session for this repo |
| `--fresh` | Start a new Grok session |
| `--model <id>` | Pick a model (e.g. `grok-composer-2.5-fast`) |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, or `max` (or natural language like "grok max 모드"). Per-run override. |
| workspace effort default | `/grok:effort high` (or none to clear). Applied automatically to `/grok:delegate` and `/grok:review`. |
| `--no-web` / `--disable-web-search` | Force-disable web search for this run |
| `--web` / `--enable-web-search` | Enable web search for this run (overrides workspace default) |
| `--no-subagents` | Call `grok-companion task` directly; skip the delegate subagent |

Delegate runs are **write-capable by default** (Grok can edit files). Ask explicitly for read-only behavior if you only want investigation or review.

**Natural language effort**: You can also say things like "grok max 모드로", "use maximum effort", or "highest reasoning" — the delegate will detect it and pass `--effort max` (or the appropriate level) to Grok. Explicit `--effort` takes precedence.

### `/grok:review`

Read-only code review. Does not modify files.

```text
/grok:review
/grok:review --base main
/grok:review --background
/grok:review --no-web --scope working-tree
```

| Flag | Meaning |
|------|---------|
| `--base <ref>` | Review branch diff against `main` (or another ref) |
| `--scope working-tree` | Review only uncommitted changes |
| `--scope branch` | Review against the default base branch |
| `--background` | Run review in the background |
| `--no-web` / `--disable-web-search` | Force-disable web search for this review run |
| `--web` / `--enable-web-search` | Enable web search for this review run |

### `/grok:web`

```text
/grok:web
/grok:web on
/grok:web off
```

Runs instantly. Default is **off** (web search disabled). `/grok:delegate` and `/grok:review` follow this unless you pass `--web` or `--no-web`.

### `/grok:effort`

```text
/grok:effort
/grok:effort high
/grok:effort max
/grok:effort none
```

Runs instantly. Sets the default reasoning effort (`low` / `medium` / `high` / `xhigh` / `max`) for `/grok:delegate` and `/grok:review` in this workspace. Use `none` or `clear` to remove the default (let Grok decide per call). Per-run override with `--effort` flag or natural language like "grok max 모드로".

### Advanced Grok Features

Both dedicated commands **and** natural language via `/grok:delegate` are supported.

**Dedicated commands** (recommended for discoverability):
- `/grok:image` — Generate images
- `/grok:edit-image` — Edit existing images (provide path + instructions)
- `/grok:video` — Generate videos
- `/grok:edit-video` — Edit existing videos
- `/grok:vision` — Analyze/describe images (vision)
- `/grok:tts` — Text-to-speech
- `/grok:stt` — Speech-to-text (transcribe audio)

**Natural language** (still fully supported):
`/grok:delegate grok generate image of a cyberpunk cat at night`
`/grok:delegate grok edit image at ./photo.jpg to oil painting style`
`/grok:delegate grok analyze image at ./screenshot.png for UI issues`

The `/grok:delegate` command includes detection for common advanced patterns and preserves file paths exactly. Detailed permission guidance is included in the prompts so Claude can handle file access and approvals gracefully.

See the individual command files and the `grok:grok-delegate` agent prompt for details.
- `/grok:delegate grok upload file at ./report.pdf and summarize`
- `/grok:delegate grok speak: welcome to the demo`
- `/grok:delegate grok transcribe ./meeting.mp3`

**File paths & permissions (important)**
- Always use the exact paths the user provides (e.g. `./photo.jpg`, `./report.pdf`).
- Grok runs with your current shell permissions in the workspace directory.
- Read-only tasks (vision, analyze, describe) are generally safe.
- Generation/editing tasks use write mode by default. Generated files are saved in the workspace; the result will tell you the paths.
- If Grok encounters permission problems, the error appears in the output. The main Claude thread can then suggest fixes or use `--no-subagents` for tighter control.
- For complex file work, `--no-subagents` gives you (or Claude) direct oversight of the command.

See the `grok:grok-delegate` agent prompt for the exact forwarding rules and permission guidance.

### `/grok:status`, `/grok:result`, `/grok:cancel`

Manage background jobs:

```text
/grok:status
/grok:status task-abc123
/grok:result
/grok:result task-abc123
/grok:cancel
/grok:cancel task-abc123
```

`/grok:result` includes the Grok session ID when available. Resume that work directly in Grok:

```bash
grok --resume <session-id>
```

### `/grok:setup` and `/grok:login`

```text
/grok:setup     # check install + auth, offer install/login
/grok:login     # sign in via full binary path (recommended after in-session install)
```

When ready, `/grok:setup` also shows workspace defaults:

- default model (`/grok:model` to change)
- web search default (`/grok:web` to change; off by default)
- reasoning effort default (`/grok:effort` to change)
- hint for `/grok:delegate --no-subagents`

Advanced Grok features (image/video generation, vision, file handling, etc.) are available through `/grok:delegate` with natural language. See the "Advanced Grok Features" section below.

---

## Typical workflows

### New user: install → login → delegate

```text
/grok:setup                              # install Grok if missing
/grok:login                              # sign in (or choose login in /grok:setup)
/grok:setup                              # confirm Status: ready
/grok:delegate investigate the failing test
```

### Review before shipping

```text
/grok:review
```

### Long-running background task

```text
/grok:delegate --background investigate the flaky integration test
/grok:status
/grok:result
```

### Continue previous Grok work

```text
/grok:delegate --resume keep going and apply the smallest fix
```

### Large prompt handoff

Web search is off by default, which avoids `400 Bad Request` on large briefs (~20k tokens):

```text
/grok:model composer
/grok:delegate <paste or reference your large brief>
```

Use `--web` only when you explicitly want Grok to search the web.

### Pick workspace defaults

```text
/grok:model
/grok:model grok-4.5
/grok:web
/grok:web on
```

### Fast delegate (skip subagent)

```text
/grok:delegate --no-subagents investigate the failing test
```

---

## How it works

```text
Claude Code
  └─ /grok:delegate
       ├─ (default) grok:grok-delegate subagent
       │    └─ grok-companion.mjs task
       └─ (--no-subagents) grok-companion.mjs task directly
            └─ ~/.grok/bin/grok.exe --prompt-file <utf-8> [--disable-web-search] --output-format json
```

The plugin:

- uses your **local** Grok install (not a remote runtime)
- reads auth from `~/.grok/auth.json`
- respects `~/.grok/config.toml` and project `.grok/config.toml`
- tracks jobs per workspace for background status/result/cancel
- saves per-workspace default model via `/grok:model`
- saves per-workspace web-search default via `/grok:web` (off by default; pass `--web` per run to enable)

---

## Troubleshooting

### `!grok login` → command not found

You installed Grok inside Claude Code and have not restarted the session. Use `/grok:login` or `/grok:setup` instead, or quit and reopen Claude Code.

### `/grok:login` not in the command menu

Update the plugin:

```text
/plugin marketplace update grok-build
/plugin install grok@grok-build
/reload-plugins
```

Requires **v1.0.7** for `/grok:effort` and advanced Grok features (image/video gen/edit, vision, file handling, etc.) via natural language in `/grok:delegate`. Requires **v1.0.6** for `/grok:web`, `--no-subagents`, etc. `/grok:setup` can also run login on older cached installs.

### `/grok:setup` says needs authentication

```text
/grok:login
```

or open a **new** PowerShell window, run `grok login`, then restart Claude Code.

### `/grok:delegate` fails immediately

1. Run `/grok:setup` — confirm `Status: ready`
2. If Grok is missing, install via `/grok:setup`
3. If auth is missing, run `/grok:login`
4. Update plugin to latest: `/plugin marketplace update grok-build`

### Plugin commands missing after install

```text
/reload-plugins
```

If still missing, reinstall:

```text
/plugin install grok@grok-build
/reload-plugins
```

---

## FAQ

### Do I need a separate Grok account?

No. The plugin uses your local Grok CLI login. Sign in once with `/grok:login` or `grok login`.

### Does the plugin use a separate Grok runtime?

No. It calls the same `grok` binary installed on your machine.

### Will it use my existing Grok config?

Yes. Same config and auth as running `grok` directly in a terminal.

### I already use Codex in Claude Code. Can I use both?

Yes. This plugin is independent of the Codex plugin. Use `/codex:rescue` for Codex and `/grok:delegate` for Grok.

---

## Development

```bash
npm test
node plugins/grok/scripts/grok-companion.mjs setup
node plugins/grok/scripts/grok-companion.mjs model
node plugins/grok/scripts/grok-companion.mjs web
```

CI runs `npm test` on push/PR via `.github/workflows/test.yml`.

### Releasing

When bumping the plugin version, update these together in one commit:

- `package.json`
- `plugins/grok/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `plugins/grok/CHANGELOG.md`
- **`README.md`** (current version, Recent changes, usage flags/examples)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).