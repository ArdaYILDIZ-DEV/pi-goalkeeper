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

### Release preparation

Release only when the user explicitly authorizes publication to this repository. Use Semantic Versioning and agree on the intended version; do not infer a bump from a documentation edit. If a bump is needed, set `NEXT_VERSION` to that approved value and run `npm version "$NEXT_VERSION" --no-git-tag-version --ignore-scripts` to update the manifest and lockfile without creating a commit/tag. For the first release, an already-approved manifest version can be used unchanged.

Add a `## VERSION` section to `CHANGELOG.md` with user-relevant changes. The release-notes script requires that exact heading and nonempty notes; do not append a date to the heading. If changing the version, update the pinned installation ref in README too. Do not claim unpublished changes are already available.

Run the following from the repository root, step by step; stop on unexpected errors. Variables are derived from the approved manifest version, not from a hardcoded current release:

```sh
REPO=ArdaYILDIZ-DEV/pi-goalkeeper
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
git remote get-url origin
gh repo view "$REPO" --json nameWithOwner
git status --short
git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}"
gh release view "$TAG" --repo "$REPO"
```

Confirm `origin` points to the repository above. For a new release, the tag lookup must be empty and the release lookup should report not found; authentication/network failures are not proof of absence. If either already exists, inspect it before proceeding. Do not replace a published release or retarget its tag. Separate unrelated local changes before preparing the release commit.

### Validate and commit

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
node scripts/release-notes.mjs "$VERSION"
git diff --check
git diff
```

Review the changelog output, package contents, and test results. Stage only intended project paths with `git add -- <paths>`; never sweep personal notes or unrelated changes into a release. Then inspect `git diff --cached` and commit with an English Conventional Commit message. Commit/push only when authorized.

Before tagging, require a clean worktree and confirm the reviewed commit is the intended `main` release commit:

```sh
git status --short --branch
git log -1 --oneline
git push origin main
RELEASE_COMMIT=$(git rev-parse HEAD)
git ls-remote origin refs/heads/main
```

The remote `main` SHA must equal `RELEASE_COMMIT`; do not continue from a different branch or an unpushed commit.

### Tag and publish

Create an annotated tag only after the checks pass, and push only that tag:

```sh
git tag -a "$TAG" "$RELEASE_COMMIT" -m "Goalkeeper $VERSION"
git push origin "refs/tags/$TAG"
gh workflow run release.yml --repo "$REPO" --ref main -f version="$VERSION"
```

Never use `--force`, move an existing tag, or push all local tags. Save the workflow run URL/ID printed by `gh workflow run`; if the client does not print one, locate the matching dispatch with:

```sh
gh run list --repo "$REPO" --workflow release.yml --event workflow_dispatch --limit 5 --json databaseId,headSha,status,conclusion,url
```

The workflow must already exist on `main`. It checks out `refs/tags/vVERSION`, validates the manifest/changelog match, installs development dependencies, and runs both project and packed-source checks. Only after verification passes does a separate job with `contents: write` create the GitHub Release from the existing tag. Prerelease versions are marked as prereleases. No npm package or custom binary/archive asset is published; GitHub provides its standard source downloads, and Pi installs from Git.

### Verify publication and recover safely

Set `RUN_ID` to the actual run ID from the dispatch, not an older successful run:

```sh
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
gh release view "$TAG" --repo "$REPO" --json name,tagName,url,isDraft,isPrerelease,publishedAt
git rev-parse "$TAG^{commit}"
git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}"
git status --short --branch
```

Require a successful release run, a published non-draft release with the expected prerelease flag, and the peeled tag commit equal to `RELEASE_COMMIT`. Report the release URL, commit, checks, and any remaining failures. The release API's `targetCommitish` may say `main`; verify the actual tag commit rather than treating that field as a SHA.

If a push, dispatch, or publication fails/times out, inspect the remote tag, matching workflow runs, and release before retrying: the write may have succeeded. For a failed job, read `gh run view "$RUN_ID" --repo "$REPO" --log-failed`. If verification failed, fix the cause on a new commit and obtain approval for a new version/tag rather than moving the existing tag. If verification passed but publication failed, check whether the release exists before retrying only the failed job with `gh run rerun "$RUN_ID" --repo "$REPO" --failed`; never rerun a completed publication blindly.

Ordinary push/PR CI is read-only and never publishes. Do not dispatch releases on every push. Documentation-only follow-ups after a release stay on `main`; do not silently retag that release. Do not publish, push, or create remote resources without user authorization. License changes must update `LICENSE`, metadata, and README together; do not invent attribution.
