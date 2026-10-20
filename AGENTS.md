# Goalkeeper development guide

Goalkeeper is a TypeScript extension for Pi that provides bounded goal continuation tied to the session tree. The product name is **Goalkeeper**; the npm package name is `goalkeeper`.

## Code layout

- `src/index.ts`: Pi entry point; lifecycle, continuation decisions, commands, tools, and goal orchestration.
- `src/status.ts`: timer and status presentation.
- `src/state.ts`: state types, saved-record validation/restoration, usage accounting, and retry waits. It must not depend on Pi or the presentation layer.
- `src/prompts.ts`: user-facing text, tool responses, and model instructions; depends only on the state layer.
- `test/state.test.ts`: pure logic and damaged/legacy record boundaries.
- `test/lifecycle.test.ts`: lifecycle regressions with controlled hook contexts and mock timers.
- `test/integration.test.ts`: real Pi SDK loader and tool pipeline; isolated sessions/settings/credentials and a fake provider.

Keep dependencies directed from `index` to `status/prompts/state`, and from presentation modules to state as needed. Keep goal orchestration in `src/index.ts`; do not add controller interfaces or new layers merely to make files smaller.

## Development and verification

Run commands from the repository root. The Node.js requirement is in `package.json`; the verified host API is Pi **1.3.0**. Do not assume a newer host contract; when changing API usage, inspect the target version's public declarations and lifecycle implementation.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check:package
npm pack --dry-run
```

`npm run check` combines type checking and the full test suite. `npm run check:package` verifies the packed file allowlist and runs the isolated SDK tests against the unpacked entry point. For a focused regression, use a command such as `npx tsx --test test/state.test.ts`.

There is no separate build or lint command; Pi loads the TypeScript sources. Do not bundle host packages as runtime dependencies: keep imported host packages as peers, with tested versions in development dependencies and the lockfile.

Do not run tests against personal Pi settings, real credentials, or paid providers. Use the integration tests' isolated SDK harness. `pi -e ./src/index.ts` does not disable normal extension discovery and is not proof of isolation on its own. To test packaged source loading, the integration harness accepts an alternative entry point through `GOALKEEPER_EXTENSION_PATH`.

## Behavioral contracts to preserve

- `/goal`, `create_goal`, `get_goal`, `update_goal`, and the `goal`, `goal-ui`, and `goal-continuation` session identifiers exist for compatibility with existing users; do not rename them just for naming consistency.
- Persistence uses the latest snapshot on the session branch. Do not add a separate task database or second progress log. Pair schema changes with restoration validation and legacy/unknown/damaged record tests; do not claim historical usage values are accurate under a new metric.
- Restoration, reload, and branch changes are not automatic resume. Explicit resume resets response and consecutive error counters; it does not erase token consumption. Editing does not replenish an exhausted budget or retry allowance.
- Normal automatic continuation uses `agent_before_settle`; do not race Pi's own retry, recovery, and compaction processes in `agent_end`. Preserve entries from earlier boundary handlers; do not add a second continuation when input is pending or a continuation is already requested.
- The token metric is `input + cacheWrite + output`. Cache-read tokens are not included; do not fall back to `totalTokens`. Account at a single closing point for each assistant response: exclude the creation response, include the response calling the completion tool, and exclude reporting after completion.
- Each start or explicit resume allows 50 assistant responses and at most 10 additional Goalkeeper error retries after Pi's recovery. A successful agent run resets the consecutive error counter; a single successful tool result does not. A limit, blocker, or cancellation is not success.
- Stop the inner tool/model loop at the appropriate `turn_end` boundary when a limit is reached; do not clear Pi's user/extension message queues. A wait or stop decision belonging to an old goal must not affect a new goal.
- Do not restart automatically after cancellation. `blocked` is immediately available for a real permission/user-input blocker; there is no three-turn retry requirement. Do not derive unreliable error classifications from the words “rate/limit” in error text.
- Pi 1.3.0 may not provide `ctx.signal` during settlement. Although abort prevents a new request, it may wait for backoff to finish; do not promise immediate cancellation without public API or runtime evidence.
- Completion instructions require current, relevant evidence; do not present the model's `complete` declaration as independent verification. A goal or retry grants no new authority; do not blindly repeat side effects with uncertain outcomes.

Add relevant regressions when lifecycle, counter, or state behavior changes. Update `README.md` and `src/prompts.ts` together when a user-facing contract changes. Direct hook/execute tests do not replace the real Pi validation and queue pipeline.

## Repository and distribution boundaries

The `files` allowlist in `package.json` is authoritative for distribution. When changing the entry point or modules, check both `pi.extensions` and package contents. `AGENTS.md` is development guidance and need not be included in the runtime package.

The public repository is https://github.com/ArdaYILDIZ-DEV/pi-goalkeeper.git. Distribution uses `pi install git:github.com/ArdaYILDIZ-DEV/pi-goalkeeper`; do not assume an npm publication. Preserve the lowercase package name `goalkeeper`. The manifest declares version `0.1.0`, which does not establish that a release has been published.

Use semantic versioning and maintain `CHANGELOG.md`. A maintainer creates and pushes a matching `vVERSION` tag after reviewing the release commit, then explicitly dispatches the release workflow with its `version` input set to `VERSION` without the `v` prefix. The workflow requires that existing tag, verifies the package version/tag match, runs checks, and creates a GitHub release from the tag only after checks pass. It does not publish to npm. Do not create/push tags or dispatch releases without explicit authorization.

If `PLAN.md` exists, it is a local roadmap, not evidence of the product contract; include it in neither Git nor the distribution package. Exclude personal settings, secrets, `node_modules/`, logs, and temporary archives.

The project is MIT-licensed; the license text is in `LICENSE`. If a license change is requested, update that file, package metadata, and README together. Do not invent an unverified copyright holder or attribution. Do not commit, push, publish, or create a remote repository on your own initiative.
