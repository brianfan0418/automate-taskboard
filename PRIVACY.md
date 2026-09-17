# Privacy

AutoMate Taskboard is a local-first application. Its desktop launcher runs the
Taskboard service on the local computer and does not send Taskboard content or
usage telemetry to the project maintainers.

## Data stored on the computer

On Windows, AutoMate Taskboard stores its database, attachments, launcher runtime
file, and independent Codex browser profile under:

`%APPDATA%\AutoMate Taskboard`

Launcher logs are stored under:

`%LOCALAPPDATA%\AutoMate Taskboard\Logs`

The launcher also installs the bundled `manage-automate-taskboard` Skill in the current
user's `.agents\skills\manage-automate-taskboard` directory.

## Network activity

- The desktop app uses a loopback-only HTTP service to connect the embedded
  panel, the launcher, and `taskctl` on the same computer.
- Windows builds check for updates only in the shared folder configured at
  build time (`AUTOMATE_UPDATE_SOURCE`) or in `update-source.json`. No update
  source is configured by default.
- Agent runs start the Codex or Claude Code CLI installed on the computer.
  Those tools contact their providers under the user's own account and terms.
- Mobile access, when turned on, accepts paired devices over the user's own
  Tailscale network.
- The official Codex application and Codex CLI use OpenAI services under the
  user's existing OpenAI account and OpenAI's terms.
- Cloud collaboration is optional. When a user configures it, Taskboard data is
  sent to the deployment selected by that user.

AutoMate Taskboard does not include advertising or a project-maintainer analytics
service.

## Removing data

Uninstalling the Windows application removes the installed program but keeps
user data and the installed Skill. See
[Windows uninstall](docs/windows-uninstall.md) for the optional manual cleanup.
