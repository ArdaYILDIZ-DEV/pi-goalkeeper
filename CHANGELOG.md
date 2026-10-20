# Changelog

Notable changes are recorded here. Versions follow Semantic Versioning; Git tags
use the `v` prefix and match `package.json`. A changelog entry is not evidence that
a GitHub Release has been published.

## 0.1.0

Initial release preparation:

- Bounded, branch-local goal continuation for Pi 1.3.0 with explicit pause,
  resume, edit and clear commands and compatible goal tools/session identifiers.
- Validated session snapshots, response/token accounting, cancellation handling,
  and up to ten extra error retries after Pi recovery.
- TypeScript entry point at `src/index.ts`, pure state and prompt helpers, and
  isolated TUI footer/timer ownership.
- Unit, lifecycle and isolated Pi SDK regressions, including packed-source loading.
- English user/contributor documentation, Git-based distribution, automated checks
  and a manually triggered, version-checked GitHub Release workflow. No npm publishing.
