# Error Handling and Logging Implementation Plan

**Goal:** Make actionable job failures visible as one ERROR event per failure in Loki, while keeping expected fallbacks at lower levels and preventing failed runs from corrupting later runs.

**Architecture:** Keep the existing JSON logger and one-shot job boundaries. Log failures at the boundary that handles them; do not add logging inside functions that rethrow to an already logging caller. Preserve the current Loki transport and file/stdout fallback.

**Tech Stack:** Node.js, built-in test runner, existing logger and state store.

## Priorities

1. **P0: State and lock safety.** Fail on malformed saved state instead of silently resetting it; make lock creation and cleanup reliable so a failed run cannot permanently block later runs. Cover with focused state and lock tests.
2. **P1: Actionable failure visibility.** Log each failed light subscription once at ERROR with destination context, and avoid a second ERROR when its aggregate failure reaches the entrypoint. Give top-level errors useful cause/status context. Cover with fan-out and entrypoint tests.
3. **P1: Optional operation failures.** Promote failed pin synchronization and pin state persistence to ERROR because configured behavior did not complete, while keeping intentional Gemini/image fallbacks at WARN. Cover with plugin tests.
4. **P2: Logger delivery diagnostics.** Keep the current stderr fallback when Loki itself fails; document that Loki cannot alert on its own outage and verify ordinary ERROR events retain their `level=error` stream label.

## Validation

- Run focused tests after each change and `npm test` before commit.
- Review `git diff --check` and ensure the original checkout remains unchanged.
- Commit, push, and open a PR targeting `main`.
