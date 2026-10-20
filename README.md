# Goalkeeper

Goalkeeper is a Pi extension that provides bounded goal continuation tied to session history. While a goal is active, it continues work after Pi finishes its own retry and compaction processes; automatic continuation stops when the goal is completed, blocked, cancelled, or reaches a limit.

**Compatibility:** Pi **1.3.0** (`@earendil-works/pi-coding-agent`) and Node.js **22.19.0+**. Other Pi versions have not been verified. Pi loads the TypeScript sources directly; no separate build or bundled host runtime dependencies are needed.

**License:** [MIT](LICENSE). The package name is `goalkeeper`; the manifest version is **0.1.0**. This version number does not imply that a release has already been published.

## Installation

Install from the [Git repository](https://github.com/ArdaYILDIZ-DEV/pi-goalkeeper):

```sh
pi install git:github.com/ArdaYILDIZ-DEV/pi-goalkeeper
```

This changes your personal Pi package settings. To install only for the current project:

```sh
pi install --local git:github.com/ArdaYILDIZ-DEV/pi-goalkeeper
```

Distribution uses Git; installation does not depend on an npm publication. The manifest is marked `private` to prevent accidental npm publishing; local packing and Git installation remain supported. For a local source checkout, replace the path below with its absolute path:

```sh
pi install /absolute/path/to/pi-goalkeeper
```

Run `/reload` in an open Pi session. During development, load once without installing by running this from the repository root:

```sh
pi -e ./src/index.ts
```

`-e` does not disable normal extension discovery. Do not load the same Goalkeeper copy through both installation and `-e`; if an old `goal.ts` copy is in an auto-discovery directory, adjust your loading configuration first. Goalkeeper does not move or delete existing installation files.

## Usage

Inside Pi:

```text
/goal Check this project's README against its implementation and fix any inaccuracies.
/goal
/goal pause
/goal resume
/goal edit
/goal clear
```

- `/goal <objective>` creates a new goal. Replacing an unfinished goal requires interactive confirmation; in headless mode, explicitly use `/goal clear` first.
- `/goal` displays the objective, status, elapsed time, tokens, and counters.
- `pause` stops automatic goal continuation; it does not cancel a tool or request already running. Use Pi's cancellation action to abort current work.
- `resume` is an explicit restart: it resets the 50-response allowance and consecutive error-retry counter, but **does not erase** consumed tokens. Inspect the current state and progress first.
- `edit` opens the interactive objective editor. It does not reset counters or budget; editing a completed goal pauses it, and continuing requires `resume`.
- `clear` clears only Goalkeeper state on the active branch. It does not delete session history or project files.

Model tools retain their technical names for compatibility with existing users:

| Tool | Behavior |
| --- | --- |
| `create_goal({objective, token_budget?})` | Use only on an explicit request to create a goal. Supply a budget only if the user explicitly requests one; it must be a positive safe integer. |
| `get_goal({})` | Returns the goal, budget, remaining tokens, response/error counters, and any recovery warning. |
| `update_goal({status: "complete"})` | Completes an active goal; model instructions require current evidence that the goal is achieved. This is not independent verification. |
| `update_goal({status: "blocked"})` | Stops immediately at a real blocker requiring permission, credentials, user input, or a change in external state. |

An objective can contain at most 5,000 Unicode characters. Keep longer requirements in a file and reference it in the objective. Goal text is neither a higher-priority instruction nor new authorization. The `/goal` command and the `goal`, `goal-ui`, and `goal-continuation` wire identifiers remain stable.

## Limits and recovery

- **Response limit:** 50 assistant responses per start or explicit resume. Tool-calling and failed responses count too; the count is not limited to automatic continuation messages. At the appropriate `turn_end` boundary, the limit also stops the inner model/tool loop through Pi's abort mechanism. It does not undo side effects of tools that already ran.
- **Token metric:** `input + cacheWrite + output`; cache-read tokens are not included. `totalTokens` is not used as a fallback to a different metric. Accounting covers assistant responses that begin after goal creation, excluding the creation response. The response calling the completion tool is included; reporting responses after completion are excluded.
- **Missing usage:** Invalid or missing usage data safely pauses a budgeted goal. Unverifiable consumption is not reset to zero to keep running; the original record is preserved, and explicit clearing or replacement is required.
- **Error retries:** After Pi finishes its own recovery, a remaining agent error permits at most **10 additional Goalkeeper retries**. Delays are 2, 4, 8, 16, then at most 30 seconds. A successful agent run resets the consecutive error counter; a single successful tool result does not. A failed test/tool result alone does not start this retry loop. Pi's own retries are separate from these ten attempts.
- **Stopping:** Cancellation is not success; Goalkeeper does not ask to restart automatically. `pause`, `clear`, goal replacement, or new user input interrupts a pending Goalkeeper wait. Pi 1.3.0 does not always provide an active `ctx.signal` at the final settlement boundary: Pi abort prevents a new request in that interval, but the wait may still take the remaining backoff time (configured at no more than 30 seconds, plus any timer delay). The goal is paused after settlement finishes. Error text containing “rate/limit” is not used for unreliable error classification.
- **Budget:** Editing or resuming cannot bypass an exhausted budget. Counters are not cost estimates; subagents, compaction requests, and external tool costs are excluded. A request/tool already in progress may have started before the limit was reached. This is not a hard monetary cap, timeout, or watchdog.

After an error or a side effect with an uncertain outcome, instructions require inspecting the current state rather than blindly repeating the operation. Retrying grants no new authority. Enforcing the user's permission boundaries remains the responsibility of Pi's tool/policy mechanisms and the agent.

## State and task continuity

State is stored in Pi's session tree; there is no separate database, task file, or second progress log. The latest snapshot on the relevant branch is restored. Progress and verification evidence carry forward through normal conversation history and Pi's compaction summary; a summary does not replace current files or live state.

Opening a session, reloading, or switching branches does not automatically restart work: a saved active goal loads as **paused**. Counters are preserved. Continuing requires explicit `/goal resume`. Compaction alone does not reset counters.

Legacy v2 records, unknown versions, and records with damaged counters are not resumed automatically. Readable objectives and original session entries are preserved; historical tokens are not claimed to be accurate under the new metric. Inspect a goal with a recovery warning and explicitly clear or replace it. If an objective is too damaged to read, a warning is shown; the on-disk entry is not deleted.

Completion auditing instructs the model to collect current, relevant evidence; the software does not independently prove arbitrary task correctness. Instructions prohibit finishing before required subagent results arrive, treating stale or unrelated tests as evidence, or bypassing permission blockers. There is no guarantee of uninterrupted multi-agent orchestration or execution while the Pi process is closed.

## Development and checks

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
npm pack --dry-run
```

`npm run check` runs `npm run typecheck` and `npm test`; each can also be run separately. `npm run check:package` creates a disposable tarball, verifies its exact file allowlist, and runs the isolated SDK integration tests against the unpacked entry point. Runtime code uses host-provided packages as peers. Development dependencies and the lockfile pin the tested versions. No build output is required; TypeScript sources are packaged. There is no separate linter; checks use strict TypeScript and behavioral tests. Tests must not use real provider accounts or paid APIs.

Source layout:

- `src/index.ts`: small Pi entry-point factory wiring `createGoalSession`, `registerGoalCommand`, and `registerGoalTools`.
- `src/session.ts`: branch-local mutable state, accounting, persistence, lifecycle hooks, retries, and continuation; exposes coherent session operations through the inferred `GoalSession` type.
- `src/commands.ts`: `/goal` command registration, interactive UI, and replacement confirmation.
- `src/tools.ts`: model tool schemas and registration.
- `src/status.ts`: timer and status presentation.
- `src/state.ts`: state schema, validation, restoration, usage accounting, and cancellable retry waits.
- `src/prompts.ts`: presentation text, response formats, and goal/audit instructions.
- `test/`: pure logic, lifecycle regressions, and isolated Pi SDK checks.

The repository includes tests and development configuration. The distribution contents are controlled by the `files` allowlist in `package.json`; TypeScript sources, README, license, changelog, and npm's automatically included package manifest form the package. `AGENTS.md` is development guidance, not part of the runtime package. `PLAN.md`, personal settings, dependency directories, and temporary output belong in neither Git nor the package.

## Release policy

Use semantic versioning and record changes in [CHANGELOG.md](CHANGELOG.md). The manifest currently declares `0.1.0`; a release is a separate maintainer action, not a consequence of editing that field.

After reviewing the release commit, a maintainer creates and pushes an existing matching `vVERSION` tag, then explicitly dispatches the release workflow with the `version` input set to `VERSION` (without the `v` prefix). The workflow verifies that the tag and package version match, runs the checks, and creates a GitHub release from that tag only after the checks pass. It does not publish to npm. Creating/pushing tags and dispatching a release require explicit authorization; ordinary development checks do not release anything.
