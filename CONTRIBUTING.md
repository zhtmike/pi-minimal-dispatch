# Contributing to pi-minimal-dispatch

Thanks for your interest. This project is intentionally small — read
[README.md](README.md) for the contract and [AGENTS.md](AGENTS.md) for the
working rules before proposing changes.

## Development

```bash
git clone https://github.com/zhtmike/pi-minimal-dispatch
cd pi-minimal-dispatch
node tests/derive.test.ts    # unit tests — no dependencies, no model calls
pi -e ./src/index.ts         # load the extension for one session
```

Integration proof (`bash tests/prove.sh`) spawns a real pi lane and bills a
small model call; run it before submitting behavior changes. The extension
targets macOS and Linux — both GNU `timeout` and `ps -o lstart=` must be
available.

## Ground rules

- **Minimal surface.** New options, states, or actions must justify
  themselves against the README's contract. Queueing, steering, and UI work
  are non-goals.
- **Tests ship with the change.** Every behavior change adds or updates a unit
  test in the same PR.
- **Docs stay in sync.** README, AGENTS.md, and the code must agree; a PR that
  changes behavior updates the README in the same commit.
- **Commit style:** `[module] type: subject` (e.g. `[dispatch] fix: refuse
  duplicate lane names`), body explains the root cause.

## Pull requests

Keep PRs small and single-purpose. Describe the failure mode or need, the
change, and how you verified it (test output pasted, not summarized).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
