# CLI and Gateway Reference

## CLI Commands

```text
openpocket [--config <path>] install-cli
openpocket [--config <path>] onboard
openpocket [--config <path>] config-show
openpocket [--config <path>] emulator status|start|stop|hide|show|list-avds|screenshot [--out <path>]
openpocket [--config <path>] emulator tap --x <int> --y <int> [--device <id>]
openpocket [--config <path>] emulator type --text <text> [--device <id>]
openpocket [--config <path>] agent [--model <name>] <task>
openpocket [--config <path>] skills list
openpocket [--config <path>] script run [--file <path> | --text <script>] [--timeout <sec>]
openpocket [--config <path>] telegram setup
openpocket [--config <path>] gateway [start|telegram]
openpocket [--config <path>] human-auth-relay start [--host <host>] [--port <port>] [--public-base-url <url>] [--api-key <key>] [--state-file <path>]
openpocket panel start
```

Legacy aliases (deprecated):

```text
openpocket [--config <path>] init
openpocket [--config <path>] setup
```

Local clone launcher:

```text
./openpocket <command>
```

## `panel start`

- startup order:
- first tries installed panel app in `/Applications` and `~/Applications`
- then falls back to source build launch from `apps/openpocket-menubar` (local clone/dev)
- if panel app is not found, opens GitHub Releases for PKG download guidance
- menu bar only (no Dock icon)
- includes UI onboarding, runtime controls, permissions, storage scope, and prompt management

## `onboard`

- loads/creates config
- saves normalized config
- ensures workspace bootstrap files and directories
- runs Android dependency doctor (auto-install on macOS when tools are missing)
- ensures Java 17+ for Android command line tools; auto-installs via Homebrew on macOS if needed
- reuses existing local AVD when available to avoid heavy repeated image/bootstrap installs
- runs interactive onboarding wizard (consent/model/API key/emulator login/human-auth tunnel mode)

## `install-cli`

- explicitly (re)installs local CLI launcher at `~/.local/bin/openpocket`
- adds `~/.local/bin` export line to `~/.zshrc` and `~/.bashrc` when missing

Interactive onboarding wizard flow:

- prints setup banner/logo
- presents required user consent (local runtime + cloud model boundary)
- selects default model profile (GPT, Claude, AutoGLM, etc.)
- configures provider-specific API key (env or local config.json)
- configures Telegram bot token and chat allowlist policy
- option prompts use Up/Down arrows + Enter (no numeric menu input)
- can start/show emulator and guide manual Gmail login for Play Store
- configures human-auth bridge mode (`ngrok` / `LAN` / disabled)
- writes onboarding state to `state/onboarding.json`

## Legacy: `init`

- deprecated compatibility alias
- in interactive terminals: behaves like `onboard`
- in non-interactive terminals: runs bootstrap only (config + workspace + env doctor), without prompts

## Legacy: `setup`

- deprecated compatibility alias
- behaves like `onboard`

## `agent`

- runs one task synchronously
- returns message and session path
- exit code `0` on success, `1` on failure

## `emulator tap` / `emulator type`

- `emulator tap` sends one direct tap action to target device
- `emulator type` types text to the focused input target
- `--device <id>` overrides default device resolution for one command

## `script run`

- executes script via `ScriptExecutor`
- prints status, run directory, and stdout/stderr
- exit code follows `result.ok`

## `telegram setup`

- interactive setup for Telegram bot token source (env or config file)
- optional interactive allowlist update for `telegram.allowedChatIds`
- requires an interactive terminal (TTY)
- `gateway start` auto-configures Telegram slash-command menu (`setMyCommands` + menu button)

## `gateway start`

Startup behavior includes a preflight sequence:

1. load and validate config
2. validate Telegram token source (`config.telegram.botToken` or env)
3. ensure emulator is booted (auto-start headless when needed)
4. start panel on macOS (`panel start`)
5. start gateway runtime services (Telegram polling, heartbeat, cron)

When human auth is enabled in config, gateway also auto-starts:

- local relay server (`useLocalRelay=true`)
- optional ngrok tunnel (`humanAuth.tunnel.provider=ngrok` and `ngrok.enabled=true`)

## Telegram

Supported commands:

- `/help`
- `/status`
- `/model [name]`
- `/startvm`
- `/stopvm`
- `/hidevm`
- `/showvm`
- `/screen`
- `/skills`
- `/clear`
- `/reset`
- `/stop`
- `/restart`
- `/cronrun <job-id>`
- `/auth`
- `/auth pending`
- `/auth approve <request-id> [note]`
- `/auth reject <request-id> [note]`
- `/run <task>`

Plain text behavior:

- auto-routed as task or chat
- task path starts `AgentRuntime`
- chat path replies conversationally

Gateway runtime behavior:

- long-running process loop with signal-aware shutdown/restart
- `SIGUSR1` restarts gateway in-process
- heartbeat runner logs health snapshots on interval
- cron service executes due jobs from `workspace/cron/jobs.json`
- if `humanAuth.enabled=true` and `useLocalRelay=true`, gateway auto-starts local relay
- if `humanAuth.tunnel.provider=ngrok` and `ngrok.enabled=true`, gateway also auto-starts ngrok tunnel

## Telegram Output

Before sending model/task content back to chat:

- remove internal lines (`Session:`, `Auto skill:`, `Auto script:`)
- redact local screenshot and run directory paths
- collapse whitespace and truncate

This keeps user-facing chat concise and avoids exposing local filesystem details.

## `human-auth-relay`

- runs a lightweight web relay for real-device authorization handoff
- receives human-auth requests from gateway and returns one-time approval links
- provides polling APIs so task runtime can resume after approve/reject
- optional standalone mode for debugging (normal flow does not require manual start)
