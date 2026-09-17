[English](README.md) | [繁體中文](README.zh-TW.md)

# AutoMate Taskboard

AutoMate Taskboard is a local issue board for work that is handed to coding agents. It runs a small Node.js service with a SQLite database on your computer, serves a React web UI, and provides a `taskctl` CLI. Issues can be assigned to Codex or Claude Code, which run on the same computer and report progress back to the board.

This project is a modified version of [Dashi Taskboard](https://github.com/chuspeeism/dashi-taskboard) (Apache-2.0). See [NOTICE](NOTICE) for a summary of the changes.

## Requirements

- Windows 10 or 11 x64 (the desktop launcher, installer and self-update are built and tested for Windows; the web service and CLI also run on macOS and Linux)
- Node.js 22.5 or newer for development
- At least one agent CLI, signed in under your own account:
  - [Codex CLI](https://github.com/openai/codex) or the Codex desktop app
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- To build the Windows installer: Rust 1.88 or newer and Visual Studio Build Tools with the C++ workload and Windows SDK
- For phone access: [Tailscale](https://tailscale.com/) on the computer and on the phone

## Run from source

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47833>. Data is stored in `.data/taskboard.sqlite`.

For development with frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## CLI

```bash
npm run taskctl -- project create --id my-project --name "My project" --workspace-path /absolute/path/to/repository
npm run taskctl -- issue create --project my-project --title "Next step" --status todo --priority high
```

Set `CODEX_TASKBOARD_URL` to point the CLI at another service. `skills/manage-automate-taskboard` contains a Skill that teaches an agent how to read and update issues through `taskctl`; the desktop app installs it to `%USERPROFILE%\.agents\skills\manage-automate-taskboard`.

## Build the Windows app

```powershell
npm ci
npm run app:build:windows
```

The NSIS installer is written to `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It installs a tray launcher, a bundled Node runtime, the service, the web UI, the Skill and `taskctl.cmd`. Data is stored in `%APPDATA%\AutoMate Taskboard` and logs in `%LOCALAPPDATA%\AutoMate Taskboard\Logs`. Builds are not code-signed. See [Windows uninstall](docs/windows-uninstall.md) for what is kept after uninstalling.

The Tauri application identifier is `io.github.automate-taskboard`. The macOS and Linux release workflows and the Tauri updater configuration are inherited from upstream and are not maintained for this fork: the updater public key is still upstream's, so macOS/Linux self-update does not work. The macOS release workflow runs on version tags and needs Apple signing secrets that this fork does not configure.

## Self-update from a shared folder (Windows)

Windows builds can update from a folder you control, for example a network share. No update source is configured in this repository.

1. Generate a signing key pair once:

   ```bash
   npm run update:keygen
   ```

   The private key is written to `~/.automate-taskboard/update-ed25519.pem` (outside the repository; override with `--private-key`). The public key is written to `shared/update-public-key.mjs`, which ships empty in this repository. Until you generate a key, the app refuses every update.
2. Set the folder at build time: `AUTOMATE_UPDATE_SOURCE=\\server\share\automate-updates` before `npm run app:build:windows`. Without it, updates are disabled. On a single computer, `%APPDATA%\AutoMate Taskboard\update-source.json` containing `{ "source": "..." }` overrides the build value (`""` turns updates off).
3. Bump the version in `package.json`, build, then publish:

   ```bash
   npm run release:publish -- --notes "What changed"
   ```

   This copies `AutoMateTaskboard-<version>-setup.exe` to the folder and writes a signed `latest.json`. The private key path can also be set with `AUTOMATE_UPDATE_PRIVATE_KEY`.

The app checks 30 seconds after start, every 6 hours, and from the tray menu. Before installing it verifies the size, the SHA-256 hash and the ed25519 signature.

## Phone access through Tailscale

The service listens on the local network by default. To use the board from a phone outside the local network, install Tailscale on both devices and sign in to the same tailnet, then turn on mobile access in the board settings and pair the phone with the one-time code or QR code shown there. While mobile access is on, requests from Tailscale addresses (100.64.0.0/10) must come from a paired phone. Starting, stopping or steering an agent run is accepted only from the computer itself or from a paired phone.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47833` | HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47833` | Service URL used by the CLI |
| `CODEX_TASKBOARD_TRUSTED_ORIGINS` | unset | Comma-separated HTTPS origins allowed through a loopback reverse tunnel |
| `AUTOMATE_UPDATE_SOURCE` | unset | Shared update folder baked into a Windows build |

Every `CODEX_TASKBOARD_*` variable can also be given as `AUTOMATE_TASKBOARD_*`.

LAN mode has no account authentication: anyone on the local network who can reach the port can read and write the board. Do not expose the port to the internet.

Optional Cloudflare deployment for sharing a board is described in [Cloud collaboration](docs/cloud-collaboration.md). Data handling is described in [PRIVACY.md](PRIVACY.md).

## Tests

```bash
npm run typecheck
npm run test:node
npm run test:components
```

`npm run check` runs all of them plus a production build of the web UI.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on Dashi Taskboard by chuspeeism and its contributors.
