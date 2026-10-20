# Goalkeeper

Goalkeeper keeps Pi working toward an explicit goal, with bounded retries, response limits, and optional token budgets. Goals follow the current session branch and stop when completed, blocked, cancelled, or limited.

**Requirements:** Pi **1.3.0** and Node.js **22.19.0+**. Other Pi versions have not been verified.

## Installation

```sh
pi install git:github.com/ArdaYILDIZ-DEV/pi-goalkeeper@v0.1.0
```

This changes your personal Pi package settings. Add `--local` to `pi install` for project-local settings. Run `/reload` in an open session. Load only one copy of Goalkeeper.

## Usage

```text
/goal Check this project's README against its implementation and fix any inaccuracies.
```

| Command | Action |
| --- | --- |
| `/goal` | Show the goal, status, elapsed time, and usage. |
| `/goal pause` | Stop automatic continuation, without cancelling work already running. |
| `/goal resume` | Explicitly restart; reset response/retry allowances, not consumed tokens. |
| `/goal edit` | Edit the objective interactively without resetting usage. |
| `/goal clear` | Clear the current branch's goal, not session history or project files. |

Replacing an unfinished goal requires interactive confirmation; in headless mode, clear it first. Objectives support up to 5,000 Unicode characters; reference a file for longer requirements.

The model can use `create_goal({objective, token_budget?})`, `get_goal({})`, and `update_goal({status: "complete" | "blocked"})`. Goal creation and positive-integer token budgets require an explicit request. Completion requires current evidence; a genuine permission, input, or credentials blocker can stop the goal immediately.

## Limits and recovery

- **50 assistant responses** per start or explicit resume, including tool-calling and failed responses.
- **10 extra error retries** after Pi finishes its own recovery. Backoff is 2, 4, 8, 16, then at most 30 seconds. A successful agent run resets consecutive retries.
- **Optional token budget:** `input + cacheWrite + output`, excluding cache reads. The creation response is excluded; the completion-calling response is included. Missing or invalid usage pauses budgeted goals. Editing or resuming cannot bypass exhausted or unverifiable budgets.
- **Explicit restart:** cancellation, session reopening, reload, and branch changes never automatically resume work. Inspect progress, then use `/goal resume`. Incompatible or damaged saved state requires inspection and explicit clearing/replacement.
- **Cancellation:** use Pi's abort action to stop current work. During final settlement in Pi 1.3.0, abort may wait for the remaining backoff before settling paused.

State lives in Pi's session tree; progress carries through conversation history and compaction. Goalkeeper is not a background worker, watchdog, or hard monetary cap. Subagents, compaction requests, and external tool costs are outside its counters; already-started work may have effects. A goal grants no new permission, and model-declared completion is not independent verification.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
```

Pi loads TypeScript directly; no build step is required. See [AGENTS.md](AGENTS.md) for architecture, testing, and release instructions, and [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT](LICENSE).
