# Bundled Codex Web GPT headless bridge

This directory is the package-owned operational source for Workgraph's isolated, browser-only route
through the upstream [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) Linux
launcher. It starts a private virtual display and exposes noVNC only on loopback so a human can sign
in through an SSH tunnel. Automation deliberately stops at the ChatGPT login boundary.

## Pin and inspected route

- Upstream release: `v5.0.4`
- Upstream commit: `c648c09501bb1b704c7ad5273fb5f5d6b8992dd2`
- Asset: `codex-web-gpt-5.0.4-linux-x64.AppImage`
- Published and pinned SHA-256:
  `53b2bda3691774fa588ae3f9b0fcdeea49b35e72966934631d172cac0adf0d76`
- Inspection found no upstream `AGENTS.md`. The release's `scripts/install-launcher.sh`, packaged
  AppImage runner, launcher profile resolution, login ownership, and core setup path were inspected
  at the pinned commit.

The upstream launcher is the supported Linux route. The older terminal-managed Chrome setup rejects
non-macOS hosts. The packaged launcher embeds Electron, Bun, the Responses bridge, and its browser;
its bounded runner extracts the AppImage when FUSE is unavailable. No sandbox bypass is used.

`install.sh` independently downloads the versioned asset and `checksums.txt`, requires the manifest
hash and local hash to match the pin, then extracts the upstream runner. It does not run the upstream
installer, create desktop files, or launch anything.

## Isolation and external state

The default external root is:

```text
~/.local/share/codex-web-gpt-headless/
├── app/                 # verified AppImage, upstream runner, checksum manifest
├── state/
│   ├── core/            # codex-chatgpt-web runtime/config
│   ├── codex-home/      # isolated Codex configuration target
│   ├── launcher/        # sensitive Electron profile and ChatGPT session
│   ├── vnc.passwd       # x11vnc password hash
│   ├── vnc-password.txt # generated VNC password, mode 0600
│   └── xdg/             # isolated config/data/cache (including any launcher autostart entry)
├── runtime/             # PID records and private XDG runtime data
├── logs/                # launcher/display logs
└── PROVENANCE
```

The scripts set `CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`,
`CODEX_WEB_GPT_LAUNCHER_DATA_DIR`, and all relevant XDG homes under that root. Existing
`~/.codex`, Pi, Workgraph, browser profiles, and listeners are not reused or changed. The launcher
may open a random loopback CDP endpoint for its own broker, as required by upstream; it is never
bound publicly. Treat `state/launcher` as an authentication secret and never copy or commit it.

Nix supplies `xorg-server`, `x11vnc`, and `novnc` user-locally. On NixOS, the AppImage's Electron
binary also needs standard GUI libraries that are not visible through a plain `nix shell`. The
start script resolves those libraries from the configured Nix environment and passes `LD_LIBRARY_PATH`
only to the private session; it does not enable `nix-ld` or alter system configuration. Defaults are display `:97`,
VNC `127.0.0.1:5905`, and noVNC `127.0.0.1:6085`. Startup refuses occupied ports or displays.
Overrides are `CODEX_WEB_GPT_HEADLESS_ROOT`, `CODEX_WEB_GPT_DISPLAY_NUMBER`,
`CODEX_WEB_GPT_VNC_PORT`, and `CODEX_WEB_GPT_NOVNC_PORT`; use the same values for every lifecycle
command.

## Install and start

From an integrated pi-workgraph Git checkout that preserves executable modes (not a temporary worker worktree):

```sh
cd /path/to/pi-workgraph/scripts/codex-web-gpt-headless
```

These direct `./*.sh` commands are for that Git checkout; npm-installed consumers should use the
package bins below instead of invoking npm-normalized bundled scripts directly. The scripts are
standalone shell scripts, not Pi extensions. Keep them under `scripts/`, never `~/.pi/agent/tools/`,
which Pi reserves for legacy custom tools. Start the runtime from this retained path so its
supervisor identity and launcher restart callback survive worker cleanup.


```sh
./install.sh
./start.sh
./status.sh
```

For an npm-installed package, use the executable package bins
`pi-workgraph-chatgpt-web-{install,start,status,stop}`. They resolve the real bundled directory
through npm's `.bin` links; the internal session is invoked explicitly through `sh`.

`start.sh` prints the tunnel command and URLs. From a trusted client machine, substitute the SSH
host and user:

```sh
ssh -N -L 6085:127.0.0.1:6085 USER@HOST
```

Then open:

```text
http://127.0.0.1:6085/vnc.html?autoconnect=1&resize=scale
```

Read the generated VNC password on the server (do not paste it into chat or logs):

```sh
cat ~/.local/share/codex-web-gpt-headless/state/vnc-password.txt
```

Proceed only through the launcher's onboarding and **Sign in to ChatGPT** step. Login and identity
provider windows remain in the launcher's embedded, dedicated Electron profile. Do not send a
ChatGPT message, install the full MCP harness, or select **Install models** during this staging
step.

## Stop and restart

```sh
./stop.sh
./status.sh
./start.sh
```

The session supervisor records its PID and Linux process start time. `stop.sh` validates both the
identity and script command line before signaling only that supervisor; after a short grace period
it terminates only the supervisor's captured process tree if a shell is still waiting on Electron.
It does not kill unrelated processes. Login state survives in `state/launcher`.

## After human login

When the human has confirmed the embedded browser is signed in, the isolated browser-only bridge
can be initialized later:

1. Restart this private session if needed and reconnect through the SSH tunnel.
2. In the launcher, run its browser smoke test.
3. Choose browser-only/automatic mode and press **Install models**.
4. Keep **MCP** and tunnel setup disabled. Restart only a Codex process explicitly launched with
   `CODEX_HOME=~/.local/share/codex-web-gpt-headless/state/codex-home`.
5. Run the launcher's doctor and inspect its Activity logs before any model request.

Those steps initialize only the isolated Codex home and loopback Responses bridge. Integrating the
user's real Codex installation would require separate authorization and migration planning.

Routine package and provider checks do not perform a live ChatGPT request or browser mutation.
Human login, real advisory quality, and full end-to-end operation remain outside those checks; use
the retained launcher artifacts and Activity view for any authorized operational investigation.

## Workgraph consultation client

Workgraph's `chatgpt-web/pro` provider invokes this source explicitly through `python3` with one
self-contained UTF-8 research objective and a new private output directory under the external root.
The fixed client request is fresh, tool-less, uses the `chatgpt-web/pro` route, and has no automatic
retry or conversation continuation. It retains `request.json`, `response.sse`, `response.json`,
`answer.md`, and `status.json` when available. On interruption, timeout, or incomplete response,
inspect the retained artifact and the launcher's Activity view before any later submission; a local
timeout is not proof that the remote request did not run. The provider serializes bridge launches with a kernel lock held by the bridge process and replays only a coherent completed artifact.

The upstream browser may still provide native ChatGPT capabilities; this is not a provider-enforced
no-web-search mode. Never copy the external root's credentials, browser profile, logs, binaries, or
runtime state into the package. Upstream describes this as unofficial browser automation subject to
OpenAI terms and workspace policies.
