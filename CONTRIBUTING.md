# Contributing to pi-minimal-dispatch

Thanks for your interest. This project is intentionally small — read
[README.md](README.md) and [docs/API.md](docs/API.md) for the contract and
[AGENTS.md](AGENTS.md) for the working rules before proposing changes.

## Development

```bash
git clone https://github.com/zhtmike/pi-minimal-dispatch
cd pi-minimal-dispatch
for t in tests/*.test.ts; do node "$t"; done   # unit tests — no dependencies, no model calls
pi -e ./src/index.ts                            # load the extension for one session
```

Integration proof (`bash tests/prove.sh`) spawns a real pi lane and bills a
small model call; run it before submitting behavior changes. The extension
targets macOS and Linux — both GNU `timeout` and `ps -o lstart=` must be
available.

## CI & releasing

The repo is dependency-free by design: no `node_modules`, no lockfile. CI
([`.github/workflows/`](.github/workflows/)) installs its toolchain ephemerally:

- **Tests** runs on every push/PR to `main` — unit tests on node 22 and 24
  (zero-install, guards the `engines` floor), a typecheck of `src/index.ts`
  against the oldest pi this package claims (`@earendil-works/pi-coding-agent`
  1.4.0 — the only compile-time coverage of the host-API boundary, since no
  unit test imports `index.ts`), and a `continue-on-error` canary typecheck
  against pi `latest`.
- **Release** runs on pushing a `v*` tag. It refuses to publish unless the tag
  matches `package.json`'s version and `CHANGELOG.md` has a `## <version> —`
  section, then publishes to npm with provenance (OIDC trusted publishing — no
  npm token is stored in the repo) and creates the GitHub release with that
  CHANGELOG section as its body.

Releasing therefore is: bump `version` in `package.json`, add the CHANGELOG
section, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
`tests/prove.sh` never runs in CI — it bills models and stays a manual
pre-release step.

One-time setup (already done or needed once, not per release): on npmjs.com,
add a trusted publisher for `pi-minimal-dispatch` pointing at this repository
and the `release.yml` workflow; on GitHub, protect `main` and require the
Tests workflow.

## Ground rules

- **Minimal surface.** New options, states, or actions must justify
  themselves against the contract in [docs/API.md](docs/API.md). Queueing,
  steering, and UI work are non-goals.
- **Tests ship with the change.** Every behavior change adds or updates a unit
  test in the same PR.
- **Docs stay in sync.** README, docs/API.md, AGENTS.md, and the code must
  agree; a PR that changes behavior updates the reference in the same commit.
- **Commit style:** `[module] type: subject` (e.g. `[dispatch] fix: refuse
  duplicate lane names`), body explains the root cause.

## Pull requests

Keep PRs small and single-purpose. Describe the failure mode or need, the
change, and how you verified it (test output pasted, not summarized).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
