# Workgraph verification boundaries

## Pi and Herdr

Deterministic adapters cannot establish ordinary Pi package loading, native Herdr identity, automatic coordinator continuation, or an actual guide-to-executor model transition.
Changes to those boundaries need a normal visible Pi operation against the exact candidate in addition to focused contract checks.
A missing integration, trust prompt, unavailable model, or absent native identity is an evidence limitation, not permission to bypass approval or claim settlement.
Herdr's idle/done observation can lag Pi events; native attempt-generation markers establish settlement.

## Static and deterministic checks

`pnpm check` is the maintained local and CI boundary for quality preparation, shared Biome, type-aware Effect Oxlint, and all deterministic `node:test` tests.
`pnpm typecheck` runs `tsc --noEmit` independently and can expose compiler compatibility diagnostics, but it is not part of `pnpm check` because Oxlint already performs the full type-aware check over the configured source set.
The project pins pnpm `11.25.0` and `@syzom/typescript-quality` `0.2.0`, so evidence from another package-manager or shared-config version is not evidence for the committed lockfile.
The only test-framework quality override disables `effecttsgo/async-function` for `test/**/*.test.ts` because `node:test` callbacks and fake adapters expose Promise contracts.
That override leaves every other shared and Effect rule active, and Oxlint rejects obsolete inline disable directives as errors.
A focused test file can establish its own behavior but cannot replace the full source-selection and unused-directive coverage of `pnpm check`.

## Effect lifecycle boundaries

Process ownership claims require real child-process checks for normal completion, spawn failure, bounded output and digesting, timeout escalation, pre-aborted launch prevention, and interruption that waits for close.
Promise-level success or rejection alone does not establish that the scoped Effect owner released the native process.
Runtime scheduling tests may inject Effect's `TestClock`, but fenced lease checks still cross the native SQLite and wall-clock boundary and must align their fixture time explicitly.
Workstream persistence claims require real temporary state files and real isolated SQLite storage because an in-memory adapter cannot establish mutation serialization, atomic replacement, or fenced ownership.

## Persistence and external effects

A retained report, successful tool response, or worker statement alone does not establish Git composition, artifact retention, or resource cleanup.
Those claims require the exact repository revision, retained bytes, or resource identity at the dependent boundary.
Interrupted operations can leave effects despite an uncertain response; recovery must inspect those effects before retrying.
Delivery is recoverable and identifier-based, not exactly once.
Tests must distinguish notification transport, explicit coordinator receipt, report validity, and evidence disposition.
When a current native attempt has no report text, `test/pi-process.test.ts` establishes latest-message and generation-local failure categorization, while `test/native-failure.test.ts` establishes the retained and projected absent-result details.
Those checks must establish that raw provider errors and credentials do not enter retained state or notifications and that typed or untyped results remain authoritative when present.
The bounded category is actionable context, not proof of the provider's underlying cause.

Lease and ownership checks use real isolated SQLite storage.
Git safety checks use disposable real repositories and preserve mismatched or unattributed resources.
Shared read-only workers use the live project cwd, including dirty tracked and untracked files, and their settlement and recovery must not invoke Git cleanup or discard.
Human authority tests enter through Pi's registered input/tool path, including rejection of extension-generated authority.
Historical work keeps its original intent scope; current maintained composition requires current intent.

## Packed consumer bootstrap

`pnpm pack --dry-run` establishes the intended published file list but does not establish that an installed consumer can resolve the package-owned `tsx` loader or start the executable outside the checkout.
Use a disposable consumer, install the exact generated tarball without lifecycle scripts, and invoke its installed binary from an unrelated working directory:

```bash
set -eu
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pnpm pack --pack-destination "$tmp" >/dev/null
tarball=$(find "$tmp" -maxdepth 1 -name '*.tgz' -print -quit)
printf '{"private":true}\n' > "$tmp/package.json"
(
  cd "$tmp"
  pnpm add --ignore-scripts "$tarball" >/dev/null
  mkdir caller
  cd caller
  ../node_modules/.bin/pi-workgraph --help
)
```

A successful JSON help response establishes packaged loader resolution and basic CLI startup without running install hooks or relying on the repository's `node_modules` lookup.
It does not establish Pi package loading or any live Herdr behavior.

## Environment and limits

Live evidence is specific to the tested Node.js, Pi, Git, Herdr, model configuration, and candidate revision.
Implementation and disposable experiments use isolated worktrees, while read-only research and review use the live project cwd.
Worktree isolation does not constrain arbitrary filesystem, network, or credential access by a worker.
An exact-revision review is verified by Git evidence for that revision; tests run against live working files do not validate another revision.
Verification fixtures must not change user-global configuration or trust decisions, and retained credential-bearing evidence must stay private.
