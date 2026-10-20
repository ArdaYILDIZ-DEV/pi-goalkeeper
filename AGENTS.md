# Goalkeeper development guide

Goalkeeper is a TypeScript extension for bounded, branch-local goal continuation in Pi. The product name is **Goalkeeper**; the lowercase package name is `goalkeeper`. Pi loads the sources directly.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Wire the session factory and command/tool registration only. |
| `src/session.ts` | Own mutable goal state, accounting, persistence, lifecycle hooks, retries, and continuation. |
| `src/commands.ts` | Register `/goal`; handle interactive editing and replacement confirmation. |
| `src/tools.ts` | Define model tool schemas and register sequential mutations. |
| `src/status.ts` | Render the TUI footer and own its refresh timer; never account or persist usage. |
| `src/state.ts` | Pure state types, validation, restoration, usage arithmetic, and cancellable retry waits. |
| `src/prompts.ts` | User-facing text, tool response formatting, and model instructions. |

Commands and tools use coherent session operations rather than mutating state. Operations persist and refresh status together and return independent snapshots. Infer `GoalSession` from its factory; do not duplicate the interface or introduce a controller framework. After an awaited dialog, re-check goal identity before applying changes. Keep `state` independent of Pi and presentation, and `prompts` dependent only on state.

## Verification

Run from the repository root with the Node.js version required by `package.json`. The verified host API is Pi **1.3.0**; inspect its public declarations and lifecycle implementation before changing API usage.

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
```

- `npm run check` runs strict TypeScript checking and the full test suite. For a narrow regression, use `npx tsx --test test/session.test.ts` or the relevant test file.
- `npm run check:package` creates a disposable tarball, checks its exact file allowlist, and runs SDK integration tests against the unpacked entry point. Update this allowlist when adding runtime modules.
- There is no separate build or lint command. Keep host-provided imports as peers with `*` ranges; pin tested development versions in the manifest/lockfile, not bundled runtime dependencies.
- Test only with isolated session/settings/credential stores and the fake provider. Never use personal Pi settings, real credentials, or paid providers.
- `pi -e ./src/index.ts` is a development loading shortcut, not isolation: it leaves normal extension discovery enabled. Avoid loading a second copy.

Tests are grouped by boundary: `state.test.ts` for pure logic and damaged/legacy records; `session.test.ts` for coherent operations and snapshot isolation; `lifecycle.test.ts` for hook ordering, cancellation, and stale dialogs; `status.test.ts` for footer timer lifetime; `integration.test.ts` for the real SDK loader/tool/queue pipeline; and `release.test.ts` for the version/changelog gate. Direct hook tests do not replace SDK tests.

## Behavioral contracts

- Preserve `/goal`, `create_goal`, `get_goal`, `update_goal`, and the `goal`, `goal-ui`, and `goal-continuation` wire identifiers.
- Persist only snapshots on the Pi session branch. Do not add a task database or second progress log. Pair schema changes with legacy/unknown/damaged restore tests; never claim historical usage is accurate under a new metric.
- Restore, reload, and branch changes are not automatic resume. Explicit resume resets response/consecutive error counters, not tokens. Editing replenishes neither budgets nor retry allowances. Invalid usage in a budgeted goal remains a recovery blocker.
- Use `agent_before_settle` for automatic continuation after Pi retry/recovery/compaction, not a competing loop in `agent_end`. Preserve earlier boundary entries and do not add continuation when input or another continuation is pending.
- Count `input + cacheWrite + output` at assistant `message_end`; do not subtract cache reads or fall back to `totalTokens`. Exclude creation, include completion-calling responses, and exclude post-completion reporting.
- Enforce 50 assistant responses per start/resume and at most 10 extra error retries after Pi recovery. A successful agent run, not one successful tool result, resets consecutive errors. Limit, blocker, cancellation, or retry exhaustion is not success.
- Stop the inner loop at the appropriate `turn_end` boundary; never clear Pi's message queues. Old-goal waits and stop decisions must not affect replacements.
- Never restart automatically after cancellation. Use `blocked` immediately for real permission/input/credentials blockers. Do not classify errors from the words “rate/limit” or require three repeated blockers.
- Pi 1.3.0 may not expose `ctx.signal` during settlement. Abort prevents another request but may wait for backoff; do not promise immediate cancellation.
- Completion requires current, relevant evidence, not just a model declaration. Goals/retries grant no authority; inspect live state before repeating uncertain side effects.

Add relevant regressions for behavior changes. Keep `README.md` and `src/prompts.ts` consistent when changing user-facing contracts. Keep README focused on installation, usage, and important limitations; put contributor/release mechanics here.

## Distribution and releases

The repository is https://github.com/ArdaYILDIZ-DEV/pi-goalkeeper.git. Distribution uses Git-based Pi packages, not npm publishing. Preserve `private: true`, MIT licensing, and the lowercase package name. Derive versions from `package.json`; do not hardcode the current release in this guide.

The `files` allowlist in `package.json` controls tarball contents; `pi.extensions` selects `src/index.ts`. Check both when changing modules. Exclude `PLAN.md`, personal settings, secrets, dependencies, logs, and temporary output from Git and packages. Local planning notes are not product contracts.

Use Semantic Versioning, matching `vVERSION` tags, and a `## VERSION` section in `CHANGELOG.md`. The release-notes script requires that exact heading and nonempty notes. For an explicitly authorized release:

1. Confirm the repository, intended version, clean worktree, and absence of a conflicting tag/release. Update the manifest/lockfile only if the release version changes, and update the changelog.
2. Review the diff, run both checks above, and validate notes with `node scripts/release-notes.mjs VERSION`.
3. Commit and push the reviewed release commit when authorized. Create an annotated `vVERSION` tag on that commit and push that specific tag; never move an existing tag or force-push.
4. Dispatch `gh workflow run release.yml --ref main -f version=VERSION`. The workflow checks out the existing tag, validates its manifest/changelog, and runs tests/package checks before a separate write-enabled job creates the GitHub Release. It never publishes to npm.
5. Verify the workflow result, published release URL, and tag commit. If a remote write fails or times out, inspect its actual state before retrying.

Ordinary push/PR CI is read-only and never publishes. Release creation is a separate, authorized action; do not dispatch it on every push. Inspect Git status and stage only intended project changes before committing. Do not publish, push, or create remote resources without user authorization. License changes must update `LICENSE`, metadata, and README together; do not invent attribution.
