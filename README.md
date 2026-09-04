# Pi Workgraph

Pi Workgraph is an outcome-driven local orchestrator for consequential repository work.

It keeps one coordinator conversation while bounded discovery, isolated product changes, exact-revision verification, and assurance run in inherited Pi session forks.

## Use

Install dependencies and run the deterministic gate.

```bash
pnpm install
pnpm check
```

Run Pi from the repository you want to change and load this package.

```bash
pi -e /absolute/path/to/pi-workgraph
```

Begin a run with an explicit outcome kind, outcome statement, and completion predicate.
The supported kinds are `answer`, `decision`, `product_change`, and `operation`.
A run may declare zero or more concrete task milestones.

Answer, decision, and operation runs finish through typed evidence and a coordinator conclusion without claiming implementation.
Product-change runs require agreement before writes, isolated bounded nodes, deterministic exact-commit composition, exact-revision verification, assurance, and final judgment.

## Skills

The package exposes sixteen optional composable procedure skills and Workgraph-owned verification skills through Pi's native `pi.skills` package manifest.
Verification guidance prefers repository-native harnesses, then a project-local verification skill, then the appropriate browser or CLI/TUI control skill.
Unavailable control surfaces produce inconclusive verification.

## Child capabilities

Workers run with `--no-extensions` and receive only the Workgraph worker extension plus explicitly resolved trusted capabilities.
Evidence discovery can use `npm:pi-web-access@0.14.0` with only `web_search`, `source_check`, `fetch_content`, and `get_search_content` enabled.
Codex workers can use the installed remote-compaction capability by stable package identity.
Each child records requested and resolved capability identity, version, tools, availability, and diagnostics in durable run state.

Repository-local configuration cannot inject executable child extensions, and third-party identities are never represented by installed `node_modules` paths.

## Verification

```bash
pnpm check
pnpm pack --dry-run
pnpm smoke:real
pnpm smoke:coordinator
```

The deterministic checks use disposable repositories and fake child outcomes where model variability would obscure engine behavior.
The smoke commands exercise the direct engine and coordinator package boundaries when configured models are authenticated.
